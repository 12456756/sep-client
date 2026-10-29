import assert from 'node:assert/strict';
import test from 'node:test';
import { FOLLOW_PLATFORM_SKILL_VERSION, type SkillLibraryItem } from '../../shared/skill-library';
import { skillSelectionValue, selectedSkillVersion } from './skill-labels';

function library(): SkillLibraryItem {
  const versions = [
    { id: 'public-a', capabilityId: 'cap', scope: 'PLATFORM', status: 'PLATFORM_APPROVED', version: '1' },
    { id: 'public-b', capabilityId: 'cap', scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED', version: '2' },
    { id: 'personal', capabilityId: 'cap', scope: 'PERSONAL', status: 'ENTERPRISE_APPROVED', version: 'mine' },
  ];
  return { capability: { id: 'cap', name: 'Skill', description: '', type: 'SKILL' }, versions,
    usableVersionIds: versions.map(version => version.id), localVersions: [],
    bindings: versions.slice(0, 2).map(version => ({ subscriptionId: version.id, employeeId: version.id, currentVersion: version, selectedVersionId: version.id })) };
}

test('public bindings share follow mode even when their released versions differ', () => {
  assert.equal(skillSelectionValue(library()), FOLLOW_PLATFORM_SKILL_VERSION);
  assert.equal(selectedSkillVersion(library()), '');
});

test('personal selections stay distinct from follow mode', () => {
  const skill = library();
  skill.bindings = skill.bindings.map(binding => ({ ...binding, selectedVersionId: 'personal' }));
  assert.equal(skillSelectionValue(skill), 'personal');
  skill.bindings[0] = { ...skill.bindings[0], selectedVersionId: 'public-a' };
  assert.equal(skillSelectionValue(skill), '');
});

test('unuploaded personal source stays fixed in the selector', () => {
  const skill = library();
  skill.localVersions = [{ idempotencyKey: 'local', createdAt: '2026-10-29', request: { capabilityId: 'cap', parentVersionId: 'public-a', content: '# Mine' } }];
  skill.bindings = skill.bindings.map(binding => ({ ...binding, selectedVersionId: 'local' }));
  assert.equal(skillSelectionValue(skill), 'local');
});
