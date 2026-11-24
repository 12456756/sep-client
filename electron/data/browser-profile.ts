import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveUnlinkedChild } from './workspace-result-path'

/** Only authenticated conversation task storage is passed by the host; never accept a model-supplied profile path. */
export async function prepareBrowserProfile(taskStateDir: string): Promise<string> {
  const state = await lstat(taskStateDir)
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Invalid browser task storage.')
  const root = await realpath(taskStateDir)
  const name = 'browser-profile'
  await mkdir(join(root, name), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  return (await resolveUnlinkedChild(root, name, 'directory')).path
}
