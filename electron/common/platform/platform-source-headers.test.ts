import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { platformSourceHeaders } from './platform-source-headers'

describe('platform source headers', () => {
  it('uses the platform origin without API paths, credentials or query strings', () => {
    assert.deepEqual(platformSourceHeaders('https://user:password@sep.example/api/?token=private'), {
      Origin: 'https://sep.example', Referer: 'https://sep.example/',
    })
  })

  it('preserves the scheme and port of a configured local platform', () => {
    assert.deepEqual(platformSourceHeaders('http://127.0.0.1:3001/api'), {
      Origin: 'http://127.0.0.1:3001', Referer: 'http://127.0.0.1:3001/',
    })
  })
})
