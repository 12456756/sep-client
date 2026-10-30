import { setTimeout as delay } from 'node:timers/promises'

const TRANSIENT = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETXTBSY', 'EIO', 'FILE_CHANGED', 'MEDIA_WRITE_FAILED'])

/** Retries local I/O only, never generation, authorization or validation failures. */
export async function retryFileOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try { return await operation() }
    catch (error) {
      signal.throwIfAborted()
      const code = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : undefined
      if (attempt >= 2 || typeof code !== 'string' || !TRANSIENT.has(code)) throw error
      await delay(100 * 2 ** attempt, undefined, { signal })
    }
  }
}
