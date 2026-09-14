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
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

/**
 * `route(INVOKE_CHANNELS.X, …)` / `listener(SEND_CHANNELS.X, …)` 的第一个实参。
 *
 * 路由注册是表驱动的，`ipcMain` 只出现在 controller/router.ts。所以这里断言的
 * 对象从"main.ts 里的 ipcMain 调用"换成"routes/ 里的路由声明"——这比原来更强：
 * 它同时盯住了"第二个参数必须是 schema"（不填 schema 就注册不了）。
 */
function routeDeclarations(): { routes: Set<string>; listeners: Set<string>; missingSchema: string[] } {
  const routes = new Set<string>()
  const listeners = new Set<string>()
  const missingSchema: string[] = []
  for (const file of readdirSync(join(repoRoot, 'electron/controller/routes'))) {
    if (!file.endsWith('.ts') || file === 'index.ts') continue
    const source = parse(`electron/controller/routes/${file}`)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'route' || node.expression.text === 'listener')
      ) {
        const first = node.arguments[0]
        assert.ok(
          first && ts.isPropertyAccessExpression(first),
          `${file}: ${node.expression.text}() 的通道必须是常量，不能是字面量`,
        )
        const channel = `${(first.expression as ts.Identifier).text}.${first.name.text}`
        if (node.arguments.length < 3) missingSchema.push(channel)
        ;(node.expression.text === 'route' ? routes : listeners).add(channel)
      }
      node.forEachChild(visit)
    }
    visit(source)
  }
  return { routes, listeners, missingSchema }
}

/**
 * `ipcMain` 只允许出现在 controller/router.ts（边界 B1）。
 * 整行注释跳过——`channels.ts` 的注释里必须能写出 `ipcMain.handle` 来说明通道用途，
 * 那是文档不是注册（与 check-boundaries 的 matchCodeLines 同一套判定）。
 */
function ipcMainReferences(): string[] {
  const found: string[] = []
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0')
  for (const path of listed) {
    if (!path.startsWith('electron/') || !path.endsWith('.ts') || path.endsWith('.test.ts')) continue
    const absolutePath = join(repoRoot, path)
    if (!existsSync(absolutePath)) continue
    const hit = readFileSync(absolutePath, 'utf8').split('\n').some(line => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false
      return /\bipcMain\b/.test(line)
    })
    if (hit) found.push(path)
  }
  return found
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

  it('every invoke channel has exactly one route', () => {
    const { routes } = routeDeclarations()
    const expected = Object.keys(INVOKE_CHANNELS).map(key => `INVOKE_CHANNELS.${key}`)
    assert.deepEqual([...routes].sort(), expected.sort())
  })

  it('every send channel has exactly one listener', () => {
    const { listeners } = routeDeclarations()
    const expected = Object.keys(SEND_CHANNELS).map(key => `SEND_CHANNELS.${key}`)
    assert.deepEqual([...listeners].sort(), expected.sort())
  })

  it('every route declares a schema', () => {
    // route() 的第二个参数是必填位置参数，所以这条在编译期就成立；
    // 断言它是为了防有人给 route 加个"schema 可选"的重载，绕过输入校验。
    assert.deepEqual(routeDeclarations().missingSchema, [])
  })

  it('keeps ipcMain inside controller/router.ts', () => {
    assert.deepEqual(ipcMainReferences(), ['electron/controller/router.ts'])
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

