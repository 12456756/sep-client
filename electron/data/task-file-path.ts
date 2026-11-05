import { resolve } from 'node:path'

/** Compare lexical workspace locations without following links or granting file access. */
export function taskFileKey(workspace: string | null, file: string): string {
  return workspace ? resolve(workspace, file) : file
}

export function uniqueTaskFiles(workspace: string | null, files: readonly string[]): string[] {
  const seen = new Set<string>()
  return files.filter(file => {
    const key = taskFileKey(workspace, file)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
