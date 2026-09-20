import type { SkillVersion } from '../../shared/platform-supplement-contracts';
import type { LocalSkillSubmission, SkillLibraryItem } from '../../shared/skill-library';

export function skillVersionLabel(version: SkillVersion): string {
  if (version.scope === 'PERSONAL') return version.changeSummary || `个人版本 · ${version.createdAt ? new Date(version.createdAt).toLocaleString() : version.id.slice(-8)}`;
  return `${version.scope === 'ENTERPRISE' ? '企业版' : '平台版'} ${version.version}`;
}
export function skillVersionStatus(status: string): string {
  const labels: Record<string, string> = { PLATFORM_APPROVED: '已发布', ENTERPRISE_APPROVED: '已通过', PENDING_ENTERPRISE_REVIEW: '待企业审核', ENTERPRISE_REJECTED: '已驳回', PERSONAL_ACTIVE: '不适用于客户端' };
  return labels[status] ?? status;
}
export function selectedSkillVersion(skill: SkillLibraryItem): string {
  const ids = new Set(skill.bindings.map(binding => binding.selectedVersionId));
  return ids.size === 1 ? [...ids][0] : '';
}

export function localSkillVersionStatus(skill: SkillLibraryItem, local: LocalSkillSubmission): string {
  const uploaded = local.uploadedVersion;
  const current = uploaded ? skill.versions.find(version => version.id === uploaded.id) ?? uploaded : undefined;
  return `本地可用 · ${current ? '已上传 · ' + skillVersionStatus(current.status) : '待上传'}`;
}
