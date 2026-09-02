/**
 * IPC 契约快照测试
 *
 * 三份东西必须始终对齐，任一处漂移都在这里失败：
 *   1. `src/shared/ipc.ts` 的 `ElectronAPI` 成员名
 *   2. `electron/preload.ts` 实际暴露的键
 *   3. `electron/controller/channels.ts` 的通道常量与 `electron/main.ts` 的注册
 *
 * 用 TypeScript 编译器 API 读语法树，而不是正则：preload 在模块加载时就会调用
 * `contextBridge`，无法在 Electron 之外直接 import。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as ts from 'typescript'

import { ALL_CHANNELS, EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from './channels'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

function parse(relativePath: string): ts.SourceFile {
  const absolute = join(repoRoot, relativePath)
  return ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.ESNext, true)
}

/** `ElectronAPI` 接口的成员名。 */
function electronApiMembers(): string[] {
  const source = parse('src/shared/ipc.ts')
  const names: string[] = []
  source.forEachChild((node: ts.Node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'ElectronAPI') return
    for (const member of node.members) {
      if (member.name && ts.isIdentifier(member.name)) names.push(member.name.text)
    }
  })
  assert.ok(names.length > 0, 'ElectronAPI interface not found in src/shared/ipc.ts')
  return names
}

/** preload 里 `const electronAPI = { ... }` 的键名。 */
function preloadKeys(): string[] {
  const source = parse('electron/preload.ts')
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'electronAPI'
    ) {
      const initializer = ts.isSatisfiesExpression(node.initializer!)
        ? node.initializer.expression
        : node.initializer!
      assert.ok(initializer && ts.isObjectLiteralExpression(initializer), 'electronAPI is not an object literal')
      for (const property of initializer.properties) {
        if (property.name && ts.isIdentifier(property.name)) names.push(property.name.text)
      }
      return
    }
    node.forEachChild(visit)
  }
  visit(source)
  assert.ok(names.length > 0, 'electronAPI object literal not found in electron/preload.ts')
  return names
}

/** 从源文件里收集所有 `<HOLDER>.<NAME>` 形式的通道引用。 */
function channelReferences(relativePath: string, holder: string): Set<string> {
  const source = parse(relativePath)
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === holder
    ) {
      found.add(node.name.text)
    }
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

/** `ipcMain.handle(...)` / `ipcMain.on(...)` 的第一个实参。 */
function ipcMainRegistrations(): { handle: Set<string>; on: Set<string> } {
  const source = parse('electron/main.ts')
  const handle = new Set<string>()
  const on = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'ipcMain'
    ) {
      const method = node.expression.name.text
      const first = node.arguments[0]
      assert.ok(
        first && ts.isPropertyAccessExpression(first),
        `ipcMain.${method} must take a channel constant, not a literal: ${node.getText().slice(0, 60)}`,
      )
      const target = method === 'handle' ? handle : on
      target.add(`${(first.expression as ts.Identifier).text}.${first.name.text}`)
    }
    node.forEachChild(visit)
  }
  visit(source)
  return { handle, on }
}

describe('IPC contract', () => {
  it('preload exposes exactly the ElectronAPI surface', () => {
    const declared = electronApiMembers()
    const exposed = preloadKeys()
    assert.deepEqual(
      [...exposed].sort(),
      [...declared].sort(),
      'preload keys and ElectronAPI members diverged',
    )
    assert.equal(new Set(exposed).size, exposed.length, 'preload has duplicate keys')
  })

  it('every channel name is unique', () => {
    assert.equal(new Set(ALL_CHANNELS).size, ALL_CHANNELS.length)
  })

  it('every invoke channel has exactly one main-process handler', () => {
    const { handle } = ipcMainRegistrations()
    const expected = Object.keys(INVOKE_CHANNELS).map(key => `INVOKE_CHANNELS.${key}`)
    assert.deepEqual([...handle].sort(), expected.sort())
  })

  it('every send channel has exactly one main-process listener', () => {
    const { on } = ipcMainRegistrations()
    const expected = Object.keys(SEND_CHANNELS).map(key => `SEND_CHANNELS.${key}`)
    assert.deepEqual([...on].sort(), expected.sort())
  })

  it('preload subscribes to every main-to-renderer event channel', () => {
    const referenced = channelReferences('electron/preload.ts', 'EVENT_CHANNELS')
    for (const key of Object.keys(EVENT_CHANNELS)) {
      assert.ok(referenced.has(key), `preload never listens on EVENT_CHANNELS.${key}`)
    }
  })

  it('preload uses no raw channel string literals', () => {
    const source = readFileSync(join(repoRoot, 'electron/preload.ts'), 'utf8')
    for (const channel of ALL_CHANNELS) {
      assert.ok(!source.includes(`'${channel}'`), `preload still hardcodes '${channel}'`)
    }
  })
})
