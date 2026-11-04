import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { SkillImportApi } from '../common/platform/skill-import-api'
import { resolveSkillImportInstances } from '../common/runtime-config'
import { SkillImportDeviceStore } from '../data/skill-import-device-store'
import { SkillImportFiles } from '../data/skill-import-files'
import { consentHash, signChallenge } from '../domain/skill-import'
import type { ImportIdentity } from '../domain/skill-import-ports'
import { SkillImportService } from '../service/skill-import-service'
import type { SkillImportStateView } from '../../src/shared/skill-import-contracts'

export async function createSkillImport(options: { userDataDir: string; clientVersion: string; publish(state: SkillImportStateView): void }): Promise<SkillImportService> {
  const store = new SkillImportDeviceStore({ userDataDir: options.userDataDir, osUserId: String(userInfo().uid) + ':' + userInfo().username,
    encryption: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: value => safeStorage.encryptString(value).toString('base64'),
      decryptString: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
      ...(process.platform === 'linux' ? { getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend() } : {}),
    } })
  const files = new SkillImportFiles({ homeDir: homedir(), tempDir: join(options.userDataDir, 'skill-import', 'temporary'),
    xdgConfigHome: process.env['XDG_CONFIG_HOME'] })
  await files.initialize()
  await files.listRoots()
  for (const binding of await store.listBindings()) {
    if (!binding.enabled || binding.revokePending) continue
    const saved = await store.getBinding(binding.deviceId, binding.instanceId).catch(() => null)
    for (const root of saved?.roots ?? []) {
      if (root.scope === 'project') await files.restoreRoot(root.rootId, root.path).catch(() => undefined)
    }
  }
  const identitySecrets = new WeakMap<ImportIdentity, string>()
  const identity = (secret: string): ImportIdentity => {
    const key = createPrivateKey({ key: Buffer.from(secret, 'base64url'), format: 'der', type: 'pkcs8' })
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url')
    const wrapped: ImportIdentity = { publicKey, keyFingerprint: createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex'),
      sign: (challenge, remember, scope, rootIds) => signChallenge(key, challenge, consentHash(remember, scope, rootIds)) }
    identitySecrets.set(wrapped, secret)
    return wrapped
  }
  return new SkillImportService({
    files: { listRoots: () => files.listRoots(), addProjectRoot: path => files.addProjectRoot(path),
      removeRoot: id => files.removeRoot(id), scan: (ids, input) => files.scan(ids, input),
      getScanWarnings: () => files.getScanWarnings(),
      preview: (input, signal) => files.preview(input, signal), packageSelected: (input, signal) => files.packageSelected(input, signal),
      reset: () => files.reset(), dispose: () => files.dispose() },
    devices: {
      available: () => store.canPersist(),
      createIdentity: () => identity(store.createIdentity().privateKeyPkcs8),
      list: async () => (await store.listBindings()).map(binding => ({ deviceId: binding.deviceId, instanceId: binding.instanceId,
        label: binding.label, keyFingerprint: binding.keyFingerprint, platform: binding.platform, scope: binding.scope,
        rootIds: binding.rootIds, revocationPending: binding.revokePending || !binding.enabled })),
      identity: async (deviceId, instanceId) => {
        const binding = await store.getBinding(deviceId, instanceId)
        if (!binding) throw new Error('DEVICE_REVOKED')
        return identity(binding.privateKeyPkcs8)
      },
      remember: async (key, binding) => {
        const secret = identitySecrets.get(key)
        if (!secret) throw new Error('DEVICE_PROOF_INVALID')
        const roots = (await files.listRoots()).filter(root => binding.rootIds.includes(root.id)).map(({ id, ...root }) => ({ ...root, rootId: id }))
        await store.saveBinding({ ...binding, clientVersion: options.clientVersion, roots, privateKeyPkcs8: secret, rememberDevice: true })
      },
      disable: (deviceId, instanceId) => store.markRevokePending(deviceId, instanceId), forget: (deviceId, instanceId) => store.confirmRevoke(deviceId, instanceId),
    },
    instances: resolveSkillImportInstances(process.env['SEP_SKILL_IMPORT_INSTANCES']), api: instance => new SkillImportApi(instance.apiBaseUrl),
    clientVersion: options.clientVersion, platform: process.platform, publish: options.publish,
  })
}
