import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generalAssistant, GENERAL_ASSISTANT_ID } from './general-assistant';
import { conversationDocument } from './run-settings';

test('general assistant is a separate chat option with common models and no skills', () => {
  const employees = [{ allowedModels: ['a', 'b'] }, { allowedModels: ['b', 'c'] }];
  const assistant = generalAssistant(employees);
  assert.equal(assistant.id, GENERAL_ASSISTANT_ID);
  assert.equal(assistant.name, '通用助手');
  assert.deepEqual(assistant.allowedModels, ['b']);
  assert.deepEqual(assistant.skillIds, []);
  assert.equal(employees.length, 2);
  assert.deepEqual(generalAssistant([]).allowedModels, []);
});

test('general conversation document uses no synthetic subscription or employee participant', () => {
  const document = conversationDocument('chat', 'hello', GENERAL_ASSISTANT_ID, 'model-a');
  assert.equal(document.conversation?.kind, 'general');
  assert.equal(document.conversation?.modelId, 'model-a');
  assert.deepEqual(document.conversation?.participants, []);
  assert.equal(document.conversation?.activeSubscriptionId, null);
});
