import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DefaultWorkspaceSettings } from './DefaultWorkspaceSettings'

test('renders the default workspace setting with task isolation guidance', () => {
  const previousReact = Reflect.get(globalThis, 'React')
  const previousWindow = Reflect.get(globalThis, 'window')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    getDefaultWorkspaceDirectory: async () => ({ success: true, path: 'C:/Tasks' }),
    selectDefaultWorkspaceDirectory: async () => ({ success: false, path: null }),
    clearDefaultWorkspaceDirectory: async () => ({ success: true, path: null }),
  } } })
  try {
    const html = renderToStaticMarkup(React.createElement(DefaultWorkspaceSettings))
    assert.match(html, /默认工作目录设置/)
    assert.match(html, /每个任务会在此目录下创建独立文件夹/)
  } finally {
    if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previousReact })
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
