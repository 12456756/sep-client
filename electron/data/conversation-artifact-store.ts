import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ConversationArtifactDirectory, ConversationArtifactStorePort } from '../domain/conversation-artifacts'

const MAX_DEPTH = 8
const MAX_FILES = 1000
const temporaryName = /(?:\.tmp|\.temp|\.part|\.partial|\.crdownload|~)$/i

export class ConversationArtifactStore implements ConversationArtifactStorePort {
  async prepare(workspace: string, taskId: string): Promise<ConversationArtifactDirectory> {
    const relativePath = `成果/${taskId}`
    if (!isSafeTaskId(taskId)) return { status: 'unsafe', relativePath }
    try {
      const root = await realpath(resolve(workspace))
      await ensureDirectory(root, ['成果', taskId], true)
      return { status: 'ready', relativePath }
    } catch (error) {
      return { status: isUnsafePath(error) ? 'unsafe' : 'retry-in-prompt', relativePath }
    }
  }

  async scan(workspace: string, taskId: string): Promise<string[]> {
    if (!isSafeTaskId(taskId)) throw new Error('UNSAFE_PATH')
    const root = await realpath(resolve(workspace))
    const artifactRoot = await ensureDirectory(root, ['成果', taskId], false)
    const files: string[] = []

    const visit = async (directory: string, segments: string[], depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (files.length >= MAX_FILES || temporaryName.test(entry.name)) continue
        const path = join(directory, entry.name)
        const info = await lstat(path)
        if (info.isSymbolicLink()) continue
        const actual = await realpath(path)
        assertContained(root, actual)
        if (info.isDirectory()) {
          await visit(actual, [...segments, entry.name], depth + 1)
        } else if (info.isFile()) {
          files.push([...segments, entry.name].join('/'))
        }
      }
    }

    await visit(artifactRoot, ['成果', taskId], 0)
    return files.sort((left, right) => left.localeCompare(right))
  }
}

async function ensureDirectory(root: string, segments: string[], create: boolean): Promise<string> {
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    try {
      await lstat(current)
    } catch (error) {
      if (!create || !isMissing(error)) throw error
      try { await mkdir(current) } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError
      }
    }
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('UNSAFE_PATH')
    const actual = await realpath(current)
    if (actual !== current) throw new Error('UNSAFE_PATH')
    assertContained(root, actual)
  }
  return current
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('UNSAFE_PATH')
}

function isSafeTaskId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
}

function isUnsafePath(error: unknown): boolean {
  return error instanceof Error && error.message === 'UNSAFE_PATH'
}
