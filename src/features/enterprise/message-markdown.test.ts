import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageContent } from '../../components/enterprise/MessageContent'
import { messageSummary } from './message-markdown'

let previousReact: unknown
beforeEach(() => { previousReact = Reflect.get(globalThis, 'React'); Reflect.set(globalThis, 'React', React) })
afterEach(() => { if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React'); else Reflect.set(globalThis, 'React', previousReact) })

function render(content: string): string {
  return renderToStaticMarkup(React.createElement(MessageContent, { content }))
}

test('Chinese punctuation beside strong markers renders in the reported reply', () => {
  const content = [
    '已使用视频模型直接生成，工具返回**生成成功、已保存**。',
    '',
    '- **实际规格：**1080×1920竖屏、24帧、带音频、MP4',
    '- **实际时长：**4.064秒',
    '- **实际费用**：￥28.80，已结算',
    '',
    '**交付仍有一项限制：**工具未返回视频路径或下载链接。',
  ].join('\n')
  const html = render(content)
  for (const label of ['生成成功、已保存', '实际规格：', '实际时长：', '实际费用', '交付仍有一项限制：']) {
    assert.ok(html.includes(`<strong>${label}</strong>`), label)
  }
  assert.doesNotMatch(html, /\*\*/)
  assert.match(html, /<ul>/)
})

test('Chinese quotes and nested formatting coexist with GFM tables and strikethrough', () => {
  const html = render('新版采用**“出发，就现在”**的场景创意，**重点含*强调*：**正文\n\n| 项目 | 结果 |\n| --- | --- |\n| 时长 | ~~旧值~~ |')
  assert.match(html, /<strong>“出发，就现在”<\/strong>/)
  assert.match(html, /<strong>重点含<em>强调<\/em>：<\/strong>/)
  assert.match(html, /<table>/)
  assert.match(html, /<del>旧值<\/del>/)
})

test('literal stars in inline code, fenced code and escaped text stay literal', () => {
  const html = render('`**实际规格：**1080`\n\n```text\n**交付限制：**工具\n```\n\n\\*\\*保留星号\\*\\*')
  assert.match(html, /<code>\*\*实际规格：\*\*1080<\/code>/)
  assert.match(html, /<code class="language-text">\*\*交付限制：\*\*工具\n<\/code>/)
  assert.match(html, /<p>\*\*保留星号\*\*<\/p>/)
  assert.doesNotMatch(html, /<strong>/)
})

test('unfinished streamed markers stay readable and render when the closing marker arrives', () => {
  assert.match(render('**实际规格：'), /<p>\*\*实际规格：<\/p>/)
  assert.match(render('**实际规格：*'), /<p>\*<em>实际规格：<\/em><\/p>/)
  assert.match(render('**实际规格：**1080'), /<strong>实际规格：<\/strong>1080/)
  assert.match(render('**实际规格： **1080'), /\*\*实际规格： \*\*1080/)
})

test('HTML, remote images and unsafe links retain the existing display restrictions', () => {
  const html = render('<script>alert(1)</script>\n\n[危险](javascript:alert(1)) [查看记录](https://example.com/video) ![视频封面](https://example.com/cover.png)')
  assert.doesNotMatch(html, /<script|<img|javascript:/)
  assert.match(html, /<span>危险<\/span>/)
  assert.match(html, /href="https:\/\/example.com\/video" target="_blank" rel="noopener noreferrer"/)
  assert.match(html, /\[图片：视频封面\]/)
})

test('summaries extract readable text with Chinese emphasis, links, code and block boundaries', () => {
  assert.equal(messageSummary('工具返回**生成成功、已保存**。\n\n- **实际规格：**1080×1920\n- [查看记录](https://example.com)\n\n`**原样代码**`'),
    '工具返回生成成功、已保存。 实际规格：1080×1920 查看记录 **原样代码**')
  assert.equal(messageSummary('| 项目 | 结果 |\n| --- | --- |\n| 时长 | 4秒 |'), '项目 结果 时长 4秒')
  assert.equal(messageSummary('第一行  \n第二行\n\n> 第三行'), '第一行 第二行 第三行')
  assert.equal(messageSummary('![封面](https://example.com/image.png)\n\n```text\n**代码**\n```'), '封面 **代码**')
})

test('summaries preserve escaped stars and hide raw HTML and link definitions', () => {
  assert.equal(messageSummary('\\*\\*文字\\*\\*'), '**文字**')
  assert.equal(messageSummary('正文 <b>强调</b>\n\n<script>alert(1)</script>\n\n[ref]: https://example.com'), '正文 强调')
  assert.equal(messageSummary(''), '')
})
