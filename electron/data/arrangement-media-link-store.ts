import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { diagnoseJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, assertSafeId, type TaskOwnerScope } from './scope-path'
import { WriteChain } from './write-chain'
import { arrangementMediaLinkSchema, assertArrangementMediaLinkUpdate, type ArrangementMediaLink, type ArrangementMediaLinkStorePort } from '../domain/arrangement-media'

const writes = new WriteChain()
const identity = (link: ArrangementMediaLink): string => link.kind + ':' + link.jobId

export class ArrangementMediaLinkPersistenceError extends Error {
  constructor() {
    super('Arrangement media index is unavailable; existing evidence has been preserved.')
    this.name = 'ArrangementMediaLinkPersistenceError'
  }
}

function parseLinks(value: unknown, scope: TaskOwnerScope, taskId: string): ArrangementMediaLink[] | null {
  if (!Array.isArray(value)) return null
  const links: ArrangementMediaLink[] = []
  const identities = new Set<string>()
  for (const candidate of value) {
    const parsed = arrangementMediaLinkSchema.safeParse(candidate)
    if (!parsed.success || parsed.data.taskId !== taskId || parsed.data.owner.memberId !== scope.memberId || parsed.data.owner.enterpriseId !== scope.enterpriseId) return null
    const key = identity(parsed.data)
    if (identities.has(key)) return null
    identities.add(key)
    links.push(parsed.data)
  }
  return links
}

export class ArrangementMediaLinkStore implements ArrangementMediaLinkStorePort {
  private readonly paths: ScopePath

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
  }

  async list(scope: TaskOwnerScope, taskId: string): Promise<ArrangementMediaLink[]> {
    const read = await diagnoseJsonWithBackup(this.paths.arrangementMediaLinksFile(scope, taskId), value => parseLinks(value, scope, taskId))
    if (read.state === 'unavailable') throw new ArrangementMediaLinkPersistenceError()
    return read.state === 'found' ? read.value : []
  }

  async get(scope: TaskOwnerScope, taskId: string, kind: ArrangementMediaLink['kind'], jobId: string): Promise<ArrangementMediaLink | null> {
    assertSafeId(jobId, 'jobId')
    const links = await this.list(scope, taskId)
    return links.find(link => link.kind === kind && link.jobId === jobId) ?? null
  }

  async upsert(scope: TaskOwnerScope, link: ArrangementMediaLink): Promise<ArrangementMediaLink> {
    const candidate = arrangementMediaLinkSchema.parse(link)
    if (candidate.owner.memberId !== scope.memberId || candidate.owner.enterpriseId !== scope.enterpriseId) throw new Error('Media link owner scope mismatch.')
    const file = resolve(this.paths.arrangementMediaLinksFile(scope, candidate.taskId))
    return writes.run(process.platform === 'win32' ? file.toLowerCase() : file, async () => {
      const current = await this.list(scope, candidate.taskId)
      const key = identity(candidate)
      const previous = current.find(item => identity(item) === key)
      if (previous) {
        assertArrangementMediaLinkUpdate(previous, candidate)
        if (isDeepStrictEqual(previous, candidate)) return structuredClone(previous)
      }
      const next = [...current.filter(item => identity(item) !== key), structuredClone(candidate)]
      next.sort((left, right) => left.createdAt - right.createdAt || left.nodeRunId.localeCompare(right.nodeRunId))
      await writeJsonAtomic(this.paths.arrangementMediaLinksFile(scope, candidate.taskId), next)
      return structuredClone(candidate)
    })
  }
}
