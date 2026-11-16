import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import type { ConnectorDependency } from '../domain/connector-dependencies'
import { WriteChain } from './write-chain'

const writes = new WriteChain()
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export class ConnectorAssetStore {
  readonly directory: string
  constructor(userDataDir: string, readonly component: ConnectorDependency) {
    this.directory = join(userDataDir, 'connector-runtime', component.id, component.sha256)
  }
  path(name: string): string {
    if (!this.component.files.some(file => file.name === name)) throw new Error('Unknown connector file')
    return join(this.directory, name)
  }
  async ready(): Promise<boolean> {
    try {
      if (!(await lstat(this.directory)).isDirectory() || (await lstat(this.directory)).isSymbolicLink()) return false
      for (const file of this.component.files) {
        const path = this.path(file.name)
        const metadata = await lstat(path)
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.bytes || hash(await readFile(path)) !== file.sha256) return false
        if (process.platform !== 'win32' && file.name === this.component.binary) {
          try { await access(path, constants.X_OK) } catch { return false }
        }
      }
      return true
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
      throw error
    }
  }
  async install(archive: Uint8Array, signal: AbortSignal): Promise<void> {
    if (archive.length !== this.component.bytes || hash(archive) !== this.component.sha256) throw new Error('Connector archive checksum mismatch')
    // Only the manifest's flat regular files are materialized, with bounded expansion.
    const expected = new Map(this.component.files.map(file => [file.name, file]))
    const seen = new Set<string>()
    const contents = unzipSync(archive, { filter: entry => {
      const file = expected.get(entry.name)
      if (!file || seen.has(entry.name) || entry.originalSize !== file.bytes) throw new Error('Unexpected connector archive entry')
      seen.add(entry.name)
      return true
    } })
    for (const file of this.component.files) {
      const bytes = contents[file.name]
      if (!bytes || bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Connector file checksum mismatch')
    }
    await writes.run(this.directory, async () => {
      signal.throwIfAborted()
      if (await this.ready()) return
      const temporary = `${this.directory}.${randomUUID()}.tmp`
      const previous = `${this.directory}.${randomUUID()}.old`
      let moved = false
      await mkdir(temporary, { recursive: true, mode: 0o700 })
      try {
        for (const file of this.component.files) {
          const path = join(temporary, file.name)
          await writeFile(path, contents[file.name], { flag: 'wx', mode: file.name === this.component.binary ? 0o700 : 0o600 })
          if (file.name === this.component.binary) await chmod(path, 0o700)
        }
        signal.throwIfAborted()
        try { await rename(this.directory, previous); moved = true } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        try { await rename(temporary, this.directory) } catch (error) {
          if (moved) await rename(previous, this.directory)
          throw error
        }
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
      if (moved) await rm(previous, { recursive: true, force: true })
    })
  }
}
