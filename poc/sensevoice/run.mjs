import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { parseOptions } from './common.mjs'

const args = process.argv.slice(2)
const options = parseOptions(args)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [fileURLToPath(new URL('./electron-main.mjs', import.meta.url)), ...args], {
  env, stdio: 'inherit', windowsHide: true,
})
const timer = setTimeout(() => {
  process.stderr.write('Electron POC exceeded its overall timeout\n')
  child.kill()
}, options.timeoutMs + 15_000)
child.once('error', error => {
  clearTimeout(timer)
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', code => {
  clearTimeout(timer)
  process.exitCode = code ?? 1
})
