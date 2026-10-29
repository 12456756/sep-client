import assert from 'node:assert/strict';
import test from 'node:test';
import type { SkillLibraryItem } from '../../shared/skill-library';
import { buildSkillSelectionOptions, buildSkillVersions, findSkillVersion, initialSkillViewingVersion, skillReadingParts, unifiedSkillSelection, unifiedSkillVersion } from './skill-version-model';

const approved = { id: 'enterprise', capabilityId: 'skill', scope: 'ENTERPRISE', version: '1.0', status: 'ENTERPRISE_APPROVED' };
const uploaded = { ...approved, id: 'uploaded', scope: 'PERSONAL', status: 'PENDING_ENTERPRISE_REVIEW', createdAt: '2026-10-20' };
const local = { idempotencyKey: 'local', createdAt: '2026-10-20', uploadedVersion: uploaded, request: { capabilityId: 'skill', parentVersionId: approved.id, content: '# text', changeSummary: '我的优化' } };
const skill: SkillLibraryItem = { capability: { id: 'skill', name: '分析', description: '', type: 'SKILL' }, versions: [approved, uploaded], localVersions: [local], usableVersionIds: ['enterprise', 'local'], bindings: [
  { subscriptionId: 'a', employeeId: 'template', currentVersion: approved, selectedVersionId: 'local' },
  { subscriptionId: 'b', employeeId: 'template', currentVersion: approved, selectedVersionId: 'uploaded' },
] };

test('local upload is one row with aliases, latest review, and local availability', () => {
  const rejected = { ...skill, versions: [approved, { ...uploaded, status: 'ENTERPRISE_REJECTED' }] };
  const entries = buildSkillVersions(rejected);
  assert.equal(entries.length, 2);
  const entry = findSkillVersion(entries, 'uploaded')!;
  assert.equal(entry.id, 'local');
  assert.equal(entry.usable, true);
  assert.match(entry.status, /本地可用.*已驳回/);
  assert.deepEqual(entry.usedBy, ['a', 'b']);
  assert.equal(unifiedSkillVersion(rejected)?.id, 'local');
});
test('mixed and unavailable usage do not create false uniformity, source only selects viewing', () => {
  const mixed = { ...skill, bindings: skill.bindings.map((binding, index) => ({ ...binding, selectedVersionId: index ? 'enterprise' : 'local' })) };
  assert.equal(unifiedSkillVersion(mixed), undefined);
  assert.equal(initialSkillViewingVersion(mixed, 'a'), 'local');
  assert.equal(initialSkillViewingVersion(mixed, 'b'), 'enterprise');
  assert.equal(initialSkillViewingVersion(mixed), 'enterprise');
  assert.equal(unifiedSkillVersion({ ...mixed, bindings: mixed.bindings.map(binding => ({ ...binding, selectedVersionId: 'missing' })) }), undefined);
});
test('no versions returns an empty viewing ID; dates sort without inventing timestamps', () => {
  assert.equal(initialSkillViewingVersion({ ...skill, versions: [], localVersions: [] }), '');
  assert.deepEqual(buildSkillVersions(skill).map(entry => entry.id), ['local', 'enterprise']);
});

test('selection offers the current public release and personal versions without removing public history', () => {
  const historical = { ...approved, id: 'old', version: '0.9' };
  const item = { ...skill, versions: [...skill.versions, historical], usableVersionIds: [...skill.usableVersionIds, historical.id] };
  const options = buildSkillSelectionOptions(item);
  assert.deepEqual(options.map(option => option.id), ['follow-platform', 'local']);
  assert.equal(options[0].label, '企业版 1.0');
  assert.equal(options[0].usable, true);
  assert.equal(buildSkillVersions(item).length, 3);
  assert.equal(unifiedSkillSelection(item, options)?.id, 'local');
});

test('public followers are one selection even when employee releases differ', () => {
  const newer = { ...approved, id: 'enterprise-v2', version: '2.0' };
  const item: SkillLibraryItem = { ...skill, versions: [...skill.versions, newer], bindings: [
    { ...skill.bindings[0], selectedVersionId: approved.id, selectionMode: 'follow-platform' },
    { ...skill.bindings[1], currentVersion: newer, selectedVersionId: newer.id, selectionMode: 'follow-platform' },
  ] };
  assert.equal(unifiedSkillSelection(item)?.id, 'follow-platform');
  assert.equal(buildSkillSelectionOptions(item)[0].label, '企业版 1.0 / 企业版 2.0');
  assert.equal(unifiedSkillSelection({ ...item, bindings: [item.bindings[0], skill.bindings[1]] }), undefined);
});

test('missing public releases disable following but do not disable owner personal versions', () => {
  const item = { ...skill, bindings: skill.bindings.map(binding => ({ ...binding, currentVersion: null })) };
  assert.equal(buildSkillSelectionOptions(item)[0].usable, false);
  assert.equal(unifiedSkillSelection(item)?.id, 'local');
});
test('frontmatter is split for display only and unclosed metadata is ordinary text', () => {
  for (const newline of ['\n', '\r\n']) {
    const metadata = ['---', 'name: analysis', 'custom: untouched', '---', ''].join(newline);
    const raw = metadata + '# 内容' + newline;
    const parts = skillReadingParts(raw);
    assert.equal(parts.metadata + parts.body, raw);
    assert.equal(parts.body, '# 内容' + newline);
  }
  const unclosed = '---\nname: unchanged\n# 内容';
  assert.deepEqual(skillReadingParts(unclosed), { metadata: '', body: unclosed });
});
test('reading omits only the matching first title while raw content and other headings remain intact', () => {
  const raw = '---\r\nname: analysis\r\n---\r\n\r\n# 分析 ###\r\n\r\n正文\r\n\r\n## 能力边界\r\n保留内容\r\n';
  assert.equal(skillReadingParts(raw, '分析').body, '正文\r\n\r\n## 能力边界\r\n保留内容\r\n');
  assert.equal(skillReadingParts(raw).metadata + skillReadingParts(raw).body, raw);
  assert.equal(skillReadingParts(raw, '其他标题').body, skillReadingParts(raw).body);
  assert.equal(skillReadingParts('## 分析\n正文', '分析').body, '## 分析\n正文');
});
