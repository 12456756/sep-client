import assert from 'node:assert/strict';
import test from 'node:test';
import { SkillRewriteSession, effectiveRewriteStatus, type RewriteRound } from './skill-rewrite-session';
import { changeSkillDraft, createSkillDraftHistory } from './skill-draft-history';
import type { SkillRewriteResult } from '../../shared/skill-rewrite';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const round: RewriteRound = { kind: 'rewrite', id: 'request-a', prompt: 'Shorten', source: '# Original', revision: 2, model: 'model', status: 'generating' };
const result: SkillRewriteResult = { requestId: round.id, content: '# Short', summary: 'Shortened', changes: [{ kind: 'change', title: 'Short', detail: 'Shorten body' }] };

test('leaving an unchanged editor ends editing, including edits reverted to the original', () => {
  for (const reverted of [false, true]) {
    const session = new SkillRewriteSession();
    let draftState = createSkillDraftHistory(round.source);
    if (reverted) {
      draftState = changeSkillDraft(draftState, draftState.revision, 'edit-a', 'manual', '# Changed');
      draftState = changeSkillDraft(draftState, draftState.revision, 'edit-b', 'manual', round.source);
    }
    session.draft = { source: round.source, viewingVersionId: 'v1', draftState, editing: true, name: '' };
    session.update({ prompt: 'Unsent input' });
    assert.equal(session.finishUnchangedEditing(), true);
    assert.equal(session.draft, undefined);
    assert.equal(session.getSnapshot().prompt, '');
  }
});

test('leaving preserves actual draft changes, active requests and pending suggestions', async () => {
  const session = new SkillRewriteSession();
  session.draft = { source: '# Base', viewingVersionId: 'v1', draftState: { ...createSkillDraftHistory(round.source), revision: round.revision }, editing: true, name: '' };
  assert.equal(session.finishUnchangedEditing(), false);
  session.draft.source = round.source;
  const response = deferred<SkillRewriteResult>();
  const pending = session.generate(round, () => response.promise);
  assert.equal(session.finishUnchangedEditing(), false);
  response.resolve(result);
  await pending;
  assert.equal(session.finishUnchangedEditing(), false);
  session.setRounds(rounds => rounds.map(item => item.kind === 'rewrite' ? { ...item, status: 'ignored' } : item));
  assert.equal(session.finishUnchangedEditing(), true);
});

test('leaving and returning during generation retains the request, draft and completed suggestion', async () => {
  const session = new SkillRewriteSession();
  const response = deferred<SkillRewriteResult>();
  const draft = changeSkillDraft(createSkillDraftHistory('# Base'), 0, 'edit', 'manual', round.source);
  session.draft = { source: '# Base', viewingVersionId: 'v1', draftState: draft, editing: true, name: 'Draft name' };
  let updates = 0;
  const leave = session.subscribe(() => updates++);
  let calls = 0;
  const pending = session.generate(round, async () => { calls++; return response.promise; });
  leave();
  const updatesAtLeave = updates;
  assert.equal(session.getSnapshot().activeRequestId, round.id);
  assert.equal(session.draft.draftState, draft);
  await session.generate({ ...round, id: 'duplicate' }, async () => { throw new Error('duplicate'); });
  assert.equal(calls, 1);
  response.resolve(result);
  await pending;
  assert.equal(updates, updatesAtLeave);
  const returnToPage = session.getSnapshot();
  assert.equal(returnToPage.activeRequestId, null);
  assert.deepEqual(returnToPage.rounds[0], { ...round, status: 'pending', result });
  assert.equal(session.draft.name, 'Draft name');
  const unsubscribe = session.subscribe(() => updates++);
  session.update({ prompt: 'Next adjustment' });
  assert.equal(updates, updatesAtLeave + 1);
  unsubscribe();
});

test('explicit stop rejects late results and a failed stop leaves generation available', async () => {
  const session = new SkillRewriteSession();
  const response = deferred<SkillRewriteResult>();
  const pending = session.generate(round, () => response.promise);
  assert.equal(await session.cancel(async () => { throw new Error('Cannot stop'); }), false);
  assert.equal(session.getSnapshot().activeRequestId, round.id);
  assert.equal(session.getSnapshot().cancelError, 'Cannot stop');
  assert.equal(await session.cancel(async id => { assert.equal(id, round.id); }), true);
  session.reset();
  response.resolve(result);
  await pending;
  assert.deepEqual(session.getSnapshot().rounds, []);
});

test('background failures are retained for retry and mismatched responses are rejected', async () => {
  const session = new SkillRewriteSession();
  const response = deferred<SkillRewriteResult>();
  const pending = session.generate(round, () => response.promise);
  response.reject(new Error('Offline'));
  await pending;
  assert.equal(session.getSnapshot().rounds[0].status, 'failed');
  assert.equal(session.getSnapshot().activeRequestId, null);
  await session.generate({ ...round, id: 'request-b' }, async () => result);
  assert.equal(session.getSnapshot().rounds[1].status, 'failed');
});

test('identity changes cannot publish old results into another workspace', async () => {
  let active = true;
  const old = new SkillRewriteSession(() => active);
  const response = deferred<SkillRewriteResult>();
  const pending = old.generate(round, () => response.promise);
  active = false;
  const current = new SkillRewriteSession();
  response.resolve(result);
  await pending;
  assert.deepEqual(current.getSnapshot().rounds, []);
  assert.equal(old.getSnapshot().rounds[0].status, 'generating');
});

test('continued adjustments retain history and changes to the draft invalidate old suggestions', async () => {
  const session = new SkillRewriteSession();
  await session.generate(round, async () => result);
  assert.equal(effectiveRewriteStatus(session.getSnapshot().rounds[0] as RewriteRound, round.revision + 1), 'stale');
  await session.generate({ ...round, id: 'request-b' }, async input => {
    assert.deepEqual(input.history, [{ prompt: round.prompt, content: result.content, status: 'pending' }]);
    return { ...result, requestId: input.requestId };
  });
  assert.deepEqual(session.getSnapshot().rounds.map(item => item.status), ['superseded', 'pending']);
});
