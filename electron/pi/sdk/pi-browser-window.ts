import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface BrowserWindowController {
  setVisible(visible: boolean): Promise<boolean>
  dispose(): Promise<void>
}

// Only windows belonging to the dedicated Playwright browser PID are touched.
// The helper also hides newly opened windows; EOF restores them before exit.
const windowsHelper = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SepBrowserWindow {
  delegate bool Callback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  public static int Apply(int pid, bool visible) {
    int count = 0;
    EnumWindows((window, data) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      var name = new StringBuilder(256); GetClassName(window, name, 256);
      if (owner == pid && name.ToString() == "Chrome_WidgetWin_1") {
        ShowWindow(window, visible ? 9 : 0); count++;
      }
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
'@
$visible = $true
try {
  [Console]::Out.WriteLine('ready')
  $line = [Console]::In.ReadLineAsync()
  while ($true) {
    if ($line.Wait(100)) {
      $value = $line.Result
      if ($null -eq $value) { break }
      $request = ConvertFrom-Json $value
      $visible = [bool]$request.visible
      $count = [SepBrowserWindow]::Apply(PID_VALUE, $visible)
      [Console]::Out.WriteLine((@{id=$request.id;ok=((-not $visible) -or $count -gt 0)} | ConvertTo-Json -Compress))
      $line = [Console]::In.ReadLineAsync()
    }
    if (-not $visible) { [void][SepBrowserWindow]::Apply(PID_VALUE, $false) }
  }
} finally { [void][SepBrowserWindow]::Apply(PID_VALUE, $true) }
`

class WindowsBrowserWindow implements BrowserWindowController {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly ready: Promise<void>
  private readonly pending = new Map<number, (ok: boolean) => void>()
  private sequence = 0
  private failed = false

  constructor(pid: number) {
    const source = windowsHelper.replaceAll('PID_VALUE', String(pid))
    this.child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' })
    // Never forward helper output to logs: diagnostics must not include page data.
    this.child.stderr.resume()
    this.child.stdin.on('error', () => this.fail())
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(); reject(new Error('Browser window control unavailable.')) }, 10_000)
      const lines = createInterface({ input: this.child.stdout })
      lines.on('line', line => {
        if (line === 'ready') { clearTimeout(timer); resolve(); return }
        try {
          const value: unknown = JSON.parse(line)
          if (!value || typeof value !== 'object' || !('id' in value) || !('ok' in value)
            || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || typeof value.ok !== 'boolean') return
          this.pending.get(value.id)?.(value.ok)
          this.pending.delete(value.id)
        } catch { /* Ignore non-protocol helper output. */ }
      })
      const fail = () => { clearTimeout(timer); this.fail(); reject(new Error('Browser window control unavailable.')) }
      this.child.once('error', fail)
      this.child.once('exit', fail)
    })
    void this.ready.catch(() => undefined)
  }

  private fail(): void {
    this.failed = true
    for (const done of this.pending.values()) done(false)
    this.pending.clear()
    this.child.stdin.end()
  }

  async setVisible(visible: boolean): Promise<boolean> {
    try { await this.ready } catch { return false }
    if (this.failed) return false
    const id = ++this.sequence
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); this.fail(); resolve(false) }, 3_000)
      this.pending.set(id, ok => { clearTimeout(timer); resolve(ok) })
      this.child.stdin.write(JSON.stringify({ id, visible }) + '\n')
    })
  }

  async dispose(): Promise<void> {
    this.fail()
    if (this.child.exitCode !== null) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve() }, 2_000)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

class MacBrowserWindow implements BrowserWindowController {
  constructor(private readonly pid: number) {}
  async setVisible(visible: boolean): Promise<boolean> {
    // NSRunningApplication targets the dedicated process, never a bundle/name match.
    const source = `ObjC.import('AppKit'); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${this.pid}); app.isNil() ? false : Boolean(app.${visible ? 'unhide' : 'hide'})`
    return new Promise(resolve => {
      const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], { stdio: ['ignore', 'pipe', 'ignore'] })
      let output = ''
      child.stdout.on('data', data => { output = (output + String(data)).slice(0, 100) })
      const timer = setTimeout(() => { child.kill(); resolve(false) }, 3_000)
      child.once('error', () => { clearTimeout(timer); resolve(false) })
      child.once('exit', code => { clearTimeout(timer); resolve(code === 0 && output.trim() === 'true') })
    })
  }
  async dispose(): Promise<void> { /* Browser process shutdown is owned by the session. */ }
}

export function createBrowserWindowController(pid: number, platform: NodeJS.Platform = process.platform): BrowserWindowController {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid dedicated browser process.')
  if (platform === 'win32') return new WindowsBrowserWindow(pid)
  if (platform === 'darwin') return new MacBrowserWindow(pid)
  return { setVisible: async visible => visible, dispose: async () => undefined }
}
