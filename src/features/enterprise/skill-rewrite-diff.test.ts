import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSkillRewriteDiff } from './skill-rewrite-diff';

const changed = (parts: ReturnType<typeof buildSkillRewriteDiff>['before']): string => parts.filter(part => part.changed).map(part => part.text).join('');

test('unchanged Markdown and frontmatter have no highlights', () => {
  const source = '---\r\nname: 促销\r\n---\r\n# 工作要求\r\n保持原文\r\n';
  const result = buildSkillRewriteDiff(source, source);
  assert.equal(changed(result.before), '');
  assert.equal(changed(result.after), '');
  assert.equal(result.before.map(part => part.text).join(''), source);
});

test('highlights multiple Chinese replacements without marking surrounding text', () => {
  const result = buildSkillRewriteDiff('# 标题\n只适用于淘宝平台；输出表格。\n', '# 标题\n只适用于京东平台；输出报告。\n');
  assert.equal(changed(result.before), '淘宝表格');
  assert.equal(changed(result.after), '京东报告');
});

test('insertions and deletions keep later unchanged sections neutral', () => {
  const before = '# 工作要求\n- 旧要求\n## 输出\n保持不变\n';
  const after = '# 工作要求\n## 输出\n保持不变\n- 新要求\n';
  const result = buildSkillRewriteDiff(before, after);
  assert.equal(changed(result.before), '- 旧要求\n');
  assert.equal(changed(result.after), '- 新要求\n');
  assert.equal(result.before.map(part => part.text).join(''), before);
  assert.equal(result.after.map(part => part.text).join(''), after);
});

test('handles empty sources, whitespace changes and complete removal', () => {
  assert.equal(changed(buildSkillRewriteDiff('', '新增\n').after), '新增\n');
  assert.equal(changed(buildSkillRewriteDiff('删除\n', '').before), '删除\n');
  assert.deepEqual(buildSkillRewriteDiff('', ''), { before: [], after: [] });
  const result = buildSkillRewriteDiff('要求\r\n', '要求\n');
  assert.equal(result.before.map(part => part.text).join(''), '要求\r\n');
  assert.ok(changed(result.before));
});

test('keeps emoji and combining characters intact when highlighting', () => {
  const result = buildSkillRewriteDiff('角色👩‍💻与é', '角色👨‍💻与è');
  assert.equal(changed(result.before), '👩‍💻é');
  assert.equal(changed(result.after), '👨‍💻è');
});

test('large replacements stay bounded and preserve the complete source', () => {
  const before = '共同开头\n' + '甲'.repeat(50_000) + '\n共同结尾';
  const after = '共同开头\n' + '乙'.repeat(50_000) + '\n共同结尾';
  const result = buildSkillRewriteDiff(before, after);
  assert.equal(changed(result.before), '甲'.repeat(50_000));
  assert.equal(changed(result.after), '乙'.repeat(50_000));
  assert.equal(result.before.map(part => part.text).join(''), before);
  assert.equal(result.after.map(part => part.text).join(''), after);
});
