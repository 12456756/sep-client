import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readDeliveryPreviewFile } from './arrangement-delivery-files'
import { resolveArrangementMediaFile } from './arrangement-media-files'
import { resolveUnlinkedChild, resolveUnlinkedDirectory, resolveWorkspaceResult } from './workspace-result-path'
import { ResultFilePathError } from '../errors/result-file-path-error'
import { scheduledFileConflict, ScheduledPathDeniedError } from '../domain/scheduled-task'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'

export async function inspectScheduledOutputDirectory(input: string) {
  const path = await resolveUnlinkedDirectory(input)
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n || /(?:^|[\\/])(?:\.git|\.ssh|\.aws|\.codex|\.agents)(?:[\\/]|$)/i.test(path)) {
    throw new Error('Invalid scheduled output directory.')
  }
  return { path, identity: `${info.dev}:${info.ino}:${info.birthtimeNs}` }
}

export async function assertScheduledPathAvailable(directory: string, path: string) {
  try { await resolveWorkspaceResult(directory, path) }
  catch (error) {
    if (error instanceof ResultFilePathError && error.reason === 'missing') return
    throw error
  }
  throw new ScheduledPathDeniedError(scheduledFileConflict)
}

function publishedName(path: string, index: number, occurrenceId: string, scheduledAt: number) {
  const stamp = new Date(scheduledAt).toISOString().slice(0, 16).replaceAll(':', '').replace('T', '-')
  return `${stamp}-${occurrenceId.slice(0, 12)}-${index + 1}-${basename(path.replaceAll('\\', '/'))}`
}

export async function checkScheduledOutputPaths(workspace: string, paths: string[], destination: { path: string; identity?: string } | undefined,
  occurrenceId: string, scheduledAt: number, guard: () => void) {
  for (const path of paths) {
    guard()
    await assertScheduledPathAvailable(workspace, path)
  }
  if (!destination) return
  guard()
  const target = await inspectScheduledOutputDirectory(destination.path)
  if (target.identity !== destination.identity) throw new ScheduledPathDeniedError()
  for (const [index, path] of paths.entries()) {
    guard()
    await assertScheduledPathAvailable(target.path, publishedName(path, index, occurrenceId, scheduledAt))
  }
}

export async function publishScheduledOutputs(input: {
  destination: { path: string; identity?: string }; workspace: string; taskDirectory: string;
  occurrenceId: string; scheduledAt: number; files: FinalDeliveryFile[]; assertCurrent(): void | Promise<void>;
}) {
  const check = async () => {
    await input.assertCurrent()
    const target = await inspectScheduledOutputDirectory(input.destination.path)
    if (!input.destination.identity || input.destination.identity !== target.identity) throw new Error('Scheduled output directory changed.')
    await input.assertCurrent()
    return target.path
  }
  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i]!
    const name = publishedName(file.path, i, input.occurrenceId, input.scheduledAt)
    const root = await check()
    const destination = join(root, name)
    const verifyExisting = async () => {
      try { await lstat(destination) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
      const existing = await resolveUnlinkedChild(await check(), name, 'file')
      const copy = await open(existing.path, 'r')
      try {
        const info = await copy.stat()
        if (info.dev !== existing.stat.dev || info.ino !== existing.stat.ino || info.size !== file.size || info.nlink !== 1) throw new Error('Scheduled output already exists.')
        const hash = createHash('sha256')
        for await (const chunk of copy.createReadStream({ autoClose: false })) hash.update(chunk)
        if (hash.digest('hex') !== file.sha256) throw new Error('Scheduled output already exists.')
        return true
      } finally { await copy.close() }
    }
    if (await verifyExisting()) continue
    const temporary = join(root, `.csep-output-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      if (await check() !== root) throw new Error('Scheduled output directory changed.')
      if (file.sourceArtifact) {
        const source = await resolveArrangementMediaFile(input.workspace, file, input.taskDirectory)
        const original = await open(source, 'r')
        try {
          const hash = createHash('sha256')
          let size = 0
          for await (const chunk of original.createReadStream({ autoClose: false })) {
            await input.assertCurrent()
            size += chunk.length
            if (size > file.size) throw new Error('Scheduled media size changed.')
            hash.update(chunk)
            await handle.writeFile(chunk)
          }
          if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error('Scheduled media changed.')
        } finally { await original.close() }
      } else {
        const { bytes } = await readDeliveryPreviewFile(input.workspace, file, input.taskDirectory)
        await handle.writeFile(bytes)
      }
      await handle.sync()
      await handle.close()
      await check()
      try { await link(temporary, destination) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await verifyExisting()) throw error }
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }
}
