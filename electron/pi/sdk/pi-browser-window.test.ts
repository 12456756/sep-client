import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BrowserModeSession } from './pi-browser-runtime'
import { createBrowserWindowController } from './pi-browser-window'

const execute = promisify(execFile)

async function visibleWindows(pid: number): Promise<{ total: number; visible: number }> {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const source = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SepWindowProbe {
  delegate bool Callback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  public static string Read(int pid) {
    int total = 0; int visible = 0;
    EnumWindows((window, data) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      var name = new StringBuilder(256); GetClassName(window, name, 256);
      if (owner == pid && name.ToString() == "Chrome_WidgetWin_1") {
        total++; if (IsWindowVisible(window)) visible++;
      }
      return true;
    }, IntPtr.Zero);
    return "{\"total\":" + total + ",\"visible\":" + visible + "}";
  }
}
'@
[SepWindowProbe]::Read(PID_VALUE)
`.replaceAll('PID_VALUE', String(pid))
  const result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10_000 })
  return JSON.parse(result.stdout.trim()) as { total: number; visible: number }
}

it('hides and restores only the dedicated Windows browser, including new windows, without losing the page', { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  let pid = 0
  const session = new BrowserModeSession(processId => {
    pid = processId
    return createBrowserWindowController(processId)
  })
  try {
    const context = await session.getContext()
    const page = await context.newPage()
    await page.setContent('<title>Native window fixture</title><input value="original">')
    await new Promise(resolve => setTimeout(resolve, 200))
    const hidden = await visibleWindows(pid)
    assert.ok(hidden.total > 0, 'test must inspect real Chromium windows')
    assert.equal(hidden.visible, 0)
    assert.equal(session.backgroundHidden, true)
    await session.setMode('visible')
    assert.ok((await visibleWindows(pid)).visible > 0)
    await session.setMode('background')
    await context.newPage()
    assert.equal((await visibleWindows(pid)).visible, 0)
    assert.equal(await page.title(), 'Native window fixture')
    assert.equal(await session.getContext(), context)
  } finally { await session.dispose() }
})

it('rejects invalid process targets without spawning a helper', () => {
  for (const pid of [0, -1, 1.5, NaN]) assert.throws(() => createBrowserWindowController(pid), /Invalid/)
})

it('keeps unsupported platforms visible instead of pretending hiding succeeded', async () => {
  const controller = createBrowserWindowController(123, 'linux')
  assert.equal(await controller.setVisible(false), false)
  assert.equal(await controller.setVisible(true), true)
  await controller.dispose()
})
