import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConnectorId } from '../../src/shared/connectors'
import { ScopePath, type TaskOwnerScope } from './scope-path'

/** CLI scratch data never shares the host user's normal CLI configuration. */
export class ConnectorProcessDirectories {
  private readonly paths: ScopePath
  constructor(userDataDir: string, private readonly id: ConnectorId) { this.paths = new ScopePath(userDataDir) }
  async run<T>(scope: TaskOwnerScope, operation: (directory: string) => Promise<T>): Promise<T> {
    const root = join(this.paths.ownerRoot(scope), 'connectors', `${this.id}-runtime`)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(root, 'run-'))
    try { return await operation(directory) }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}
