import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import type { TaskReadView } from '../../src/shared/types'
import { ResultFilePathError, resultFileSystemError } from '../errors/result-file-path-error'
import type { TaskOwnerScope } from './scope-path'
import { resolveUnlinkedChild, resolveUnlinkedDirectory, resolveWorkspaceResult } from './workspace-result-path'

export async function resolveConversationResult(scope: TaskOwnerScope, task: TaskReadView, fileId: string) {
  if (task.ownerId !== scope.memberId || task.ownerEnterpriseId !== scope.enterpriseId ||
    task.workType.state !== 'resolved' || task.workType.kind !== 'conversation') return null
  const name = task.files.find((_file, index) => `${task.id}-file-${index}` === fileId)
  if (!name) return null
  const receipt = task.externalFileReceipts && Object.hasOwn(task.externalFileReceipts, name) ? task.externalFileReceipts[name] : undefined
  if (!receipt) return task.workDir ? { ...await resolveWorkspaceResult(task.workDir, name), name, external: false as const } : null
  if (!isAbsolute(name)) throw new ResultFilePathError('invalidPath')

  const identity = (info: { dev: bigint; ino: bigint; birthtimeNs: bigint }) => `${info.dev}:${info.ino}:${info.birthtimeNs}`
  const matches = (info: BigIntStats) => info.isFile() && info.nlink === 1n && info.ino !== 0n &&
    info.size === BigInt(receipt.size) && identity(info) === receipt.identity
  const stat = (path: string) => lstat(path, { bigint: true })
  const locate = async () => {
    const root = await resolveUnlinkedDirectory(dirname(name))
    const { path } = await resolveUnlinkedChild(root, basename(name), 'file')
    if (path !== name || !matches(await stat(path))) throw new ResultFilePathError('changed')
    return { root, path }
  }
  try {
    const source = await locate()
    const handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const before = await handle.stat({ bigint: true })
      if (!matches(before)) throw new ResultFilePathError('changed')
      const buffer = Buffer.alloc(receipt.size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      const bytes = buffer.subarray(0, length)
      const after = await handle.stat({ bigint: true })
      if (!matches(after) || length !== receipt.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) throw new ResultFilePathError('changed')
      await locate()
      return { ...source, name, bytes, receipt, external: true as const }
    } finally { await handle.close() }
  } catch (error) {
    throw resultFileSystemError(error) ?? error
  }
}
