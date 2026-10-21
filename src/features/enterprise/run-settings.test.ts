import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultAutoRunSettings, defaultConversationRunSettings, defaultRunSettings, RUN_PERMISSIONS, conversationDocument } from './run-settings';

test('execution settings default to read-only with confirmation and expose exactly three backend presets', () => {
  assert.deepEqual(RUN_PERMISSIONS.map(item => item.id), ['read-only', 'workspace-edit', 'full-local']);
  assert.deepEqual(defaultRunSettings().permissions, { preset: 'read-only', approvalMode: 'confirm-each' });
});
test('automatic orchestration defaults to full local access, automatic approval, and the supplied first model', () => {
  assert.deepEqual(defaultAutoRunSettings('model-a'), {
    workDir: '', modelId: 'model-a',
    permissions: { preset: 'full-local', approvalMode: 'auto-approve' },
  });
  assert.equal(defaultAutoRunSettings().modelId, '');
});
test('conversation defaults to full local access and automatic approval', () => {
  assert.deepEqual(defaultConversationRunSettings().permissions, { preset: 'full-local', approvalMode: 'auto-approve' });
  assert.equal(defaultRunSettings().permissions.preset, 'read-only');
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
test('conversation document uses conversation permission defaults when settings are omitted', () => {
  const doc = conversationDocument('title', 'prompt', 'employee', 'model-b');
  assert.deepEqual(doc.permissions, { preset: 'full-local', approvalMode: 'auto-approve' });
});
