import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { transformArrangementPlannerSystemPrompt } from './pi-planner-system-prompt'
import { ARRANGEMENT_PLANNER_RULES } from '../../domain/arrangement-planner-prompts'

const nativeRole = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'
const nativeEnd = 'Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)'

describe('planning system prompt transform', () => {
  it('translates fixed text and preserves dynamic paths, tools and external content', () => {
    const external = '\n\n<project_context>Available tools:\nBe concise in your responses\n</project_context>\n<skills>Custom English skill</skills>'
    const native = `${nativeRole}\n\nAvailable tools:\n- custom_tool: Unknown English description\n\nGuidelines:\n- Be concise in your responses\n- Unknown guideline\n- Show file paths clearly when working with files\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: D:/动态目录/README.md\n- Additional docs: D:/动态目录/docs\n- Examples: D:/动态目录/examples (extensions, custom tools, SDK)\n- ${nativeEnd}${external}\nCurrent working directory: D:/任务目录`
    const result = transformArrangementPlannerSystemPrompt(native)
    assert.ok(result.startsWith('你运行在 Pi 中。你通过读取文件、执行命令、编辑代码和创建新文件来帮助用户。'))
    for (const value of ['可用工具：', '主要文档：D:/动态目录/README.md', '附加文档：D:/动态目录/docs', '示例：D:/动态目录/examples', '当前工作目录：D:/任务目录', '- custom_tool: Unknown English description', '- Unknown guideline', external]) assert.ok(result.includes(value), value)
    assert.ok(result.endsWith(ARRANGEMENT_PLANNER_RULES))
    assert.doesNotMatch(result, /expert coding assistant|\{\{SDK/)
    assert.equal(transformArrangementPlannerSystemPrompt(result), result)
  })

  it('translates the empty tools list and preserves unknown English', () => {
    const native = `${nativeRole}\n\nAvailable tools:\n(none)\n\nFuture SDK text\n${nativeEnd}\nCurrent working directory: /tmp/task`
    const result = transformArrangementPlannerSystemPrompt(native)
    assert.ok(result.includes('可用工具：\n无'))
    assert.ok(result.includes('Future SDK text'))
  })

  it('does not turn unrelated summary prompts into planning requests', () => {
    const prompt = 'Summarize the conversation.\nCurrent working directory: /tmp/task'
    assert.equal(transformArrangementPlannerSystemPrompt(prompt), prompt)
  })
})
