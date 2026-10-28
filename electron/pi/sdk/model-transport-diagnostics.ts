import { redactModelTraceText, redactText } from '../../common/redact'

interface TransportErrorDetail {
  name: string
  message: string
  code?: string
}

export interface ModelTransportFailure {
  transportPhase: 'connect' | 'response-body'
  errorName: string
  errorMessage: string
  errorCode?: string
  causes: TransportErrorDetail[]
  providerStatus?: number
  platformRequestId?: string
  elapsedMs: number
  bytesReceived: number
  firstByteMs?: number
  lastDataAgeMs?: number
  signalAborted: boolean
}

interface TransportDependencies {
  fetch?: typeof globalThis.fetch
  now?: () => number
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : undefined
}

function errorDetail(error: unknown): TransportErrorDetail {
  return {
    name: error instanceof Error ? safeIdentifier(error.name) ?? 'Error' : 'UnknownError',
    message: redactText(redactModelTraceText(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown transport error'), 512),
    ...(error instanceof Error && 'code' in error && safeIdentifier(error.code) ? { code: safeIdentifier(error.code) } : {}),
  }
}

/** Observe bytes before Pi reduces transport errors to text, without buffering or retrying. */
export async function fetchWithModelDiagnostics(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit,
  onFailure: (failure: ModelTransportFailure) => void | Promise<void>,
  dependencies: TransportDependencies = {},
): Promise<Response> {
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
  let bytesReceived = 0
  let firstByteAt: number | undefined
  let lastByteAt: number | undefined
  const report = (error: unknown, transportPhase: ModelTransportFailure['transportPhase'], response?: Response): void => {
    // Even a failed diagnostic sink must leave the original transport error unchanged.
    try {
      const detail = errorDetail(error)
      const causes: TransportErrorDetail[] = []
      const seen = new Set<unknown>([error])
      let current = error
      while (current instanceof Error && 'cause' in current && current.cause !== undefined && causes.length < 3) {
        current = current.cause
        if (seen.has(current)) break
        seen.add(current)
        causes.push(errorDetail(current))
      }
      const failedAt = now()
      const failure: ModelTransportFailure = {
        transportPhase, errorName: detail.name, errorMessage: detail.message,
        ...(detail.code ? { errorCode: detail.code } : {}), causes,
        ...(response ? { providerStatus: response.status, platformRequestId: safeIdentifier(response.headers.get('x-request-id')) } : {}),
        elapsedMs: Math.max(0, failedAt - startedAt), bytesReceived,
        ...(firstByteAt !== undefined ? { firstByteMs: Math.max(0, firstByteAt - startedAt) } : {}),
        ...(lastByteAt !== undefined ? { lastDataAgeMs: Math.max(0, failedAt - lastByteAt) } : {}),
        signalAborted: signal?.aborted ?? false,
      }
      void Promise.resolve(onFailure(failure)).catch(() => {})
    } catch { /* Diagnostic extraction and logging are best-effort, never business failures. */ }
  }

  let response: Response
  try { response = await (dependencies.fetch ?? globalThis.fetch)(input, init) }
  catch (error) { report(error, 'connect'); throw error }
  if (!response.body) return response

  const reader = response.body.getReader()
  let finished = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (finished) return
        if (done) {
          finished = true
          controller.close()
          reader.releaseLock()
          return
        }
        if (value.byteLength > 0) {
          const receivedAt = now()
          firstByteAt ??= receivedAt
          lastByteAt = receivedAt
          bytesReceived += value.byteLength
        }
        controller.enqueue(value)
      } catch (error) {
        if (finished) return
        finished = true
        report(error, 'response-body', response)
        controller.error(error)
        reader.releaseLock()
      }
    },
    async cancel(reason) {
      finished = true
      try { await reader.cancel(reason) }
      finally { reader.releaseLock() }
    },
  }, { highWaterMark: 0 })
  const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  Object.defineProperties(observed, {
    url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
  })
  return observed
}
