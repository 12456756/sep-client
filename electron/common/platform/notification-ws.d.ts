/** Only the installed ws surface used by the notification transport; no new dependency. */
declare module 'ws' {
  import { EventEmitter } from 'node:events'

  export default class WebSocket extends EventEmitter {
    constructor(url: string, options?: { maxPayload?: number; followRedirects?: boolean })
    send(data: string): void
    terminate(): void
  }
}
