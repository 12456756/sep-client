import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SkillImportArtifactSchema, SkillImportCandidateSchema, SkillImportEventSchema, SkillImportPreviewSchema, SkillImportStateViewSchema } from './skill-import-contracts'

test('validates strict import contracts and safe state view', () => {
  const candidate = SkillImportCandidateSchema.parse({ candidateId: 'cand_1', revision: 1, name: 'Demo', description: null, sources: ['codex'], scope: 'user', locations: [{ rootId: 'root_1', rootLabel: '个人', relativePath: 'skills/demo' }], treeHash: null, availability: 'previewable', warnings: [] })
  assert.equal(candidate.name, 'Demo')
  assert.equal(SkillImportCandidateSchema.safeParse({ ...candidate, name: 'x'.repeat(161), description: 'x'.repeat(4001), locations: [{ rootId: 'root_1', rootLabel: 'Personal', relativePath: 'nested/'.repeat(150) + 'skill' }] }).success, true)
  assert.equal(SkillImportCandidateSchema.safeParse({ ...candidate, extra: true }).success, false)
  assert.equal(SkillImportPreviewSchema.safeParse({ requestId: 'req_1', candidateId: 'cand_1', snapshotId: 'snap_1', expiresAt: '2026-11-03T10:00:00.000Z', content: '# Demo', treeHash: 'a'.repeat(64), fileCount: 1, totalUncompressedBytes: 10, estimatedPackageBytes: 20, files: [{ relativePath: 'SKILL.md', bytes: 10 }], nextFilesCursor: null, warnings: [] }).success, true)
  assert.equal(SkillImportStateViewSchema.safeParse({ revision: 1, visible: true, phase: 'awaiting-local-consent', clientVersion: '0.3.2', protocolVersion: 1, sessionId: 'session_1', instanceId: 'sep-default', siteLabel: 'SEP', initiatorLabel: 'Admin', scope: 'user', roots: [], pairing: null, devices: [], progress: null, error: null, persistenceAvailable: true, busySessionId: null }).success, true)
})

test('retains safe paths without imposing client content, size, or file-count quotas', () => {
  for (const relativePath of ['/SKILL.md', 'C:\\skills\\SKILL.md', 'C:/skills/SKILL.md', '../SKILL.md', './SKILL.md', 'a/../b', 'a/\u0001']) {
    assert.equal(SkillImportCandidateSchema.safeParse({ candidateId: 'cand_1', revision: 1, name: 'Demo', description: null, sources: ['codex'], scope: 'user', locations: [{ rootId: 'root_1', rootLabel: 'Personal', relativePath }], treeHash: null, availability: 'previewable', warnings: [] }).success, false, relativePath)
  }
  const base = { requestId: 'req_1', candidateId: 'cand_1', snapshotId: 'snap_1', expiresAt: '2026-11-03T10:00:00.000Z', content: '# Demo', treeHash: 'a'.repeat(64), fileCount: 1, totalUncompressedBytes: 10, estimatedPackageBytes: 20, files: [{ relativePath: 'SKILL.md', bytes: 10 }], nextFilesCursor: null, warnings: [] }
  assert.equal(SkillImportPreviewSchema.safeParse({ ...base, content: 'x'.repeat(2 * 1024 * 1024 + 1) }).success, true)
  assert.equal(SkillImportPreviewSchema.safeParse({ ...base, fileCount: 10001 }).success, true)
  assert.equal(SkillImportPreviewSchema.safeParse({ ...base, totalUncompressedBytes: 500 * 1024 * 1024 + 1 }).success, true)
  assert.equal(SkillImportPreviewSchema.safeParse({ ...base, estimatedPackageBytes: 100 * 1024 * 1024 + 1 }).success, true)
  const artifact = { zipPath: 'artifacts/skill.zip', sha256: 'a'.repeat(64), fileCount: 1, totalSize: 20, filename: 'skill.zip', content: '# Demo', suggested: { name: null, description: null }, warnings: [] }
  assert.equal(SkillImportArtifactSchema.safeParse({ ...artifact, totalSize: 100 * 1024 * 1024 + 1 }).success, true)
  assert.equal(SkillImportArtifactSchema.safeParse({ ...artifact, fileCount: 10001 }).success, true)
  assert.equal(SkillImportPreviewSchema.safeParse({ ...base, files: [{ relativePath: 'large.bin', bytes: 500 * 1024 * 1024 + 1 }] }).success, true)
  for (const field of ['fileCount', 'totalUncompressedBytes', 'estimatedPackageBytes']) {
    for (const invalid of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(SkillImportPreviewSchema.safeParse({ ...base, [field]: invalid }).success, false)
    }
  }
  for (const field of ['fileCount', 'totalSize']) {
    for (const invalid of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(SkillImportArtifactSchema.safeParse({ ...artifact, [field]: invalid }).success, false)
    }
  }
})

test('accepts only the backend allowlisted event error codes and consumes the fixture', () => {
  const fixture = JSON.parse(readFileSync('src/shared/fixtures/skill-import-v1.json', 'utf8')) as { protocolVersion: number; preview: unknown }
  assert.equal(fixture.protocolVersion, 1)
  const parsedPreview = SkillImportPreviewSchema.parse({ ...(fixture.preview as object), expiresAt: '2026-11-03T10:00:00.000Z' })
  assert.equal(SkillImportEventSchema.safeParse({ eventId: 'event_1', commandId: 'cmd_1', sequence: 1, type: 'preview', payload: parsedPreview }).success, true)
  for (const code of ['CANDIDATE_CHANGED', 'SNAPSHOT_EXPIRED', 'PERMISSION_DENIED', 'SCAN_FAILED', 'PACKAGE_REJECTED', 'CLIENT_BUSY']) assert.equal(SkillImportEventSchema.safeParse({ eventId: 'event_1', commandId: 'cmd_1', sequence: 1, type: 'error', payload: { code, message: 'error', retryable: true } }).success, true)
  assert.equal(SkillImportEventSchema.safeParse({ eventId: 'event_1', commandId: 'cmd_1', sequence: 1, type: 'error', payload: { code: 'IMPORT_UNAVAILABLE', message: 'error', retryable: true } }).success, false)
})
