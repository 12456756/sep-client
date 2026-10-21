import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { maxSkillEntryBytes } from '../../common/platform/skill-artifact-contract'
import { approvedPackageBody, matchesApprovedSkillMarkdown, parseSkillMarkdown, validatedSkillMarkdown, validateSkillResources } from './skill-package-parser'

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

  it('rejects duplicate keys, executable tags, invalid source and byte overflow', () => {
    for (const content of [
      '---\nname: a\nname: b\ndescription: test\n---\nWork',
      '---\nname: a\ndescription: test\ncustom: !!js/function function() {}\n---\nWork',
      '---\nname: a\ndescription: test\nmetadata: []\n---\nWork',
      '\ud800', '中'.repeat(Math.ceil(maxSkillEntryBytes / 3)),
    ]) assert.throws(() => validatedSkillMarkdown(content))
    assert.equal(parseSkillMarkdown('--- not a YAML delimiter\nWork').hasFrontmatter, false)
  })

  it('ignores external links, output names and directories but rejects concrete missing input files', () => {
    for (const body of [
      '[HTTP](https://example.test/assets/a.png) [FTP](ftp://example.test/a) [CDN](//cdn.test/a) [Anchor](#anchor)',
      '[URL][x]\n[x]: <https://example.test/a>',
      'Output `result.json`. Save `assets/result.png`. Directory `scripts/`. [Assets](assets/).',
      '输出 `report.md`，保存 `./result.json`。目录 `assets/`。',
      'The output filename is `report.md` and package folder is `references/`.',
    ]) assert.doesNotThrow(() => validateSkillResources(body))
    for (const body of ['Read guide.md', 'Run `./helper.sh`', '读取 `references/说明.md`', '[Guide](references/guide.md)', '<img src="assets/a.png">', '[Bad](%2e%2e/escape.md)']) {
      assert.throws(() => validateSkillResources(body), /missing local resource/)
    }
    assert.doesNotThrow(() => validateSkillResources('[Guide](<references/my guide.md>)', 'CRM 标签体系/SKILL.md', new Set(['CRM 标签体系/SKILL.md', 'CRM 标签体系/references/my guide.md'])))
  })
})
