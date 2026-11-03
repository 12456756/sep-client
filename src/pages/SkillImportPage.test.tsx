import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SkillImportPage } from './SkillImportPage'
import type { SkillImportStateView } from '../shared/skill-import-contracts'

const state: SkillImportStateView = {
  revision: 2, visible: true, phase: 'awaiting-local-consent', clientVersion: '0.3.2', protocolVersion: 1,
  sessionId: 'session_1', instanceId: 'stable', siteLabel: 'SEP', initiatorLabel: '管理员', scope: 'user',
  roots: [{ rootId: 'root_1', label: 'Codex Skills', scope: 'user', authorized: true }],
  pairing: { pairingId: 'pairing_1', shortCode: '123456', keyFingerprint: 'a'.repeat(64), expiresAt: '2026-11-03T10:00:00.000Z', webConfirmed: false },
  devices: [], progress: null, error: null, persistenceAvailable: true, busySessionId: null,
}
const actions = { onClose() {}, onConfirm() {}, onSelectRoot() {}, onRemoveRoot() {}, onCancel() {}, onRevoke() {}, onCheckForUpdate() {} }

test('shows pairing context and does not echo local absolute paths or secrets', () => {
  const html = renderToStaticMarkup(createElement(SkillImportPage, { state, ...actions }))
  assert.match(html, /SEP/)
  assert.match(html, /管理员 发起了本次扫描/)
  assert.match(html, /123456/)
  assert.match(html, /Codex Skills/)
  assert.doesNotMatch(html, /private|sessionGrant|privateKey/)
})

test('uploaded state asks the user to return to the web flow', () => {
  const html = renderToStaticMarkup(createElement(SkillImportPage, { state: { ...state, phase: 'uploaded' }, ...actions }))
  assert.match(html, /文件已传送/)
  assert.match(html, /回到网页完成创建和提交审核/)
  assert.doesNotMatch(html, /已发布/)
})

test('does not show consent controls while a job is active', () => {
  const html = renderToStaticMarkup(createElement(SkillImportPage, { state: { ...state, phase: 'scanning' }, ...actions }))
  assert.match(html, /扫描中/)
  assert.match(html, /取消本次导入/)
  assert.doesNotMatch(html, /允许并开始扫描/)
})

test('busy state directs the user back to the web page', () => {
  const html = renderToStaticMarkup(createElement(SkillImportPage, { state: { ...state, phase: 'busy', busySessionId: 'other_session' }, ...actions }))
  assert.match(html, /另一导入会话正在运行/)
  assert.match(html, /请回到网页重试/)
})
