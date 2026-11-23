import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { BrowserWindow } from 'electron'
import { WindowCloseController } from './window-close'
import type { WindowCloseBehavior } from '../../src/shared/window-close'

class TestWindow extends EventEmitter {
  id = 1
  webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, isCrashed: () => false })
  minimized = false
  isDestroyed() { return false }
  isMinimized() { return this.minimized }
  minimize() { this.minimized = true }
  restore() { this.minimized = false }
  requestClose() {
    let prevented = false
    this.emit('close', { preventDefault: () => { prevented = true } })
    return prevented
  }
}

function setup(behavior: WindowCloseBehavior = 'ask', write?: (behavior: WindowCloseBehavior) => Promise<void>) {
  const window = new TestWindow()
  const requests: number[] = []
  const saved: WindowCloseBehavior[] = []
  const state = { quits: 0, installing: false }
  const browserWindow = window as unknown as BrowserWindow
  const controller = new WindowCloseController({ initialBehavior: behavior,
    settings: { write: write ?? (async value => { saved.push(value) }) },
    publish: id => requests.push(id), quit: () => { state.quits++ }, isUpdateInstallPrepared: () => state.installing,
  })
  controller.attach(browserWindow)
  window.webContents.emit('did-finish-load')
  return { controller, window, state, requests, saved, command: controller.command.bind(controller, browserWindow) }
}

test('close prompts once at a time; cancellation never persists or executes an action', async () => {
  const { window, requests, command, saved, state } = setup()
  assert.equal(window.requestClose(), true)
  assert.equal(window.requestClose(), true)
  assert.deepEqual(requests, [1])
  await command({ type: 'resolve', requestId: 1, action: 'cancel', remember: true })
  assert.equal(window.isMinimized(), false)
  assert.deepEqual(saved, [])
  assert.equal(state.quits, 0)
  assert.equal(window.requestClose(), true)
  assert.deepEqual(requests, [1, 2])
  await assert.rejects(command({ type: 'resolve', requestId: 1, action: 'quit', remember: false }))
})

test('minimize preserves the window and only skips later prompts when remembered', async () => {
  const { window, requests, command, saved, state } = setup()
  window.requestClose()
  await command({ type: 'resolve', requestId: 1, action: 'minimize', remember: false })
  assert.equal(window.isMinimized(), true)
  assert.equal(state.quits, 0)
  assert.deepEqual(saved, [])

  window.requestClose()
  assert.equal(window.isMinimized(), false, 'taskbar close restores the window to show the prompt')
  await command({ type: 'resolve', requestId: 2, action: 'minimize', remember: true })
  window.restore()
  window.requestClose()
  assert.equal(window.isMinimized(), true)
  assert.deepEqual(requests, [1, 2])
  assert.deepEqual(saved, ['minimize'])

  await command({ type: 'set', behavior: 'ask' })
  window.requestClose()
  assert.deepEqual(requests, [1, 2, 3])
})

test('direct exit waits for persistence and invokes the app quit path only once', async () => {
  let finish!: () => void
  const { window, requests, command, state } = setup('ask', () => new Promise(resolve => { finish = resolve }))
  window.requestClose()
  const quitting = command({ type: 'resolve', requestId: 1, action: 'quit', remember: true })
  window.requestClose()
  assert.equal(state.quits, 0)
  assert.deepEqual(requests, [1])
  finish()
  assert.equal(await quitting, 'quit')
  assert.equal(window.requestClose(), true, 'block further native closes during cleanup')
  assert.equal(state.quits, 1)
})

test('settings can select direct quit, and update shutdown never opens the close prompt', async () => {
  const { window, requests, state, command, controller } = setup()
  await command({ type: 'set', behavior: 'quit' })
  state.installing = true
  assert.equal(window.requestClose(), false)
  controller.beginShutdown()
  assert.equal(window.requestClose(), false)
  assert.equal(state.quits, 0)
  assert.deepEqual(requests, [])

  const coldStart = setup('quit')
  assert.equal(coldStart.window.requestClose(), true)
  await Promise.resolve()
  assert.equal(coldStart.state.quits, 1)
  assert.deepEqual(coldStart.requests, [])
})

test('a failed write does not quit or overwrite the effective behavior', async () => {
  const { window, requests, command, state } = setup('ask', async () => { throw Error('write denied') })
  window.requestClose()
  await assert.rejects(command({ type: 'resolve', requestId: 1, action: 'quit', remember: true }), /write denied/)
  assert.equal(await command({ type: 'get' }), 'ask')
  assert.equal(state.quits, 0)
  window.requestClose()
  assert.deepEqual(requests, [1, 2])
})
