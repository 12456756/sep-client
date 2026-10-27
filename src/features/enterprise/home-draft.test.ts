import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { GENERAL_ASSISTANT_ID } from './general-assistant';
import { createHomeDraft, homeMessage } from './home-draft';

describe('home draft', () => {
  it('starts with an empty assistant draft and an isolated composer identity', () => {
    const first = createHomeDraft();
    const second = createHomeDraft();
    assert.equal(first.text, '');
    assert.equal(first.employeeId, GENERAL_ASSISTANT_ID);
    assert.equal(first.context, '');
    assert.equal(first.epoch, 0);
    assert.deepEqual(first.attachment, { session: null, attachments: [] });
    assert.notEqual(first.composerId, second.composerId);
  });

  it('builds the submitted message with optional trimmed context', () => {
    assert.equal(homeMessage('  整理数据  ', '  输出结论  '), '整理数据\n\n补充上下文：\n输出结论');
    assert.equal(homeMessage('  整理数据  ', '   '), '整理数据');
  });
});
