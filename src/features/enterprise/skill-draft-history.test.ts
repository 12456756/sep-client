import assert from 'node:assert/strict';
import test from 'node:test';
import { changeSkillDraft, createSkillDraftHistory, resetSkillDraft, undoSkillDraft } from './skill-draft-history';

test('three adopted rounds undo in order while revisions remain monotonic', () => {
  let draft = createSkillDraftHistory('original');
  for (const id of ['first', 'second', 'third']) draft = changeSkillDraft(draft, draft.revision, id, 'rewrite', id);
  assert.equal(undoSkillDraft(draft, 'first'), draft);
  assert.equal(undoSkillDraft(draft, 'second'), draft);
  for (const [id, expected, revision] of [['third', 'second', 4], ['second', 'first', 5], ['first', 'original', 6]] as const) {
    draft = undoSkillDraft(draft, id);
    assert.equal(draft.content, expected);
    assert.equal(draft.revision, revision);
  }
  assert.deepEqual(draft.changes, []);
  assert.equal(undoSkillDraft(draft, 'first'), draft);
});

test('a manual editing session is one layer and blocks earlier adopted changes', () => {
  let draft = changeSkillDraft(createSkillDraftHistory('original'), 0, 'round', 'rewrite', 'adopted');
  draft = changeSkillDraft(draft, draft.revision, 'manual-session', 'manual', 'first keystroke');
  draft = changeSkillDraft(draft, draft.revision, 'manual-session', 'manual', 'finished edit');
  assert.equal(draft.changes.length, 2);
  assert.equal(undoSkillDraft(draft, 'round'), draft);
  draft = undoSkillDraft(draft, 'manual-session');
  assert.equal(draft.content, 'adopted');
  draft = undoSkillDraft(draft, 'round');
  assert.equal(draft.content, 'original');
});

test('separate manual sessions can be undone independently', () => {
  let draft = createSkillDraftHistory('original');
  draft = changeSkillDraft(draft, 0, 'session-a', 'manual', 'first edit');
  draft = changeSkillDraft(draft, 1, 'session-b', 'manual', 'second edit');
  assert.equal(draft.changes.length, 2);
  draft = undoSkillDraft(draft, 'session-b');
  assert.equal(draft.content, 'first edit');
  draft = undoSkillDraft(draft, 'session-a');
  assert.equal(draft.content, 'original');
});

test('typing back the original content removes only the empty manual layer and invalidates previews', () => {
  let draft = changeSkillDraft(createSkillDraftHistory('original'), 0, 'round', 'rewrite', 'adopted');
  draft = changeSkillDraft(draft, 1, 'manual', 'manual', 'changed');
  draft = changeSkillDraft(draft, 2, 'manual', 'manual', 'adopted');
  assert.deepEqual(draft.changes.map(change => change.id), ['round']);
  assert.equal(draft.revision, 3);
  assert.equal(changeSkillDraft(draft, 1, 'outdated', 'rewrite', 'old suggestion'), draft);
  assert.equal(undoSkillDraft(draft, 'round').content, 'original');
});

test('undo and new adoption create a new branch without reviving the abandoned round', () => {
  let draft = changeSkillDraft(createSkillDraftHistory('original'), 0, 'first', 'rewrite', 'first');
  draft = changeSkillDraft(draft, 1, 'second', 'rewrite', 'second');
  draft = undoSkillDraft(draft, 'second');
  assert.equal(changeSkillDraft(draft, 1, 'stale', 'rewrite', 'stale'), draft);
  draft = changeSkillDraft(draft, draft.revision, 'new-third', 'rewrite', 'new branch');
  assert.deepEqual(draft.changes.map(change => change.id), ['first', 'new-third']);
  assert.equal(undoSkillDraft(draft, 'second'), draft);
  draft = undoSkillDraft(draft, 'new-third');
  assert.equal(draft.content, 'first');
  assert.equal(undoSkillDraft(draft, 'first').content, 'original');
});

test('saving, cancelling or changing source clears undo history without resetting revisions', () => {
  const initial = changeSkillDraft(createSkillDraftHistory('original'), 0, 'round', 'rewrite', 'adopted');
  for (const source of ['original', 'adopted', 'different source']) {
    const reset = resetSkillDraft(initial, source);
    assert.equal(reset.content, source);
    assert.equal(reset.revision, 2);
    assert.deepEqual(reset.changes, []);
    assert.equal(undoSkillDraft(reset, 'round'), reset);
  }
});

test('no-op adoption, duplicate IDs and outdated undo cannot corrupt the stack', () => {
  const draft = changeSkillDraft(createSkillDraftHistory('original'), 0, 'round', 'rewrite', 'adopted');
  assert.equal(changeSkillDraft(draft, 1, 'noop', 'rewrite', 'adopted'), draft);
  assert.equal(changeSkillDraft(draft, 1, 'round', 'rewrite', 'duplicate'), draft);
  const changedOutsideHistory = { ...draft, content: 'unexpected edit' };
  assert.equal(undoSkillDraft(changedOutsideHistory, 'round'), changedOutsideHistory);
});

test('manual previews retain the first source and final edit after undo and branching', () => {
  let draft = createSkillDraftHistory('original');
  draft = changeSkillDraft(draft, draft.revision, 'manual-a', 'manual', 'typing');
  draft = changeSkillDraft(draft, draft.revision, 'manual-a', 'manual', 'finished');
  const snapshot = { id: 'manual-a', before: 'original', after: 'finished', status: 'applied' };
  assert.deepEqual(draft.manualEdits, [snapshot]);
  draft = undoSkillDraft(draft, 'manual-a');
  assert.deepEqual(draft.manualEdits, [{ ...snapshot, status: 'undone' }]);
  draft = changeSkillDraft(draft, draft.revision, 'new-round', 'rewrite', 'new branch');
  draft = changeSkillDraft(draft, draft.revision, 'manual-b', 'manual', 'another edit');
  assert.deepEqual(draft.changes.map(change => change.id), ['new-round', 'manual-b']);
  assert.deepEqual(draft.manualEdits, [
    { ...snapshot, status: 'undone' },
    { id: 'manual-b', before: 'new branch', after: 'another edit', status: 'applied' },
  ]);
  assert.equal(undoSkillDraft(draft, 'manual-a'), draft);
});

test('empty manual sessions disappear while reset clears undone previews', () => {
  let draft = createSkillDraftHistory('original');
  draft = changeSkillDraft(draft, draft.revision, 'empty', 'manual', 'temporary');
  draft = changeSkillDraft(draft, draft.revision, 'empty', 'manual', 'original');
  assert.deepEqual(draft.manualEdits, []);
  draft = changeSkillDraft(draft, draft.revision, 'manual', 'manual', 'edited');
  draft = undoSkillDraft(draft, 'manual');
  const reset = resetSkillDraft(draft, 'original');
  assert.equal(reset.revision, draft.revision + 1);
  assert.deepEqual(reset.manualEdits, []);
  assert.deepEqual(reset.changes, []);
});
