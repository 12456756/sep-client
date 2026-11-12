import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { isSensitiveModelTraceKey, redactModelTraceText } from '../common/redact'
import type { ConnectorCommandResult } from '../domain/connectors'

export interface ConnectorProcessOptions {
  binary: string
  directory: string
  environment: NodeJS.ProcessEnv
  cwd: string
  args: string[]
  signal: AbortSignal
  timeoutMs?: number
  onOutput?(text: string): void
}
export type ConnectorProcessRunner = (options: ConnectorProcessOptions) => Promise<ConnectorCommandResult>

function safeOutput(output: string, secrets: string[]): string {
  const redact = (text: string): string => secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), redactModelTraceText(text))
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value)
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      isSensitiveModelTraceKey(key) || /^(?:appsecret|webhooktoken)$/i.test(key.replace(/[-_]/g, '')) ? '[redacted]' : scrub(item)]))
    return value
  }
  try { return JSON.stringify(scrub(JSON.parse(output))) }
  catch { return redact(output) }
}

/** No shell, inherited connector identity, stdin prompts, or unbounded command output. */
export const runConnectorProcess: ConnectorProcessRunner = async options => {
  options.signal.throwIfAborted()
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  Object.assign(env, options.environment)
  const secrets = Object.entries(options.environment).flatMap(([key, value]) => /token|secret/i.test(key) && value ? [value] : [])
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary, options.args, { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let out = ''
    let err = ''
    let stopped = false
    let failure = false
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    const stop = (): void => { stopped = true; child.kill() }
    const timer = setTimeout(stop, options.timeoutMs ?? 90000)
    const capture = (chunk: Buffer, decoder: StringDecoder, stream: 'out' | 'err'): void => {
      if (Buffer.byteLength(output) + chunk.length > 1024 * 1024) { failure = true; stop(); return }
      const text = decoder.write(chunk)
      output += text
      if (stream === 'out') out += text
      else err += text
      try { options.onOutput?.(output) } catch { failure = true; stop() }
    }
    child.stdout.on('data', chunk => capture(chunk, stdout, 'out'))
    child.stderr.on('data', chunk => capture(chunk, stderr, 'err'))
    options.signal.addEventListener('abort', stop, { once: true })
    if (options.signal.aborted) stop()
    const cleanup = (): void => { clearTimeout(timer); options.signal.removeEventListener('abort', stop) }
    child.once('error', () => { cleanup(); reject(new Error('连接器运行组件不可用，请重新安装客户端。')) })
    child.once('close', code => {
      cleanup()
      if (stopped || failure) {
        resolve({ text: '连接器调用已中止或超时；执行结果尚未确认，请先查询状态，勿自动重试。', isError: true, executionUncertain: true })
      } else {
        const text = safeOutput(code === 0 ? out || err : err || out, secrets)
        resolve({ text: text.length > 128000 ? `${text.slice(0, 128000)}\n[truncated; narrow the query or page size]` : text, isError: code !== 0 })
      }
    })
  })
}
