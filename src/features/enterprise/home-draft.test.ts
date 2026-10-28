import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { GENERAL_ASSISTANT_ID } from './general-assistant';
import { createHomeDraft } from './home-draft';

describe('home draft', () => {
  it('starts with an empty assistant draft and an isolated composer identity', () => {
    const first = createHomeDraft();
    const second = createHomeDraft();
    assert.equal(first.text, '');
    assert.equal(first.employeeId, GENERAL_ASSISTANT_ID);
    assert.equal(first.epoch, 0);
    assert.deepEqual(first.attachment, { session: null, attachments: [] });
    assert.notEqual(first.composerId, second.composerId);
  });

});
