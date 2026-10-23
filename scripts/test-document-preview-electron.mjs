import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import process from 'node:process'

const electron = createRequire(import.meta.url)('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['scripts/fixtures/document-preview-electron.mjs'], { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true })
const timer = setTimeout(() => child.kill(), 60000)
child.on('error', error => { clearTimeout(timer); process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
child.on('exit', code => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1 })
