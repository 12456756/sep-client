import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import { LoginFeedbackError } from './login-error'

function setup() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'sep-vault-test-'))
  fs.mkdirSync(path.join(directory, 'auth'))
  const dependencies: Record<string, unknown> = {
    electron: { app: { getPath: () => directory }, safeStorage: {
      isEncryptionAvailable: () => true,
      decryptString: (buffer: Buffer) => buffer.toString(),
      encryptString: (value: string) => Buffer.from(value),
    } },
    fs, path, zod: { z }, './login-error': { LoginFeedbackError },
  }
  const filename = fileURLToPath(new URL('./credential-vault.ts', import.meta.url))
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  compileFunction(compiled, ['require', 'exports', 'module'], { filename })(
    (id: string) => { assert.ok(Object.hasOwn(dependencies, id), id); return dependencies[id] }, module.exports, module,
  )
  return {
    vault: module.exports as typeof import('./credential-vault'),
    file: (name: string) => path.join(directory, 'auth', name),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  }
}

it('distinguishes absent credentials from corrupt files and preserves corrupt data on save', () => {
  const h = setup()
  try {
    assert.deepEqual(h.vault.listRememberedAccounts(), [])
    assert.equal(h.vault.getRememberedPassword('test@example.test'), null)
    fs.writeFileSync(h.file('accounts.json'), 'broken')
    assert.throws(() => h.vault.listRememberedAccounts(), { reason: 'accounts_read' })
    fs.writeFileSync(h.file('accounts.json'), '[]')
    fs.writeFileSync(h.file('passwords.enc'), 'broken')
    assert.throws(() => h.vault.getRememberedPassword('test@example.test'), { reason: 'password_read' })
    assert.throws(() => h.vault.saveRememberedAccount({ email: 'test@example.test', displayName: 'Test', enterpriseName: 'Test' }, 'fixture', true))
    assert.equal(fs.readFileSync(h.file('passwords.enc'), 'utf8'), 'broken')
    fs.writeFileSync(h.file('passwords.enc'), '{"test@example.test":123}')
    assert.throws(() => h.vault.getRememberedPassword('test@example.test'), { reason: 'password_read' })
  } finally { h.cleanup() }
})
