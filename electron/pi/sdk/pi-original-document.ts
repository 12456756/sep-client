import { randomUUID } from 'node:crypto'
import { open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { boundOriginal } from '../../../pi-extension/guard'
import { ORIGINAL_DOCUMENT_REPLACE_TOOL } from '../../../src/shared/python-tool'
import { redactText } from '../../common/redact'
import { prepareDocumentBytes, supportsOriginalDocument } from '../../runtime/original-document-formats'
import { inspectPythonFile, PYTHON_FILE_LIMIT } from '../../runtime/python-runtime'
import type { PiAgentSessionConfig } from './pi-agent-runtime'

const writing = new Set<string>()

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
      const backup = join(folder, `csep-backup-${id}${extension}`)
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
        const write = async (file: string, content: Buffer, markCreated: () => void, preserveMode = false) => {
          signal?.throwIfAborted()
          const handle = await open(file, 'wx', 0o600)
          markCreated()
          try {
            await handle.writeFile(content)
            if (preserveMode) await handle.chmod(Number(snapshot.info.mode & 0o777n))
            await handle.sync()
          } finally { await handle.close() }
        }
        await write(temporary, bytes, () => { staged = true }, true)
        await write(backup, snapshot.bytes, () => { backedUp = true })
        await verifyUnchanged()
        signal?.throwIfAborted()
        await rename(temporary, path)
        published = true
        return `Original document replaced: ${basename(path)}. Backup saved next to it: ${basename(backup)}. Reattach the original before editing it again.`
      } finally {
        // Do not follow a renamed or replaced parent directory during cleanup.
        if (!published && await realpath(folder).catch(() => '') === folder) {
          if (staged) await unlink(temporary).catch(() => undefined)
          if (backedUp) await unlink(backup).catch(() => undefined)
        }
        writing.delete(key)
      }
    },
  }
}
