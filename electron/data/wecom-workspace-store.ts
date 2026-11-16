import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ConnectorStore } from './connector-store'
import { ConnectorProcessDirectories } from './connector-process-directories'
import type { TaskOwnerScope } from './scope-path'
import { WriteChain } from './write-chain'

const recordSchema = z.object({
  revision: z.string(), connectedAt: z.number(),
  token: z.string().min(1).max(16384), botId: z.string().min(1).max(256),
})
export type WecomRecord = z.infer<typeof recordSchema>
export interface WecomDirectories { config: string; workspace: string }

/** Import only the CLI bearer credential into safeStorage; business calls cannot refresh/replay writes. */
export class WecomWorkspaceStore {
  private readonly directories: ConnectorProcessDirectories
  private readonly writes = new WriteChain()
  constructor(userDataDir: string, private readonly store: ConnectorStore) {
    this.directories = new ConnectorProcessDirectories(userDataDir, 'wecom')
  }
  async read(scope: TaskOwnerScope): Promise<WecomRecord | undefined> {
    const value = await this.store.read(scope)
    return value == null ? undefined : recordSchema.parse(value)
  }
  async clear(scope: TaskOwnerScope): Promise<void> {
    await this.writes.run(JSON.stringify(scope), () => this.store.write(scope, null))
  }
  async run<T>(scope: TaskOwnerScope, operation: (directories: WecomDirectories) => Promise<T>): Promise<T> {
    return this.directories.run(scope, async directory => {
      const config = join(directory, 'config')
      const workspace = join(directory, 'work')
      await mkdir(config, { mode: 0o700 })
      await mkdir(workspace, { mode: 0o700 })
      // The CLI loads dotenv from cwd and parents; stop lookup in our private directory.
      await writeFile(join(workspace, '.env'), '', { mode: 0o600 })
      return operation({ config, workspace })
    })
  }
  async authorize(scope: TaskOwnerScope, valid: () => boolean, operation: (directories: WecomDirectories) => Promise<void>): Promise<WecomRecord> {
    return this.writes.run(JSON.stringify(scope), () => this.run(scope, async directories => {
      if (!valid()) throw new Error('WeCom authorization cancelled.')
      await this.store.write(scope, null)
      // 1.3.4 reads this key before keyring; it also writes a keyring entry namespaced by this unique path.
      await writeFile(join(directories.config, '.encryption_key'), randomBytes(32).toString('base64'), { mode: 0o600 })
      await operation(directories)
      if (!valid()) throw new Error('WeCom authorization cancelled.')
      const key = Buffer.from(await readFile(join(directories.config, '.encryption_key'), 'utf8'), 'base64')
      const encrypted = await readFile(join(directories.config, 'credentials.enc'))
      if (key.length !== 32 || encrypted.length < 28 || encrypted.length > 65536) throw new Error('Invalid WeCom credential file.')
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
      decipher.setAuthTag(encrypted.subarray(-16))
      const plaintext = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()])
      const credential = z.object({ token: z.string().min(1).max(16384), bot: z.object({ id: z.string().min(1).max(256) }) }).parse(JSON.parse(plaintext.toString('utf8')))
      const record: WecomRecord = { revision: randomUUID(), connectedAt: Date.now(), token: credential.token, botId: credential.bot.id }
      if (!valid()) throw new Error('WeCom authorization cancelled.')
      await this.store.write(scope, record)
      if (!valid()) { await this.store.write(scope, null); throw new Error('WeCom authorization cancelled.') }
      return record
    }))
  }
}
