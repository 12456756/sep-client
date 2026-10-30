import { randomUUID } from 'node:crypto'
import { link, lstat, rename, unlink } from 'node:fs/promises'
import { WriteChain } from './write-chain'

const writes = new WriteChain()

/** A corrupt snapshot is quarantined; only an already verified identical version can replace it. */
export async function publishDeliverySnapshot(part: string, target: string, verify: (path: string) => Promise<void>,
  checkPath: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  await writes.run(target, async () => {
    signal?.throwIfAborted()
    await checkPath()
    await verify(part)
    try { await verify(target); return }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !(error instanceof Error && ['SNAPSHOT_CHANGED', 'MEDIA_INTEGRITY_MISMATCH'].includes(error.message))) throw error
    }
    await checkPath()
    const existing = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error('UNSAFE_PATH')
      signal?.throwIfAborted()
      await rename(target, target + '.corrupt-' + randomUUID())
    }
    signal?.throwIfAborted()
    await checkPath()
    try { await link(part, target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await unlink(part)
    await verify(target)
  })
}
