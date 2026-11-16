import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Native launchers may unpack support files beside the executable. */
export async function prepareConnectorBinary(source: string, runtimeRoot: string): Promise<string> {
  const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
  const hash = digest(await readFile(source))
  const directory = join(runtimeRoot, hash)
  const target = join(directory, basename(source))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try { if (digest(await readFile(target)) === hash) return target } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(directory, `${randomUUID()}.tmp`)
  await copyFile(source, temporary)
  if (digest(await readFile(temporary)) !== hash) throw new Error('Connector runtime integrity check failed.')
  await chmod(temporary, 0o700)
  await rename(temporary, target)
  return target
}
