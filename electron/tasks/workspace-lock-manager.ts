import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, normalize, relative, sep } from 'node:path'

interface HeldLock {
  runId: string
  path: string
}

function canonicalizePath(workDir: string | null, defaultWorkDir: string): string {
  const input = workDir?.trim() || defaultWorkDir
  const absolute = resolve(input)
  if (existsSync(absolute)) return normalizeCase(normalize(realpathSync(absolute)))

  let current = absolute
  const suffix: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    suffix.unshift(relative(parent, current))
    current = parent
  }
  const base = existsSync(current) ? realpathSync(current) : current
  return normalizeCase(normalize(resolve(base, ...suffix)))
}

function normalizeCase(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true
  const leftRelative = relative(left, right)
  const rightRelative = relative(right, left)
  return Boolean(
    leftRelative && !leftRelative.startsWith(`..${sep}`) && leftRelative !== '..' ||
    rightRelative && !rightRelative.startsWith(`..${sep}`) && rightRelative !== '..',
  )
}

export class WorkspaceLockManager {
  private readonly locks = new Map<string, HeldLock>()
  private readonly defaultWorkDir: string
  private readonly waiters = new Set<() => void>()

  constructor(defaultWorkDir = process.cwd()) {
    this.defaultWorkDir = defaultWorkDir
  }

  canonicalize(workDir: string | null): string {
    return canonicalizePath(workDir, this.defaultWorkDir)
  }

  hasConflict(workDir: string | null): boolean {
    const path = this.canonicalize(workDir)
    return Array.from(this.locks.values()).some(lock => pathsOverlap(lock.path, path))
  }

  acquire(runId: string, workDir: string | null): (() => void) | null {
    const path = this.canonicalize(workDir)
    if (Array.from(this.locks.values()).some(lock => lock.runId !== runId && pathsOverlap(lock.path, path))) {
      return null
    }
    this.locks.set(runId, { runId, path })
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.locks.get(runId)?.path === path) this.locks.delete(runId)
      for (const wake of this.waiters) wake()
    }
  }

  waitForRelease(): Promise<void> {
    return new Promise(resolvePromise => {
      const resolveOnce = () => {
        this.waiters.delete(resolveOnce)
        resolvePromise()
      }
      this.waiters.add(resolveOnce)
    })
  }

  get size(): number {
    return this.locks.size
  }
}
