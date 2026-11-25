import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { boundOriginal, managedFilePath } from '../../../pi-extension/guard'
import { ORIGINAL_DOCUMENT_REPLACE_TOOL } from '../../../src/shared/python-tool'
import { redactText } from '../../common/redact'
import { resolveUnlinkedChild } from '../../data/workspace-result-path'
import { prepareDocumentBytes, supportsOriginalDocument } from '../../runtime/original-document-formats'
import { inspectPythonFile, PYTHON_FILE_LIMIT } from '../../runtime/python-runtime'
import type { PiAgentSessionConfig } from './pi-agent-runtime'

const writing = new Set<string>()
const backupDirectory = '原件备份'

export function canReplaceOriginalDocument(config: PiAgentSessionConfig): boolean {
  const policy = config.toolPolicy
  return !!policy?.fileAccess && !policy.unattended && policy.preset !== 'read-only' &&
    policy.allowedTools.includes('read') && policy.allowedTools.includes('write') &&
    [...(policy.originalFiles?.values() ?? [])].some(file => supportsOriginalDocument(extname(file.path).toLowerCase()))
}

export async function prepareOriginalDocument(config: PiAgentSessionConfig, alias: string, guestName: string, signal?: AbortSignal) {
  if (!canReplaceOriginalDocument(config) || !alias.startsWith('@original/')) throw new Error('Select or drop the original document into this conversation first.')
  signal?.throwIfAborted()
  const policy = config.toolPolicy!
  const original = boundOriginal(alias, policy)
  const extension = original && extname(original.path).toLowerCase()
  if (!original || !extension || !supportsOriginalDocument(extension) || extname(guestName).toLowerCase() !== extension) {
    throw new Error('A matching, supported attachment original is required (.docx, .xlsx, .pptx, .pdf).')
  }
  const path = original.path, folder = dirname(path)
  const snapshot = await inspectPythonFile(path, PYTHON_FILE_LIMIT)
  const identity = `${snapshot.info.dev}:${snapshot.info.ino}:${snapshot.info.birthtimeNs}`
  if (identity !== original.identity) throw new Error('The attachment original changed. Select it again.')
  const prepared = await prepareDocumentBytes(snapshot.bytes, extension, signal)
  if (prepared.length > PYTHON_FILE_LIMIT) throw new Error('The expanded document exceeds the sandbox input limit.')

  const verifyUnchanged = async () => {
    signal?.throwIfAborted()
    if (boundOriginal(alias, policy)?.path !== path || await realpath(folder) !== folder) throw new Error('The original document path changed.')
    const current = await inspectPythonFile(path, PYTHON_FILE_LIMIT)
    const a = snapshot.info, b = current.info
    if (a.dev !== b.dev || a.ino !== b.ino || a.birthtimeNs !== b.birthtimeNs || a.mtimeNs !== b.mtimeNs ||
        a.ctimeNs !== b.ctimeNs || !snapshot.bytes.equals(current.bytes)) throw new Error('The original document changed; prepare the edit again.')
  }

  return {
    bytes: Buffer.from(prepared),
    async replace(output: Buffer, purpose: string): Promise<string> {
      const bytes = Buffer.from(output)
      if (!bytes.length || bytes.length > PYTHON_FILE_LIMIT) throw new Error('The replacement document exceeds the supported size or is empty.')
      await verifyUnchanged()
      if (snapshot.bytes.equals(bytes) || (await prepareDocumentBytes(bytes, extension, signal)).equals(prepared)) {
        return 'The document did not change. The original was not replaced.'
      }
      const id = randomUUID()
      const temporary = join(folder, `.csep-edit-${id}.tmp`)
      const workspace = await realpath(config.workspaceDir)
      const backupFolder = join(workspace, backupDirectory)
      const backup = join(backupFolder, `csep-backup-${id}${extension}`)
      const workspacePolicy = { ...policy, fileAccess: 'workspace' as const }
      const verifyBackupPath = async () => {
        if (await realpath(config.workspaceDir) !== workspace || managedFilePath(backup, workspacePolicy, true) !== backup) {
          throw new Error('The workspace backup location is unavailable. The original was not replaced.')
        }
      }
      await verifyBackupPath()
      signal?.throwIfAborted()
      if (!await config.authorizeTool({ toolName: ORIGINAL_DOCUMENT_REPLACE_TOOL, input: {
        path, backup, purpose: redactText(purpose), beforeBytes: snapshot.bytes.length, afterBytes: bytes.length,
      } })) throw new Error('Document replacement was not approved. The original was not changed.')

      const key = process.platform === 'win32' ? path.toLowerCase() : path
      if (writing.has(key)) throw new Error('Another change is being saved. Prepare the edit again.')
      writing.add(key)
      let staged = false, backedUp = false, published = false
      try {
        await verifyUnchanged()
        await verifyBackupPath()
        await mkdir(backupFolder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
        await resolveUnlinkedChild(workspace, backupDirectory, 'directory')
        const write = async (file: string, content: Buffer, markCreated: () => void, preserveMode = false) => {
          signal?.throwIfAborted()
          const handle = await open(file, 'wx', 0o600)
          markCreated()
          try {
            await handle.writeFile(content)
            if (preserveMode) await handle.chmod(Number(snapshot.info.mode & 0o777n))
            await handle.sync()
            return await handle.stat({ bigint: true })
          } finally { await handle.close() }
        }
        const replacement = await write(temporary, bytes, () => { staged = true }, true)
        await verifyBackupPath()
        await write(backup, snapshot.bytes, () => { backedUp = true })
        await verifyBackupPath()
        await verifyUnchanged()
        signal?.throwIfAborted()
        await rename(temporary, path)
        published = true
        const result = `Original document replaced: ${basename(path)}. Backup saved in the task workspace: ${backup}. Reattach the original before editing it again.`
        if (config.registerWrittenFile) {
          try {
            if (managedFilePath(path, workspacePolicy, true)) await config.registerWrittenFile(path)
            else await config.registerWrittenFile(path, {
              identity: `${replacement.dev}:${replacement.ino}:${replacement.birthtimeNs}`,
              size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
            })
          } catch {
            return `${result} The file was saved, but could not be added to the task results. Do not repeat the replacement.`
          }
        }
        return result
      } finally {
        // Do not follow a renamed or replaced parent directory during cleanup.
        if (!published && staged && await realpath(folder).catch(() => '') === folder) await unlink(temporary).catch(() => undefined)
        if (!published && backedUp && await realpath(backupFolder).catch(() => '') === backupFolder) await unlink(backup).catch(() => undefined)
        writing.delete(key)
      }
    },
  }
}
