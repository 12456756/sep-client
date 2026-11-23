import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isSafeDeliveryPath } from '../domain/arrangement-plan'
import { ResultFilePathError, resultFileSystemError } from '../errors/result-file-path-error'

function inside(relativePath: string): boolean {
  return !!relativePath && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

/** Trust the configured workspace root, but reject links within its result paths. */
export async function resolveWorkspaceResult(workspace: string, file: string) {
  if (!workspace) throw new ResultFilePathError('workspaceUnavailable')
  const configured = resolve(workspace)
  let root: string
  try {
    root = await realpath(configured)
    if (!(await lstat(root)).isDirectory()) throw new ResultFilePathError('workspaceUnavailable')
  } catch (error) {
    if (error instanceof ResultFilePathError) throw error
    const mapped = resultFileSystemError(error)
    if (mapped?.reason === 'access') throw mapped
    throw new ResultFilePathError('workspaceUnavailable', error)
  }

  const declared = resolve(configured, file)
  const candidates = [relative(configured, declared), relative(root, declared)]
  if (candidates.includes('')) throw new ResultFilePathError('notFile')
  const suffix = candidates.find(inside)
  if (!suffix) throw new ResultFilePathError('outside')
  if (!isSafeDeliveryPath(suffix)) throw new ResultFilePathError('invalidPath')

  try {
    const parts = suffix.split(sep)
    let current = root
    for (const [index, part] of parts.entries()) {
      current = join(current, part)
      const entry = await lstat(current)
      if (entry.isSymbolicLink()) throw new ResultFilePathError('link')
      if (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile()) throw new ResultFilePathError('notFile')
    }
    const path = await realpath(current)
    // Both sides are canonical. Exact containment also respects case-sensitive directories on Windows.
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep) || path === root) throw new ResultFilePathError('outside')
    if (isAbsolute(file) && await realpath(declared) !== path) throw new ResultFilePathError('outside')
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new ResultFilePathError('link')
    if (!stat.isFile()) throw new ResultFilePathError('notFile')
    return { root, path, stat }
  } catch (error) {
    throw resultFileSystemError(error) ?? error
  }
}
