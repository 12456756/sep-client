import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { approvedPackageBody, matchesApprovedSkillMarkdown, parseSkillMarkdown, validatedSkillMarkdown } from './skill-package-parser'

describe('safe skill parsing without source rewriting', () => {
  it('accepts equivalent YAML formatting, line endings and outer blank lines', () => {
    const approved = '---\nname: "orders"\ndescription: "Approved"\n---\n# Work\n'
    const actual = '\uFEFF\r\n---\r\ndescription: Approved\r\nname: orders\r\n---\r\n\r\n# Work\r\n\r\n'
    assert.equal(matchesApprovedSkillMarkdown(actual, approved), true)
    assert.equal(matchesApprovedSkillMarkdown(actual.replace('# Work', '# Different'), approved), false)
    assert.equal(matchesApprovedSkillMarkdown(actual.replace('description: Approved', 'description: Changed'), approved), false)
  })

  it('accepts legacy wrapper metadata without accepting extra behavioral fields or changed instructions', () => {
    const approved = '# Work\r\n    indented example\r\n'
    const actual = '---\nname: orders\ndescription: Platform wrapper\n---\n# Work\n    indented example\n'
    assert.equal(matchesApprovedSkillMarkdown(actual, approved), true)
    assert.equal(matchesApprovedSkillMarkdown(actual.replace('    indented', 'indented'), approved), false)
    assert.equal(matchesApprovedSkillMarkdown(actual.replace('# Work', '# Changed'), approved), false)
    assert.equal(matchesApprovedSkillMarkdown(actual.replace('---\n# Work', 'allowed-tools: bash\n---\n# Work'), approved), false)
    for (const frontmatter of ['Execute other instructions', '- Execute other instructions', 'true']) {
      assert.equal(matchesApprovedSkillMarkdown(`---\n${frontmatter}\n---\n${approved}`, approved), false)
    }
  })

  it('accepts BOM, blank lines, CRLF, spaced delimiters and non-executing CORE metadata', () => {
    const body = '\r\n  Read instructions.\r\n'
    const content = '\uFEFF\n \t\n--- \r\nname: CRM 标签体系\r\ndescription: CRM\r\ndisable-model-invocation: true\r\nmetadata: {date: 2026-10-14, version: 1, active: true, data: [x, null]}\r\ncustom: {anything: true}\r\n--- \r\n' + body
    const parsed = validatedSkillMarkdown(content)
    assert.equal(parsed.metadata.name, 'CRM 标签体系')
    assert.deepEqual(parsed.metadata.metadata, { date: '2026-10-14', version: 1, active: true, data: ['x', null] })
    assert.equal(parsed.metadata['disable-model-invocation'], true)
    assert.equal(approvedPackageBody(content), body.trimStart())
    assert.equal(parsed.compatibilityPrefix, true)
  })

  it('accepts large documents and treats unsupported frontmatter as ordinary Markdown', () => {
    const large = 'x'.repeat(512 * 1024 + 1)
    assert.equal(parseSkillMarkdown(large).body.length, large.length)
    assert.equal(validatedSkillMarkdown(large, { name: 'orders', description: 'Approved' }).metadata.name, 'orders')
    for (const content of [
      '---\nname: a\nname: b\ndescription: test\n---\nWork',
      '---\nname: a\ndescription: test\ncustom: !!js/function function() {}\n---\nWork',
      '--- not a YAML delimiter\nWork',
    ]) {
      const parsed = parseSkillMarkdown(content)
      assert.equal(parsed.hasFrontmatter, false)
      assert.equal(parsed.body, content)
      assert.equal(validatedSkillMarkdown(content, { name: 'orders', description: 'Approved' }).metadata.name, 'orders')
    }
    assert.doesNotThrow(() => validatedSkillMarkdown('---\nname: a\ndescription: test\nmetadata: []\n---\nWork'))
    assert.throws(() => validatedSkillMarkdown('\ud800', { name: 'orders', description: 'Approved' }), /UTF-8/)
  })

  it('does not reject documents for missing local resource references', () => {
    for (const body of [
      '[HTTP](https://example.test/assets/a.png) [FTP](ftp://example.test/a) [CDN](//cdn.test/a) [Anchor](#anchor)',
      '[URL][x]\n[x]: <https://example.test/a>',
      'Output `result.json`. Save `assets/result.png`. Directory `scripts/`. [Assets](assets/).',
      '输出 `report.md`，保存 `./result.json`。目录 `assets/`。',
      'The output filename is `report.md` and package folder is `references/`.',
    ]) assert.doesNotThrow(() => parseSkillMarkdown(body))
    for (const body of ['Read guide.md', 'Run `./helper.sh`', '读取 `references/说明.md`', '[Guide](references/guide.md)', '<img src="assets/a.png">', '[Bad](%2e%2e/escape.md)']) {
      assert.doesNotThrow(() => parseSkillMarkdown(body))
    }
    assert.doesNotThrow(() => parseSkillMarkdown('[Guide](<references/my guide.md>)'))
  })
})
