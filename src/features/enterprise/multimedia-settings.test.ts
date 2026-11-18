import { deepEqual, equal, match, doesNotMatch } from 'node:assert/strict'
import { test } from 'node:test'
import { sepRuntimeV3Fixture } from '../../shared/fixtures/sep-media-runtime-v3'
import type { MediaProfile } from '../../shared/media'
import type { SepRuntimeV3ProfileMetadata } from '../../shared/sep-runtime-v3-contract'
import { describeMediaParameters } from './multimedia-settings'

function profile(): MediaProfile {
  const fixture = sepRuntimeV3Fixture('image').profiles[0]
  return { profileId: fixture.profileId, configVersion: fixture.configVersion, displayName: fixture.displayName,
    parameters: fixture.parameters as SepRuntimeV3ProfileMetadata['parameters'], kind: 'image', operations: ['generate', 'edit'],
    executionMode: 'sync-response', capabilities: { referenceImage: true, cancel: false, recoverByRequestId: false }, allowedAspectRatios: [] }
}

test('media parameter descriptions keep suggestions distinct from allowed values and unknown limits', () => {
  const rows = describeMediaParameters(profile())
  const size = rows.find(row => row.key === 'size')!
  match(size.details.join(' '), /建议值：1024x1024/)
  doesNotMatch(size.details.join(' '), /允许值/)
  const ratio = rows.find(row => row.key === 'aspectRatio')!
  match(ratio.details.join(' '), /取值未声明/)
  doesNotMatch(ratio.details.join(' '), /无限|不限/)
  match(rows.find(row => row.key === 'count')!.details.join(' '), /最小值：1.*最大值：4.*步长：1/)
})

test('media parameter descriptions retain false and zero defaults and unsupported status', () => {
  const value = profile()
  value.parameters = { audio: { ...value.parameters!.quality, label: 'Audio', type: 'boolean', required: false, support: 'unsupported', valuesMode: 'unknown', values: undefined, default: false },
    offset: { ...value.parameters!.count, default: 0 } }
  const rows = describeMediaParameters(value)
  match(rows[0].details.join(' '), /不支持/)
  match(rows[0].details.join(' '), /默认值：否/)
  match(rows[1].details.join(' '), /默认值：0/)
})

test('legacy image capabilities expose known limits without inventing model parameters', () => {
  const value = profile()
  delete value.parameters
  value.allowedSizes = ['1024x1024']
  value.maxCount = 4
  value.maxCountSource = 'local-output-safety'
  const rows = describeMediaParameters(value)
  match(rows.find(row => row.key === 'size')!.details.join(' '), /允许值：1024x1024/)
  match(rows.find(row => row.key === 'count')!.details.join(' '), /客户端输出安全上限：4/)
  deepEqual(rows.find(row => row.key === 'aspectRatio')?.details, ['取值未声明'])
  value.parameters = {}
  equal(describeMediaParameters(value).length, 0)
})
