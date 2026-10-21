import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { diagnoseJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { ScopePath, sanitizeWorkspaceDirectoryName, type TaskOwnerScope, type WorkspaceDirectoryNames } from './scope-path'
import { TaskPersistenceError } from './task-store'
import { WriteChain } from './write-chain'

const directorySegment = z.string().min(1).max(80).refine(value =>
  sanitizeWorkspaceDirectoryName(value, 'Directory') === value && !value.startsWith('.'),
)
const indexSchema = z.object({
  version: z.literal(1),
  enterprises: z.array(z.object({
    enterpriseId: z.string().min(1),
    directory: directorySegment,
    members: z.array(z.object({ memberId: z.string().min(1), directory: directorySegment })),
  })),
}).superRefine((index, ctx) => {
  const ids = new Set<string>()
  const directories = new Set<string>()
  for (const enterprise of index.enterprises) {
    if (ids.has(enterprise.enterpriseId) || directories.has(enterprise.directory.toLowerCase())) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate workspace enterprise' })
    }
    ids.add(enterprise.enterpriseId)
    directories.add(enterprise.directory.toLowerCase())
    const memberIds = new Set<string>()
    const memberDirectories = new Set<string>()
    for (const member of enterprise.members) {
      if (memberIds.has(member.memberId) || memberDirectories.has(member.directory.toLowerCase())) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate workspace member' })
      }
      memberIds.add(member.memberId)
      memberDirectories.add(member.directory.toLowerCase())
    }
  }
})

const writes = new WriteChain()

async function assertWorkspaceDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new TaskPersistenceError('Workspace directory associations point to an unsafe directory.')
  }
}

async function allocateName(parent: string, base: string, assigned: string[]): Promise<string> {
  const entries = await readdir(parent).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })
  const occupied = new Set([...assigned, ...entries].map(name => name.normalize('NFC').toLowerCase()))
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? '' : ` (${index})`
    const characters = Array.from(base)
    while (characters.join('').length + suffix.length > 80 || Buffer.byteLength(characters.join('') + suffix, 'utf8') > 160) {
      characters.pop()
    }
    const candidate = `${characters.join('').replace(/[. ]+$/g, '')}${suffix}`
    if (!occupied.has(candidate.toLowerCase())) return candidate
  }
}

/** Bind readable folders to stable IDs; names alone must never decide ownership. */
export class WorkspaceDirectoryStore {
  private readonly paths: ScopePath

  constructor(userDataDir: string) {
    this.paths = new ScopePath(userDataDir)
  }

  async resolve(scope: TaskOwnerScope, names?: WorkspaceDirectoryNames): Promise<WorkspaceDirectoryNames> {
    this.paths.scopeKey(scope)
    const file = this.paths.workspaceDirectoryIndexFile()
    return writes.run(file, async () => {
      await assertWorkspaceDirectory(this.paths.workspaceBaseRoot())
      const result = await diagnoseJsonWithBackup(file, value => {
        const parsed = indexSchema.safeParse(value)
        return parsed.success ? parsed.data : null
      })
      if (result.state === 'unavailable') throw new TaskPersistenceError('Workspace directory associations could not be read.')
      const index: z.infer<typeof indexSchema> = result.state === 'found' ? result.value : { version: 1, enterprises: [] }
      let changed = false
      let enterprise = index.enterprises.find(item => item.enterpriseId === scope.enterpriseId)
      if (!enterprise) {
        const directory = await allocateName(
          this.paths.workspaceBaseRoot(),
          sanitizeWorkspaceDirectoryName(names?.enterpriseName ?? '', 'Enterprise'),
          index.enterprises.map(item => item.directory),
        )
        enterprise = { enterpriseId: scope.enterpriseId, directory, members: [] }
        index.enterprises.push(enterprise)
        changed = true
      }
      await assertWorkspaceDirectory(join(this.paths.workspaceBaseRoot(), enterprise.directory))
      let member = enterprise.members.find(item => item.memberId === scope.memberId)
      if (!member) {
        const directory = await allocateName(
          join(this.paths.workspaceBaseRoot(), enterprise.directory),
          sanitizeWorkspaceDirectoryName(names?.memberName ?? '', 'User'),
          enterprise.members.map(item => item.directory),
        )
        member = { memberId: scope.memberId, directory }
        enterprise.members.push(member)
        changed = true
      }
      await assertWorkspaceDirectory(join(this.paths.workspaceBaseRoot(), enterprise.directory, member.directory))
      if (changed) await writeJsonAtomic(file, index)
      return { enterpriseName: enterprise.directory, memberName: member.directory }
    })
  }
}
