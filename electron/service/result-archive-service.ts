import { join } from 'node:path'
import type { ResultArchiveSettings } from '../../src/shared/result-files'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ResultArchiveStore } from '../data/result-archive-store'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'

export class ResultArchiveService {
  constructor(readonly store: ResultArchiveStore, private readonly scope: ScopeSource, private readonly documents: () => string,
    private readonly revision: () => number) {}

  assertOwner(owner: TaskOwnerScope): () => void {
    const revision = this.revision()
    const assert = () => {
      const current = requireScope(this.scope)
      if (current.enterpriseId !== owner.enterpriseId || current.memberId !== owner.memberId || revision !== this.revision()) throw new AppError('AUTH_REQUIRED')
    }
    assert()
    return assert
  }

  async settings(): Promise<ResultArchiveSettings> {
    const owner = requireScope(this.scope), assert = this.assertOwner(owner)
    const configured = (await this.store.settings(owner)).at(-1)
    const defaultPath = join(this.documents(), '元机AI', '生成文件')
    const path = configured?.root ?? defaultPath
    const available = await this.store.available(path)
    assert()
    return { mode: !configured ? 'off' : configured.system ? 'system' : 'custom', defaultPath, path, available }
  }

  async configure(select?: (state: ResultArchiveSettings) => Promise<string | null>): Promise<ResultArchiveSettings | null> {
    const owner = requireScope(this.scope), assert = this.assertOwner(owner)
    const state = await this.settings()
    const path = select ? await select(state) : state.defaultPath
    if (!path) return null
    assert()
    try { await this.store.configure(owner, path, !select, assert) }
    catch (cause) {
      if (cause instanceof AppError) throw cause
      throw new AppError('INVALID_ARGUMENT', { message: '无法使用此目录，请选择可写入的文件夹。', cause })
    }
    assert()
    return this.settings()
  }

  async open(launch: (path: string) => Promise<string>): Promise<void> {
    const assert = this.assertOwner(requireScope(this.scope))
    const state = await this.settings()
    assert()
    if (state.mode === 'off' || !state.available || await launch(state.path)) {
      throw new AppError('NOT_FOUND', { message: '保存位置不可用，请检查或重新选择文件夹。' })
    }
  }
}
