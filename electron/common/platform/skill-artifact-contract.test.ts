import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  skillArtifactSchema, skillArtifactAvailableSchema, skillArtifactBlockedSchema,
  skillArtifactBlockedReasonSchema, skillArtifactFrontmatterSchema, skillArtifactParamsSchema,
  maxSkillArtifactBytes, skillArtifactNameSchema, skillNameComparisonKey,
} from './skill-artifact-contract'

const available = {
  protocolVersion: 1, capabilityId: 'cap-1', versionId: 'ver-1', approvedContentSha256: 'a'.repeat(64),
  status: 'AVAILABLE', format: 'single-file', installationDirectory: 'example-skill', entryPath: 'SKILL.md',
  entrySha256: 'b'.repeat(64), artifactSha256: 'b'.repeat(64), byteLength: 180, fileCount: 1,
  downloadPath: '/client/subscriptions/sub-1/skills/cap-1/versions/ver-1/artifact',
}
const blocked = { protocolVersion: 1, capabilityId: 'cap-1', versionId: 'ver-1',
  approvedContentSha256: 'a'.repeat(64), status: 'BLOCKED', reason: 'INVALID_ENTRY' }

describe('SEP skill artifact descriptor schema parity', () => {
  it('preserves complete single-file, ZIP and all BLOCKED variants', () => {
    for (const format of ['single-file', 'zip']) {
      assert.deepEqual(skillArtifactSchema.parse({ ...available, format }), { ...available, format })
    }
    for (const reason of skillArtifactBlockedReasonSchema.options) {
      assert.deepEqual(skillArtifactSchema.parse({ ...blocked, reason }), { ...blocked, reason })
    }
    assert.equal(skillArtifactAvailableSchema.safeParse(blocked).success, false)
    assert.equal(skillArtifactBlockedSchema.safeParse(available).success, false)
  })

  it('requires every descriptor field and rejects extra storage/secret fields', () => {
    for (const descriptor of [available, blocked]) {
      for (const key of Object.keys(descriptor)) {
        const missing: Record<string, unknown> = { ...descriptor }
        delete missing[key]
        assert.equal(skillArtifactSchema.safeParse(missing).success, false, key)
      }
      for (const extra of [
        { apiKey: 'private' }, { storageKey: 'private' }, { packageKey: 'private' },
        { absolutePath: '/tmp/private' }, { buffer: 'private' }, { signedUrl: 'https://example.com' },
      ]) assert.equal(skillArtifactSchema.safeParse({ ...descriptor, ...extra }).success, false)
    }
    assert.equal(skillArtifactSchema.safeParse({ ...available, reason: 'INVALID_ENTRY' }).success, false)
    for (const key of ['format', 'installationDirectory', 'entryPath', 'entrySha256', 'artifactSha256', 'byteLength', 'fileCount', 'downloadPath']) {
      assert.equal(skillArtifactSchema.safeParse({ ...blocked, [key]: available[key as keyof typeof available] }).success, false)
    }
    assert.equal(skillArtifactSchema.safeParse({ ...blocked, reason: 'UNKNOWN' }).success, false)
  })

  it('matches field type and inclusive size/count/name/hash boundaries', () => {
    for (const override of [
      { protocolVersion: 2 }, { status: 'UNKNOWN' }, { format: 'tar' },
      { approvedContentSha256: 'bad' }, { entrySha256: 'A'.repeat(64) }, { artifactSha256: 'a'.repeat(63) },
      { installationDirectory: '' }, { installationDirectory: 'Bad_Name' }, { installationDirectory: '../skill' },
      { installationDirectory: 'a'.repeat(65) }, { installationDirectory: 'a--b' },
      { byteLength: 0 }, { byteLength: -1 }, { byteLength: 1.5 }, { byteLength: '180' }, { byteLength: maxSkillArtifactBytes + 1 },
      { fileCount: 0 }, { fileCount: 1.5 }, { fileCount: 501 },
    ]) assert.equal(skillArtifactSchema.safeParse({ ...available, ...override }).success, false, JSON.stringify(override))
    assert.equal(skillArtifactSchema.safeParse({ ...available, byteLength: maxSkillArtifactBytes, fileCount: 500,
      installationDirectory: 'a'.repeat(64) }).success, true)
  })

  it('accepts only safe relative entry paths ending in SKILL.md', () => {
    for (const entryPath of ['SKILL.md', 'weekly/SKILL.md', 'bundle/weekly/SKILL.md']) {
      assert.equal(skillArtifactSchema.safeParse({ ...available, entryPath }).success, true)
    }
    for (const entryPath of ['', '/SKILL.md', '//SKILL.md', '../SKILL.md', './SKILL.md', 'a/../SKILL.md',
      'a/./SKILL.md', 'a//SKILL.md', 'a\\SKILL.md', 'C:/SKILL.md', 'a\0/SKILL.md', 'a\n/SKILL.md',
      'a\x7f/SKILL.md', 'CON.txt/SKILL.md', 'COM¹/SKILL.md', 'ＣＯＭ１.txt/SKILL.md', 'nul/SKILL.md',
      'a./SKILL.md', 'a /SKILL.md', 'a?/SKILL.md', 'a|/SKILL.md', 'a＜/SKILL.md',
      'skill.md', 'NOTSKILL.md', 'SKILL.md/', `${'a'.repeat(1020)}/SKILL.md`]) {
      assert.equal(skillArtifactSchema.safeParse({ ...available, entryPath }).success, false, entryPath)
    }
  })

  it('uses backend ID constraints in both identities, route params and each download path segment', () => {
    const params = { subscriptionId: 'sub-1', capabilityId: 'cap-1', versionId: 'ver-1' }
    assert.equal(skillArtifactParamsSchema.safeParse({ ...params, apiKey: 'private' }).success, false)
    for (const key of Object.keys(params)) {
      for (const value of ['a', 'Mock_123-valid', 'a'.repeat(128), '', '.', '..', 'a.b', 'a/b', 'a\\b', 'a:b',
        'a%2fb', 'a%252fb', 'a?b', 'a#b', 'a b', 'a\n', '\u4e2d\u6587', 'a'.repeat(129)]) {
        const valid = /^[a-zA-Z0-9_-]{1,128}$/.test(value)
        const updated = { ...params, [key]: value }
        assert.equal(skillArtifactParamsSchema.safeParse(updated).success, valid)
        const downloadPath = `/client/subscriptions/${updated.subscriptionId}/skills/${updated.capabilityId}/versions/${updated.versionId}/artifact`
        assert.equal(skillArtifactSchema.safeParse({ ...available, downloadPath }).success, valid)
        if (key !== 'subscriptionId') {
          assert.equal(skillArtifactSchema.safeParse({ ...available, [key]: value }).success, valid)
          assert.equal(skillArtifactSchema.safeParse({ ...blocked, [key]: value }).success, valid)
        }
      }
    }
  })

  it('rejects API-prefixed, absolute, query, fragment and suffixed download URLs', () => {
    for (const downloadPath of [`/api${available.downloadPath}`, `https://example.com${available.downloadPath}`,
      `${available.downloadPath}?token=private`, `${available.downloadPath}#private`, `${available.downloadPath}/extra`]) {
      assert.equal(skillArtifactSchema.safeParse({ ...available, downloadPath }).success, false)
    }
  })

  it('matches backend frontmatter validation, preserving custom metadata without trimming content', () => {
    const value = { name: 'example-skill', description: ' Description ', license: 'MIT', compatibility: 'Node',
      metadata: { author: 'mock' }, 'allowed-tools': 'Read Bash', custom: 'retained' }
    assert.deepEqual(skillArtifactFrontmatterSchema.parse(value), value)
    for (const override of [{ description: '' }, { description: ' \n ' }, { description: 'x'.repeat(1025) },
      { name: 'Bad_Name' }, { 'disable-model-invocation': 'true' }, { license: 1 }, { compatibility: '' }, { 'allowed-tools': ['Read'] }]) {
      assert.equal(skillArtifactFrontmatterSchema.safeParse({ ...value, ...override }).success, false)
    }
    assert.equal(skillArtifactFrontmatterSchema.safeParse({ name: 'a', description: 'x'.repeat(1024), compatibility: 'x'.repeat(500) }).success, true)
    const extra = { ...value, metadata: { version: 1, nested: { safe: true } }, 'disable-model-invocation': true }
    assert.deepEqual(skillArtifactFrontmatterSchema.parse(extra), extra)
  })

  it('accepts Unicode letters and numbers without rewriting names and compares only using NFKC', () => {
    for (const name of ['订单-处理', 'Orders', 'ＡＢＣ-１２３', '𠀀'.repeat(64), 'CRM 标签体系', 'SKU 生命周期管理', '电商 SOP 编排', 'CRM  标签', 'CRM\u00a0标签', 'CRM\u3000\u2002标签']) assert.equal(skillArtifactNameSchema.parse(name), name)
    for (const name of ['中'.repeat(65), '𠀀'.repeat(65), 'a--b', '-中', '中-', '../中', 'a_b', 'a\u200db', '½', 'a\u0301', ' CRM', 'CRM ', 'CRM\t标签', 'CRM\n标签', 'CRM\u2028标签', 'CRM -标签', 'CON', 'ｎｕｌ', 'COM1', 'COM¹', 'ＣＯＭ１', 'lpt9']) assert.equal(skillArtifactNameSchema.safeParse(name).success, false, name)
    assert.equal(skillNameComparisonKey('ＡＢＣ'), skillNameComparisonKey('abc'))
  })
})
