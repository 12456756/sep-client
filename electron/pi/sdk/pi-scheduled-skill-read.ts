import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isApprovedSkillRead, type ApprovedSkillReadPath, type ToolPolicy } from '../../../pi-extension/guard'
import type { PiSkill } from './pi-coding-agent-adapter'

const skillPrefix = '@skill/'

export function isScheduledSkillAlias(path: string): boolean {
  return path.startsWith(skillPrefix)
}

export function isScheduledSkillCacheEntry(path: string, policy: ToolPolicy): boolean {
  if (!policy.applicationDataRoot || !isAbsolute(path) || basename(path).toLowerCase() !== 'skill.md') return false
  const fromCache = relative(join(policy.applicationDataRoot, 'runtime', 'skills-v2'), path)
  return !!fromCache && !isAbsolute(fromCache) && fromCache !== '..' && !fromCache.startsWith(`..${sep}`)
}

export function bindScheduledSkills(skills: readonly PiSkill[], policy: ToolPolicy) {
  const entries = new Map<string, { description: string; grant: ApprovedSkillReadPath }>()
  for (const skill of skills) {
    if (skill.disableModelInvocation) continue
    const grant = policy.approvedSkillPaths?.find(item => item.entryPath === skill.filePath)
    if (grant && isApprovedSkillRead(grant.entryPath, policy)) entries.set(skill.name, { description: skill.description, grant })
  }
  return {
    prompt: entries.size ? [
      'Use read with the exact @skill/<name> alias below for a matching skill. Do not construct a skill cache path.',
      'For referenced files in an approved skill package, use @skill/<name>/<relative path from the skill entry directory>.',
      'Available skills: ' + JSON.stringify([...entries].map(([name, entry]) => ({ path: skillPrefix + name, description: entry.description }))),
    ].join('\n') : '',
    describe(input: string) {
      if (!isScheduledSkillAlias(input)) return undefined
      const name = input.slice(skillPrefix.length)
      const entry = entries.get(name)
      return entry && { path: `${input}/SKILL.md`, label: entry.grant.label ?? { name, description: entry.description } }
    },
    resolve(input: string): { path: string; sha256?: string } | 'unavailable' | null {
      const [name, ...parts] = input.slice(skillPrefix.length).split('/')
      if (!name || parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))) return null
      const entry = entries.get(name)
      if (!entry || (parts.length && !entry.grant.packageRoot)) return null
      const { grant } = entry
      const path = parts.length ? join(dirname(grant.entryPath), ...parts) : grant.entryPath
      if (!isApprovedSkillRead(path, { ...policy, approvedSkillPaths: [grant] })) return parts.length ? null : 'unavailable'
      try { if (realpathSync(path) !== path) return parts.length ? null : 'unavailable' } catch { return parts.length ? null : 'unavailable' }
      return { path, ...(path === grant.entryPath && grant.sha256 ? { sha256: grant.sha256 } : {}) }
    },
  }
}
