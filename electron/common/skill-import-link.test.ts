import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseSkillImportLink } from './skill-import-link'

test('accepts only registered skill import links', () => {
  assert.deepEqual(parseSkillImportLink('sep-import://skills/v1?instanceId=sep-default&sessionId=session_1', new Set(['sep-default'])), { instanceId: 'sep-default', sessionId: 'session_1' })
  assert.equal(parseSkillImportLink('sep-import://skills/v1?instanceId=sep-default&sessionId=session_1&x=y', new Set(['sep-default'])), null)
  assert.equal(parseSkillImportLink('sep-import://skills/v1?instanceId=other&sessionId=session_1', new Set(['sep-default'])), null)
  assert.equal(parseSkillImportLink('sep-import://skills/v1?instanceId=sep-default&sessionId=../secret', new Set(['sep-default'])), null)
  assert.equal(parseSkillImportLink('sep-import://skills/v1?instanceId=sep-default&instanceId=other&sessionId=session_1', new Set(['sep-default'])), null)
})
