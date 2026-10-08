import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlatformNotification } from '../../shared/notification-contracts'
import {
  assertNotificationCommand, initialNotificationState, notificationReducer, NOTIFICATION_PAGE_SIZE,
} from './notification-state'
import { NotificationCenter, NotificationPanel } from '../../components/enterprise/NotificationCenter'

function notification(id: string, patch: Partial<PlatformNotification> = {}): PlatformNotification {
  return { id, title: `通知 ${id}`, message: '完整预览 <script>unsafe</script>', type: 'INFO',
    read: false, category: 'SYSTEM', severity: 'INFO', relatedType: null, relatedId: null,
    actionUrl: null, createdAt: '2026-10-08T01:00:00Z', ...patch }
}

function loadedState() {
  return notificationReducer(notificationReducer(initialNotificationState, { type: 'start', id: 1 }), {
    type: 'finish', id: 1, page: { items: [notification('one')], total: 81 }, unreadCount: 204,
    categoryUnreadCount: 204, error: null,
  })
}

test('REST owns unread counts, independent of the loaded page; limit is 50', () => {
  const state = loadedState()
  assert.equal(state.unreadCount, 204)
  assert.equal(state.items.length, 1)
  assert.equal(NOTIFICATION_PAGE_SIZE, 50)
  const pushed = notificationReducer(state, { type: 'push', notification: notification('two') })
  assert.equal(pushed.unreadCount, 204)
  assert.equal(pushed.total, 81)
})

test('deduplicates push by id and content, updates in place, and bounds the first page', () => {
  const state = loadedState()
  assert.equal(notificationReducer(state, { type: 'push', notification: notification('one') }), state)
  const changed = notificationReducer(state, { type: 'push', notification: notification('one', { title: '更新' }) })
  assert.equal(changed.items.length, 1)
  assert.equal(changed.items[0].title, '更新')
  let next = state
  for (let id = 0; id < 220; id++) next = notificationReducer(next, { type: 'push', notification: notification(String(id)) })
  assert.equal(next.items.length, 50)
  assert.ok(Object.keys(next.seen).length <= 200)
  assert.equal(notificationReducer(next, { type: 'push', notification: notification('219') }), next)
})

test('filters and paging reject old responses and reset offset when filters change', () => {
  const pending = notificationReducer(loadedState(), { type: 'start', id: 2 })
  const filtered = notificationReducer(pending, { type: 'query', query: { category: 'SECURITY', unreadOnly: true, offset: 0 } })
  const stale = notificationReducer(filtered, { type: 'finish', id: 2, page: { items: [notification('stale')], total: 1 }, unreadCount: 0, error: null })
  assert.equal(stale, filtered)
  assert.equal(filtered.unreadCount, 204)
  assert.equal(filtered.categoryUnreadCount, null)
  assert.deepEqual(filtered.items, [])
  const paged = notificationReducer(filtered, { type: 'query', query: { ...filtered.query, offset: 50 } })
  assert.equal(paged.query.offset, 50)
})

test('push invalidates an in-flight snapshot and never inserts on later pages', () => {
  const pending = notificationReducer(loadedState(), { type: 'start', id: 2 })
  const pushed = notificationReducer(pending, { type: 'push', notification: notification('new') })
  assert.equal(notificationReducer(pushed, { type: 'finish', id: 2, page: { items: [], total: 0 }, unreadCount: 0, error: null }), pushed)
  const later = notificationReducer(loadedState(), { type: 'query', query: { unreadOnly: false, offset: 50 } })
  assert.deepEqual(notificationReducer(later, { type: 'push', notification: notification('new') }).items, [])
})

test('push respects category/unread filters and removes rows that stop matching', () => {
  let state = notificationReducer(loadedState(), { type: 'query', query: { category: 'SYSTEM', unreadOnly: true, offset: 0 } })
  state = notificationReducer(state, { type: 'push', notification: notification('one') })
  state = notificationReducer(state, { type: 'push', notification: notification('security', { category: 'SECURITY' }) })
  assert.deepEqual(state.items.map(item => item.id), ['one'])
  state = notificationReducer(state, { type: 'push', notification: notification('one', { read: true }) })
  assert.deepEqual(state.items, [])
})

test('failed/partial REST refresh retains cached data and badge', () => {
  const state = notificationReducer(loadedState(), { type: 'start', id: 2 })
  const failed = notificationReducer(state, { type: 'finish', id: 2, error: '离线' })
  assert.deepEqual(failed.items, state.items)
  assert.equal(failed.unreadCount, 204)
  assert.equal(failed.error, '离线')
  assert.equal(failed.loading, false)
  const partial = notificationReducer(notificationReducer(failed, { type: 'start', id: 3 }), {
    type: 'finish', id: 3, unreadCount: 7, error: '列表失败',
  })
  assert.deepEqual(partial.items, state.items)
  assert.equal(partial.unreadCount, 7)
})

test('deduplicates REST rows and separates mutation errors from refresh errors', () => {
  const state = notificationReducer(notificationReducer(initialNotificationState, { type: 'start', id: 1 }), {
    type: 'finish', id: 1, page: { items: [notification('one'), notification('one', { title: '新版本' })], total: 1 }, error: null,
  })
  assert.equal(state.items.length, 1)
  assert.equal(state.items[0].title, '新版本')
  const failed = notificationReducer(state, { type: 'mutation', pending: false, error: '删除失败' })
  const refreshed = notificationReducer(notificationReducer(failed, { type: 'start', id: 2 }), { type: 'finish', id: 2, error: null })
  assert.equal(refreshed.mutationError, '删除失败')
})

function renderPanel(state = loadedState(), hasInternalActions = false) {
  const previousReact = Reflect.get(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  const noop = () => undefined
  try {
    return renderToStaticMarkup(React.createElement(NotificationPanel, {
      id: 'notifications', state, hasInternalActions, onClose: noop, onCategory: noop,
      onPage: noop, onRetry: noop, onRead: noop, onReadAll: noop, onDelete: noop,
      onViewAll: noop, onAction: noop,
    }))
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact })
  }
}

function buttonMarkup(html: string, label: string): string {
  const button = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .find(([markup]) => markup.includes(`aria-label="${label}"`))?.[0]
  assert.ok(button, `Missing button: ${label}`)
  return button
}

test('panel follows the reference header and five visible icon category tabs', () => {
  const html = renderPanel()
  assert.match(html, /role="dialog" aria-labelledby="notifications-title"/)
  assert.match(html, /<h2 id="notifications-title">通知<\/h2>/)
  assert.match(buttonMarkup(html, '全部标为已读'), /lucide-check[\s\S]*全部已读/)
  assert.match(html, /role="group" aria-label="通知分类"/)
  const tabs = { 全部: 'bell', 系统: 'settings-2', 用量: 'chart-no-axes-column-increasing', 安全: 'shield-alert', 审批: 'square-check-big' }
  for (const label of Object.keys(tabs)) {
    const markup = buttonMarkup(html, label)
    assert.match(markup, /<svg/)
    assert.ok(markup.includes(`<span>${label}</span>`))
    assert.match(markup, new RegExp(`aria-pressed="${label === '全部'}"`))
  }
  assert.doesNotMatch(html, /ent-notification-count|仅看未读|type="checkbox"|<details|<select/)
  assert.match(html, /完整预览 &lt;script&gt;unsafe&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>/)
})

test('category selection is visible directly and has no nested overflow menu', () => {
  const html = renderPanel({ ...loadedState(), query: { category: 'SECURITY', unreadOnly: false, offset: 0 } })
  assert.match(buttonMarkup(html, '安全'), /aria-pressed="true"/)
  assert.match(buttonMarkup(html, '全部'), /aria-pressed="false"/)
  assert.match(buttonMarkup(html, '全部标为已读'), /title="将安全通知全部标为已读"/)
  assert.doesNotMatch(html, /更多|清除已读|<select|<details/)
})

test('footer always exposes the trusted platform notification center', () => {
  for (const state of [loadedState(), initialNotificationState, { ...initialNotificationState, loading: false }]) {
    const html = renderPanel(state)
    assert.match(html, /<footer class="ent-notification-footer">/)
    assert.match(buttonMarkup(html, '查看全部通知'), /lucide-external-link[\s\S]*查看全部通知/)
    assert.doesNotMatch(html, /<a\b/)
  }
})

test('pagination is absent for empty or single-page results and preserved for multiple pages', () => {
  for (const total of [0, 1, NOTIFICATION_PAGE_SIZE]) {
    const html = renderPanel({ ...loadedState(), total, items: total ? [notification('one')] : [] })
    assert.doesNotMatch(html, /ent-notification-pagination|上一页|下一页|第 .* 页/)
  }
  const first = renderPanel()
  assert.match(first, /第 1 \/ 2 页/)
  assert.match(buttonMarkup(first, '上一页'), /disabled=""/)
  assert.doesNotMatch(buttonMarkup(first, '下一页'), /disabled=""/)
  const last = renderPanel({ ...loadedState(), query: { unreadOnly: false, offset: NOTIFICATION_PAGE_SIZE } })
  assert.match(last, /第 2 \/ 2 页/)
  assert.doesNotMatch(buttonMarkup(last, '上一页'), /disabled=""/)
  assert.match(buttonMarkup(last, '下一页'), /disabled=""/)
  const loading = renderPanel({ ...loadedState(), loading: true })
  for (const label of ['上一页', '下一页']) assert.match(buttonMarkup(loading, label), /disabled=""/)
})

test('rows follow title, category tag, right-side relative date and left unread dot layout', () => {
  const createdAt = new Date(Date.now() - 18 * 86400_000).toISOString()
  const html = renderPanel({ ...loadedState(), items: [notification('one', { createdAt })] })
  assert.match(html, /class="ent-notification-category-tag is-system">系统/)
  assert.match(html, /class="ent-notification-unread-dot"[^>]*aria-label="未读"/)
  assert.match(html, /ent-notification-row-heading[\s\S]*<h3>通知 one<\/h3>[\s\S]*<time[^>]*title="[^"]+">18 天前/)
  assert.doesNotMatch(html, /ent-notification-category-icon/)
  assert.match(buttonMarkup(html, '标为已读：通知 one'), /lucide-check/)
  assert.match(buttonMarkup(html, '删除通知：通知 one'), /lucide-trash2/)
  assert.doesNotMatch(html, /在平台查看/)
  const read = renderPanel({ ...loadedState(), items: [notification('one', { read: true })] })
  assert.doesNotMatch(read, /ent-notification-unread-dot|标为已读：通知 one/)
  assert.match(buttonMarkup(read, '删除通知：通知 one'), /lucide-trash2/)
  const approval = renderPanel({ ...loadedState(), items: [notification('one', { category: 'APPROVAL' })] })
  assert.match(approval, /class="ent-notification-category-tag is-approval">审批/)
})

test('explicit view action is subtle text only when available, never a preview link', () => {
  const state = { ...loadedState(), items: [notification('one', { actionUrl: '/approvals/1' })] }
  const html = renderPanel(state)
  assert.match(buttonMarkup(html, '在平台查看：通知 one'), /class="ent-notification-view-action"/)
  assert.doesNotMatch(html, /<a\b/)
})

test('busy state disables mutation actions but keeps cached rows visible during refresh', () => {
  const state = { ...loadedState(), pending: true, loading: true,
    items: [notification('one', { actionUrl: '/approvals/1' })] }
  const html = renderPanel(state)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /正在更新通知…/)
  assert.match(html, /正在处理…/)
  assert.match(html, /完整预览/)
  for (const label of ['全部标为已读', '查看全部通知', '标为已读：通知 one', '删除通知：通知 one', '在平台查看：通知 one']) {
    assert.match(buttonMarkup(html, label), /disabled=""/)
  }
  assert.doesNotMatch(html, /暂无通知|ent-notification-empty/)
})

test('loading and empty states are concise; unavailable unread counts are not fabricated', () => {
  const loading = renderPanel(initialNotificationState)
  assert.match(loading, /正在加载通知…/)
  assert.doesNotMatch(loading, /ent-notification-count|暂无通知/)
  assert.match(renderPanel({ ...initialNotificationState, loading: false }), /暂无通知/)
  assert.match(renderPanel({ ...initialNotificationState, loading: false, query: { unreadOnly: true, offset: 0 } }), /暂无未读通知/)
})

test('empty errors use a calm icon, title, friendly message and retry; cached errors use a note', () => {
  const empty = renderPanel({ ...initialNotificationState, loading: false, error: '网络错误' })
  assert.match(empty, /class="ent-notification-empty" role="alert"/)
  assert.match(empty, /lucide-circle-alert/)
  assert.match(empty, /暂时无法加载通知/)
  assert.match(empty, /网络错误/)
  assert.doesNotMatch(buttonMarkup(empty, '重试加载通知'), /disabled=""/)
  assert.doesNotMatch(empty, /暂无通知|ent-notification-error/)
  const cached = renderPanel({ ...loadedState(), error: '网络错误' })
  assert.match(cached, /class="ent-notification-note" role="alert"/)
  assert.match(cached, /网络错误/)
  assert.match(cached, /完整预览/)
  assert.doesNotMatch(cached, /ent-notification-empty|暂时无法加载通知/)
  const retrying = renderPanel({ ...loadedState(), loading: true, error: '网络错误' })
  assert.match(buttonMarkup(retrying, '重试加载通知'), /disabled=""/)
  const mutation = renderPanel({ ...loadedState(), mutationError: '操作失败' })
  assert.match(mutation, /class="ent-notification-note" role="alert">操作失败/)
})

test('center SSR is a bell disclosure, not a route or an eagerly open panel', () => {
  const previousReact = Reflect.get(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try {
    const html = renderToStaticMarkup(React.createElement(NotificationCenter, {}))
    assert.match(html, /aria-haspopup="dialog"/)
    assert.match(html, /aria-expanded="false"/)
    assert.doesNotMatch(html, /role="dialog"|<a\b/)
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact })
  }
})

test('204 mutation success needs no data and failures preserve their message', () => {
  assert.doesNotThrow(() => assertNotificationCommand({ success: true }))
  assert.throws(() => assertNotificationCommand({ success: false, error: { message: '没有权限' } }), /没有权限/)
  assert.throws(() => assertNotificationCommand({ success: false }), /通知操作失败/)
})

test('newer requests win; mutation/resync invalidation rejects outstanding snapshots', () => {
  const first = notificationReducer(loadedState(), { type: 'start', id: 2 })
  const second = notificationReducer(first, { type: 'start', id: 3 })
  assert.equal(notificationReducer(second, { type: 'finish', id: 2, unreadCount: 0, error: null }), second)
  const invalidated = notificationReducer(second, { type: 'invalidate' })
  assert.equal(notificationReducer(invalidated, { type: 'finish', id: 3, unreadCount: 0, error: null }), invalidated)
  assert.equal(invalidated.unreadCount, 204)
})

test('shrinking REST total after delete/clear moves off an invalid final page', () => {
  const paged = notificationReducer(loadedState(), { type: 'query', query: { unreadOnly: false, offset: 100 } })
  const finished = notificationReducer(notificationReducer(paged, { type: 'start', id: 2 }), {
    type: 'finish', id: 2, page: { items: [], total: 50 }, error: null,
  })
  assert.equal(finished.query.offset, 0)
  assert.equal(finished.loading, true)
  assert.deepEqual(finished.items, [])
})

test('category badge is independent of global badge and preserves authoritative zero', () => {
  let state = notificationReducer(loadedState(), { type: 'query', query: { category: 'SECURITY', unreadOnly: false, offset: 0 } })
  state = notificationReducer(notificationReducer(state, { type: 'start', id: 2 }), {
    type: 'finish', id: 2, unreadCount: 204, categoryUnreadCount: 0, error: null,
  })
  assert.equal(state.unreadCount, 204)
  assert.equal(state.categoryUnreadCount, 0)
  assert.match(buttonMarkup(renderPanel(state), '全部标为已读'), /disabled=""/)
  assert.doesNotMatch(renderPanel(state), /ent-notification-count/)
  assert.doesNotMatch(renderPanel(state), /当前分类：0 条未读/)
})

test('validated WS counts update the global badge immediately even when REST fails', () => {
  const started = notificationReducer(loadedState(), { type: 'start', id: 2 })
  const pushed = notificationReducer(started, { type: 'count', count: 19 })
  assert.equal(pushed.unreadCount, 19)
  assert.equal(pushed.categoryUnreadCount, 19)
  assert.equal(notificationReducer(pushed, { type: 'finish', id: 2, unreadCount: 204, error: null }), pushed)
  const failed = notificationReducer(notificationReducer(pushed, { type: 'start', id: 3 }), { type: 'finish', id: 3, error: '离线' })
  assert.equal(failed.unreadCount, 19)
  assert.equal(failed.items.length, 1)
  const compensated = notificationReducer(notificationReducer(failed, { type: 'start', id: 4 }), { type: 'finish', id: 4, unreadCount: 18, categoryUnreadCount: 18, error: null })
  assert.equal(compensated.unreadCount, 18)
})

test('WS global counts never replace a selected category count', () => {
  let state = notificationReducer(loadedState(), { type: 'query', query: { category: 'SECURITY', unreadOnly: false, offset: 0 } })
  state = notificationReducer(notificationReducer(state, { type: 'start', id: 2 }), { type: 'finish', id: 2, categoryUnreadCount: 3, error: null })
  state = notificationReducer(state, { type: 'count', count: 12 })
  assert.equal(state.unreadCount, 12)
  assert.equal(state.categoryUnreadCount, 3)
  assert.equal(notificationReducer(state, { type: 'count', count: 0 }).unreadCount, 0)
})

test('internal callback actions remain available for usage/skill/reward notices without a URL', () => {
  for (const item of [
    notification('usage', { category: 'USAGE_ALERT' }),
    notification('skill', { type: 'SKILL_VERSION_UPDATED' }),
    notification('reward', { type: 'CONTRIBUTION_REWARD_CREDITED' }),
  ]) {
    const state = { ...loadedState(), items: [item] }
    assert.match(renderPanel(state, true), /查看详情/)
    assert.doesNotMatch(renderPanel(state, false), /查看详情|在平台查看/)
  }
  assert.doesNotMatch(renderPanel(loadedState(), true), /查看详情|在平台查看/)
})
