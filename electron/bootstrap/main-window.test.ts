import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { compileFunction } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'

describe('main window application icon', () => {
  it('uses a bundled asset for the window icon in development and packaged builds', () => {
    const source = readFileSync(new URL('./main-window.ts', import.meta.url), 'utf8')
    assert.match(source, /import appIcon from ['"]\.\.\/\.\.\/build\/icon\.png\?asset['"]/)
    assert.match(source, /\bicon:\s*appIcon\b/)
  })

  it('uses a valid square PNG suitable for the native window icon', () => {
    const png = readFileSync(new URL('../../build/icon.png', import.meta.url))
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.equal(png.readUInt32BE(16), 512)
    assert.equal(png.readUInt32BE(20), 512)
  })
})

describe('main window background import startup', () => {
  class Window extends EventEmitter {
    visible = false
    shows = 0
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} })
    loadURL() {}
    loadFile() {}
    isDestroyed() { return false }
    isVisible() { return this.visible }
    show() { this.visible = true; this.shows++ }
  }
  const filename = fileURLToPath(new URL('./main-window.ts', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText
  const dependencies: Record<string, unknown> = {
    electron: { BrowserWindow: Window, Menu: { setApplicationMenu() {} }, shell: {} },
    'node:path': { join }, 'node:url': { pathToFileURL },
    '../common/logger': { logger: { child: () => ({ info() {}, debug() {}, error() {} }) } },
    '../common/external-web-link': { externalWebLink() {} },
    './speech-permissions': { installSpeechPermissions() {} },
    '../common/window-layout': { getWindowChromeConfig: () => ({ titleBarStyle: 'hidden' }) },
    '../../build/icon.png?asset': { default: 'test-icon.png' },
  }
  const pageModule = { exports: {} }
  compileFunction(compiled, ['require', 'exports', 'module', '__dirname'], { filename })(
    (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected runtime import: ${id}`)
      return dependencies[id]
    }, pageModule.exports, pageModule, dirname(filename),
  )
  const { createMainWindow } = pageModule.exports as typeof import('./main-window')

  it('keeps Web-launched windows hidden through ready, load completion and renderer reload', () => {
    const window = createMainWindow({ showOnReady: false, onClosed() {} }) as unknown as Window
    window.emit('ready-to-show')
    window.webContents.emit('did-finish-load')
    window.webContents.emit('did-finish-load')
    assert.equal(window.shows, 0)
    assert.equal(window.isVisible(), false)
    window.show()
    assert.equal(window.isVisible(), true, 'Local consent can explicitly present the window')
  })

  it('preserves normal startup and its did-finish-load fallback', () => {
    const ready = createMainWindow({ onClosed() {} }) as unknown as Window
    ready.emit('ready-to-show')
    assert.equal(ready.isVisible(), true)
    const fallback = createMainWindow({ onClosed() {} }) as unknown as Window
    fallback.webContents.emit('did-finish-load')
    assert.equal(fallback.isVisible(), true)
  })
})

describe('main process activation wiring', () => {
  const filename = fileURLToPath(new URL('../main.ts', import.meta.url))
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  function handler(owner: string, method: string, event?: string): string {
    let callback: string | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(source) === owner && node.expression.name.text === method
        && (!event || ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === event)) {
        callback = node.arguments[event ? 1 : 0].getText(source)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    assert.ok(callback, `${owner}.${method} handler must be registered`)
    return callback
  }

  it('Dock activation restores an existing hidden window and recreates a closed one', () => {
    let windows: object[] = [{}]
    let focused = 0
    let created = 0
    const activate = compileFunction(`return (${handler('app', 'on', 'activate')});`,
      ['BrowserWindow', 'openMainWindow', 'focusMainWindow', 'backend', 'skillImport'])(
      { getAllWindows: () => windows }, () => { created++ }, () => { focused++ }, { speech: {} }, {},
    ) as () => void
    activate()
    assert.equal(focused, 1)
    assert.equal(created, 0)
    windows = []
    activate()
    assert.equal(created, 1)
  })

  it('only a matching pending consent link restores a minimized/hidden native window', async () => {
    let exists = true
    let focused = 0
    const created: unknown[][] = []
    let state = { visible: false, phase: 'connecting', sessionId: 'session_1', instanceId: 'sep-default' }
    const link = { sessionId: 'session_1', instanceId: 'sep-default' }
    const open = compileFunction(`return (${handler('deepLinks', 'attach')});`,
      ['bridge', 'openMainWindow', 'focusMainWindow', 'backend', 'skillImport'])(
      { currentWindow: () => exists ? {} : null }, (...args: unknown[]) => { created.push(args) }, () => { focused++ },
      { speech: {} }, { async open() {}, async getState() { return state } },
    ) as (input: typeof link) => Promise<void>
    await open(link)
    state = { ...state, visible: false, phase: 'scanning' }
    await open(link)
    assert.equal(focused, 0)
    state = { ...state, visible: true, phase: 'awaiting-local-consent' }
    await open({ ...link, sessionId: 'other_session' })
    assert.equal(focused, 0, 'An unrelated session must not show another pending authorization')
    await open(link)
    assert.equal(focused, 1, 'A repeated authorization link must restore the native window')
    exists = false
    state = { ...state, visible: false, phase: 'ready' }
    await open(link)
    assert.equal(created.length, 1)
    assert.equal(created[0][2], false, 'A Web link recreates the native window in the background')
    assert.equal(focused, 1)
  })
})
