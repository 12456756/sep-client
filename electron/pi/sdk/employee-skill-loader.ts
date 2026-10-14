import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadSkills, type DefaultResourceLoader } from '@earendil-works/pi-coding-agent'

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]

function integrityMismatch(): never {
  throw new Error('Employee runtime skill loader integrity mismatch.')
}

/** Constrain employee sessions to the immutable entries prepared by the authorizer. */
export function employeeSkillLoaderOptions(
  cwd: string,
  agentDir: string,
  paths: readonly string[] | undefined,
): Pick<LoaderOptions, 'noSkills' | 'skillsOverride'> {
  // Ordinary sessions retain Pi's workstation/project skill discovery.
  if (paths === undefined) return { noSkills: false }

  const entries = paths.map(path => join(resolve(cwd, path), 'SKILL.md'))
  const prepared = loadSkills({ cwd, agentDir, skillPaths: [...paths], includeDefaults: false })
  if (new Set(entries).size !== entries.length || prepared.skills.length !== entries.length ||
    prepared.diagnostics.length > 0 || prepared.skills.some(skill => !entries.includes(resolve(skill.filePath)))) integrityMismatch()
  const expected = new Map(prepared.skills.map(skill => [resolve(skill.filePath), {
    name: skill.name, description: skill.description, disableModelInvocation: skill.disableModelInvocation,
    sha256: createHash('sha256').update(readFileSync(skill.filePath)).digest('hex'),
  }]))

  return {
    // noSkills disables discovery but still loads additionalSkillPaths in SDK 0.83.0.
    noSkills: true,
    // The SDK invokes this on reload and extendResources, before publishing skills.
    skillsOverride(base) {
      if (base.skills.length !== expected.size || base.diagnostics.length > 0) integrityMismatch()
      const seen = new Set<string>()
      for (const skill of base.skills) {
        const path = resolve(skill.filePath)
        const entry = expected.get(path)
        if (!entry || seen.has(path) || skill.name !== entry.name || skill.description !== entry.description ||
          skill.disableModelInvocation !== entry.disableModelInvocation) integrityMismatch()
        seen.add(path)
        try {
          if (createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.sha256) integrityMismatch()
        } catch { integrityMismatch() }
      }
      return base
    },
  }
}
