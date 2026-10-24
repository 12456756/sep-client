import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import type { PiBashOperations, PiEncodingToolSdk } from './pi-coding-agent-adapter'
import { OrderedToolOutput } from './pi-text-encoding'

const active = new Set<number>()

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => {})
    killer.unref()
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* Process already exited. */ }
    }
  }
}

function killActive(): void { for (const pid of active) killTree(pid) }

/** Match Pi's post-exit idle drain so inherited pipe handles cannot hang a tool. */
function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let done = false
    let exited = false
    let code: number | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let stdoutEnded = child.stdout === null
    let stderrEnded = child.stderr === null
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      child.stdout?.removeListener('data', onData)
      child.stderr?.removeListener('data', onData)
      child.stdout?.removeListener('end', onStdoutEnd)
      child.stderr?.removeListener('end', onStderrEnd)
    }
    const finish = (error?: Error): void => {
      if (done) return
      done = true
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (error) reject(error)
      else resolve(code)
    }
    const idle = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => finish(), 100)
    }
    const onData = (): void => { if (exited) idle() }
    const onError = (error: Error): void => finish(error)
    const onExit = (value: number | null): void => {
      exited = true
      code = value
      if (stdoutEnded && stderrEnded) finish()
      else idle()
    }
    const onClose = (value: number | null): void => { code = value; finish() }
    const onStdoutEnd = (): void => { stdoutEnded = true; if (exited && stderrEnded) finish() }
    const onStderrEnd = (): void => { stderrEnded = true; if (exited && stdoutEnded) finish() }
    child.once('error', onError)
    child.once('exit', onExit)
    child.once('close', onClose)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.stdout?.once('end', onStdoutEnd)
    child.stderr?.once('end', onStderrEnd)
  })
}

/** SDK operation hook: retain its bash schema, accumulator, truncation, updates and error formatting. */
export function createEncodingBashOperations(getShellConfig: PiEncodingToolSdk['getShellConfig']): PiBashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)) {
        throw new Error('Invalid timeout: must be a finite positive number within the timer limit')
      }
      if (signal?.aborted) throw new Error('aborted')
      try { await access(cwd, constants.F_OK) } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`)
      }
      if (signal?.aborted) throw new Error('aborted')
      const shell = getShellConfig()
      const stdin = shell.commandTransport === 'stdin'
      const child = spawn(shell.shell, stdin ? shell.args : [...shell.args, command], {
        cwd, env, detached: process.platform !== 'win32', windowsHide: true,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
      const output = new OrderedToolOutput(onData)
      const stdout = (data: Buffer): void => output.write('stdout', data)
      const stderr = (data: Buffer): void => output.write('stderr', data)
      child.stdout?.on('data', stdout)
      child.stderr?.on('data', stderr)
      if (stdin) {
        child.stdin?.on('error', () => {})
        child.stdin?.end(command)
      }
      if (active.size === 0) process.once('exit', killActive)
      if (child.pid) active.add(child.pid)
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = (): void => { if (child.pid) killTree(child.pid) }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      if (timeout !== undefined) timer = setTimeout(() => { timedOut = true; abort() }, timeout * 1000)
      try {
        const exitCode = await waitForExit(child)
        if (signal?.aborted) throw new Error('aborted')
        if (timedOut) throw new Error(`timeout:${timeout}`)
        return { exitCode }
      } finally {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        child.stdout?.removeListener('data', stdout)
        child.stderr?.removeListener('data', stderr)
        if (child.pid) active.delete(child.pid)
        if (active.size === 0) process.removeListener('exit', killActive)
        output.finish()
      }
    },
  }
}
