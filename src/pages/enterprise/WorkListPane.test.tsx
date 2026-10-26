import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkItem } from '../../features/enterprise/types'
import { resetWorkRecordFilters } from '../../features/enterprise/work-record-filters'
import { WorkListPane } from './WorkListPane'

const work = {
  id: 'a', title: '季度报告', status: 'completed', workType: { state: 'unavailable' },
  currentEmployeeName: '小李', nextUserAction: null, messages: [], goal: '整理报告', updatedAt: 1,
} as unknown as WorkItem

let previousReact: unknown
beforeEach(() => { previousReact = Reflect.get(globalThis, 'React'); Reflect.set(globalThis, 'React', React) })
afterEach(() => { if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React'); else Reflect.set(globalThis, 'React', previousReact) })

function props(): Parameters<typeof WorkListPane>[0] {
  return { works: [work], records: [work], selectedWorkId: 'a', filters: resetWorkRecordFilters(), onFilters: () => {}, onSelect: () => {}, onCreate: () => {}, onClose: () => {}, onRetryTypes: () => {} }
}

test('work rows use one named button with semantic status and unknown-type icons', () => {
  const oldReact = Reflect.get(globalThis, 'React')
  Reflect.set(globalThis, 'React', React)
  try {
    const html = renderToStaticMarkup(React.createElement(WorkListPane, props()))
    assert.match(html, /aria-label="季度报告，已完成，类型暂不可用"/)
    assert.match(html, /role="img" aria-label="已完成"/)
    assert.match(html, /role="img" aria-label="类型暂不可用"/)
    assert.match(html, /aria-label="按状态筛选工作"/)
    assert.match(html, /aria-label="按类型筛选工作"/)
    const row = html.slice(html.indexOf('class="ent-work-row selected"'))
    assert.equal((row.match(/<button\b/g) ?? []).length, 0)
    assert.doesNotMatch(row, /tabindex="0"/)
    assert.doesNotMatch(row, /aria-label="会话"/)
  } finally { if (oldReact === undefined) Reflect.deleteProperty(globalThis, 'React'); else Reflect.set(globalThis, 'React', oldReact) }
})

test('type filters preserve the current state bucket and search; selecting only opens work', () => {
  const current = { ...props(), filters: { bucket: 'done' as const, workType: 'all' as const, search: '季度' } }
  let changed: unknown
  let selected: unknown
  current.onFilters = next => { changed = next }
  current.onSelect = id => { selected = id }
  const tree = WorkListPane(current)
  const elements: React.ReactElement<Record<string, unknown>>[] = []
  function visit(node: React.ReactNode): void {
    React.Children.forEach(node, child => {
      if (!React.isValidElement<Record<string, unknown>>(child)) return
      elements.push(child)
      visit(child.props.children as React.ReactNode)
    })
  }
  visit(tree)
  const conversation = elements.find(element => element.type === 'button' && String(element.props['aria-label']).startsWith('会话，'))
  assert.ok(conversation)
  ;(conversation.props.onClick as () => void)()
  assert.deepEqual(changed, { bucket: 'done', workType: 'conversation', search: '季度' })
  changed = undefined
  const row = elements.find(element => element.type === 'button' && String(element.props.className).includes('ent-work-row'))
  assert.ok(row)
  ;(row.props.onClick as () => void)()
  assert.equal(selected, 'a')
  assert.equal(changed, undefined)
})
