import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { PiLoadSkills, PiResourceLoaderOptions, PiSkill } from './pi-coding-agent-adapter'
import { skillNameComparisonKey } from '../../common/platform/skill-artifact-contract'
import { validatedSkillMarkdown } from './skill-package-parser'
import { assertSkillPathParents, packageManifestName, verifyPackageCache } from './skill-package-zip'

function integrityMismatch(): never {
  throw new Error('Employee runtime skill loader integrity mismatch.')
}

function canonicalEntry(path: string): string {
  assertSkillPathParents(path)
  return realpathSync(path)
}

/** Constrain employee sessions to the immutable entries prepared by the authorizer. */
export function employeeSkillLoaderOptions(
  cwd: string,
  agentDir: string,
  paths: readonly string[] | undefined,
  loadSkills: PiLoadSkills,
): Pick<PiResourceLoaderOptions, 'noSkills' | 'skillsOverride'> {
  // Ordinary sessions retain Pi's workstation/project skill discovery.
  if (paths === undefined) return { noSkills: false }

  const entries = paths.map(path => join(resolve(cwd, path), 'SKILL.md'))
  if (new Set(entries.map(skillNameComparisonKey)).size !== entries.length) integrityMismatch()
  const expected = new Map(entries.map(path => {
    try {
      const stat = lstatSync(path)
      const directory = lstatSync(dirname(path))
      if (!stat.isFile() || stat.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()) integrityMismatch()
      const canonical = canonicalEntry(path)
      const bytes = readFileSync(path)
      const parsed = validatedSkillMarkdown(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
      const manifestPath = join(dirname(path), packageManifestName)
      let manifest: Buffer | undefined
      try {
        const info = lstatSync(manifestPath)
        if (!info.isFile() || info.isSymbolicLink()) integrityMismatch()
        manifest = readFileSync(manifestPath)
        verifyPackageCache(path, manifest)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const skill: PiSkill = {
        name: parsed.metadata.name, description: parsed.metadata.description,
        disableModelInvocation: parsed.metadata['disable-model-invocation'] === true,
        filePath: path, baseDir: dirname(path),
        sourceInfo: { path, source: 'local', scope: 'temporary', origin: 'top-level', baseDir: dirname(path) },
      }
      return [path, { skill, canonical, prefix: parsed.compatibilityPrefix, sha256: createHash('sha256').update(bytes).digest('hex'), dev: stat.dev, ino: stat.ino, manifest }] as const
    } catch { return integrityMismatch() }
  }))
  if (new Set([...expected.values()].map(entry => skillNameComparisonKey(entry.skill.name))).size !== expected.size) integrityMismatch()
  const prepared = loadSkills({ cwd, agentDir, skillPaths: [...paths], includeDefaults: false })

  function validateBase(base: typeof prepared): void {
    for (const diagnostic of base.diagnostics) {
      const entry = diagnostic.path ? expected.get(resolve(diagnostic.path)) : undefined
      if (!entry || diagnostic.type !== 'warning') integrityMismatch()
      const nameWarning = diagnostic.message === 'name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)'
        || diagnostic.message === `name exceeds 64 characters (${entry.skill.name.length})` && Array.from(entry.skill.name).length <= 64
      // Pi 0.83 does not recognize prefixed frontmatter. Our strict parser already validated it.
      if (!nameWarning && !(entry.prefix && diagnostic.message === 'description is required')) integrityMismatch()
    }
    const seen = new Set<string>()
    for (const skill of base.skills) {
      const path = resolve(skill.filePath)
      const entry = expected.get(path)
      if (!entry || seen.has(path) || skill.name !== entry.skill.name || skill.description !== entry.skill.description ||
        skill.disableModelInvocation !== entry.skill.disableModelInvocation || resolve(skill.baseDir) !== dirname(path)) integrityMismatch()
      seen.add(path)
    }
    for (const [path, entry] of expected) if (!entry.prefix && !seen.has(path)) integrityMismatch()
  }
  validateBase(prepared)

  return {
    // noSkills disables discovery but still loads additionalSkillPaths in SDK 0.83.0.
    noSkills: true,
    // The SDK invokes this on reload and extendResources, before publishing skills.
    skillsOverride(base) {
      validateBase(base)
      for (const [path, entry] of expected) {
        try {
          const stat = lstatSync(path)
          if (!stat.isFile() || stat.isSymbolicLink() || canonicalEntry(path) !== entry.canonical || stat.dev !== entry.dev || stat.ino !== entry.ino ||
            createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.sha256) integrityMismatch()
          if (entry.manifest) verifyPackageCache(path, entry.manifest)
        } catch { integrityMismatch() }
      }
      return { skills: [...expected.values()].map(entry => ({ ...entry.skill })), diagnostics: [] }
    },
  }
}
