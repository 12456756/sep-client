import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { mediaCapabilitiesSchema, mediaGenerationInputSchema, mediaQuoteSchema, mediaReceiptSchema, parseMediaCapabilities } from './media-contract'
import * as mediaV2Fixture from '../../../src/shared/fixtures/media-runtime-v2.json'

const sepFixtures: { name: string; media: Record<string, unknown> }[] = JSON.parse(readFileSync(
  new URL('./fixtures/sep-media-runtime-v1.json', import.meta.url), 'utf8',
))

test('formal SEP configuration fixtures never advertise executable image tools', () => {
  for (const fixture of sepFixtures) {
    assert.deepEqual(parseMediaCapabilities(fixture.media), { protocolVersion: 1, tools: [], profiles: [] }, fixture.name)
  }
})

test('formal SEP runtime rejects unsupported execution and malformed configuration without leaking input', () => {
  const configured = sepFixtures[1].media
  for (const invalid of [
    { ...configured, executionAvailable: true },
    { ...configured, executionAvailable: 'false' },
    { ...configured, protocolVersion: 2 },
    { ...configured, tools: ['media_generate_image'] },
    { ...configured, profiles: [{ modelId: 'private-model', apiKey: 'secret' }] },
  ]) assert.throws(() => parseMediaCapabilities(invalid), { message: 'Invalid or unsupported SEP media runtime.' })
})

test('SEP image v2 defaults map into optional local fields while preserving protocol 1', () => {
  const wire = { protocolVersion: 2, executionAvailable: true, defaultProfileId: 'image-v2', tools: ['image_generate'], profiles: [{
    profileId: 'image-v2', kind: 'image', displayName: 'Image v2', configVersion: 'cfg-v2', operations: ['generate'], executionMode: 'sync-response',
    capabilities: { supportsReferenceImage: false, maxOutputs: 2, sizes: ['1024x1024', '1536x1024'], maxWidth: 1536, maxHeight: 1024,
      qualities: ['low', 'medium', 'high'], defaultQuality: 'high', defaultSize: '1536x1024' },
  }] }
  const local = parseMediaCapabilities(wire)
  assert.equal(local.protocolVersion, 1)
  assert.equal(local.defaultProfileId, 'image-v2')
  assert.equal(local.profiles[0]?.defaultQuality, 'high')
  assert.equal(local.profiles[0]?.defaultSize, '1536x1024')
  assert.throws(() => parseMediaCapabilities({ ...wire, protocolVersion: 1 }))
  assert.equal(mediaCapabilitiesSchema.safeParse({ ...capabilities, profiles: [{ ...capabilities.profiles[0], defaultSize: '1024x1024' }] }).success, false)
})

test('SEP backend image v2 fixture is consumed with strict defaults', () => {
  const local = parseMediaCapabilities(mediaV2Fixture.media)
  assert.equal(local.protocolVersion, 1)
  assert.equal(local.defaultProfileId, 'product-image-standard')
  assert.deepEqual(local.profiles[0]?.allowedQualities, ['low', 'medium', 'high'])
  assert.equal(local.profiles[0]?.defaultQuality, 'medium')
  assert.equal(local.profiles[0]?.defaultSize, '1024x1024')
  assert.throws(() => parseMediaCapabilities({
    ...mediaV2Fixture.media,
    profiles: [{ ...mediaV2Fixture.media.profiles[0], capabilities: {
      ...mediaV2Fixture.media.profiles[0].capabilities,
      defaultQuality: 'ultra',
    } }],
  }))
})

const capabilities = { protocolVersion: 1, tools: ['media_generate_image'], profiles: [{
  profileId: 'product', kind: 'image', displayName: 'Product image', configVersion: 'v1', operations: ['generate'], executionMode: 'async-query',
  capabilities: { referenceImage: false, cancel: false, recoverByRequestId: true }, allowedAspectRatios: ['1:1'], maxCount: 4,
}] }
const input = { profileId: 'product', operation: 'generate', localAssetIds: [], creativeBrief: 'Create a product image', parameters: { aspectRatio: '1:1', count: 1 } }
test('media accepts the explicit v1 image capability format and rejects unsupported protocols/video', () => {
  assert.equal(mediaCapabilitiesSchema.parse(capabilities).profiles.length, 1)
  assert.equal(mediaCapabilitiesSchema.safeParse({ ...capabilities, protocolVersion: 2 }).success, false)
  assert.equal(mediaCapabilitiesSchema.safeParse({ ...capabilities, profiles: [{ ...capabilities.profiles[0], kind: 'video' }] }).success, false)
})
test('media tool input rejects paths, provider payloads, billing and request identity', () => {
  assert.equal(mediaGenerationInputSchema.safeParse(input).success, true)
  for (const key of ['path', 'subscriptionId', 'clientRequestId', 'quoteId', 'providerPayload', 'price', 'url', 'apiKey']) {
    assert.equal(mediaGenerationInputSchema.safeParse({ ...input, [key]: 'untrusted' }).success, false, key)
  }
  assert.equal(mediaGenerationInputSchema.safeParse({ ...input, localAssetIds: ['../../secret'] }).success, false)
  assert.equal(mediaGenerationInputSchema.safeParse({ ...input, parameters: { ...input.parameters, count: 17 } }).success, false)
})
test('local quote port requires explicit authorization fields and platform-owned amount strings', () => {
  const quote = { quoteId: 'q', requestHash: 'a'.repeat(64), expiresAt: 1234, status: 'quoted', amount: '1.25', currency: 'CNY', authorized: true, budgetAuthorized: true, allowUnknownCost: false }
  assert.equal(mediaQuoteSchema.safeParse(quote).success, true)
  assert.equal(mediaQuoteSchema.safeParse({ ...quote, amount: 1.25 }).success, false)
  assert.equal(mediaQuoteSchema.safeParse({ ...quote, amount: null }).success, false)
  assert.equal(mediaQuoteSchema.safeParse({ ...quote, status: 'unavailable', amount: null, currency: null, allowUnknownCost: true }).success, true)
  const { budgetAuthorized: _budget, ...missing } = quote
  assert.equal(mediaQuoteSchema.safeParse(missing).success, false)
})
test('receipt input does not accept arbitrary output URLs or oversized content', () => {
  const receipt = { receiptId: 'receipt', clientRequestId: 'client', profileId: 'product', configVersion: 'v1', status: 'SUCCEEDED', pollAfterMs: 1000, billingStatus: 'SETTLED', outputs: [] }
  const output = { outputId: 'out', mime: 'image/png', size: 100, width: 1, height: 1, expiresAt: null }
  assert.equal(mediaReceiptSchema.safeParse({ ...receipt, outputs: [output] }).success, true)
  assert.equal(mediaReceiptSchema.safeParse({ ...receipt, outputs: [{ ...output, url: 'https://untrusted.test/image' }] }).success, false)
  assert.equal(mediaReceiptSchema.safeParse({ ...receipt, outputs: [{ ...output, size: 33 * 1024 * 1024 }] }).success, false)
})

test('V3 runtime preserves its negotiated version and advisory specifications do not become defaults', () => {
  const capabilities = parseMediaCapabilities({ protocolVersion: 3, executionAvailable: true, defaultProfileId: 'image-v3',
    tools: ['image_generate'], profiles: [{ profileId: 'image-v3', kind: 'image', displayName: 'Image', configVersion: 'cfg',
      operations: ['generate'], executionMode: 'sync-response', capabilities: { supportsReferenceImage: false } }] })
  assert.equal(capabilities.protocolVersion, 3)
  assert.deepEqual(capabilities.profiles[0].allowedAspectRatios, [])
  assert.equal(capabilities.profiles[0].defaultSize, undefined)
  assert.equal(capabilities.profiles[0].maxCountSource, undefined)
  assert.equal(capabilities.profiles[0].maxCount, undefined)
  const input = { protocolVersion: 3, profileId: 'image-v3', operation: 'generate', creativeBrief: 'poster', localAssetIds: [],
    requestedSpec: { width: 1600, height: 2400, quality: 'ultra', count: 12 }, parameters: { width: 1600, height: 2400, quality: 'ultra', count: 12 },
    parameterSources: { width: 'user', height: 'model', quality: 'model', count: 'user' }, specRevision: 2 }
  assert.deepEqual(mediaGenerationInputSchema.parse(input), input)
  assert.equal(mediaGenerationInputSchema.safeParse({ ...input, specRevision: undefined }).success, false)
})

test('V3 operation exposure is the intersection of profile support and runtime authorization', () => {
  const profile = { profileId: 'image-v3', kind: 'image', displayName: 'Image', configVersion: 'cfg',
    operations: ['generate', 'edit'], executionMode: 'sync-response', capabilities: { supportsReferenceImage: true } }
  for (const [tools, expected] of [
    [['image_generate'], ['generate']], [['image_edit'], ['edit']], [['image_generate', 'image_edit'], ['generate', 'edit']],
  ]) {
    const capabilities = parseMediaCapabilities({ protocolVersion: 3, executionAvailable: true, defaultProfileId: profile.profileId, tools, profiles: [profile] })
    assert.deepEqual(capabilities.profiles[0].operations, expected)
    assert.equal(mediaCapabilitiesSchema.safeParse(capabilities).success, true)
  }
  const unavailable = parseMediaCapabilities({ protocolVersion: 3, executionAvailable: true, defaultProfileId: profile.profileId,
    tools: ['image_generate'], profiles: [{ ...profile, operations: ['edit'] }] })
  assert.deepEqual(unavailable.profiles, [])
  assert.deepEqual(unavailable.tools, [])
  assert.equal(unavailable.defaultProfileId, null)
})

test('new V3 inputs normalize cleared optional fields without rewriting historical legacy input', () => {
  const parameters = { count: 1, quality: undefined }
  const parsed = mediaGenerationInputSchema.parse({ protocolVersion: 3, profileId: 'image-v3', operation: 'generate', localAssetIds: [],
    creativeBrief: 'poster', parameters, requestedSpec: parameters, parameterSources: { count: 'user' }, specRevision: 1 })
  assert.deepEqual(parsed.parameters, { count: 1 })
  assert.deepEqual(parsed.requestedSpec, { count: 1 })
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(parsed)))
  const legacy = { profileId: 'legacy', operation: 'generate', localAssetIds: [], creativeBrief: 'poster',
    parameters: { aspectRatio: '1:1', count: 1, quality: undefined } }
  assert.deepEqual(mediaGenerationInputSchema.parse(legacy), legacy)
})
