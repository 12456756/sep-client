import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { SkillImportApiError } from '../common/platform/skill-import-api'
import { acceptedScopeHash } from '../domain/skill-import'
import type { ImportApiPort, ImportDevicesPort, ImportFilesPort, ImportInstance } from '../domain/skill-import-ports'
import type { SkillImportStateView } from '../../src/shared/skill-import-contracts'
import { SkillImportService } from './skill-import-service'

type HttpOptions = { body?: Record<string, unknown>; signal?: AbortSignal; token?: string }
type RequestFn = (method: 'GET' | 'POST' | 'DELETE', route: string, schema: unknown, options: HttpOptions) => Promise<unknown>
type Override = { request?: RequestFn; scan?: ImportFilesPort['scan']; preview?: ImportFilesPort['preview']; packageSelected?: ImportFilesPort['packageSelected']; commandItems?: unknown[]; bindings?: ImportDevicesPort extends { list(): Promise<Array<infer T>> } ? T[] : never; wait?: (ms: number, signal: AbortSignal) => Promise<void> }

const date = (delta = 60_000) => new Date(Date.now() + delta).toISOString()
const challenge = { challengeId: 'challenge_1', purpose: 'session-grant', instanceId: 'sep-default', sessionId: 'session_1', pairingId: 'pairing_1', deviceId: null, keyFingerprint: 'a'.repeat(64), nonce: 'nonce_nonce_nonce', expiresAt: date(300_000) }
const granted = { status: 'granted', sessionId: 'session_1', deviceId: null, sessionGrant: 'independent-session-grant', sessionGrantExpiresAt: date(300_000), sessionExpiresAt: date(600_000), idleExpiresAt: date(300_000), acceptedScopeHash: 'will-be-computed' }

function harness(overrides: Override = {}) {
  const calls: Array<{ method: string; route: string; options: HttpOptions }> = []
  const states: SkillImportStateView[] = []
  const files = {
    async listRoots() { return [{ id: 'root_1', label: 'Personal', scope: 'user' as const, sources: ['codex'] }] },
    async addProjectRoot() { throw new Error('unused') }, async removeRoot() {},
    scan: overrides.scan ?? (async () => []),
    preview: overrides.preview ?? (async () => { throw new SkillImportApiError('PREVIEW_TIMEOUT') }),
    packageSelected: overrides.packageSelected ?? (async () => ({ sha256: 'b'.repeat(64), bytes: 12, filename: 'skill.zip', async *open() { yield new Uint8Array([1]) } })),
    async reset() {}, async dispose() {},
  }
  const devices = {
    available: () => false,
    createIdentity: () => ({ publicKey: 'public-key', keyFingerprint: 'a'.repeat(64), sign: () => 'signature' }),
    async list() { return overrides.bindings ?? [] }, async identity() { return ({ publicKey: 'public-key', keyFingerprint: 'a'.repeat(64), sign: () => 'signature' }) }, async remember() {}, async disable() {}, async forget() {},
  }
  const api = {
    async request(method: 'GET' | 'POST' | 'DELETE', route: string, schema: unknown, options: HttpOptions) {
      calls.push({ method, route, options })
      if (overrides.request) return overrides.request(method, route, schema, options)
      if (route === 'pairings') return { pairingId: 'pairing_1', shortCode: '123456', ownerLabel: 'Admin', scope: 'user', expiresAt: date(300_000), challenge }
      if (route === 'grants') return { ...granted, acceptedScopeHash: requireScopeHash(options.body!.scope as string, options.body!.rootIds as string[]) }
      if (route.includes('/commands')) return { items: overrides.commandItems ?? [], nextCursor: 1 }
      if (route.endsWith('/events')) return { ok: true, eventId: options.body!.eventId, cursor: options.body!.sequence, ignored: false }
      if (route.endsWith('/operations/op_1')) return { operationId: 'op_1', status: 'succeeded', retryable: false, sha256: 'b'.repeat(64), errorCode: null, expiresAt: date() }
      if (route.endsWith('/upload-grant')) return { uploadGrant: 'separate-upload-grant', expiresAt: date() }
      if (route === 'challenges') return { ...challenge, challengeId: 'challenge_2' }
      if (route.startsWith('sessions/')) return { ok: true }
      throw new Error(`unexpected ${method} ${route}`)
    },
    async upload() { throw new Error('upload must not happen') },
  }
  const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
  const service = new SkillImportService({ files: files as unknown as ImportFilesPort, devices: devices as unknown as ImportDevicesPort,
    instances: [{ instanceId: 'sep-default', label: 'SEP', apiBaseUrl: 'https://sep.example/api' }] satisfies ImportInstance[], api: () => api as unknown as ImportApiPort,
    clientVersion: '1.0.0', platform: 'darwin', publish: state => states.push(state), wait: overrides.wait ?? wait })
  return { service, calls, states, files, api }
}

function requireScopeHash(scope: string, rootIds: string[]) {
  return acceptedScopeHash(scope as 'user' | 'project' | 'all', rootIds)
}

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) { if (Date.now() > deadline) assert.fail('condition did not settle'); await new Promise(resolve => setTimeout(resolve, 1)) }
}

test('pairing alone cannot scan before local consent and Web confirmation', async () => {
  let grantCalls = 0
  const h = harness({ request: async (_method, route, _schema, _options) => {
    if (route === 'pairings') return { pairingId: 'pairing_1', shortCode: '123456', ownerLabel: 'Admin', scope: 'user', expiresAt: date(300_000), challenge }
    if (route === 'grants') { grantCalls++; return { status: 'pending-web-confirmation', pairingId: 'pairing_1', retryAfterSeconds: 2, expiresAt: date(300_000) } }
    if (route.includes('/commands')) return { items: [], nextCursor: 0 }
    throw new Error(route)
  } })
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await until(() => h.service['state'].phase === 'awaiting-local-consent')
  assert.equal(h.states[0].visible, false, 'Connecting must not take over the workspace')
  assert.equal(h.service['state'].visible, true, 'First-time local consent must be visible')
  assert.equal(h.calls.some(call => call.route.includes('/commands')), false)
  await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['root_1'] })
  await until(() => h.service['state'].phase === 'waiting-web-confirmation')
  assert.equal(h.service['state'].visible, false, 'After local approval the user continues on Web')
  assert.equal(grantCalls, 1)
  assert.equal(h.calls.some(call => call.route.includes('/commands')), false)
  await h.service.cancel('session_1')
})

test('renderer cannot inject an unapproved root or change the requested scope', async () => {
  const h = harness()
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await until(() => h.service['state'].phase === 'awaiting-local-consent')
  await assert.rejects(h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['other_root'] }), { code: 'SCOPE_MISMATCH' })
  await assert.rejects(h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'project', rootIds: ['root_1'] }), { code: 'SCOPE_MISMATCH' })
  assert.equal(h.calls.some(call => call.route === 'grants'), false)
  await h.service.cancel('session_1')
})

test('cancel prevents a late command completion from publishing uploaded', async () => {
  let finishScan!: (items: never[]) => void
  const h = harness({ scan: () => new Promise(resolve => { finishScan = resolve }), commandItems: [{ sessionId: 'session_1', commandId: 'scan_1', sequence: 1, expiresAt: date(), type: 'scan', payload: { scope: 'user', rootIds: ['root_1'] } }] })
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await until(() => h.service['state'].phase === 'awaiting-local-consent')
  await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['root_1'] })
  await until(() => Boolean(finishScan)).catch(() => assert.fail(JSON.stringify({ calls: h.calls.map(call => call.route), state: h.service['state'] })))
  const cancelled = h.service.cancel('session_1')
  finishScan([])
  await cancelled
  assert.equal(h.states.some(state => state.phase === 'uploaded'), false)
  assert.equal(h.service['state'].phase, 'cancelled')
})

test('an upload response lost after server success is reconciled without a second upload', async () => {
  let uploads = 0
  let commandCalls = 0
  const h = harness({ commandItems: [{ sessionId: 'session_1', commandId: 'package_1', sequence: 1, expiresAt: date(), type: 'package-selected', payload: { candidateId: 'candidate_1', snapshotId: 'snapshot_1', operationId: 'op_1' } }], request: async (_method, route, _schema, options) => {
    if (route === 'pairings') return { pairingId: 'pairing_1', shortCode: '123456', ownerLabel: 'Admin', scope: 'user', expiresAt: date(300_000), challenge }
    if (route === 'grants') return { ...granted, acceptedScopeHash: requireScopeHash(options.body!.scope as string, options.body!.rootIds as string[]) }
    if (route.includes('/commands')) { commandCalls++; return { items: [{ sessionId: 'session_1', commandId: 'package_1', sequence: 1, expiresAt: date(), type: 'package-selected', payload: { candidateId: 'candidate_1', snapshotId: 'snapshot_1', operationId: 'op_1' } }], nextCursor: 1 } }
    if (route.endsWith('/events')) return { ok: true, eventId: options.body!.eventId, cursor: options.body!.sequence, ignored: false }
    if (route.endsWith('/operations/op_1')) return { operationId: 'op_1', status: 'succeeded', retryable: false, sha256: 'b'.repeat(64), errorCode: null, expiresAt: date() }
    throw new Error(route)
  } })
  h.api.upload = async () => { uploads++; throw new Error('unexpected') }
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await until(() => h.service['state'].phase === 'awaiting-local-consent')
  await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['root_1'] })
  await until(() => commandCalls > 0)
  await until(() => h.service['state'].phase === 'uploaded' || h.service['state'].phase === 'failed')
  assert.equal(uploads, 0)
  assert.equal(h.service['state'].phase, 'uploaded', JSON.stringify({ state: h.service['state'], calls: h.calls.map(call => call.route) }))
  assert.equal(h.service.isActive(), true, 'successful upload keeps the grant active for the next Web selection')
  assert.ok(h.states.filter(state => ['packaging', 'uploading', 'uploaded'].includes(state.phase)).every(state => !state.visible))
  await h.service.cancel('session_1')
})

test('matching remembered device receives a fresh challenge without a second pairing confirmation', async () => {
  let grantBody: Record<string, unknown> | undefined
  let commandPolls = 0
  const h = harness({ bindings: [{ deviceId: 'device_1', instanceId: 'sep-default', label: 'This computer', keyFingerprint: 'a'.repeat(64), platform: 'darwin', scope: 'user', rootIds: ['root_1'], revocationPending: false }], request: async (_method, route, _schema, options) => {
    if (route === 'pairings') return { pairingId: 'pairing_1', shortCode: '123456', ownerLabel: 'Admin', scope: 'user', expiresAt: date(300_000), challenge }
    if (route === 'challenges') return { ...challenge, challengeId: 'challenge_2', deviceId: 'device_1', pairingId: null }
    if (route === 'grants') { grantBody = options.body; return { ...granted, acceptedScopeHash: requireScopeHash(options.body!.scope as string, options.body!.rootIds as string[]) } }
    if (route.includes('/commands')) { commandPolls++; return { items: [], nextCursor: 0 } }
    throw new Error(route)
  } })
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await until(() => commandPolls > 0)
  assert.equal(h.calls.some(call => call.route === 'grants'), true)
  assert.deepEqual(grantBody?.['rootIds'], ['root_1'])
  assert.equal(grantBody?.['rememberDevice'], true)
  assert.equal(h.service['state'].phase, 'ready')
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await h.service.open({ instanceId: 'sep-default', sessionId: 'other_session' })
  assert.equal(h.service['state'].busySessionId, 'other_session')
  assert.ok(h.states.every(state => !state.visible), 'Remembered authorization and repeated links must stay in the background')
  assert.equal(h.states.some(state => state.phase === 'awaiting-local-consent'), false)
  await h.service.cancel('session_1')
})

test('Web can reopen a dismissed first-time consent request without starting a second pairing', async () => {
  const h = harness()
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await until(() => h.service['state'].phase === 'awaiting-local-consent')
  h.service.setVisible(false)
  await h.service.open({ instanceId: 'sep-default', sessionId: 'other_session' })
  assert.equal(h.service['state'].visible, false, 'Another session must not take over the pending consent')
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  assert.equal(h.service['state'].visible, true)
  assert.equal(h.calls.filter(call => call.route === 'pairings').length, 1)
  await h.service.cancel('session_1')
  assert.equal(h.service['state'].visible, false)
})

test('revoked, different-owner, missing-root, and expanded-scope bindings require local consent', async () => {
  const binding = { deviceId: 'device_1', instanceId: 'sep-default', label: 'This computer', keyFingerprint: 'a'.repeat(64), platform: 'darwin', scope: 'user' as const, rootIds: ['root_1'], revocationPending: false }
  for (const reason of ['DEVICE_REVOKED', 'OWNER_MISMATCH', 'missing-root', 'expanded-scope', 'revocation-pending']) {
    const h = harness({ bindings: [{ ...binding,
      ...(reason === 'missing-root' ? { rootIds: ['missing_root'] } : {}),
      ...(reason === 'expanded-scope' ? { scope: 'project' as const } : {}),
      revocationPending: reason === 'revocation-pending',
    }] })
    const request = h.api.request.bind(h.api)
    h.api.request = async (method, route, schema, options) => {
      if (route === 'challenges') throw new SkillImportApiError(reason)
      return request(method, route, schema, options)
    }
    try {
      await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
      await until(() => h.service['state'].phase === 'awaiting-local-consent')
      assert.equal(h.service['state'].visible, true, reason)
      assert.equal(h.calls.some(call => call.route === 'grants' || call.route.includes('/commands')), false, reason)
    } finally { await h.service.cancel('session_1') }
  }
})

test('non-retryable initial pairing errors ask for local action', async () => {
  for (const code of ['IMPORT_UNAVAILABLE', 'CLIENT_UPGRADE_REQUIRED']) {
    const h = harness({ request: async () => { throw new SkillImportApiError(code, 403, false) } })
    await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
    await until(() => h.service['state'].phase === 'failed')
    assert.equal(h.service['state'].visible, true)
    assert.equal(h.service['state'].error?.code, code)
    await h.service.dispose()
  }
})

test('retryable initial pairing outage remains in background while the client retries', async () => {
  const h = harness({ request: async () => { throw new SkillImportApiError('NETWORK_UNAVAILABLE', 0, true) } })
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.service['state'].visible, false)
  await h.service.cancel('session_1')
})

test('remembered authorization finds the current owner and keeps the originally approved root subset', async () => {
  const binding = { deviceId: 'other_owner', instanceId: 'sep-default', label: 'Same label', keyFingerprint: 'a'.repeat(64), platform: 'darwin', scope: 'user' as const, rootIds: ['root_1'], revocationPending: false }
  let approvedRoots: unknown
  const h = harness({ bindings: [binding, { ...binding, deviceId: 'current_owner' }], request: async (_method, route, _schema, options) => {
    if (route === 'pairings') return { pairingId: 'pairing_1', shortCode: '123456', ownerLabel: 'Same label', scope: 'user', expiresAt: date(300_000), challenge }
    if (route === 'challenges') {
      if (options.body?.deviceId === 'other_owner') throw new SkillImportApiError('OWNER_MISMATCH')
      assert.equal(options.body?.deviceId, 'current_owner')
      return { ...challenge, challengeId: 'challenge_2', deviceId: 'current_owner', pairingId: null }
    }
    if (route === 'grants') {
      approvedRoots = options.body?.rootIds
      return { ...granted, deviceId: 'current_owner', acceptedScopeHash: acceptedScopeHash('user', ['root_1']) }
    }
    if (route.includes('/commands')) return { items: [], nextCursor: 0 }
    return { ok: true }
  } })
  h.files.listRoots = async () => [
    { id: 'root_1', label: 'Personal', scope: 'user', sources: ['codex'] },
    { id: 'root_2', label: 'New directory', scope: 'user', sources: ['codex'] },
  ]
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await until(() => h.service['state'].phase === 'ready')
  assert.deepEqual(approvedRoots, ['root_1'])
  assert.equal(h.service['state'].roots.find(root => root.rootId === 'root_2')?.authorized, false)
  await h.service.cancel('session_1')
})

test('preview failure reports an error and returns the active session to results', async () => {
  const h = harness({ commandItems: [{ sessionId: 'session_1', commandId: 'preview_1', sequence: 1, expiresAt: date(), type: 'preview', payload: { requestId: 'request_1', candidateId: 'candidate_1', revision: 1 } }] })
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await until(() => h.service['state'].phase === 'awaiting-local-consent')
  await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['root_1'] })
  await until(() => h.calls.some(call => call.method === 'POST' && call.route.endsWith('/events') && call.options.body?.['type'] === 'error'))
  assert.equal(h.service['state'].phase, 'results')
  assert.equal(h.states.some(state => state.phase === 'failed'), false)
  await h.service.cancel('session_1')
})

test('preview expiry is bounded by the five-minute client limit', async () => {
  let previewInput: Parameters<ImportFilesPort['preview']>[0] | undefined
  const h = harness({
    commandItems: [{ sessionId: 'session_1', commandId: 'preview_1', sequence: 1, expiresAt: date(), type: 'preview', payload: { requestId: 'request_1', candidateId: 'candidate_1', revision: 1 } }],
    preview: async input => {
      previewInput = input
      return { requestId: input.requestId, candidateId: input.candidateId, snapshotId: 'snapshot_1', expiresAt: date(240_000), content: 'name: demo', treeHash: 'b'.repeat(64), fileCount: 1, totalUncompressedBytes: 12, estimatedPackageBytes: 120, files: [{ relativePath: 'SKILL.md', bytes: 12 }], nextFilesCursor: null, warnings: [] }
    },
  })
  const before = Date.now()
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await until(() => h.service['state'].phase === 'awaiting-local-consent')
  await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['root_1'] })
  await until(() => previewInput !== undefined)
  const expiresAt = Date.parse(previewInput!.expiresAt)
  assert.ok(expiresAt > before)
  assert.ok(expiresAt <= before + 5 * 60_000 + 1000, `${previewInput!.expiresAt} exceeds five-minute bound`)
  await h.service.cancel('session_1')
})

test('retryable upload failure is reconciled by operation status without a second upload', async () => {
  let uploads = 0
  let operationReads = 0
  let commandPolls = 0
  const h = harness({
    commandItems: [{ sessionId: 'session_1', commandId: 'package_1', sequence: 1, expiresAt: date(), type: 'package-selected', payload: { candidateId: 'candidate_1', snapshotId: 'snapshot_1', operationId: 'op_1' } }],
    wait: async (_ms, signal) => { signal.throwIfAborted(); await new Promise<void>(resolve => setImmediate(resolve)) },
    request: async (_method, route, _schema, options) => {
      if (route === 'pairings') return { pairingId: 'pairing_1', shortCode: '123456', ownerLabel: 'Admin', scope: 'user', expiresAt: date(300_000), challenge }
      if (route === 'grants') return { ...granted, acceptedScopeHash: requireScopeHash(options.body!.scope as string, options.body!.rootIds as string[]) }
      if (route.includes('/commands')) {
        commandPolls++
        return { items: commandPolls === 1 ? [{ sessionId: 'session_1', commandId: 'package_1', sequence: 1, expiresAt: date(), type: 'package-selected', payload: { candidateId: 'candidate_1', snapshotId: 'snapshot_1', operationId: 'op_1' } }] : [], nextCursor: 1 }
      }
      if (route.endsWith('/events')) return { ok: true, eventId: options.body!.eventId, cursor: options.body!.sequence, ignored: false }
      if (route.endsWith('/operations/op_1')) {
        operationReads++
        return { operationId: 'op_1', status: operationReads === 1 ? 'pending' : 'succeeded', retryable: false, sha256: 'b'.repeat(64), errorCode: null, expiresAt: date(300_000) }
      }
      if (route.endsWith('/upload-grant')) return { uploadGrant: 'separate-upload-grant', expiresAt: date(300_000) }
      throw new Error(route)
    },
  })
  h.api.upload = async () => { uploads++; throw new SkillImportApiError('NETWORK_UNAVAILABLE', 0, true) }
  await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
  await until(() => h.service['state'].phase === 'awaiting-local-consent')
  await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['root_1'] })
  await until(() => h.service['state'].phase === 'uploaded' || h.service['state'].phase === 'failed')
  assert.equal(h.service['state'].phase, 'uploaded', JSON.stringify({ state: h.service['state'], calls: h.calls.map(call => call.route) }))
  assert.equal(uploads, 1)
  assert.ok(operationReads >= 2)
  assert.equal(h.service.isActive(), true, 'reconciled upload keeps the grant active for the next Web selection')
  await h.service.cancel('session_1')
})

test('lost first remembered grant recovers with the same pairing and its newly registered device', async () => {
  const h = harness({ wait: async (_ms, signal) => { signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 1)) } })
  h.service['options'].devices.available = () => true
  const request = h.api.request.bind(h.api)
  let grantCalls = 0
  let rememberedDevice: string | undefined
  h.service['options'].devices.remember = async (_identity, binding) => { rememberedDevice = binding.deviceId }
  h.api.request = async (method, route, schema, options) => {
    if (route === 'grants') {
      grantCalls++
      if (grantCalls === 1) throw new SkillImportApiError('NETWORK_UNAVAILABLE', 0, true)
      if (grantCalls === 2) throw new SkillImportApiError('CHALLENGE_USED')
      return { ...granted, deviceId: 'device_1', acceptedScopeHash: acceptedScopeHash('user', ['root_1']) }
    }
    if (route === 'challenges') {
      assert.equal(options.body?.pairingId, 'pairing_1')
      return { ...challenge, challengeId: 'replacement', deviceId: 'device_1' }
    }
    return request(method, route, schema, options)
  }
  try {
    await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
    await until(() => h.service['state'].phase === 'awaiting-local-consent')
    await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: true, scope: 'user', rootIds: ['root_1'] })
    await until(() => h.service['state'].phase === 'ready' || h.service['state'].phase === 'failed')
    assert.equal(h.service['state'].phase, 'ready')
    assert.equal(rememberedDevice, 'device_1')
    assert.equal(grantCalls, 3)
  } finally { await h.service.dispose() }
})

test('replacement challenges still reject a different pairing, key, or session', async () => {
  for (const changed of [{ pairingId: 'other_pairing' }, { keyFingerprint: 'b'.repeat(64) }, { sessionId: 'other_session' }]) {
    const h = harness()
    h.service['options'].devices.available = () => true
    const request = h.api.request.bind(h.api)
    h.api.request = async (method, route, schema, options) => {
      if (route === 'grants') throw new SkillImportApiError('CHALLENGE_USED')
      if (route === 'challenges') return { ...challenge, challengeId: 'replacement', deviceId: 'device_1', ...changed }
      return request(method, route, schema, options)
    }
    try {
      await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
      await until(() => h.service['state'].phase === 'awaiting-local-consent')
      await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: true, scope: 'user', rootIds: ['root_1'] })
      await until(() => h.service['state'].phase === 'failed')
      assert.equal(h.service['state'].error?.code, 'DEVICE_PROOF_INVALID')
    } finally { await h.service.dispose() }
  }
})

test('grant recovery cannot create a remembered device without consent or switch the recovered device', async () => {
  for (const rememberDevice of [false, true]) {
    const h = harness()
    h.service['options'].devices.available = () => true
    const request = h.api.request.bind(h.api)
    let grants = 0
    let remembered = false
    h.service['options'].devices.remember = async () => { remembered = true }
    h.api.request = async (method, route, schema, options) => {
      if (route === 'grants') {
        if (++grants === 1) throw new SkillImportApiError('CHALLENGE_USED')
        return { ...granted, deviceId: 'different_device', acceptedScopeHash: acceptedScopeHash('user', ['root_1']) }
      }
      if (route === 'challenges') return { ...challenge, challengeId: 'replacement', deviceId: 'device_1' }
      return request(method, route, schema, options)
    }
    try {
      await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
      await until(() => h.service['state'].phase === 'awaiting-local-consent')
      await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice, scope: 'user', rootIds: ['root_1'] })
      await until(() => h.service['state'].phase === 'failed')
      assert.equal(h.service['state'].error?.code, 'DEVICE_PROOF_INVALID')
      assert.equal(remembered, false)
      assert.equal(h.calls.some(call => call.route.includes('/commands')), false)
    } finally { await h.service.dispose() }
  }
})

const scanCommand = () => ({ sessionId: 'session_1', commandId: 'scan_1', sequence: 1, expiresAt: date(), type: 'scan', payload: { scope: 'user', rootIds: ['root_1'] } })

test('scan failures report a Web-visible error before stopping the hidden client', async () => {
  const h = harness({ scan: async () => { throw new SkillImportApiError('PERMISSION_DENIED') }, commandItems: [scanCommand()] })
  try {
    await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
    await until(() => h.service['state'].phase === 'awaiting-local-consent')
    await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['root_1'] })
    await until(() => h.service['state'].phase === 'failed')
    const events = h.calls.filter(call => call.route.endsWith('/events')).map(call => call.options.body)
    assert.deepEqual(events.map(event => event?.type), ['command-started', 'error'])
    assert.equal((events[1]?.payload as { code: string }).code, 'PERMISSION_DENIED')
    assert.equal(h.service['state'].visible, false)
  } finally { await h.service.dispose() }
})

test('unreachable failure reporting is bounded and preserves the original scan error', { timeout: 8000 }, async () => {
  const h = harness({ scan: async () => { throw new SkillImportApiError('PERMISSION_DENIED') }, commandItems: [scanCommand()] })
  const request = h.api.request.bind(h.api)
  let reports = 0
  h.api.request = async (method, route, schema, options) => {
    if (route.endsWith('/events') && options.body?.type === 'error') {
      reports++
      return new Promise((_resolve, reject) => {
        const signal = options.signal!
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    return request(method, route, schema, options)
  }
  try {
    await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
    await until(() => h.service['state'].phase === 'awaiting-local-consent')
    await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['root_1'] })
    await until(() => h.service['state'].phase === 'failed', 5000)
    assert.equal(reports, 1)
    assert.equal(h.service['state'].error?.code, 'PERMISSION_DENIED')
    assert.equal(h.service.isActive(), false)
  } finally { await h.service.dispose() }
})

test('cancelling during failure reporting aborts the notification and completes cleanup', { timeout: 2000 }, async () => {
  const h = harness({ scan: async () => { throw new SkillImportApiError('PERMISSION_DENIED') }, commandItems: [scanCommand()] })
  const request = h.api.request.bind(h.api)
  let reportingSignal: AbortSignal | undefined
  let reset = false
  h.files.reset = async () => { reset = true }
  h.api.request = async (method, route, schema, options) => {
    if (route.endsWith('/events') && options.body?.type === 'error') {
      reportingSignal = options.signal!
      return new Promise((_resolve, reject) => reportingSignal!.addEventListener('abort', () => reject(reportingSignal!.reason), { once: true }))
    }
    return request(method, route, schema, options)
  }
  try {
    await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
    await until(() => h.service['state'].phase === 'awaiting-local-consent')
    await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['root_1'] })
    await until(() => Boolean(reportingSignal))
    await h.service.cancelActive()
    assert.equal(reportingSignal!.aborted, true)
    assert.equal(h.service['state'].phase, 'cancelled')
    assert.equal(reset, true)
    assert.equal(h.calls.some(call => call.route.endsWith('/events') && call.options.body?.type === 'command-completed'), false)
  } finally { await h.service.dispose() }
})

test('partial scans return existing-protocol warnings on candidates and fail explicitly when none were readable', async () => {
  const fullWarnings = [...Array.from({ length: 31 }, (_, index) => ({ code: `WARNING_${index}`, message: 'Existing warning', severity: 'warning' as const })),
    { code: 'BLOCKED', message: 'Existing blocking warning', severity: 'blocking' as const }]
  for (const { empty, warnings } of [{ empty: false, warnings: [] }, { empty: true, warnings: [] }, { empty: false, warnings: fullWarnings }]) {
    const candidate = { candidateId: 'candidate_1', revision: 1, name: 'Demo', description: null, sources: ['codex'], scope: 'user' as const,
      locations: [{ rootId: 'root_1', rootLabel: 'Personal', relativePath: 'demo' }], treeHash: null, availability: 'previewable' as const, warnings }
    const h = harness({ scan: async () => empty ? [] : [candidate], commandItems: [scanCommand()] })
    h.service['options'].files.getScanWarnings = () => [{ code: 'ROOT_UNAVAILABLE', rootId: 'root_1' }]
    try {
      await h.service.open({ instanceId: 'sep-default', sessionId: 'session_1' })
      await until(() => h.service['state'].phase === 'awaiting-local-consent')
      await h.service.confirmConsent({ pairingId: 'pairing_1', rememberDevice: false, scope: 'user', rootIds: ['root_1'] })
      await until(() => ['results', 'failed'].includes(h.service['state'].phase))
      const events = h.calls.filter(call => call.route.endsWith('/events')).map(call => call.options.body)
      if (empty) {
        assert.equal(h.service['state'].phase, 'failed')
        assert.equal(events.some(event => event?.type === 'candidates'), false)
        const error = events.find(event => event?.type === 'error')
        assert.equal((error?.payload as { code: string }).code, 'SCAN_FAILED')
      } else {
        assert.equal(h.service['state'].phase, 'results')
        const batch = events.find(event => event?.type === 'candidates')
        const received = (batch?.payload as { items: Array<{ warnings: Array<{ code: string; message: string; severity: string }> }> }).items[0].warnings
        assert.ok(received.some(warning => warning.code === 'SCAN_PARTIAL' && warning.message === h.service['state'].error?.message))
        assert.ok(received.length <= 32)
        if (warnings.length) assert.ok(received.some(warning => warning.code === 'BLOCKED' && warning.severity === 'blocking'), 'Partial-scan warnings must never discard existing blocking warnings')
        assert.ok(events.some(event => event?.type === 'command-completed'))
      }
    } finally { await h.service.dispose() }
  }
})
