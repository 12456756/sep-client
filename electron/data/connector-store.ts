import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ConnectorId } from '../../src/shared/connectors'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { writeJsonAtomic } from './atomic-file'

export interface ConnectorEncryption {
  available(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}
export class ConnectorStore {
  private readonly paths: ScopePath
  constructor(userDataDir: string, private readonly encryption: ConnectorEncryption, private readonly name: ConnectorId | `${ConnectorId}-workspace` = 'dingtalk') { this.paths = new ScopePath(userDataDir) }
  async read(scope: TaskOwnerScope): Promise<unknown> {
    if (!this.encryption.available()) throw new Error('Secure connector storage unavailable.')
    try {
      const envelope = z.object({ version: z.literal(1), encrypted: z.string() }).parse(JSON.parse(await readFile(this.path(scope), 'utf8')))
      return JSON.parse(this.encryption.decrypt(envelope.encrypted))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Cannot read secure connector storage.')
    }
  }
  async write(scope: TaskOwnerScope, value: unknown): Promise<void> {
    if (!this.encryption.available()) throw new Error('Secure connector storage unavailable.')
    await writeJsonAtomic(this.path(scope), { version: 1, encrypted: this.encryption.encrypt(JSON.stringify(value)) }, { backup: false, durable: true })
  }
  private path(scope: TaskOwnerScope): string { return join(this.paths.ownerRoot(scope), 'connectors', `${this.name}.json`) }
}
