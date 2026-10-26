import { createHash } from 'node:crypto'
import { skillNameComparisonKey } from '../../common/platform/skill-artifact-contract'

export interface RuntimeSkillName {
  id: string
  name: string
  source: 'common' | 'employee'
}

/** Names are presentation-only. Source bytes and authorization identities never change. */
export function allocateSkillNames(entries: readonly RuntimeSkillName[]): Map<string, string> {
  const groups = new Map<string, RuntimeSkillName[]>()
  for (const entry of entries) {
    const key = skillNameComparisonKey(entry.name)
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const result = new Map<string, string>()
  const used = new Set(groups.keys())
  const pending: RuntimeSkillName[] = []
  for (const group of groups.values()) {
    if (group.length === 1) result.set(group[0].id, group[0].name)
    else {
      const common = group.filter(entry => entry.source === 'common')
      if (common.length === 1) result.set(common[0].id, common[0].name)
      pending.push(...group.filter(entry => !result.has(entry.id)))
    }
  }
  for (const entry of pending.sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    const prefix = `${entry.source}-`
    const base = prefix + Array.from(entry.name).slice(0, 64 - prefix.length).join('')
    let alias = base
    let salt = 0
    while (used.has(skillNameComparisonKey(alias))) {
      const suffix = '-' + createHash('sha256').update(`${entry.id}:${salt++}`).digest('hex').slice(0, 12)
      alias = Array.from(base).slice(0, 64 - suffix.length).join('') + suffix
    }
    used.add(skillNameComparisonKey(alias))
    result.set(entry.id, alias)
  }
  return result
}
