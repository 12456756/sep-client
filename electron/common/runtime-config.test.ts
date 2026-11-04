import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { resolveSkillImportInstances } from './runtime-config'

test('trusted import instances require local HTTPS configuration and unique IDs', () => {
  assert.equal(resolveSkillImportInstances()[0]!.instanceId, 'sep-default')
  const site = { instanceId: 'private', label: 'Private SEP', apiBaseUrl: 'https://private.example/api' }
  assert.deepEqual(resolveSkillImportInstances(JSON.stringify([site])), [site])
  for (const entries of [[{ ...site, apiBaseUrl: 'http://private.example/api' }], [site, site], [{ ...site, callback: 'https://attacker.example' }]]) {
    assert.throws(() => resolveSkillImportInstances(JSON.stringify(entries)))
  }
})
