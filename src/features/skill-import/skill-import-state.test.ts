import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptSkillImportSnapshot } from './use-skill-import'

const base = {
  revision: 3, visible: true, phase: 'scanning' as const, clientVersion: '0.3.2', protocolVersion: 1 as const,
  sessionId: 'session_1', instanceId: 'sep-default', siteLabel: 'SEP', initiatorLabel: 'Admin', scope: 'user' as const,
  roots: [], pairing: null, devices: [], progress: { phase: 'scanning', completed: 1, total: 3 }, error: null,
  persistenceAvailable: true, busySessionId: null,
}

test('ignores a delayed initial snapshot after a newer state event', () => {
  const newer = { ...base, revision: 4, phase: 'results' as const }
  assert.equal(acceptSkillImportSnapshot(newer, base), newer)
})

test('accepts equal revisions and newer snapshots', () => {
  const updated = { ...base, visible: false }
  assert.equal(acceptSkillImportSnapshot(base, updated), updated)
  const newer = { ...base, revision: 4, phase: 'ready' as const }
  assert.equal(acceptSkillImportSnapshot(base, newer), newer)
})
