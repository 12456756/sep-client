import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { link, lstat, open, rename, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { readDeliveryPreviewFile } from './arrangement-delivery-files'
import { resolveArrangementMediaFile } from './arrangement-media-files'
import { resolveUnlinkedChild, resolveUnlinkedDirectory, resolveWorkspaceResult } from './workspace-result-path'
import { WriteChain } from './write-chain'
import { ResultFilePathError } from '../errors/result-file-path-error'
import { scheduledFileConflict, ScheduledPathDeniedError } from '../domain/scheduled-task'
import { isSafeDeliveryPath } from '../domain/arrangement-plan'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'
import type { ScheduleInput } from '../../src/shared/scheduled-tasks'

type OutputDirectory = NonNullable<ScheduleInput['outputDirectory']>
const writes = new WriteChain()
const backupPrefix = 'CSEP-备份-'
export class ScheduledPublicationUncertainError extends Error {}

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

function publishedNames(paths: string[]) {
  const seen = new Set<string>()
  return paths.map(path => {
    if (!isSafeDeliveryPath(path)) throw new ScheduledPathDeniedError()
    const name = basename(path.replaceAll('\\', '/'))
    const key = name.normalize('NFC').toLowerCase()
    if (key.startsWith(backupPrefix.toLowerCase()) || key.startsWith('.csep-output-')) throw new ScheduledPathDeniedError()
    if (seen.has(key)) throw new ScheduledPathDeniedError({ code: 'SCHEDULED_OUTPUT_DUPLICATE_NAME', message: '多份成果使用了相同的文件名，请为它们指定不同名称。' })
    seen.add(key)
    return name
  })
}

function sameVersion(left: BigIntStats, right: BigIntStats) {
  return left.isFile() && right.isFile() && left.nlink === 1n && right.nlink === 1n && left.ino !== 0n &&
    left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function existingFile(root: string, name: string) {
  const requested = join(root, name)
  let initial: BigIntStats
  try { initial = await lstat(requested, { bigint: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const { path } = await resolveUnlinkedChild(root, name, 'file')
  const stat = await lstat(path, { bigint: true })
  if (!sameVersion(initial, stat)) throw new ResultFilePathError('changed')
  return { path, stat }
}

export async function checkScheduledOutputPaths(workspace: string, paths: string[], destination: OutputDirectory | undefined,
  guard: () => void) {
  for (const path of paths) {
    guard()
    await assertScheduledPathAvailable(workspace, path)
  }
  if (!destination) return
  guard()
  const target = await inspectScheduledOutputDirectory(destination.path)
  if (target.identity !== destination.identity) throw new ScheduledPathDeniedError()
  for (const name of publishedNames(paths)) {
    guard()
    await existingFile(target.path, name)
  }
}

async function publishOne(root: string, name: string, file: FinalDeliveryFile, intent: string, check: () => Promise<string>, stage: () => Promise<string>,
  reconcileOnly: boolean, tracked: boolean) {
  const destination = join(root, name)
  const recordIntent = async () => {
    const handle = await open(intent, 'wx', 0o600)
    try { await handle.sync() } finally { await handle.close() }
  }
  const attempted = await lstat(intent).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  })
  const cannotReconcile = () => tracked ? new ScheduledPublicationUncertainError() : new ResultFilePathError('changed')

  const current = await existingFile(await check(), name)
  if (!current && !attempted && !reconcileOnly) {
    const temporary = await stage()
    await recordIntent()
    await check()
    await link(temporary, destination)
    return
  }
  // A previous publication may have completed just before the client stopped.
  // Reconcile matching bytes only; never replay an older result over a newer one.
  if (!current) throw cannotReconcile()
  const original = await open(current.path, 'r')
  const assertUnchanged = async () => {
    if (!sameVersion(current.stat, await original.stat({ bigint: true })) ||
      !sameVersion(current.stat, await lstat(current.path, { bigint: true }))) throw new ResultFilePathError('changed')
  }
  try {
    await assertUnchanged()
    if (current.stat.size === BigInt(file.size)) {
      const hash = createHash('sha256')
      for await (const chunk of original.createReadStream({ autoClose: false })) hash.update(chunk)
      await assertUnchanged()
      if (hash.digest('hex') === file.sha256) {
        await check()
        await assertUnchanged()
        if (!attempted && !reconcileOnly) await recordIntent()
        return
      }
    }
    if (attempted || reconcileOnly) throw cannotReconcile()

    const temporary = await stage()
    // Publish an independent, flushed copy before atomically replacing the original path.
    const id = randomUUID()
    const backupTemporary = join(root, `.csep-output-${id}.tmp`)
    const suffix = extname(name)
    const extension = [...suffix].length <= 16 ? suffix : ''
    const stem = [...(extension ? basename(name, extension) : name)].slice(0, 40).join('')
    const backup = join(root, `${backupPrefix}${stem}-${id}${extension}`)
    await check()
    const handle = await open(backupTemporary, 'wx', 0o600)
    try {
      let size = 0n
      for await (const chunk of original.createReadStream({ autoClose: false, start: 0 })) {
        size += BigInt(chunk.length)
        if (size > current.stat.size) throw new ResultFilePathError('changed')
        await handle.writeFile(chunk)
      }
      if (size !== current.stat.size) throw new ResultFilePathError('changed')
      await handle.sync()
      await handle.close()
      await check()
      await assertUnchanged()
      await link(backupTemporary, backup)
      await recordIntent()
      await check()
      await assertUnchanged()
      await original.close()
      if (!sameVersion(current.stat, await lstat(current.path, { bigint: true }))) throw new ResultFilePathError('changed')
      await rename(temporary, current.path)
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(backupTemporary).catch(() => undefined)
    }
  } finally { await original.close().catch(() => undefined) }
}

export async function publishScheduledOutputs(input: {
  destination: OutputDirectory; workspace: string; taskDirectory: string;
  occurrenceId: string; files: FinalDeliveryFile[]; assertCurrent(): void | Promise<void>;
  track?(name: string, publish: (reconcileOnly?: boolean) => Promise<void>): Promise<void>;
}) {
  const check = async () => {
    await input.assertCurrent()
    const target = await inspectScheduledOutputDirectory(input.destination.path)
    if (!input.destination.identity || input.destination.identity !== target.identity) throw new Error('Scheduled output directory changed.')
    await input.assertCurrent()
    return target.path
  }
  const names = publishedNames(input.files.map(file => file.path))
  const identity = input.destination.identity
  if (!identity) throw new ScheduledPathDeniedError()
  await writes.run(identity, async () => {
    for (const [i, file] of input.files.entries()) {
      const name = names[i]!
      const publish = async (reconcileOnly = false) => {
        const root = await check()
        const temporary = join(root, `.csep-output-${randomUUID()}.tmp`)
        const intent = join(input.taskDirectory,
          `.csep-publish-${createHash('sha256').update(JSON.stringify([input.occurrenceId, name])).digest('hex')}`)
        let staged = false
        const stage = async () => {
          await check()
          const handle = await open(temporary, 'wx', 0o600)
          staged = true
          try {
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
          } finally { await handle.close() }
          return temporary
        }
        try {
          await publishOne(root, name, file, intent, check, stage, reconcileOnly, !!input.track)
        } finally {
          if (staged) await unlink(temporary).catch(() => undefined)
        }
      }
      if (input.track) await input.track(name, publish)
      else await publish()
    }
  })
}
