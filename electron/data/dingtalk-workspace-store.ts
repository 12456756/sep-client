import { mkdir, mkdtemp, readdir, readFile, writeFile, rm, lstat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import type { ConnectorStore } from './connector-store'
import { ScopePath, type TaskOwnerScope } from './scope-path'
import { WriteChain } from './write-chain'

const snapshotSchema = z.object({
  revision: z.string(), connectedAt: z.number(),
  files: z.record(z.string(), z.string()),
})
export type DingTalkSnapshot = z.infer<typeof snapshotSchema>

/** DWS sees a private directory only while running; credentials at rest use safeStorage. */
export class DingTalkWorkspaceStore {
  private readonly paths: ScopePath
  private readonly writes = new WriteChain()
  constructor(userDataDir: string, private readonly store: ConnectorStore) { this.paths = new ScopePath(userDataDir) }
  async read(scope: TaskOwnerScope): Promise<DingTalkSnapshot | undefined> {
    const value = await this.store.read(scope)
    return value == null ? undefined : snapshotSchema.parse(value)
  }
  async clear(scope: TaskOwnerScope): Promise<void> {
    await this.writes.run(this.paths.scopeKey(scope), () => this.store.write(scope, null))
  }
  async run<T>(scope: TaskOwnerScope, valid: () => boolean, operation: (directory: string, snapshot: DingTalkSnapshot | undefined, keychainDirectory: string) => Promise<{ result: T; identity?: { revision: string; connectedAt: number } }>): Promise<T> {
    return this.writes.run(this.paths.scopeKey(scope), async () => {
      if (!valid()) throw new Error('DingTalk connection changed.')
      const snapshot = await this.read(scope)
      const root = join(this.paths.ownerRoot(scope), 'connectors', 'dws-runtime')
      await rm(root, { recursive: true, force: true })
      await mkdir(root, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(root, 'run-'))
      try {
        for (const [name, content] of Object.entries(snapshot?.files ?? {})) {
          if (!safeName(name)) throw new Error('Invalid DingTalk credential snapshot.')
          const target = join(directory, name)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await writeFile(target, Buffer.from(content, 'base64'), { mode: 0o600 })
        }
        if (!valid()) throw new Error('DingTalk connection changed.')
        const keychainDirectory = process.platform === 'win32' ? join(this.paths.ownerRoot(scope), 'connectors', 'dws-keychain') : join(directory, 'keychain')
        const { result, identity = snapshot } = await operation(directory, snapshot, keychainDirectory)
        if (!valid()) throw new Error('DingTalk connection changed.')
        if (identity) {
          const files: Record<string, string> = {}
          let size = 0
          const visit = async (parent: string): Promise<void> => {
            for (const entry of await readdir(join(directory, parent), { withFileTypes: true })) {
              const name = parent ? `${parent}/${entry.name}` : entry.name
              if (!safeName(name) || ['logs', 'cache'].includes(name.split('/')[0]) || entry.name.endsWith('.lock')) continue
              if (entry.isSymbolicLink()) throw new Error('Unsafe DingTalk credential file.')
              if (entry.isDirectory()) await visit(name)
              else if (entry.isFile()) {
                const stat = await lstat(join(directory, name))
                size += stat.size
                if (size > 8 * 1024 * 1024 || Object.keys(files).length >= 256) throw new Error('DingTalk credential snapshot is too large.')
                files[name] = (await readFile(join(directory, name))).toString('base64')
              }
            }
          }
          await visit('')
          if (!valid()) throw new Error('DingTalk connection changed.')
          await this.store.write(scope, { revision: identity.revision, connectedAt: identity.connectedAt, files })
          if (!valid()) await this.store.write(scope, null)
        }
        return result
      } finally {
        // Never leave decrypted credentials behind after a completed invocation.
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
}

function safeName(name: string): boolean {
  return name.length > 0 && name.length < 512 && name.split('/').every(part => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..')
}
