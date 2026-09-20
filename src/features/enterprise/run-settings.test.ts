import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRunSettings, RUN_PERMISSIONS, conversationDocument } from './run-settings';

test('execution settings default to read-only with confirmation and expose exactly three backend presets', () => {
  assert.deepEqual(RUN_PERMISSIONS.map(item => item.id), ['read-only', 'workspace-edit', 'full-local']);
  assert.deepEqual(defaultRunSettings().permissions, { preset: 'read-only', approvalMode: 'confirm-each' });
});
test('conversation document keeps the real model, permission and directory without legacy switches', () => {
  const doc = conversationDocument('title', 'prompt', 'employee', 'model-b', {
    workDir: 'D:/work', permissions: { preset: 'workspace-edit', approvalMode: 'auto-approve' },
  });
  assert.equal(doc.conversation?.participants[0].modelId, 'model-b');
  assert.equal(doc.permissions.approvalMode, 'auto-approve');
  assert.equal(doc.permissions.preset, 'workspace-edit');
  assert.equal(doc.workspace.path, 'D:/work');
  assert.equal(doc.mode, 'conversation');
});
