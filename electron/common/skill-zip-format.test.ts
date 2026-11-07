import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { skillZipHeaders, skillZipEnd } from './skill-zip-format'

test('ordinary skill ZIP records remain readable by an independent parser', () => {
  const data = Buffer.from('123456789')
  const { local, central } = skillZipHeaders({ name: Buffer.from('resource.txt'), size: data.length, crc: 0xcbf43926, offset: 0 })
  const zip = Buffer.concat([local, data, central, skillZipEnd(1, central.length, local.length + data.length)])
  assert.deepEqual(Buffer.from(unzipSync(zip)['resource.txt']!), data)
})

test('ZIP64 records represent sizes, offsets and counts beyond the legacy fields', () => {
  const large = 0x100000000
  const { local, central } = skillZipHeaders({ name: Buffer.from('large.bin'), size: large, crc: 0, offset: large })
  assert.equal(local.readUInt32LE(18), 0xffffffff)
  assert.equal(local.readBigUInt64LE(30 + 9 + 4), BigInt(large))
  assert.equal(central.readUInt32LE(42), 0xffffffff)
  const end = skillZipEnd(65536, large, large)
  assert.equal(end.readUInt32LE(0), 0x06064b50)
  assert.equal(end.readBigUInt64LE(32), 65536n)
  assert.equal(end.readBigUInt64LE(40), BigInt(large))
  assert.equal(end.readUInt32LE(56), 0x07064b50)
})
