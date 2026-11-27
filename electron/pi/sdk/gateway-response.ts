import { createParser } from 'eventsource-parser'
import { readApiDiagnostic, safeApiDiagnostic } from '../../common/platform/api-diagnostic'
import type { ApiDiagnostic } from '../../../src/shared/api-diagnostic'
import { RUNTIME_FAILURE_MESSAGES } from '../../../src/shared/runtime-feedback'
import { gatewayFailureMessage, gatewaySdkErrorBody } from '../../errors/gateway-response-error'

export interface GatewayResponseFailure {
  kind: 'http' | 'sse' | 'incomplete'
  diagnostic: ApiDiagnostic
}

/** Keep gateway evidence before the SDK flattens errors, and never forward a failed stream's DONE. */
export async function guardGatewayResponse(response: Response, options: {
  secrets?: readonly string[]
  signal?: AbortSignal | null
  onFailure: (failure: GatewayResponseFailure) => void
}): Promise<Response> {
  const report = (kind: GatewayResponseFailure['kind'], diagnostic: ApiDiagnostic): void => {
    try { options.onFailure({ kind, diagnostic }) } catch { /* Diagnostic observers do not own the stream. */ }
  }
  if (!response.ok) {
    const diagnostic = await readApiDiagnostic(response, 'gateway.chat', { secrets: options.secrets, signal: options.signal ?? undefined })
    report('http', diagnostic)
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    headers.set('content-type', 'application/json')
    return new Response(JSON.stringify(gatewaySdkErrorBody(diagnostic)), {
      status: response.status, statusText: response.statusText, headers,
    })
  }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream' || !response.body) {
    const diagnostic = await readApiDiagnostic(response, 'gateway.chat', { secrets: options.secrets, signal: options.signal ?? undefined })
    report('incomplete', diagnostic)
    return new Response(new ReadableStream({ start(controller) {
      controller.error(new Error(RUNTIME_FAILURE_MESSAGES.MODEL_RESPONSE_INTERRUPTED))
    } }), { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const queue: string[] = []
  let complete = false
  let ended = false
  let failure: Error | undefined
  let failedFrame: string | undefined
  let failedValue: unknown
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const parser = createParser({
    maxBufferSize: 1024 * 1024,
    onError(error) {
      if (error.type === 'max-buffer-size-exceeded') {
        failure ??= new Error(RUNTIME_FAILURE_MESSAGES.MODEL_RESPONSE_INTERRUPTED)
      }
    },
    onEvent(event) {
      if (failure || failedFrame !== undefined) return
      let value: unknown
      try { value = JSON.parse(event.data) } catch { /* Named error events may contain plain text. */ }
      const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      if (['error', 'response.failed', 'response.error'].includes(event.event ?? '')
        || ['error', 'response.failed', 'response.error'].includes(String(item.type)) || item.error != null) {
        failedFrame = event.data
        failedValue = item
        complete = false
        return
      }
      if (event.data.trim() === '[DONE]') { complete = true; return }
      // The SDK consumes OpenAI data events. Reframing also separates an error from
      // preceding text in the same network chunk so that partial text is retained.
      queue.push(`data: ${event.data.replace(/\n/g, '\ndata: ')}\n\n`)
    },
  })
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!queue.length && !failure && !complete && !ended) {
          options.signal?.throwIfAborted()
          const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
            const abort = () => { cleanup(); reject(options.signal?.reason) }
            const cleanup = () => options.signal?.removeEventListener('abort', abort)
            options.signal?.addEventListener('abort', abort, { once: true })
            if (options.signal?.aborted) { abort(); return }
            void reader.read().then(result => { cleanup(); resolve(result) }, error => { cleanup(); reject(error) })
          })
          if (released) return
          if (part.done) {
            ended = true
            parser.feed(decoder.decode())
            if (!complete && failedFrame === undefined) failure = new Error(RUNTIME_FAILURE_MESSAGES.MODEL_RESPONSE_INTERRUPTED)
          } else parser.feed(decoder.decode(part.value, { stream: true }))
          if (failedFrame !== undefined) {
            const item = failedValue as Record<string, unknown>
            const nested = item.response && typeof item.response === 'object' ? item.response as Record<string, unknown> : {}
            const data = nested.error ? JSON.stringify({ body: failedValue, error: nested.error }) : failedFrame
            const diagnostic = await readApiDiagnostic(new Response(data, { headers: response.headers }), 'gateway.chat', { secrets: options.secrets })
            diagnostic.httpStatus = response.status
            const rawError = item.error ?? nested.error
            const error = rawError && typeof rawError === 'object' ? rawError as Record<string, unknown> : {}
            if ([item.httpStatus, item.statusCode, error.status, error.statusCode, error.httpStatus].includes(429)
              || error.type === 'rate_limit_error' || item.type === 'rate_limit_error') {
              diagnostic.computeStatus = 429
              diagnostic.retryable ??= true
              const embedded = safeApiDiagnostic({ headers: item.diagnosticHeaders ?? error.headers })
              if (embedded?.headers) diagnostic.headers = { ...diagnostic.headers, ...embedded.headers }
            }
            report('sse', diagnostic)
            failure = new Error(`${diagnostic.computeStatus === 429 ? '429: ' : ''}${gatewayFailureMessage(diagnostic)}`)
          } else if (failure) {
            const diagnostic = await readApiDiagnostic(new Response(null, { headers: response.headers }), 'gateway.chat', { secrets: options.secrets })
            report('incomplete', { ...diagnostic, httpStatus: response.status, message: 'SSE ended without a complete response',
              readError: 'Unexpected SSE EOF or frame limit exceeded' })
          }
        }
        if (queue.length) { controller.enqueue(encoder.encode(queue.shift()!)); return }
        if (failure) throw failure
        if (complete) controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
        release()
      } catch (error) {
        if (released) return
        controller.error(error)
        release()
      }
    },
    cancel() { release() },
  }, { highWaterMark: 0 })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
