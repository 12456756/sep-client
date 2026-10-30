import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillLeaveRegistry, createSkillPageState, enterSkillPage } from './skill-page-state';

test('employee entry resets filters while ordinary detail return preserves snapshot', () => {
  const state = { ...createSkillPageState(), query: 'old', versionFilter: 'personal' as const, sort: 'recent' as const, scrollTop: 350, focusId: 'old' };
  assert.equal(enterSkillPage(state, { name: 'skills' }), state);
  assert.equal(enterSkillPage(state, { name: 'skills', skillId: 'id', employeeFilterId: 'sub' }), state);
  assert.deepEqual(enterSkillPage(state, { name: 'skills', employeeFilterId: 'sub' }), { ...createSkillPageState(), sort: 'recent', employeeFilterId: 'sub' });
});
test('navigation guard supports rejection, cleanup and immediate scope isolation', () => {
  const registry = createSkillLeaveRegistry();
  const remove = registry.register('a', () => false);
  assert.equal(registry.mayLeave('a'), false);
  assert.equal(registry.mayLeave('b'), true);
  const removeNew = registry.register('a', () => true);
  remove();
  assert.equal(registry.mayLeave('a'), true);
  removeNew();
  assert.equal(registry.mayLeave('a'), true);
});
