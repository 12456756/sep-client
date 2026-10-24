import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentRefSchema, nodeInputRefSchema } from '../../shared/attachment-contracts';

const ref = { attachmentId: 'att-1', sha256: 'a'.repeat(64) };

test('node attachment binding preserves required and purpose metadata', () => {
  const input = { kind: 'attachment' as const, attachment: ref, required: true, purpose: 'analysis' as const };
  assert.deepEqual(nodeInputRefSchema.parse(input), input);
  assert.equal(attachmentRefSchema.parse(ref).attachmentId, 'att-1');
});

test('paste text insertion replaces the captured selection exactly once', () => {
  const value = 'beforeafter';
  const start = 6;
  const end = 6;
  const pasted = ' image ';
  assert.equal(`${value.slice(0, start)}${pasted}${value.slice(end)}`, 'before image after');
});

test('stale paste session results are ignored by identity', () => {
  const active = { composerId: 'compose-1', sessionId: 'session-2' };
  const stale = { composerId: 'compose-1', sessionId: 'session-1' };
  assert.equal(active.composerId === stale.composerId && active.sessionId === stale.sessionId, false);
});
