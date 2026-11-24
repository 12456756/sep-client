import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readBundledRelease(root: string): { version: string; notes: string } {
  const pkg: { version?: unknown } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    throw new Error('Invalid package version for bundled release notes.')
  }
  let notes = ''
  try {
    notes = readFileSync(join(root, 'release-notes', `${pkg.version}.md`), 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { version: pkg.version, notes }
}
