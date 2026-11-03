import { protocol } from 'electron'
import type { ResultFileService } from '../service/result-file-service'

export function registerResultFileScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'sep-result', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])
}

export function installResultFileProtocol(service: Pick<ResultFileService, 'handle'>): () => void {
  protocol.handle('sep-result', request => service.handle(request))
  return () => { protocol.unhandle('sep-result') }
}
