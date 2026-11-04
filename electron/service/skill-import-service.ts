import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  SkillImportArtifactSchema, SkillImportCommandsResponseSchema, SkillImportConsentInputSchema,
  SkillImportEventAckSchema, SkillImportEventSchema, SkillImportGrantResponseSchema,
  SkillImportChallengeViewSchema, SkillImportOperationSchema, SkillImportPairingResponseSchema,
  SkillImportStateViewSchema, SkillImportUploadGrantResponseSchema,
  SKILL_IMPORT_LIMITS,
  type SkillImportStateView, type SkillImportCommandSchema,
} from '../../src/shared/skill-import-contracts'
import { SkillImportApiError } from '../common/platform/skill-import-api'
import { logger } from '../common/logger'
import { acceptedScopeHash, normalizedRootIds } from '../domain/skill-import'
import type { ImportApiPort, ImportChallenge, ImportDevicesPort, ImportFilesPort, ImportIdentity, ImportInstance, ImportScope } from '../domain/skill-import-ports'

const okSchema = z.object({ ok: z.literal(true) }).strict()
const TERMINAL_CODES = new Set(['SESSION_EXPIRED', 'SESSION_CANCELLED', 'SESSION_CLOSED', 'DEVICE_REVOKED', 'OWNER_AUTH_REQUIRED', 'OWNER_AUTH_REVOKED', 'OWNER_MISMATCH'])
const MESSAGES: Record<string, string> = {
  IMPORT_DISABLED: '此站点暂未开放本机导入。', CLIENT_UPGRADE_REQUIRED: '请升级 SEP 客户端后重新打开导入。',
  CLIENT_BUSY: '另一项本机导入正在进行，请返回网页稍后重试。', SCOPE_MISMATCH: '扫描范围与已批准的授权不一致，请重新发起导入。',
  CANDIDATE_CHANGED: '技能文件已变化，请在网页重新预览。', SNAPSHOT_EXPIRED: '预览快照已过期，请重新预览。',
  SESSION_EXPIRED: '导入会话已过期，请从网页重新发起。', SESSION_CLOSED: '网页已结束本次导入。',
  SESSION_CANCELLED: '本次导入已取消。', DEVICE_REVOKED: '设备授权已撤销，请重新确认。',
  PACKAGE_REJECTED: '技能包未通过检查，请返回网页查看并重新选择。',
  NETWORK_UNAVAILABLE: '暂时无法连接站点，正在重试。', PREVIEW_TIMEOUT: '预览超时，请在网页重试。',
  REVOCATION_PENDING: '本机授权已停用，云端撤销尚未确认；联网后重试或在网页设备管理中撤销。',
  SCAN_PARTIAL: '部分目录无法完整读取或已达到扫描上限，当前结果可能不完整。请检查目录权限后从网页重新发起。',
  SCAN_FAILED: '本机扫描未能完成，请检查目录权限后从网页重新发起。',
  DEVICE_LIMIT_REACHED: '已达到设备授权保存上限，请先撤销不再使用的设备授权后重试。',
}
type Consent = z.infer<typeof SkillImportConsentInputSchema>
type Command = z.infer<typeof SkillImportCommandSchema>
interface ActiveImport {
  instance: ImportInstance; sessionId: string; controller: AbortController; api: ImportApiPort
  identity: ImportIdentity; pairingId?: string; deviceId?: string; challenge?: ImportChallenge; consent?: Consent
  grant?: string; grantExpiresAt: number; deadline: number; idleDeadline: number
  startedAt: number
  commandCursor: number; eventSequence: number; completed: Set<string>; sequences: Map<number, string>
  job?: Promise<void>; deadlineTimer?: ReturnType<typeof setTimeout>
  renewal?: Promise<void>
}
interface SkillImportOptions {
  files: ImportFilesPort; devices: ImportDevicesPort; instances: readonly ImportInstance[]
  api(instance: ImportInstance): ImportApiPort
  clientVersion: string; platform: string
  publish(state: SkillImportStateView): void
  now?: () => number
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

export class SkillImportService {
  private readonly log = logger.child('skill-import')
  private active: ActiveImport | null = null
  private disposed = false
  private cleanup: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
  private state: SkillImportStateView

  constructor(private readonly options: SkillImportOptions) {
    this.now = options.now ?? Date.now
    this.wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }))
    this.state = {
      revision: 0, visible: false, phase: 'idle', clientVersion: options.clientVersion, protocolVersion: 1,
      sessionId: null, instanceId: null, siteLabel: null, initiatorLabel: null, scope: null, roots: [], pairing: null,
      devices: [], progress: null, error: null, persistenceAvailable: options.devices.available(), busySessionId: null,
    }
  }

  async getState(): Promise<SkillImportStateView> { await this.refreshLocal(); return structuredClone(this.state) }
  isActive(): boolean { return this.active !== null }
  setVisible(visible: boolean): void { this.publish({ visible }) }

  async open(link: { instanceId: string; sessionId: string }): Promise<void> {
    if (this.disposed) return
    if (this.active) {
      const sameSession = this.active.sessionId === link.sessionId && this.active.instance.instanceId === link.instanceId
      this.publish({ busySessionId: sameSession ? null : link.sessionId,
        ...(sameSession && this.state.phase === 'awaiting-local-consent' ? { visible: true } : {}) })
      return
    }
    const instance = this.options.instances.find(item => item.instanceId === link.instanceId)
    if (!instance) { this.publish({ visible: true, phase: 'error', error: this.errorView('UNTRUSTED_INSTANCE') }); return }
    const current: ActiveImport = {
      instance, sessionId: link.sessionId, controller: new AbortController(), api: this.options.api(instance),
      identity: this.options.devices.createIdentity(), startedAt: this.now(), grantExpiresAt: 0, deadline: this.now() + SKILL_IMPORT_LIMITS.pairingMs,
      idleDeadline: this.now() + SKILL_IMPORT_LIMITS.pairingMs, commandCursor: 0, eventSequence: 0, completed: new Set(), sequences: new Map(),
    }
    this.active = current
    this.publish({ visible: false, phase: 'connecting', sessionId: link.sessionId, instanceId: instance.instanceId,
      siteLabel: instance.label, initiatorLabel: null, scope: null, pairing: null, progress: null, error: null, busySessionId: null })
    this.armDeadline(current)
    this.launch(current, async () => {
      await this.cleanup
      this.assertCurrent(current)
      await this.refreshLocal()
      const pairing = await this.request(current, 'POST', 'pairings', SkillImportPairingResponseSchema, {
        requestId: randomUUID(), sessionId: current.sessionId, publicKey: current.identity.publicKey,
        keyFingerprint: current.identity.keyFingerprint, protocolVersion: 1, clientVersion: this.options.clientVersion, platform: this.options.platform,
      })
      current.pairingId = pairing.pairingId
      this.validateChallenge(current, pairing.challenge, current.identity)
      current.challenge = pairing.challenge
      current.deadline = Math.min(current.deadline, Date.parse(pairing.expiresAt))
      this.armDeadline(current)
      this.publish({ initiatorLabel: pairing.ownerLabel, scope: pairing.scope,
        pairing: { pairingId: pairing.pairingId, shortCode: pairing.shortCode, keyFingerprint: pairing.challenge.keyFingerprint, expiresAt: pairing.expiresAt, webConfirmed: false } })
      // The server proves ownership of a remembered device. Display names are never account identifiers.
      const bindings = (await this.options.devices.list()).filter(binding => binding.instanceId === instance.instanceId && !binding.revocationPending && binding.scope === pairing.scope)
      const availableRoots = this.state.roots.filter(root => pairing.scope === 'all' || root.scope === pairing.scope).map(root => root.rootId)
      for (const remembered of bindings) {
        const roots = normalizedRootIds(remembered.rootIds)
        if (!roots.length || roots.some(root => !availableRoots.includes(root))) continue
        let challenge: ImportChallenge
        try {
          challenge = await current.api.request('POST', 'challenges', SkillImportChallengeViewSchema, { signal: current.controller.signal,
            body: { purpose: 'session-grant', sessionId: current.sessionId, deviceId: remembered.deviceId } })
        } catch (error) {
          if (error instanceof SkillImportApiError && ['DEVICE_REVOKED', 'OWNER_MISMATCH'].includes(error.code)) continue
          throw error
        }
        this.assertCurrent(current)
        const identity = await this.options.devices.identity(remembered.deviceId, instance.instanceId)
        if (challenge.deviceId !== remembered.deviceId || challenge.pairingId !== null) throw new SkillImportApiError('DEVICE_PROOF_INVALID')
        current.deviceId = remembered.deviceId
        this.validateChallenge(current, challenge, identity)
        current.identity = identity; current.challenge = challenge
        current.consent = { pairingId: pairing.pairingId, rememberDevice: true, scope: pairing.scope, rootIds: roots }
        await this.grantAndPoll(current)
        return
      }
      this.assertCurrent(current)
      this.publish({ visible: true, phase: 'awaiting-local-consent' })
    })
  }

  async confirmConsent(raw: Consent): Promise<void> {
    const input = SkillImportConsentInputSchema.parse(raw)
    const current = this.active
    if (!current || this.state.phase !== 'awaiting-local-consent' || current.consent || current.job || input.pairingId !== current.pairingId || input.scope !== this.state.scope) throw new SkillImportApiError('SCOPE_MISMATCH')
    const ids = normalizedRootIds(input.rootIds)
    if (ids.length !== input.rootIds.length || !ids.length || ids.some(id => !this.state.roots.some(root => root.rootId === id && (input.scope === 'all' || root.scope === input.scope)))) throw new SkillImportApiError('SCOPE_MISMATCH')
    if (input.rememberDevice && !this.options.devices.available()) throw new SkillImportApiError('STORAGE_UNAVAILABLE')
    current.consent = { ...input, rootIds: ids }
    this.publish({ visible: false, roots: this.state.roots.map(root => ({ ...root, authorized: ids.includes(root.rootId) })) })
    this.launch(current, () => this.grantAndPoll(current))
  }

  async addProjectRoot(path: string): Promise<void> {
    if (this.active?.consent) throw new SkillImportApiError('SCOPE_MISMATCH')
    await this.options.files.addProjectRoot(path)
    await this.refreshLocal()
  }
  async removeRoot(rootId: string): Promise<void> {
    if (!this.state.roots.some(root => root.rootId === rootId)) throw new SkillImportApiError('INVALID_ARGUMENT')
    if (this.active) await this.cancel(this.active.sessionId)
    for (const binding of await this.options.devices.list()) {
      if (binding.rootIds.includes(rootId)) await this.revokeDevice(binding.deviceId, binding.instanceId)
    }
    await this.options.files.removeRoot(rootId)
    await this.refreshLocal()
  }

  async cancel(sessionId: string): Promise<void> {
    const current = this.active
    if (!current || current.sessionId !== sessionId) return
    this.active = null
    current.controller.abort()
    clearTimeout(current.deadlineTimer)
    this.publish({ visible: false, phase: 'cancelled', pairing: null, progress: null, busySessionId: null })
    const notify = current.grant ? current.api.request('DELETE', `sessions/${current.sessionId}`, okSchema,
      { token: current.grant, signal: AbortSignal.timeout(3000) }).catch(() => undefined) : Promise.resolve()
    this.cleanup = Promise.resolve(current.job).catch(() => undefined).then(() => this.options.files.reset())
    await notify
  }

  async revokeDevice(deviceId: string, instanceId: string): Promise<void> {
    const binding = (await this.options.devices.list()).find(item => item.deviceId === deviceId && item.instanceId === instanceId)
    if (!binding) throw new SkillImportApiError('INVALID_ARGUMENT')
    if (this.active?.instance.instanceId === binding.instanceId) await this.cancel(this.active.sessionId)
    await this.options.devices.disable(deviceId, instanceId)
    await this.refreshLocal()
    const instance = this.options.instances.find(item => item.instanceId === binding.instanceId)
    if (!instance) { this.publish({ error: this.errorView('REVOCATION_PENDING') }); return }
    try {
      const api = this.options.api(instance)
      const identity = await this.options.devices.identity(deviceId, instanceId)
      const signal = AbortSignal.timeout(10_000)
      const challenge = await api.request('POST', 'challenges', SkillImportChallengeViewSchema, { signal, body: { purpose: 'device-revoke', deviceId } })
      if (challenge.purpose !== 'device-revoke' || challenge.instanceId !== instance.instanceId || challenge.deviceId !== deviceId || challenge.sessionId || challenge.pairingId || challenge.keyFingerprint !== identity.keyFingerprint || Date.parse(challenge.expiresAt) <= this.now()) throw new SkillImportApiError('DEVICE_PROOF_INVALID')
      await api.request('POST', `devices/${deviceId}/revoke`, okSchema, { signal, body: { challengeId: challenge.challengeId, signature: identity.sign(challenge, false, 'revoke', []) } })
      await this.options.devices.forget(deviceId, instanceId)
      this.publish({ error: null })
    } catch (error) {
      if (error instanceof SkillImportApiError && error.code === 'DEVICE_REVOKED') await this.options.devices.forget(deviceId, instanceId)
      else this.publish({ error: this.errorView('REVOCATION_PENDING') })
    }
    await this.refreshLocal()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.active) await this.cancel(this.active.sessionId)
    await this.cleanup
    await this.options.files.dispose()
  }

  async cancelActive(): Promise<void> {
    if (this.active) await this.cancel(this.active.sessionId)
    await this.cleanup
  }

  private async grantAndPoll(current: ActiveImport): Promise<void> {
    await this.acquireGrant(current)
    while (this.active === current) {
      this.assertCurrent(current)
      if (this.now() + SKILL_IMPORT_LIMITS.grantRenewBeforeMs >= current.grantExpiresAt) await this.renewGrant(current)
      const batch = await this.request(current, 'GET', `sessions/${current.sessionId}/commands?cursor=${current.commandCursor}`, SkillImportCommandsResponseSchema)
      for (const command of batch.items) {
        this.assertCurrent(current)
        if (command.sessionId !== current.sessionId || Date.parse(command.expiresAt) <= this.now() || command.sequence > batch.nextCursor) throw new SkillImportApiError('COMMAND_INVALID')
        if (current.completed.has(command.commandId)) continue
        if (current.sequences.has(command.sequence) && current.sequences.get(command.sequence) !== command.commandId || command.sequence <= current.commandCursor) throw new SkillImportApiError('COMMAND_INVALID')
        current.sequences.set(command.sequence, command.commandId)
        await this.withRemoteCancellation(current, () => this.execute(current, command))
        if (this.active !== current) return
        current.completed.add(command.commandId)
        current.commandCursor = command.sequence
      }
      await this.wait(SKILL_IMPORT_LIMITS.pollMs, current.controller.signal)
    }
  }

  private async acquireGrant(current: ActiveImport, renew = false): Promise<void> {
    const consent = current.consent!
    if (renew) {
      current.challenge = await this.request(current, 'POST', 'challenges', SkillImportChallengeViewSchema, {
        purpose: 'session-grant', sessionId: current.sessionId, ...(current.deviceId ? { deviceId: current.deviceId } : { pairingId: current.pairingId }),
      }, false)
    }
    this.validateChallenge(current, current.challenge!, current.identity)
    let proof = { challengeId: current.challenge!.challengeId,
      signature: current.identity.sign(current.challenge!, consent.rememberDevice, consent.scope, consent.rootIds),
      rememberDevice: consent.rememberDevice, scope: consent.scope, rootIds: consent.rootIds }
    let replacedChallenge = false
    for (;;) {
      let grant: z.infer<typeof SkillImportGrantResponseSchema>
      try { grant = await this.request(current, 'POST', 'grants', SkillImportGrantResponseSchema, proof, false) }
      catch (error) {
        if (!(error instanceof SkillImportApiError) || error.code !== 'CHALLENGE_USED' || replacedChallenge) throw error
        replacedChallenge = true
        current.challenge = await this.request(current, 'POST', 'challenges', SkillImportChallengeViewSchema, {
          purpose: 'session-grant', sessionId: current.sessionId, ...(current.deviceId ? { deviceId: current.deviceId } : { pairingId: current.pairingId }),
        }, false)
        this.validateChallenge(current, current.challenge, current.identity, consent.rememberDevice)
        proof = { ...proof, challengeId: current.challenge.challengeId,
          signature: current.identity.sign(current.challenge, consent.rememberDevice, consent.scope, consent.rootIds) }
        continue
      }
      if (grant.status === 'pending-web-confirmation') {
        if (grant.pairingId !== current.pairingId) throw new SkillImportApiError('DEVICE_PROOF_INVALID')
        if (Date.parse(grant.expiresAt) <= this.now()) throw new SkillImportApiError('SESSION_EXPIRED')
        this.publish({ phase: 'waiting-web-confirmation' })
        await this.wait(Math.max(SKILL_IMPORT_LIMITS.pollMs, grant.retryAfterSeconds * 1000), current.controller.signal)
        continue
      }
      if (grant.sessionId !== current.sessionId || grant.acceptedScopeHash !== acceptedScopeHash(consent.scope, consent.rootIds) || Date.parse(grant.sessionGrantExpiresAt) <= this.now()) throw new SkillImportApiError('SCOPE_MISMATCH')
      if (current.challenge!.pairingId && current.challenge!.deviceId && grant.deviceId !== current.challenge!.deviceId) throw new SkillImportApiError('DEVICE_PROOF_INVALID')
      current.grant = grant.sessionGrant
      current.deadline = Math.min(Date.parse(grant.sessionExpiresAt), current.startedAt + SKILL_IMPORT_LIMITS.sessionMs)
      current.grantExpiresAt = Math.min(Date.parse(grant.sessionGrantExpiresAt), current.deadline)
      current.idleDeadline = Math.min(Date.parse(grant.idleExpiresAt), this.now() + SKILL_IMPORT_LIMITS.idleMs, current.deadline)
      current.deviceId = grant.deviceId ?? current.deviceId
      this.armDeadline(current)
      if (grant.deviceId && consent.rememberDevice) {
        await this.options.devices.remember(current.identity, { deviceId: grant.deviceId, instanceId: current.instance.instanceId,
          label: this.state.initiatorLabel ?? 'SEP', keyFingerprint: current.identity.keyFingerprint, platform: this.options.platform,
          scope: consent.scope, rootIds: consent.rootIds })
      }
      this.assertCurrent(current)
      await this.refreshLocal()
      this.assertCurrent(current)
      this.publish({ phase: renew ? this.state.phase : 'ready', pairing: null, error: null,
        roots: this.state.roots.map(root => ({ ...root, authorized: consent.rootIds.includes(root.rootId) })) })
      return
    }
  }

  private renewGrant(current: ActiveImport): Promise<void> {
    current.renewal ??= this.acquireGrant(current, true).finally(() => { current.renewal = undefined })
    return current.renewal
  }

  private async withRemoteCancellation(current: ActiveImport, work: () => Promise<void>): Promise<void> {
    const stop = new AbortController()
    const signal = AbortSignal.any([current.controller.signal, stop.signal])
    const monitor = (async () => {
      let backoff: number = SKILL_IMPORT_LIMITS.pollMs
      while (!signal.aborted && this.active === current) {
        await this.wait(backoff, signal)
        try {
          if (this.now() + SKILL_IMPORT_LIMITS.grantRenewBeforeMs >= current.grantExpiresAt) await this.renewGrant(current)
          const batch = await current.api.request('GET', `sessions/${current.sessionId}/commands?cursor=${current.commandCursor}`,
            SkillImportCommandsResponseSchema, { signal, token: current.grant })
          if (batch.items.some(command => command.type === 'cancel' && command.sessionId === current.sessionId)) throw new SkillImportApiError('SESSION_CANCELLED')
          backoff = SKILL_IMPORT_LIMITS.pollMs
        } catch (error) {
          if (signal.aborted) return
          if (error instanceof SkillImportApiError && error.retryable && !TERMINAL_CODES.has(error.code)) {
            backoff = Math.max(error.retryAfterMs, Math.min(backoff * 2, SKILL_IMPORT_LIMITS.maxBackoffMs))
            continue
          }
          throw error
        }
      }
    })().catch(error => {
      if (!signal.aborted && this.active === current) current.controller.abort(error)
    })
    try { await work(); this.assertCurrent(current) }
    finally { stop.abort(); await monitor }
  }

  private async execute(current: ActiveImport, command: Command): Promise<void> {
    if (command.type === 'cancel') { await this.stopFromWorker(current, 'cancelled'); return }
    await this.event(current, command, 'command-started', { type: command.type })
    try {
      switch (command.type) {
        case 'scan': {
          const scope = command.payload as { scope: ImportScope; rootIds: string[] }
          if (scope.scope !== current.consent!.scope || JSON.stringify(normalizedRootIds(scope.rootIds)) !== JSON.stringify(normalizedRootIds(current.consent!.rootIds))) throw new SkillImportApiError('SCOPE_MISMATCH')
          this.publish({ phase: 'scanning', progress: { phase: 'scanning', completed: 0 } })
          const scanned = await this.options.files.scan(current.consent!.rootIds, { signal: current.controller.signal })
          const partial = Boolean(this.options.files.getScanWarnings?.().length)
          // Existing Web clients already render candidate warnings. Keep useful results while
          // making an incomplete scan explicit, including when no candidate could be read.
          if (partial && !scanned.length) throw new SkillImportApiError('SCAN_PARTIAL')
          const candidates = partial ? scanned.map(candidate => ({ ...candidate,
            warnings: [...candidate.warnings.filter(warning => warning.severity === 'blocking'),
              { code: 'SCAN_PARTIAL', message: MESSAGES['SCAN_PARTIAL']!, severity: 'warning' as const },
              ...candidate.warnings.filter(warning => warning.severity === 'warning')].slice(0, 32),
          })) : scanned
          for (let offset = 0; offset < Math.max(candidates.length, 1); offset += 25) {
            await this.event(current, command, 'candidates', { items: candidates.slice(offset, offset + 25), final: offset + 25 >= candidates.length })
          }
          this.publish({ phase: 'results', progress: { phase: 'scanning', completed: candidates.length },
            error: partial ? this.errorView('SCAN_PARTIAL') : null })
          break
        }
        case 'preview': {
          this.publish({ phase: 'previewing', error: null })
          const signal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(SKILL_IMPORT_LIMITS.previewMs)])
          const preview = await this.options.files.preview({ ...(command.payload as { requestId: string; candidateId: string; revision: number }),
            expiresAt: new Date(Math.min(current.deadline, current.idleDeadline, this.now() + SKILL_IMPORT_LIMITS.pairingMs)).toISOString() }, signal)
          const files = preview.files
          const firstCursor = files.length > 100 ? randomUUID() : null
          await this.event(current, command, 'preview', { ...preview, files: files.slice(0, 100), nextFilesCursor: firstCursor })
          let cursor = firstCursor
          for (let offset = 100; offset < files.length; offset += 100) {
            const nextFilesCursor = offset + 100 < files.length ? randomUUID() : null
            await this.event(current, command, 'files', { requestId: preview.requestId, candidateId: preview.candidateId,
              snapshotId: preview.snapshotId, cursor, files: files.slice(offset, offset + 100), nextFilesCursor })
            cursor = nextFilesCursor
          }
          this.publish({ phase: 'results' })
          break
        }
        case 'package-selected': {
          this.publish({ phase: 'packaging', error: null })
          const selection = command.payload as { candidateId: string; snapshotId: string; operationId: string }
          const pkg = await this.options.files.packageSelected(selection, current.controller.signal)
          await this.event(current, command, 'command-completed', { type: command.type })
          this.publish({ phase: 'uploading' })
          await this.upload(current, selection, pkg)
          return
        }
      }
      await this.event(current, command, 'command-completed', { type: command.type })
    } catch (error) {
      this.assertCurrent(current)
      const code = this.code(error)
      const publicCode = ['CANDIDATE_CHANGED', 'SNAPSHOT_EXPIRED', 'PERMISSION_DENIED'].includes(code) ? code : command.type === 'scan' ? 'SCAN_FAILED' : 'PACKAGE_REJECTED'
      const payload = { code: publicCode, message: this.errorView(code).message, retryable: command.type === 'preview' }
      if (command.type !== 'preview') {
        try { await this.event(current, command, 'error', payload, true) }
        catch (notificationError) { this.log.warn('import failure notification unavailable', { code: this.code(notificationError) }) }
        throw error
      }
      await this.event(current, command, 'error', payload)
      this.publish({ phase: 'results', error: this.errorView(code) })
    }
  }

  private async upload(current: ActiveImport, selection: { candidateId: string; snapshotId: string; operationId: string }, pkg: { bytes: number; sha256: string; open(): AsyncIterable<Uint8Array> }): Promise<void> {
    let attempts = 0
    for (;;) {
      const operation = await this.request(current, 'GET', `sessions/${current.sessionId}/operations/${selection.operationId}`, SkillImportOperationSchema)
      if (operation.operationId !== selection.operationId || Date.parse(operation.expiresAt) <= this.now()) throw new SkillImportApiError('OPERATION_CONFLICT')
      if (operation.status === 'succeeded') {
        if (operation.sha256 !== pkg.sha256) throw new SkillImportApiError('PACKAGE_CHANGED')
        await this.stopFromWorker(current, 'uploaded')
        return
      }
      if (operation.status === 'processing') { await this.wait(2000, current.controller.signal); continue }
      if (operation.status === 'failed' && !operation.retryable || attempts >= 3) throw new SkillImportApiError(operation.errorCode ?? 'PACKAGE_REJECTED')
      const grant = await this.request(current, 'POST', `sessions/${current.sessionId}/operations/${selection.operationId}/upload-grant`, SkillImportUploadGrantResponseSchema,
        { candidateId: selection.candidateId, snapshotId: selection.snapshotId, packageSha256: pkg.sha256, packageBytes: pkg.bytes })
      if (Date.parse(grant.expiresAt) <= this.now()) throw new SkillImportApiError('GRANT_EXPIRED')
      attempts++
      try {
        const artifact = await current.api.upload(current.sessionId, selection.operationId, grant.uploadGrant, pkg, SkillImportArtifactSchema, current.controller.signal)
        this.assertCurrent(current)
        if (artifact.sha256 !== pkg.sha256) throw new SkillImportApiError('PACKAGE_CHANGED')
        await this.stopFromWorker(current, 'uploaded')
        return
      } catch (error) {
        this.assertCurrent(current)
        if (error instanceof SkillImportApiError && (TERMINAL_CODES.has(error.code) || !error.retryable && !['GRANT_EXPIRED', 'UPLOAD_PROCESSING', 'INVALID_RESPONSE'].includes(error.code))) throw error
        await this.wait(2000, current.controller.signal)
      }
    }
  }

  private async event(current: ActiveImport, command: Command, type: string, payload: unknown, terminal = false): Promise<void> {
    const event = SkillImportEventSchema.parse({ eventId: randomUUID(), commandId: command.commandId, sequence: current.eventSequence + 1, type, payload })
    this.assertCurrent(current)
    const route = `sessions/${current.sessionId}/events`
    // Failure reporting must not keep file access or shutdown alive during an outage.
    const ack = terminal ? await current.api.request('POST', route, SkillImportEventAckSchema, {
      body: event, token: current.grant, signal: AbortSignal.any([current.controller.signal, AbortSignal.timeout(3000)]),
    }) : await this.request(current, 'POST', route, SkillImportEventAckSchema, event, true, type === 'preview')
    this.assertCurrent(current)
    if (ack.eventId !== event.eventId || ack.cursor !== event.sequence) throw new SkillImportApiError('INVALID_RESPONSE')
    current.eventSequence = event.sequence
    if (!ack.ignored) {
      current.idleDeadline = Math.min(this.now() + SKILL_IMPORT_LIMITS.idleMs, current.deadline)
      this.armDeadline(current)
    }
  }

  private async request<T>(current: ActiveImport, method: 'GET' | 'POST' | 'DELETE', route: string, schema: z.ZodType<T>, body?: unknown, authenticated = true, contentResponse = false): Promise<T> {
    let backoff: number = SKILL_IMPORT_LIMITS.pollMs
    let recovered = false
    for (;;) {
      this.assertCurrent(current)
      try {
        const result = await current.api.request(method, route, schema, { signal: current.controller.signal, body, contentResponse, ...(authenticated && current.grant ? { token: current.grant } : {}) })
        this.assertCurrent(current)
        return result
      } catch (error) {
        this.assertCurrent(current)
        if (!(error instanceof SkillImportApiError)) throw error
        if (authenticated && error.code === 'GRANT_EXPIRED' && !recovered) {
          recovered = true
          await this.renewGrant(current)
          continue
        }
        if (TERMINAL_CODES.has(error.code) || !error.retryable) throw error
        this.publish({ error: this.errorView(error.code) })
        await this.wait(Math.max(error.retryAfterMs, Math.floor(backoff * (0.8 + Math.random() * 0.2))), current.controller.signal)
        backoff = Math.min(backoff * 2, SKILL_IMPORT_LIMITS.maxBackoffMs)
      }
    }
  }

  private launch(current: ActiveImport, job: () => Promise<void>): void {
    current.job = job().catch(async error => {
      if (this.active !== current) return
      const code = this.code(current.controller.signal.aborted ? current.controller.signal.reason : error)
      this.publish({ error: this.errorView(code), ...(['CLIENT_UPGRADE_REQUIRED', 'STORAGE_UNAVAILABLE', 'DEVICE_LIMIT_REACHED'].includes(code) ? { visible: true } : {}) })
      await this.stopFromWorker(current, code === 'SESSION_EXPIRED' ? 'expired' : TERMINAL_CODES.has(code) ? 'cancelled' : 'failed')
    }).finally(() => { current.job = undefined })
  }
  private async stopFromWorker(current: ActiveImport, phase: 'uploaded' | 'cancelled' | 'expired' | 'failed'): Promise<void> {
    if (this.active !== current) return
    this.active = null
    current.controller.abort()
    clearTimeout(current.deadlineTimer)
    this.publish({ phase, pairing: null, busySessionId: null })
    this.cleanup = this.options.files.reset()
    await this.cleanup
  }
  private armDeadline(current: ActiveImport): void {
    clearTimeout(current.deadlineTimer)
    current.deadlineTimer = setTimeout(() => {
      if (this.active !== current) return
      this.publish({ error: this.errorView('SESSION_EXPIRED') })
      void this.cancel(current.sessionId).then(() => { if (this.state.sessionId === current.sessionId) this.publish({ phase: 'expired' }) })
    }, Math.max(0, Math.min(current.deadline, current.idleDeadline) - this.now()))
    current.deadlineTimer.unref?.()
  }
  private assertCurrent(current: ActiveImport): void {
    current.controller.signal.throwIfAborted()
    if (this.active !== current) throw new SkillImportApiError('SESSION_CANCELLED')
    if (this.now() >= Math.min(current.deadline, current.idleDeadline)) throw new SkillImportApiError('SESSION_EXPIRED')
  }
  private validateChallenge(current: ActiveImport, challenge: ImportChallenge, identity: ImportIdentity, recoveringRememberedPairing = false): void {
    if (challenge.purpose !== 'session-grant' || challenge.instanceId !== current.instance.instanceId || challenge.sessionId !== current.sessionId || challenge.keyFingerprint !== identity.keyFingerprint || Date.parse(challenge.expiresAt) <= this.now()
      || (current.deviceId ? challenge.deviceId !== current.deviceId || challenge.pairingId !== null
        : challenge.pairingId !== current.pairingId || challenge.deviceId !== null && !recoveringRememberedPairing)) throw new SkillImportApiError('DEVICE_PROOF_INVALID')
  }
  private async refreshLocal(): Promise<void> {
    const roots = await this.options.files.listRoots()
    const bindings = await this.options.devices.list()
    this.publish({ roots: roots.map(root => ({ rootId: root.id, label: root.label, scope: root.scope,
      authorized: this.active?.consent?.rootIds.includes(root.id) ?? false })),
      devices: bindings.map(binding => ({ deviceId: binding.deviceId, instanceId: binding.instanceId, label: binding.label,
        keyFingerprint: binding.keyFingerprint, platform: binding.platform, lastSeenAt: null, revocationPending: binding.revocationPending })),
      persistenceAvailable: this.options.devices.available() })
  }
  private publish(update: Partial<SkillImportStateView>): void {
    if (update.phase && update.phase !== this.state.phase) this.log.info('import phase changed', { phase: update.phase, protocolVersion: 1 })
    this.state = SkillImportStateViewSchema.parse({ ...this.state, ...update, revision: this.state.revision + 1 })
    this.options.publish(structuredClone(this.state))
  }
  private code(error: unknown): string { return error instanceof SkillImportApiError ? error.code : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'IMPORT_UNAVAILABLE' }
  private errorView(code: string): NonNullable<SkillImportStateView['error']> { return { code, message: MESSAGES[code] ?? '本机导入暂不可用，请返回网页重试。', retryable: ['NETWORK_UNAVAILABLE', 'CANDIDATE_CHANGED', 'SNAPSHOT_EXPIRED', 'REVOCATION_PENDING'].includes(code) } }
}
