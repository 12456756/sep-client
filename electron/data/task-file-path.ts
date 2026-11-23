import { basename, resolve } from 'node:path'
import { resolveWorkspaceResult } from './workspace-result-path'

/** Compare lexical workspace locations without following links or granting file access. */
function taskFileKey(workspace: string | null, file: string): string {
  return workspace ? resolve(workspace, file) : file
}

export async function findTaskFileIndex(workspace: string | null, files: readonly string[], file: string): Promise<number> {
  const key = taskFileKey(workspace, file)
  const keys = files.map(item => taskFileKey(workspace, item))
  const index = keys.findIndex((candidate, position) => !!files[position] && candidate === key)
  if (index !== -1 || !workspace) return index

  // Filter by name first; distinct names in a large artifact scan need no filesystem lookup.
  const comparableName = (path: string) => process.platform === 'win32' ? basename(path).toLowerCase() : basename(path)
  const name = comparableName(key)
  const candidates = keys.flatMap((path, position) => files[position] && comparableName(path) === name ? [position] : [])
  if (!candidates.length) return -1
  const canonical = (path: string) => resolveWorkspaceResult(workspace, path).then(result => result.path, () => null)
  const location = await canonical(file)
  if (!location) return -1
  for (const candidate of candidates) {
    if (await canonical(files[candidate]!) === location) return candidate
  }
  return -1
}
