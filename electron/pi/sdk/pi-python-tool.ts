import { realpath, lstat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { z } from 'zod'
import { RUN_PYTHON_TOOL } from '../../../src/shared/python-tool'
import { redactText } from '../../common/redact'
import { externalFileCandidate, isManagedReadException, managedFilePath } from '../../../pi-extension/guard'
import { prepareOfficeInputBytes } from '../../runtime/original-document-formats'
import { PYTHON_CODE_LIMIT, PYTHON_FILE_LIMIT, PYTHON_TIMEOUT_SECONDS, pythonGuestFilename, readPythonFile, runPython } from '../../runtime/python-runtime'
import type { PiAgentSessionConfig } from './pi-agent-runtime'
import { managedFileTools } from './pi-managed-file-tools'
import { canReplaceOriginalDocument, prepareOriginalDocument } from './pi-original-document'

const purposeLimit = 240
const running = new Set<string>()
const maxInputs = 16
const filePath = z.string().min(1).max(1024)
const guestName = z.string().refine(pythonGuestFilename)
const inputSchema = z.object({
  purpose: z.string().trim().min(1).max(purposeLimit).refine(purpose =>
    Array.from(purpose).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)),
  code: z.string().min(1).max(PYTHON_CODE_LIMIT).refine(code => !code.includes('\0') && Buffer.byteLength(code) <= PYTHON_CODE_LIMIT),
  inputs: z.array(z.object({ path: filePath, name: guestName }).strict()).max(maxInputs).optional(),
  output: z.object({ name: guestName, path: filePath }).strict().optional(),
  replaceOriginal: z.object({ name: guestName, path: filePath }).strict().optional(),
}).strict()

export function pythonToolAllowed(config: Pick<PiAgentSessionConfig, 'disableTools'>): boolean {
  return !config.disableTools
}

export function pythonToolSummary(input: unknown): { purpose?: string } {
  if (!input || typeof input !== 'object' || !('purpose' in input) || typeof input.purpose !== 'string') return {}
  return { purpose: redactText(input.purpose.slice(0, purposeLimit)) }
}

export function pythonTool(config: PiAgentSessionConfig, executable: string, execute = runPython) {
  const policy = config.toolPolicy
  const canRead = !!policy?.fileAccess && policy.allowedTools.includes('read')
  const canWrite = !!policy?.fileAccess && policy.preset !== 'read-only' && policy.allowedTools.includes('write')
  const canReplace = canReplaceOriginalDocument(config)
  const writer = canWrite ? managedFileTools(config)[0] : undefined
  return defineTool({
    name: RUN_PYTHON_TOOL,
    label: '运行 Python',
    description: 'Run Python code you write using the bundled CPython standard library in an isolated temporary filesystem. No network, subprocesses, or package installation. Review stdout, stderr and exitCode before claiming success.' +
      (canRead ? ' To read a permitted file, declare {path, name} in inputs and open its copy at inputs/<name>. DOCX, XLSX and PPTX inputs are validated and copied as uncompressed ZIPs so zipfile can read them without zlib. Without an input declaration, host files are not visible.' : ' This run cannot import host files.') +
      (canWrite ? ' To save one UTF-8 text result (up to 128 KiB), declare output {name, path} and write outputs/<name>. The normal file policy and approvals apply to the destination. Other files are discarded.' : ' This run cannot save results to host files; return results with print().') +
      (canReplace ? ' Only when the user explicitly asks to modify the original DOCX, XLSX, PPTX or PDF, declare replaceOriginal {path: "@original/<attachmentId>", name: "document.<same-extension>"} instead of output. Read inputs/<name> and write the edited document to outputs/<name>. Office inputs are stored ZIP copies: use zipfile with ZIP_STORED and format-aware XML changes, preserving unmodified parts. Do not save extracted text as a document. State the precise intended changes in purpose. The host validates the result, asks for separate replacement approval and keeps a backup.' : ''),
    parameters: Type.Object({
      purpose: Type.String({ minLength: 1, maxLength: purposeLimit }), code: Type.String({ minLength: 1, maxLength: PYTHON_CODE_LIMIT }),
      ...(canRead ? { inputs: Type.Optional(Type.Array(Type.Object({ path: Type.String(), name: Type.String() }, { additionalProperties: false }), { maxItems: maxInputs })) } : {}),
      ...(canWrite ? { output: Type.Optional(Type.Object({ name: Type.String(), path: Type.String() }, { additionalProperties: false })) } : {}),
      ...(canReplace ? { replaceOriginal: Type.Optional(Type.Object({ name: Type.String(), path: Type.String() }, { additionalProperties: false })) } : {}),
    }, { additionalProperties: false }),
    async execute(id, raw, signal, onUpdate, ctx) {
      if (!pythonToolAllowed(config)) throw new Error('Python is not available under this task policy.')
      const parsed = inputSchema.safeParse(raw)
      if (!parsed.success) throw new Error('Provide a single-line purpose, valid file declarations, and up to 64 KiB of Python source.')
      const { purpose, code, inputs = [], output, replaceOriginal } = parsed.data
      if ((inputs.length && !canRead) || (output && !writer)) throw new Error('File access denied by task policy.')
      if (replaceOriginal && !canReplace) {
        if (!canRead || !canWrite || policy?.unattended) throw new Error('File access denied by task policy.')
        throw new Error('No original document is bound for replacement in this turn. Reselect or drop the target original in this conversation.')
      }
      if (inputs.some(file => file.path.startsWith('@original/'))) throw new Error('Use conversation_attachment readOnlyPath for Python inputs. Attachment original identifiers are only for replaceOriginal.')
      if (replaceOriginal && output) throw new Error('Choose a text output or an original document replacement, not both.')
      const inputNames = [...inputs.map(file => file.name), ...(replaceOriginal ? [replaceOriginal.name] : [])]
      if (new Set(inputNames.map(name => name.normalize('NFC').toLowerCase())).size !== inputNames.length) throw new Error('Input names must be unique.')
      signal?.throwIfAborted()
      const cwd = await realpath(config.workspaceDir)
      const lockKey = process.platform === 'win32' ? cwd.toLowerCase() : cwd
      if (running.has(lockKey)) throw new Error('Another Python call is already pending or running in this workspace.')
      running.add(lockKey)
      try {
        signal?.throwIfAborted()
        // Scheduled runs can execute in the sandbox without adding an interactive approval.
        // Host-side writes still go through the existing file tool and its policies.
        if (!policy?.unattended && !await config.authorizeTool({ toolName: RUN_PYTHON_TOOL, input: { purpose: redactText(purpose), timeoutSeconds: PYTHON_TIMEOUT_SECONDS } })) {
          throw new Error('Python execution was not approved.')
        }
        signal?.throwIfAborted()
        if (await realpath(config.workspaceDir) !== cwd) throw new Error('The task workspace changed before execution.')
        const files = new Map<string, Buffer>()
        const original = replaceOriginal && await prepareOriginalDocument(config, replaceOriginal.path, replaceOriginal.name, signal)
        if (original && replaceOriginal) files.set(replaceOriginal.name, original.bytes)
        let remaining = PYTHON_FILE_LIMIT - (original?.bytes.length ?? 0)
        for (const file of inputs) {
          const activePolicy = policy!
          let path = managedFilePath(file.path, activePolicy)
          if (!path && isManagedReadException(file.path, activePolicy)) {
            const candidate = resolve(cwd, file.path)
            const canonical = await realpath(candidate)
            if (isManagedReadException(canonical, activePolicy) && await realpath(candidate) === canonical) path = canonical
          }
          if (!path) {
            const candidate = externalFileCandidate(file.path, activePolicy)
            if (candidate && managedFilePath(candidate, { ...activePolicy, fileAccess: 'local' }) && (await lstat(candidate)).isFile() &&
              await config.authorizeTool({ toolName: 'file_select_original', input: { path: candidate } })) {
              path = managedFilePath(candidate, { ...activePolicy, fileAccess: 'local' })
            }
          }
          signal?.throwIfAborted()
          if (!path) throw new Error('Python input was denied by task policy.')
          const extension = extname(activePolicy.attachmentNamesByPath?.get(path) ?? path).toLowerCase()
          const bytes = prepareOfficeInputBytes(await readPythonFile(path, remaining), extension, remaining)
          remaining -= bytes.length
          files.set(file.name, bytes)
        }
        const { files: results, binaryFile, ...result } = await execute(executable, code, signal, {
          inputs: files, outputs: output && writer ? [output.name] : [], binaryOutput: replaceOriginal?.name,
        })
        const text = output && results.get(output.name)
        const content = [{ type: 'text' as const, text: JSON.stringify(result) }]
        if (original && result.status === 'finished' && result.exitCode === 0) {
          if (!binaryFile) throw new Error('Python did not produce the replacement document.')
          signal?.throwIfAborted()
          if (await realpath(config.workspaceDir) !== cwd) throw new Error('The task workspace changed before saving.')
          content.push({ type: 'text', text: await original.replace(binaryFile, purpose) })
        } else if (text !== undefined && writer && output && result.status === 'finished' && result.exitCode === 0) {
          signal?.throwIfAborted()
          if (await realpath(config.workspaceDir) !== cwd) throw new Error('The task workspace changed before saving.')
          content.push(...(await writer.execute(id, { path: output.path, content: text }, signal, onUpdate, ctx)).content.filter(item => item.type === 'text'))
        }
        return { content, details: { isError: result.status !== 'finished' || result.exitCode !== 0 } }
      } finally { running.delete(lockKey) }
    },
  })
}
