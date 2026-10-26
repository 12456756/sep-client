import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { compileFunction } from 'node:vm'
import * as React from 'react'
import * as ts from 'typescript'
import type { WorkItem } from '../../features/enterprise/types'
import type { WorkListActions } from './WorkListActions'

type Props = Parameters<typeof WorkListActions>[0]
type Element = React.ReactElement<Record<string, unknown>>
const require = createRequire(import.meta.url)
const filename = new URL('./WorkListActions.tsx', import.meta.url)
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText
const work = { id: 'a', title: '季度报告', status: 'completed', pinnedAt: null } as WorkItem
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function mount(overrides: Partial<Props> = {}) {
  const oldWindow = Reflect.get(globalThis, 'window')
  const oldDocument = Reflect.get(globalThis, 'document')
  const cells: unknown[] = []
  let cursor = 0
  let pending: (() => void)[] = []
  const effects = new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>()
  const doc = { activeElement: null as unknown, addEventListener() {}, removeEventListener() {} }
  const button = () => ({ focus() { doc.activeElement = this } })
  const trigger = { ...button(), isConnected: true } as unknown as HTMLElement
  const items = [button(), button(), button()]
  const menu = { open: false, style: { left: '', top: '' }, showPopover() { this.open = true }, hidePopover() { this.open = false },
    matches() { return this.open }, getBoundingClientRect: () => ({ width: 200, height: 150 }), querySelector: () => items[0], querySelectorAll: () => items }
  const dialog = { open: false, showModal() { this.open = true }, close() { this.open = false } }
  const input = { ...button(), selected: false, select() { this.selected = true } }
  Reflect.set(globalThis, 'window', { innerWidth: 1024, innerHeight: 768, addEventListener() {}, removeEventListener() {} })
  Reflect.set(globalThis, 'document', doc)
  const hooks = {
    useRef: (initial: unknown) => { const i = cursor++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i] },
    useState: (initial: unknown) => { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], (next: unknown) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next }] },
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = cursor++, previous = effects.get(i)
      if (previous?.deps && deps && deps.every((dep, j) => Object.is(dep, previous.deps?.[j]))) return
      pending.push(() => { previous?.cleanup?.(); effects.set(i, { deps, cleanup: run() || undefined }) })
    },
  }
  const loaded = { exports: {} }
  compileFunction(compiled, ['require', 'exports', 'module'], { filename: filename.pathname })((id: string) => id === 'react' ? hooks : require(id), loaded.exports, loaded)
  const Component = (loaded.exports as { WorkListActions: typeof WorkListActions }).WorkListActions
  const props: Props = { works: [work], request: { workId: 'a', x: 1000, y: 750, trigger }, busy: false,
    onDismiss: () => { props.request = null }, onRename: async () => true, onPin: async () => true, onDelete: async () => true, ...overrides }
  let elements: Element[] = []
  const find = (predicate: (element: Element) => boolean): Element => { const element = elements.find(predicate); assert.ok(element); return element }
  function render() {
    cursor = 0; pending = []; elements = []
    const visit = (node: React.ReactNode): void => React.Children.forEach(node, child => {
      if (React.isValidElement<Record<string, unknown>>(child)) { elements.push(child); visit(child.props.children as React.ReactNode) }
    })
    visit(Component(props))
    for (const [element, value] of [[find(e => e.props.role === 'menu'), menu], [find(e => e.type === 'dialog'), dialog]] as const) {
      (Reflect.get(element, 'ref') as { current: unknown }).current = value
    }
    for (const element of elements) {
      const ref = Reflect.get(element, 'ref') as { current: unknown } | null
      if (ref && element.type === 'input') ref.current = input
      if (ref && element.type === 'button') ref.current = items[0]
    }
    pending.forEach(run => run())
  }
  const click = (label: string) => { const element = find(e => e.type === 'button' && e.props.children === label || e.type === 'button' && React.Children.toArray(e.props.children as React.ReactNode).includes(label)); (element.props.onClick as () => void)() }
  const submit = () => { (find(e => e.type === 'form').props.onSubmit as (event: unknown) => void)({ preventDefault() {} }) }
  render()
  return { props, menu, dialog, input, trigger, doc, items, find, render, click, submit, cleanup() {
    effects.forEach(effect => effect.cleanup?.())
    if (oldWindow === undefined) Reflect.deleteProperty(globalThis, 'window'); else Reflect.set(globalThis, 'window', oldWindow)
    if (oldDocument === undefined) Reflect.deleteProperty(globalThis, 'document'); else Reflect.set(globalThis, 'document', oldDocument)
  } }
}

test('menu is clamped to the viewport, restores focus on escape and supports arrow keys', () => {
  const ui = mount()
  try {
    assert.equal(ui.find(e => e.props.role === 'menu').props.popover, 'manual')
    assert.equal(ui.menu.style.left, '816px')
    assert.equal(ui.menu.style.top, '610px')
    assert.equal(ui.doc.activeElement, ui.items[0])
    const key = ui.find(e => e.props.role === 'menu').props.onKeyDown as (event: unknown) => void
    key({ key: 'ArrowDown', preventDefault() {} })
    assert.equal(ui.doc.activeElement, ui.items[1])
    key({ key: 'End', preventDefault() {} })
    assert.equal(ui.doc.activeElement, ui.items[2])
    key({ key: 'Escape', preventDefault() {} })
    assert.equal(ui.props.request, null)
    assert.equal(ui.menu.open, false)
    assert.equal(ui.doc.activeElement, ui.trigger)
  } finally { ui.cleanup() }
})

test('pin and unpin target the menu row without requiring selection', async () => {
  const calls: unknown[][] = []
  for (const pinnedAt of [null, 5]) {
    const ui = mount({ works: [{ ...work, pinnedAt }], onPin: async (...args) => { calls.push(args); return true } })
    try { ui.click(pinnedAt ? '取消置顶' : '置顶'); await tick(); assert.equal(ui.props.request, null) } finally { ui.cleanup() }
  }
  assert.deepEqual(calls, [['a', true], ['a', false]])
})

test('rename validates before saving, trims input and keeps failure recoverable', async () => {
  const calls: unknown[][] = []
  const ui = mount({ onRename: async (...args) => { calls.push(args); return calls.length > 1 } })
  try {
    ui.click('重命名'); ui.render()
    assert.equal(ui.dialog.open, true)
    assert.equal(ui.input.selected, true)
    const change = (value: string) => { (ui.find(e => e.type === 'input').props.onChange as (event: unknown) => void)({ target: { value } }); ui.render() }
    change('   '); ui.submit(); await tick(); ui.render()
    assert.deepEqual(calls, [])
    assert.ok(ui.find(e => e.props.role === 'alert'))
    change('新名称\n第二行'); ui.submit(); await tick(); ui.render()
    assert.deepEqual(calls, [])
    change('  年度报告  '); ui.submit(); await tick(); ui.render()
    assert.equal(ui.dialog.open, true)
    assert.ok(ui.find(e => e.props.role === 'alert'))
    ui.submit(); await tick(); ui.render()
    assert.deepEqual(calls, [['a', '年度报告'], ['a', '年度报告']])
    assert.equal(ui.dialog.open, false)
  } finally { ui.cleanup() }
})

test('delete requires confirmation, blocks duplicate requests and disables active work', async () => {
  let calls = 0
  let resolve!: (value: boolean) => void
  const ui = mount({ onDelete: async () => { calls++; return new Promise<boolean>(done => { resolve = done }) } })
  try {
    ui.click('删除'); ui.render()
    assert.equal(calls, 0)
    ui.submit(); ui.submit(); ui.render()
    assert.equal(calls, 1)
    const cancel = ui.find(e => e.type === 'button' && e.props.children === '取消')
    assert.equal(cancel.props.disabled, true)
    resolve(true); await tick(); ui.render()
    assert.equal(ui.dialog.open, false)
  } finally { ui.cleanup() }
  const active = mount({ works: [{ ...work, isActive: true, status: 'running' }] })
  try { assert.equal(active.find(e => e.props.role === 'menuitem' && e.props.className === 'danger').props.disabled, true) } finally { active.cleanup() }
})

test('cancel performs no mutation and streaming snapshots do not reset the edited name', () => {
  let calls = 0
  const ui = mount({ onRename: async () => { calls++; return true }, onDelete: async () => { calls++; return true } })
  try {
    ui.click('重命名'); ui.render()
    ;(ui.find(e => e.type === 'input').props.onChange as (event: unknown) => void)({ target: { value: '编辑中的名称' } })
    ui.render()
    ui.input.selected = false
    ui.props.works = [{ ...work, updatedAt: Date.now() }]
    ui.render()
    assert.equal(ui.find(e => e.type === 'input').props.value, '编辑中的名称')
    assert.equal(ui.input.selected, false)
    ui.click('取消'); ui.render()
    assert.equal(ui.dialog.open, false)
    assert.equal(calls, 0)
  } finally { ui.cleanup() }
})
