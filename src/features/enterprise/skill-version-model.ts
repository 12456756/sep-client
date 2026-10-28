import type { SkillVersion } from '../../shared/platform-supplement-contracts';
import type { LocalSkillSubmission, SkillLibraryItem } from '../../shared/skill-library';
import { localSkillVersionStatus, skillVersionLabel, skillVersionStatus } from './skill-labels';
import { uniqueSkillBindings } from './skill-list-model';

export interface SkillVersionEntry {
  id: string;
  aliases: string[];
  label: string;
  status: string;
  createdAt?: string;
  version?: SkillVersion;
  local?: LocalSkillSubmission;
  usable: boolean;
  parentVersionId?: string;
  usedBy: string[];
}

export function buildSkillVersions(skill: SkillLibraryItem): SkillVersionEntry[] {
  const localRemoteIds = new Set(skill.localVersions.flatMap(local => local.uploadedVersion ? [local.uploadedVersion.id] : []));
  const bindings = uniqueSkillBindings(skill);
  const entries: SkillVersionEntry[] = skill.localVersions.map(local => {
    const version = skill.versions.find(version => version.id === local.uploadedVersion?.id) ?? local.uploadedVersion;
    const aliases = [local.idempotencyKey, ...(version ? [version.id] : [])];
    return { id: local.idempotencyKey, aliases, label: local.request.changeSummary || '个人修改版', status: localSkillVersionStatus(skill, local), createdAt: local.createdAt, local, version,
      usable: skill.usableVersionIds.includes(local.idempotencyKey), parentVersionId: version?.id ?? local.request.parentVersionId,
      usedBy: bindings.filter(binding => binding.selectedVersionId !== null && aliases.includes(binding.selectedVersionId)).map(binding => binding.subscriptionId) };
  });
  for (const version of skill.versions) {
    if (localRemoteIds.has(version.id) || entries.some(entry => entry.id === version.id)) continue;
    entries.push({ id: version.id, aliases: [version.id], label: skillVersionLabel(version), status: skillVersionStatus(version.status), createdAt: version.createdAt, version,
      usable: skill.usableVersionIds.includes(version.id), parentVersionId: version.id,
      usedBy: bindings.filter(binding => binding.selectedVersionId === version.id).map(binding => binding.subscriptionId) });
  }
  const time = (entry: SkillVersionEntry): number => {
    const date = entry.createdAt ? Date.parse(entry.createdAt) : NaN;
    return Number.isFinite(date) ? date : -Infinity;
  };
  return entries.sort((a, b) => time(a) === time(b) ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : time(a) > time(b) ? -1 : 1);
}

export function findSkillVersion(entries: readonly SkillVersionEntry[], id: string | null | undefined): SkillVersionEntry | undefined {
  return id ? entries.find(entry => entry.aliases.includes(id)) : undefined;
}

export function unifiedSkillVersion(skill: SkillLibraryItem, entries = buildSkillVersions(skill)): SkillVersionEntry | undefined {
  const bindings = uniqueSkillBindings(skill);
  const first = findSkillVersion(entries, bindings[0]?.selectedVersionId);
  return first && bindings.every(binding => findSkillVersion(entries, binding.selectedVersionId)?.id === first.id) ? first : undefined;
}

export function initialSkillViewingVersion(skill: SkillLibraryItem, sourceEmployeeId?: string): string {
  const entries = buildSkillVersions(skill);
  const unified = unifiedSkillVersion(skill, entries);
  if (unified) return unified.id;
  const source = findSkillVersion(entries, skill.bindings.find(binding => binding.subscriptionId === sourceEmployeeId)?.selectedVersionId);
  if (source) return source.id;
  const currentIds = new Set(skill.bindings.flatMap(binding => binding.currentVersion ? [binding.currentVersion.id] : []));
  return entries.find(entry => entry.aliases.some(id => currentIds.has(id)))?.id
    ?? entries.find(entry => !entry.local)?.id ?? entries[0]?.id ?? '';
}

/** Presentation only. The original string, including metadata and line endings, is never rewritten. */
export function skillReadingParts(source: string, title?: string): { metadata: string; body: string } {
  const match = source.match(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  const metadata = match?.[0] ?? '';
  let body = source.slice(metadata.length);
  const heading = body.match(/^(?:\uFEFF)?(?:[ \t]*\r?\n)*#[ \t]+([^\r\n]+)(?:\r?\n|$)/);
  if (title?.trim() && heading?.[1].replace(/[ \t]+#+[ \t]*$/, '').trim() === title.trim()) {
    body = body.slice(heading[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');
  }
  return { metadata, body };
}

export function skillDateLabel(date: string | undefined): string {
  return date && Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleString() : '创建时间未知';
}
