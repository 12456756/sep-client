import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { imageAspectRatio } from './media-spec'

test('image size ratio helper normalizes dimensions and rejects unsupported or mismatched sizes', () => {
  assert.equal(imageAspectRatio('1536x1024'), '3:2')
  assert.equal(imageAspectRatio('1024x1536'), '2:3')
  assert.equal(imageAspectRatio('bad'), undefined)
})
