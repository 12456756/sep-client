import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-file'
import { WriteChain } from './write-chain'

const envelopeSchema = z.object({ version: z.literal(1), payload: z.string().min(1) }).strict()
const rootSchema = z.object({
  rootId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  label: z.string().min(1).max(160),
  path: z.string().min(1).max(4096),
  scope: z.enum(['user', 'project']),
  sources: z.array(z.string().min(1).max(96)).max(16),
}).strict()
const bindingSchema = z.object({
  bindingId: z.string().uuid(), instanceId: z.string().min(1).max(160), ownerUserId: z.string().min(1).max(160),
  osUserId: z.string().min(1).max(512), deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  keyFingerprint: z.string().regex(/^[0-9a-f]{64}$/), label: z.string().min(1).max(160),
  platform: z.string().min(1).max(32), clientVersion: z.string().min(1).max(64),
  scope: z.enum(['user', 'project', 'all']), rootIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)).max(128),
  roots: z.array(rootSchema).max(128), encryptedPrivateKey: z.string().min(1),
  enabled: z.boolean(), revokePending: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
}).strict()
const MAX_BINDINGS = 32
const recordsSchema = z.object({ bindings: z.array(bindingSchema).max(MAX_BINDINGS) }).strict()

export interface SkillImportEncryption {
  isEncryptionAvailable(): boolean
  encryptString(value: string): string
  decryptString(value: string): string
  getSelectedStorageBackend?: () => string
}

export interface SkillImportRootRecord {
  rootId: string; label: string; path: string; scope: 'user' | 'project'; sources: string[]
}

export interface SkillImportDeviceIdentity {
  publicKey: string
  keyFingerprint: string
  privateKeyPkcs8: string
}

export interface SkillImportBindingInput {
  instanceId: string; ownerUserId?: string; deviceId: string; keyFingerprint?: string
  label: string; platform: string; clientVersion: string; scope: 'user' | 'project' | 'all'
  rootIds: string[]; roots: SkillImportRootRecord[]; privateKeyPkcs8: string
  rememberDevice?: boolean
}

export interface SkillImportBindingView {
  bindingId: string; instanceId: string; ownerUserId: string; deviceId: string; keyFingerprint: string
  label: string; platform: string; clientVersion: string; scope: 'user' | 'project' | 'all'
  rootIds: string[]; roots: Array<Omit<SkillImportRootRecord, 'path'>>; enabled: boolean; revokePending: boolean
  createdAt: string; updatedAt: string
}

export interface SkillImportStoredBinding extends SkillImportBindingView {
  roots: SkillImportRootRecord[]
  privateKeyPkcs8: string
}

export interface SkillImportDeviceStoreOptions {
  userDataDir?: string
  file?: string
  osUserId: string
  encryption: SkillImportEncryption
}

function base64url(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function normalizeIds(ids: string[]): string[] { return [...new Set(ids)].sort() }

function identityView(record: z.infer<typeof bindingSchema>): SkillImportBindingView {
  return {
    bindingId: record.bindingId, instanceId: record.instanceId, ownerUserId: record.ownerUserId,
    deviceId: record.deviceId, keyFingerprint: record.keyFingerprint, label: record.label,
    platform: record.platform, clientVersion: record.clientVersion, scope: record.scope,
    rootIds: [...record.rootIds], roots: record.roots.map(({ path: _path, ...root }) => root),
    enabled: record.enabled, revokePending: record.revokePending, createdAt: record.createdAt, updatedAt: record.updatedAt,
  }
}

export class SkillImportDeviceStore {
  private readonly file: string
  private readonly writes = new WriteChain()
  private readonly options: SkillImportDeviceStoreOptions
  private readonly memory = new Map<string, z.infer<typeof bindingSchema>>()

  constructor(options: SkillImportDeviceStoreOptions) {
    this.options = options
    this.file = options.file ?? join(options.userDataDir ?? '.', 'skill-import', 'devices.json')
  }

  canPersist(): boolean {
    const backend = this.options.encryption.getSelectedStorageBackend?.()
    return this.options.encryption.isEncryptionAvailable() && backend !== 'basic_text'
  }

  createIdentity(): SkillImportDeviceIdentity {
    const pair = generateKeyPairSync('ed25519')
    const publicKeyDer = pair.publicKey.export({ type: 'spki', format: 'der' })
    const privateKeyDer = pair.privateKey.export({ type: 'pkcs8', format: 'der' })
    return {
      publicKey: base64url(publicKeyDer),
      keyFingerprint: createHash('sha256').update(publicKeyDer).digest('hex'),
      privateKeyPkcs8: base64url(privateKeyDer),
    }
  }

  async listBindings(): Promise<SkillImportBindingView[]> {
    return [...(await this.allBindings())].filter(binding => binding.osUserId === this.options.osUserId).map(identityView)
  }

  async findBinding(input: { instanceId: string; ownerUserId: string; deviceId?: string; scope?: string; rootIds?: string[] }): Promise<SkillImportStoredBinding | null> {
    const record = (await this.allBindings()).find(binding => binding.osUserId === this.options.osUserId
      && binding.instanceId === input.instanceId && binding.ownerUserId === input.ownerUserId
      && (!input.deviceId || binding.deviceId === input.deviceId) && binding.enabled && !binding.revokePending
      && (!input.scope || binding.scope === input.scope)
      && (!input.rootIds || JSON.stringify(binding.rootIds) === JSON.stringify(normalizeIds(input.rootIds))))
    if (!record) return null
    const privateKeyPkcs8 = this.memory.has(record.bindingId)
      ? this.memory.get(record.bindingId)!.encryptedPrivateKey
      : this.options.encryption.decryptString(record.encryptedPrivateKey)
    return { ...identityView(record), roots: record.roots, privateKeyPkcs8 }
  }

  async getBinding(deviceId: string, instanceId?: string): Promise<SkillImportStoredBinding | null> {
    const record = (await this.allBindings()).find(binding => binding.osUserId === this.options.osUserId
      && binding.deviceId === deviceId && (!instanceId || binding.instanceId === instanceId))
    if (!record) return null
    const privateKeyPkcs8 = this.memory.has(record.bindingId)
      ? this.memory.get(record.bindingId)!.encryptedPrivateKey
      : this.options.encryption.decryptString(record.encryptedPrivateKey)
    return { ...identityView(record), roots: record.roots, privateKeyPkcs8 }
  }

  async listActiveBindings(instanceId: string): Promise<SkillImportStoredBinding[]> {
    const bindings = (await this.allBindings()).filter(binding => binding.osUserId === this.options.osUserId
      && binding.instanceId === instanceId && binding.enabled && !binding.revokePending)
    return bindings.map(record => ({
      ...identityView(record), roots: record.roots,
      privateKeyPkcs8: this.memory.has(record.bindingId)
        ? this.memory.get(record.bindingId)!.encryptedPrivateKey
        : this.options.encryption.decryptString(record.encryptedPrivateKey),
    }))
  }

  async saveBinding(input: SkillImportBindingInput): Promise<{ persisted: boolean; binding: SkillImportBindingView }> {
    const now = new Date().toISOString()
    const rootIds = normalizeIds(input.rootIds)
    const identity = input.keyFingerprint ?? this.keyFingerprintForPrivateKey(input.privateKeyPkcs8)
    const bindingId = randomUUID()
    const persist = input.rememberDevice === true && this.canPersist()
    const record = bindingSchema.parse({
      bindingId, instanceId: input.instanceId, ownerUserId: input.ownerUserId ?? input.deviceId, osUserId: this.options.osUserId,
      deviceId: input.deviceId, keyFingerprint: identity, label: input.label, platform: input.platform,
      clientVersion: input.clientVersion, scope: input.scope, rootIds, roots: input.roots, enabled: true,
      revokePending: false, encryptedPrivateKey: persist ? this.options.encryption.encryptString(input.privateKeyPkcs8) : input.privateKeyPkcs8, createdAt: now, updatedAt: now,
    })
    if (!persist) {
      this.memory.set(record.bindingId, record)
      return { persisted: false, binding: identityView(record) }
    }
    await this.writes.run(this.file, async () => {
      const current = await this.read()
      const withoutSame = current.bindings.filter(item => !(item.osUserId === this.options.osUserId && item.instanceId === record.instanceId && item.ownerUserId === record.ownerUserId && item.deviceId === record.deviceId))
      if (withoutSame.length >= MAX_BINDINGS) throw Object.assign(new Error('DEVICE_LIMIT_REACHED'), { code: 'DEVICE_LIMIT_REACHED' })
      await this.write({ bindings: [...withoutSame, record] })
    })
    for (const [id, item] of this.memory) {
      if (item.osUserId === record.osUserId && item.instanceId === record.instanceId && item.deviceId === record.deviceId) this.memory.delete(id)
    }
    return { persisted: true, binding: identityView(record) }
  }

  async disableBinding(deviceId: string, instanceId?: string): Promise<void> { await this.update(deviceId, { enabled: false }, instanceId) }
  async markRevokePending(deviceId: string, instanceId?: string): Promise<void> { await this.update(deviceId, { enabled: false, revokePending: true }, instanceId) }
  async confirmRevoke(deviceId: string, instanceId?: string): Promise<void> {
    await this.writes.run(this.file, async () => {
      const current = await this.read()
      await this.write({ bindings: current.bindings.filter(item => !(item.osUserId === this.options.osUserId && item.deviceId === deviceId && (!instanceId || item.instanceId === instanceId))) })
    })
    for (const [id, item] of this.memory) if (item.osUserId === this.options.osUserId && item.deviceId === deviceId && (!instanceId || item.instanceId === instanceId)) this.memory.delete(id)
  }

  private async update(deviceId: string, patch: { enabled?: boolean; revokePending?: boolean }, instanceId?: string): Promise<void> {
    await this.writes.run(this.file, async () => {
      const current = await this.read(); const now = new Date().toISOString()
      await this.write({ bindings: current.bindings.map(item => item.osUserId === this.options.osUserId && item.deviceId === deviceId && (!instanceId || item.instanceId === instanceId) ? { ...item, ...patch, updatedAt: now } : item) })
    })
    for (const [id, item] of this.memory) if (item.osUserId === this.options.osUserId && item.deviceId === deviceId && (!instanceId || item.instanceId === instanceId)) this.memory.set(id, { ...item, ...patch, updatedAt: new Date().toISOString() })
  }

  private keyFingerprintForPrivateKey(privateKeyPkcs8: string): string {
    const der = Buffer.from(privateKeyPkcs8.replaceAll('-', '+').replaceAll('_', '/') + '==', 'base64')
    const privateKey = createPrivateKey({ key: der, type: 'pkcs8', format: 'der' })
    const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(publicKeyDer).digest('hex')
  }

  private async allBindings(): Promise<Array<z.infer<typeof bindingSchema>>> {
    const persistent = (await this.read()).bindings
    const byId = new Map(persistent.map(item => [item.bindingId, item]))
    for (const [id, item] of this.memory) byId.set(id, item)
    return [...byId.values()]
  }

  private async read(): Promise<z.infer<typeof recordsSchema>> {
    if (!this.canPersist()) return { bindings: [] }
    return (await readJsonWithBackup(this.file, value => {
      const envelope = envelopeSchema.safeParse(value); if (!envelope.success) return null
      try { return recordsSchema.parse(JSON.parse(this.options.encryption.decryptString(envelope.data.payload))) } catch { return null }
    })) ?? { bindings: [] }
  }

  private write(value: z.infer<typeof recordsSchema>): Promise<void> {
    if (!this.canPersist()) return Promise.resolve()
    const payload = this.options.encryption.encryptString(JSON.stringify(recordsSchema.parse(value)))
    return writeJsonAtomic(this.file, { version: 1, payload })
  }
}
