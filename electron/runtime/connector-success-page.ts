import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { connectorOAuthSuccessPage, connectorOAuthSuccessPolicy } from './connector-oauth-page'

/** Serves only the existing success page, after credentials have been committed. */
export class ConnectorSuccessPage {
  private host = ''
  private readonly path = `/${randomUUID()}/success`
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    if (request.method !== 'GET' || request.headers.host !== this.host || request.url !== this.path || !this.valid()) {
      response.writeHead(404).end(); return
    }
    response.setHeader('Content-Security-Policy', connectorOAuthSuccessPolicy)
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(connectorOAuthSuccessPage)
  })
  private constructor(private readonly valid: () => boolean) {}
  static async start(valid: () => boolean): Promise<ConnectorSuccessPage> {
    const result = new ConnectorSuccessPage(valid)
    await new Promise<void>((resolve, reject) => { result.server.once('error', reject); result.server.listen(0, '127.0.0.1', resolve) })
    const address = result.server.address()
    if (!address || typeof address === 'string') { result.close(); throw new Error('Cannot start connector success page.') }
    result.host = `127.0.0.1:${address.port}`
    result.server.unref()
    result.timer = setTimeout(() => result.close(), 60000)
    result.timer.unref()
    return result
  }
  get url(): string { return `http://${this.host}${this.path}` }
  close(): void { clearTimeout(this.timer); this.server.close(); this.server.closeAllConnections() }
}
