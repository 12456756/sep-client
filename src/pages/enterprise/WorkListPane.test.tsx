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
  return { works: [work], records: [work], selectedWorkId: 'a', filters: resetWorkRecordFilters(), onFilters: () => {}, onSelect: () => {}, onCreate: () => {}, onClose: () => {}, onRetryTypes: () => {}, menuWorkId: null, onWorkMenu: () => {} }
}

test('work rows use one named button with semantic status and unknown-type icons', () => {
  const oldReact = Reflect.get(globalThis, 'React')
  Reflect.set(globalThis, 'React', React)
  try {
    const html = renderToStaticMarkup(React.createElement(WorkListPane, props()))
    assert.match(html, /aria-label="季度报告，已完成，类型暂不可用"/)
    assert.match(html, /role="img" aria-label="已完成"/)
    assert.match(html, /role="img" aria-label="类型暂不可用"/)
    assert.doesNotMatch(html, /aria-label="已完成"[^>]*>.*class="ent-spin"/s)
    assert.match(html, /aria-label="按状态筛选工作"/)
    assert.match(html, /aria-label="按类型筛选工作"/)
    const rowStart = html.indexOf('class="ent-work-row selected"')
    const row = html.slice(rowStart, html.indexOf('</button>', rowStart))
    assert.equal((row.match(/<button\b/g) ?? []).length, 0)
    assert.doesNotMatch(row, /tabindex="0"/)
    assert.doesNotMatch(row, /aria-label="会话"/)
    assert.match(html, /aria-label="更多操作：季度报告" aria-haspopup="menu"/)
  } finally { if (oldReact === undefined) Reflect.deleteProperty(globalThis, 'React'); else Reflect.set(globalThis, 'React', oldReact) }
})

test('running and loading status icons use the shared spin animation', () => {
  const running = { ...work, id: 'running', status: 'running' } as unknown as WorkItem
  const loading = { ...work, id: 'loading', workType: { state: 'loading' } } as unknown as WorkItem
  const html = renderToStaticMarkup(React.createElement(WorkListPane, { ...props(), works: [running, loading], records: [running, loading] }))
  assert.match(html, /class="ent-work-status is-running"[^>]*>\s*<svg[^>]*class="[^"]*ent-spin[^"]*"/)
  assert.match(html, /aria-label="类型加载中"[^>]*>\s*<svg[^>]*class="[^"]*ent-spin[^"]*"/)
})

test('the active filter icon stays still when there are no active works', () => {
  const idleHtml = renderToStaticMarkup(React.createElement(WorkListPane, props()))
  const idleStart = idleHtml.indexOf('class="bucket-active"')
  const idleButton = idleHtml.slice(idleStart, idleHtml.indexOf('</button>', idleStart))
  assert.doesNotMatch(idleButton, /ent-spin/)

  const active = { ...work, id: 'active', status: 'running', isActive: true } as unknown as WorkItem
  const activeHtml = renderToStaticMarkup(React.createElement(WorkListPane, { ...props(), works: [active], records: [active] }))
  const activeStart = activeHtml.indexOf('class="bucket-active"')
  const activeButton = activeHtml.slice(activeStart, activeHtml.indexOf('</button>', activeStart))
  assert.match(activeButton, /ent-spin/)
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

test('right-click, keyboard and ellipsis open actions for their own row without navigating', () => {
  const current = props()
  let selected = false
  const requests: unknown[][] = []
  current.onSelect = () => { selected = true }
  current.onWorkMenu = (...args) => { requests.push(args) }
  const elements: React.ReactElement<Record<string, unknown>>[] = []
  const visit = (node: React.ReactNode): void => React.Children.forEach(node, child => {
    if (React.isValidElement<Record<string, unknown>>(child)) { elements.push(child); visit(child.props.children as React.ReactNode) }
  })
  visit(WorkListPane(current))
  const row = elements.find(element => element.type === 'button' && String(element.props.className).startsWith('ent-work-row '))!
  const more = elements.find(element => element.type === 'button' && element.props.className === 'ent-work-row-menu')!
  const trigger = {} as HTMLElement
  let prevented = 0
  ;(row.props.onContextMenu as (event: unknown) => void)({ currentTarget: trigger, clientX: 240, clientY: 310, preventDefault() { prevented++ } })
  ;(row.props.onKeyDown as (event: unknown) => void)({ currentTarget: trigger, key: 'F10', shiftKey: true, preventDefault() { prevented++ } })
  ;(more.props.onClick as (event: unknown) => void)({ currentTarget: trigger })
  assert.equal(selected, false)
  assert.equal(prevented, 2)
  assert.deepEqual(requests, [['a', trigger, { x: 240, y: 310 }], ['a', trigger], ['a', trigger]])
  const pinned = renderToStaticMarkup(React.createElement(WorkListPane, { ...current, records: [{ ...work, pinnedAt: 1 }] }))
  assert.match(pinned, /role="img" aria-label="已置顶"/)
  assert.doesNotMatch(pinned, /归档/)
})
