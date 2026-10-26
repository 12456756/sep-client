import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve from the application module, not the user's working directory or PATH. */
export function applicationResourcesDirectory(): string {
  const entry = fileURLToPath(import.meta.url)
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath && /[\\/]app\.asar[\\/]/.test(entry)) return resourcesPath
  let directory = dirname(entry)
  for (;;) {
    try {
      const pkg: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (pkg && typeof pkg === 'object' && 'name' in pkg && pkg.name === 'longsilicon') return join(directory, 'resources')
    } catch { /* The module can live in source, a main bundle, or a generated chunk. */ }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('Cannot resolve application resources directory.')
    directory = parent
  }
}
