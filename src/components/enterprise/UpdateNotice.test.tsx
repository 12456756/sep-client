import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UpdateModel } from '../../features/update/use-update'
import type { UpdateState } from '../../shared/ipc'
import { UpdateDetails, UpdateNotice, UpdateRestartDetails } from './UpdateNotice'
import type { UpdateTaskStatus } from './update-restart'

const idle: UpdateState = { status: 'idle', currentVersion: '0.1.2' }
const noop = () => {}
const action = async () => {}
function model(state: UpdateState | null, patch: Partial<UpdateModel> = {}): UpdateModel {
  return { state, pending: null, error: null, release: null, check: action, download: action, cancel: action, install: action, ...patch }
}
function render(element: React.ReactElement): string {
  const previous = Reflect.get(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try { return renderToStaticMarkup(element) }
  finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previous })
  }
}
function details(update: UpdateModel): string {
  return render(React.createElement(UpdateDetails, { update, onRestart: noop, onClose: noop }))
}

test('idle and current states never open a panel automatically or mark a new update', () => {
  for (const state of [idle, { ...idle, status: 'not-available', checkedAt: '2026-10-09T00:00:00Z' } as UpdateState]) {
    const html = render(React.createElement(UpdateNotice, { update: model(state), open: false, onOpenChange: noop, onOpenWorkRecords: noop }))
    assert.match(html, /aria-label="客户端更新，打开更新面板"/)
    assert.doesNotMatch(html, /has-update|role="dialog"|role="alert"/)
  }
})

test('available details render main versions and notes as escaped text', () => {
  const html = details(model({ ...idle, status: 'available', version: '0.1.3', releaseDate: '2026-10-09T00:00:00Z',
    releaseNotes: ['支持新功能', '<script>alert(1)</script>'] }))
  assert.match(html, /当前版本.*0\.1\.2/)
  assert.match(html, /新版本 0\.1\.3/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /下载更新/)
  assert.doesNotMatch(html, /重启并安装/)
})

test('100 percent still displays verification and cancellation until main reports downloaded', () => {
  const html = details(model({ ...idle, status: 'downloading', version: '0.1.3', percent: 100,
    transferred: 1024, total: 1024, bytesPerSecond: 100 }, { pending: 'download' }))
  assert.match(html, /<progress max="100" value="100" aria-label="新版本 0.1.3 下载进度"/)
  assert.match(html, /正在校验更新文件/)
  assert.match(html, /<button[^>]*>取消下载<\/button>/)
  assert.doesNotMatch(html, /重启并安装|下载完成/)
})

test('preserves known notes during download and does not invent notes after reload', () => {
  const state: UpdateState = { ...idle, status: 'downloaded', version: '0.1.3' }
  assert.match(details(model(state, { release: { version: '0.1.3', releaseDate: null, releaseNotes: ['修复问题'] } })), /修复问题/)
  assert.match(details(model(state)), /此版本未提供更新说明/)
  assert.doesNotMatch(details(model(state, { release: { version: '0.1.4', releaseDate: null, releaseNotes: ['其他版本'] } })), /其他版本/)
  assert.match(details(model(state)), /重启并安装/)
})

test('check and download errors provide appropriate retry actions and forbid nonretryable retry', () => {
  const error: UpdateState = { ...idle, status: 'error', operation: 'download', message: '下载失败', retryable: true }
  assert.match(details(model(error)), /重试下载/)
  assert.match(details(model({ ...error, operation: 'check' })), /重新检查/)
  assert.doesNotMatch(details(model({ ...error, retryable: false })), /重试下载/)
  assert.match(details(model(null, { error: '读取更新状态失败' })), /读取更新状态失败/)
  assert.doesNotMatch(details(model(null, { error: '读取更新状态失败' })), /disabled=""[^>]*>检查更新/)
})

test('pending commands disable downloads and install without removing the defer action', () => {
  const html = details(model({ ...idle, status: 'downloaded', version: '0.1.3' }, { pending: 'install' }))
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*重启并安装/)
  assert.match(html, /稍后更新/)
})

test('restart confirmation blocks installation for checking, unknown or active task status', () => {
  const blocked: UpdateTaskStatus = { status: 'blocked', running: 1, pending: 2, waitingApproval: 3 }
  for (const tasks of [{ status: 'checking' }, { status: 'error' }, blocked] as UpdateTaskStatus[]) {
    const html = render(React.createElement(UpdateRestartDetails, { tasks, installing: false, onConfirm: noop,
      onRetry: noop, onClose: noop, onOpenWorkRecords: noop }))
    assert.match(html, /<button[^>]*disabled=""[^>]*>确认重启并安装/)
    assert.match(html, /稍后更新/)
  }
  const html = render(React.createElement(UpdateRestartDetails, { tasks: blocked, installing: false, onConfirm: noop,
    onRetry: noop, onClose: noop, onOpenWorkRecords: noop }))
  assert.match(html, /运行中 1 · 排队中 2 · 待审批 3/)
  assert.match(html, /查看工作记录|重新检查任务/)
})

test('ready confirmation explains saving edits and enables only the explicit confirmation', () => {
  const html = render(React.createElement(UpdateRestartDetails, { tasks: { status: 'ready' }, installing: false,
    onConfirm: noop, onRetry: noop, onClose: noop, onOpenWorkRecords: noop }))
  assert.match(html, /请保存正在编辑的内容/)
  assert.match(html, /<button[^>]*>确认重启并安装/)
  assert.doesNotMatch(html, /disabled=""/)
})
