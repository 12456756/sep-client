import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArguments, shellQuote } from './upload-download-update.mjs'

test('upload CLI accepts exactly source, prepared directory and stable channel', () => {
  assert.deepEqual(parseArguments(['source', 'prepared', 'stable']), { source: 'source', prepared: 'prepared', channel: 'stable' })
  for (const args of [[], ['source'], ['source', 'prepared'], ['source', 'prepared', 'beta'], ['--source', 'prepared', 'stable']]) {
    assert.throws(() => parseArguments(args), /usage/)
  }
})

test('remote shell quoting preserves apostrophes as data', () => {
  assert.equal(shellQuote("/tmp/it's-safe"), "'/tmp/it'\\''s-safe'")
  assert.throws(() => shellQuote(''), /invalid remote path/)
  assert.throws(() => shellQuote('bad\0path'), /invalid remote path/)
})
