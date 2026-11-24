import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import { getSettingsPages } from './settings-catalog'

test('settings catalog exposes only supported sections and authorized enterprise settings', () => {
  const personal = getSettingsPages(false, false)
  deepEqual(personal.map(page => page.id), ['general', 'account', 'multimedia'])
  deepEqual(personal[1].sections.map(section => section.id), ['profile'])
  deepEqual(getSettingsPages(true, true)[1].sections.map(section => section.id), ['profile', 'enterprise'])
  equal(getSettingsPages(false, true).at(-1)?.id, 'voice')
  deepEqual(getSettingsPages(false, true, 'Logo'), [])
})

test('global search matches section keywords, category names and normalized multiple terms', () => {
  deepEqual(getSettingsPages(false, true, '  WORKSPACE  ').flatMap(page => page.sections.map(section => section.id)), ['workspace'])
  deepEqual(getSettingsPages(false, true, '临时文件').flatMap(page => page.sections.map(section => section.id)), ['workspace'])
  deepEqual(getSettingsPages(false, true, '自动保存 保存位置').flatMap(page => page.sections.map(section => section.id)), ['workspace'])
  deepEqual(getSettingsPages(false, true, '账号 邮箱').flatMap(page => page.sections.map(section => section.id)), ['profile'])
  deepEqual(getSettingsPages(false, true, '常规').flatMap(page => page.sections.map(section => section.id)), ['permissions', 'window', 'models', 'workspace'])
  deepEqual(getSettingsPages(false, true, '新会话 完全访问').flatMap(page => page.sections.map(section => section.id)), ['permissions'])
  deepEqual(getSettingsPages(false, true, '退出').flatMap(page => page.sections.map(section => section.id)), ['window'])
  deepEqual(getSettingsPages(true, false, '麦克风'), [])
  deepEqual(getSettingsPages(true, true, '没有这项设置'), [])
  deepEqual(getSettingsPages(false, false, '视频 参数').map(page => page.id), ['multimedia'])
  deepEqual(getSettingsPages(false, false, '参考图').flatMap(page => page.sections.map(section => section.id)), ['multimedia'])
})
