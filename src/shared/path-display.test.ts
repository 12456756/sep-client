import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDirectoryPath } from './path-display'

test('shows the last directory segments', () => {
  assert.equal(formatDirectoryPath('C:\\Users\\alice\\Projects\\sep\\task-123'), '...\\Projects\\sep\\task-123')
  assert.equal(formatDirectoryPath('/Users/alice/Projects/sep'), '.../alice/Projects/sep')
})

test('keeps short paths unchanged and handles empty paths', () => {
  assert.equal(formatDirectoryPath('C:\\Tasks'), 'C:\\Tasks')
  assert.equal(formatDirectoryPath(''), '')
})

test('limits an unusually long path while preserving its end', () => {
  const formatted = formatDirectoryPath('C:\\Tasks\\this-is-a-very-long-directory-name-that-keeps-going', { maxSegments: 3, maxChars: 32 })
  assert.equal(formatted.length, 32)
  assert.match(formatted, /^\.\.\./)
  assert.match(formatted, /keeps-going$/)
})
