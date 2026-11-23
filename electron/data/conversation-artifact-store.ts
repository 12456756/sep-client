import { mkdir, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { ConversationArtifactDirectory, ConversationArtifactStorePort } from '../domain/conversation-artifacts'
import { ResultFilePathError } from '../errors/result-file-path-error'
import { resolveUnlinkedChild } from './workspace-result-path'

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

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (files.length >= MAX_FILES || temporaryName.test(entry.name)) continue
        if (!entry.isDirectory() && !entry.isFile()) continue
        const resolved = await resolveUnlinkedChild(directory, entry.name, entry.isDirectory() ? 'directory' : 'file').catch(error => {
          if (isMissing(error) || error instanceof ResultFilePathError) return null
          throw error
        })
        if (!resolved) continue
        if (entry.isDirectory()) await visit(resolved.path, depth + 1)
        else files.push(relative(root, resolved.path).split(sep).join('/'))
      }
    }

    await visit(artifactRoot, 0)
    return files.sort((left, right) => left.localeCompare(right))
  }
}

async function ensureDirectory(root: string, segments: string[], create: boolean): Promise<string> {
  let current = root
  for (const segment of segments) {
    try {
      current = (await resolveUnlinkedChild(current, segment, 'directory')).path
    } catch (error) {
      if (error instanceof ResultFilePathError) throw new Error('UNSAFE_PATH', { cause: error })
      if (!create || !isMissing(error)) throw error
      try { await mkdir(join(current, segment)) } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError
      }
      try { current = (await resolveUnlinkedChild(current, segment, 'directory')).path }
      catch (recheck) {
        if (recheck instanceof ResultFilePathError) throw new Error('UNSAFE_PATH', { cause: recheck })
        throw recheck
      }
    }
  }
  return current
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
