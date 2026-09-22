import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { processActivityLabel, currentWorkOperation } from './work-process'
import type { WorkActivity } from '../../shared/work-activity'

const activity = (toolName: string, state: WorkActivity['state'] = 'running'): WorkActivity => ({
  id: 'tool:one', runId: 'run-one', toolName, state, text: 'Executing tool: ' + toolName, startedAt: 1,
})

describe('user-facing work process', () => {
  it('names built-in and browser operations in Chinese, without exposing protocol names', () => {
    for (const [tool, label] of Object.entries({ ls: '查看目录', find: '查找文件', grep: '搜索文件内容', read: '读取文件', bash: '执行命令', write: '写入文件', edit: '编辑文件', mcp__playwright__browser_navigate: '打开网页', mcp__playwright__browser_snapshot: '读取网页内容', mcp__playwright__browser_click: '点击网页元素', mcp__other__unknown: '执行扩展操作' })) {
      assert.equal(processActivityLabel(activity(tool)), label)
    }
  })
  it('uses live operations, not completed actions or raw logs, for the current status', () => {
    assert.equal(currentWorkOperation('running', [activity('ls', 'completed')]), '正在处理，请稍候')
    assert.equal(currentWorkOperation('running', [activity('ls')]), '正在查看目录')
    assert.equal(currentWorkOperation('waiting-user', [activity('bash', 'waiting-user')]), '等待你的确认：执行命令')
    assert.equal(currentWorkOperation('completed', [activity('ls')]), '本轮工作已完成')
    assert.equal(currentWorkOperation('paused', [activity('ls')]), '工作已终止')
    assert.equal(currentWorkOperation('failed', [activity('ls')]), '工作已中断')
    assert.equal(currentWorkOperation('arranging', []), '正在准备工作')
  })
  it('keeps real step titles but does not show raw session errors', () => {
    assert.equal(processActivityLabel({ ...activity(''), toolName: undefined, text: '开始执行：整理资料' }), '整理资料')
    assert.equal(processActivityLabel({ ...activity(''), toolName: undefined, text: '运行遇到问题：Error: 400 status code' }), '本轮处理遇到问题')
  })
})
