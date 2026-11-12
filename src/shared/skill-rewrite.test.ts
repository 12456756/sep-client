import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { skillRewriteInputSchema, skillRewriteOutputSchema, splitSkillRewriteSource } from './skill-rewrite'

test('rewrite source splitting retains metadata and line endings exactly', () => {
  for (const metadata of ['---\nname: report\ntools: [read]\n---\n', '\uFEFF\r\n--- \r\nname: report\r\ncustom: true\r\n---\r\n']) {
    assert.deepEqual(splitSkillRewriteSource(metadata + '# Body\r\n'), { metadata, body: '# Body\r\n' })
  }
  assert.deepEqual(splitSkillRewriteSource('# Body\n---\nMore'), { metadata: '', body: '# Body\n---\nMore' })
})

test('rewrite contracts reject tools, extra fields, oversized input and incomplete output', () => {
  const input = { requestId: '00000000-0000-4000-8000-000000000001', capabilityId: 'cap', versionId: 'v1',
    content: '# Body', modelId: 'model', prompt: 'Improve', history: [] }
  assert.ok(skillRewriteInputSchema.safeParse(input).success)
  for (const value of [{ ...input, tools: ['exec'] }, { ...input, prompt: ' ' }, { ...input, content: 'x'.repeat(100001) },
    { ...input, requestId: '../escape' }, { ...input, history: [{ prompt: 'Test', content: '# Body', status: 'executed' }] }]) {
    assert.equal(skillRewriteInputSchema.safeParse(value).success, false)
  }
  for (const value of [{ body: '# Body', summary: 'Done', changes: [] }, { body: '', summary: 'Done', changes: [] },
    { body: '# Body', summary: 'Done', changes: [{ kind: 'exec', title: 'Run', detail: 'Tool' }] }]) {
    assert.equal(skillRewriteOutputSchema.safeParse(value).success, false)
  }
})
