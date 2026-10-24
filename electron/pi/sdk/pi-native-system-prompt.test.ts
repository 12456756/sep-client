import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { translatePiNativeSystemPrompt } from './pi-native-system-prompt'

const role = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'
const end = 'Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)'

describe('native Pi prompt translation', () => {
  it('translates only SDK text while retaining real tools, paths, employee rules and skills', () => {
    const tail = '\n\n# 硅基员工节点执行要求\nAvailable tools:\n<skills>External English skill</skills>'
    const prompt = `${role}\n\nAvailable tools:\n- read: Real tool description\n- media_generate_image: Custom tool\nGuidelines:\n- Unknown English rule\n- Main documentation: D:/actual/README.md\n- Additional docs: D:/actual/docs\n- Examples: D:/actual/examples (extensions, custom tools, SDK)\n- ${end}${tail}\nCurrent working directory: D:/实际工作区`
    const translated = translatePiNativeSystemPrompt(prompt)
    assert.ok(translated.startsWith('你运行在 Pi 中。你通过读取文件、执行命令、编辑代码和创建新文件来帮助用户。'))
    for (const text of ['可用工具：', '主要文档：D:/actual/README.md', '附加文档：D:/actual/docs', '示例：D:/actual/examples', '当前工作目录：D:/实际工作区', '- read: Real tool description', '- media_generate_image: Custom tool', '- Unknown English rule', tail]) assert.ok(translated.includes(text), text)
    assert.doesNotMatch(translated, /自动编排规划 Agent/)
    assert.equal(translatePiNativeSystemPrompt(translated), translated)
  })

  it('does not replace unrelated summary or custom prompts', () => {
    for (const prompt of ['Summarize the conversation.', 'Custom employee prompt']) assert.equal(translatePiNativeSystemPrompt(prompt), prompt)
  })
})
