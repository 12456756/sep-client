import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import semver from 'semver'
import { MANIFEST_NAMES, parseManifest, validateManifestSet, verifyUpdateDirectory } from './verify-update-manifest.mjs'
import {
  buildReleasePlan, copyReleaseFile, hashReleaseFile, readReleaseBytes,
  releaseDirectory, requireRelease, requiredPlatformFiles, sameReleaseFile, validateBuildReceipt, validateReleaseFile, validateReleaseIdentity,
} from './release-plan.mjs'

const MARKER = '.sep-release-fixture.json'
const RECORD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const pendingStatuses = new Set(['publishing-local', 'rolling-back-local', 'recovery-required'])
const statuses = new Set([...pendingStatuses, 'published-local', 'failed-restored-local', 'rolled-back-local', 'recovered-local'])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const mutableNames = channel => ['release-builds.json', `RELEASE-NOTES-${channel}.md`, 'SHA256SUMS.txt', 'latest.yml', 'latest-mac.yml']

async function exists(file) {
  try { return await lstat(file) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
async function childDirectory(root, name) {
  const target = resolve(root, name)
  try { await mkdir(target) } catch (error) { if (error.code !== 'EEXIST') throw error }
  requireRelease((await lstat(target)).isDirectory(), 'fixture directories cannot be symbolic links')
  return target
}
async function atomicBytes(root, name, bytes) {
  const previous = await exists(resolve(root, name))
  requireRelease(!previous || previous.isFile(), 'fixture metadata must be a regular file')
  const temporary = resolve(root, `.temporary-${randomUUID()}`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, resolve(root, name))
  } finally {
    if (handle) await handle.close()
    await rm(temporary, { force: true })
  }
}
async function atomicJson(root, name, value) {
  await atomicBytes(root, name, Buffer.from(JSON.stringify(value, null, 2) + '\n'))
}
function parse(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error('fixture state contains invalid UTF-8 JSON') }
}
export async function initializeFixture(directory) {
  requireRelease(typeof directory === 'string' && !directory.includes('://'), 'fixture must be a local directory')
  const target = resolve(directory)
  await mkdir(target, { recursive: true })
  const root = await releaseDirectory(target)
  requireRelease((await readdir(root)).length === 0, 'fixture initialization requires an empty directory')
  const handle = await open(resolve(root, MARKER), 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, localOnly: true }) + '\n'); await handle.sync() } finally { await handle.close() }
  return { schemaVersion: 1, mode: 'local-rehearsal', releaseApproved: false }
}
async function fixtureRoot(directory) {
  try {
    const root = await releaseDirectory(directory)
    const marker = parse(await readReleaseBytes(root, MARKER, 1024))
    requireRelease(marker.schemaVersion === 1 && marker.localOnly === true, 'explicitly initialized local fixture is required')
    return root
  } catch { throw new Error('explicitly initialized local fixture is required') }
}
async function withLock(directory, channel, action) {
  requireRelease(channel === 'beta' || channel === 'stable', 'channel must be beta or stable')
  const root = await fixtureRoot(directory)
  const stateRoot = await childDirectory(root, '.release-state')
  const state = await childDirectory(stateRoot, channel)
  const records = await childDirectory(state, 'records')
  const lock = resolve(state, 'lock')
  try { await mkdir(lock) } catch (error) { if (error.code === 'EEXIST') throw new Error('local release channel is locked'); throw error }
  try {
    const feed = await childDirectory(root, channel)
    return await action({ root, state, records, feed })
  } finally { await rm(lock, { recursive: true }) }
}
async function snapshot(feed, channel) {
  const result = {}
  for (const name of mutableNames(channel)) {
    if (!await exists(resolve(feed, name))) result[name] = null
    else {
      const bytes = await readReleaseBytes(feed, name)
      result[name] = { bytes: bytes.toString('base64'), sha256: hash(bytes) }
    }
  }
  return result
}
function validateRecord(record, channel) {
  requireRelease(record?.schemaVersion === 1 && record.mode === 'local-rehearsal' && RECORD_ID.test(record.id) && record.channel === channel && record.releaseApproved === false && statuses.has(record.status), 'local release record is invalid')
  validateReleaseIdentity(record)
  requireRelease(record.plan?.mode === 'local-rehearsal' && record.plan.releaseApproved === false && record.plan.version === record.version && record.plan.commit === record.commit && record.plan.channel === channel && Array.isArray(record.plan.files), 'local release record plan is invalid')
  const names = mutableNames(channel)
  const artifacts = ['darwin', 'win32'].flatMap(platform => requiredPlatformFiles(record.version, platform)).filter(name => !name.startsWith('latest'))
  const allowed = new Set([...artifacts, ...artifacts.filter(name => /\.(dmg|zip)$/.test(name)).map(name => name + '.blockmap'), ...names])
  const seen = new Set()
  for (const file of record.plan.files) {
    validateReleaseFile(file)
    requireRelease(allowed.has(file.name) && !seen.has(file.name), 'local release plan files are invalid')
    seen.add(file.name)
    const phase = file.name.startsWith('latest') ? 'manifest' : names.includes(file.name) ? 'metadata' : 'artifact'
    requireRelease(file.phase === phase, 'local release plan file phase is invalid')
  }
  requireRelease([...artifacts, ...names].every(name => seen.has(name)), 'local release plan is incomplete')
  requireRelease(record.before && Object.keys(record.before).length === names.length, 'local rollback snapshot is invalid')
  for (const name of names) {
    const entry = record.before[name]
    requireRelease(entry === null || (entry && typeof entry.bytes === 'string' && entry.bytes.length <= 2 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(entry.sha256)), 'local rollback snapshot entry is invalid')
    if (entry) {
      const bytes = Buffer.from(entry.bytes, 'base64')
      requireRelease(bytes.length > 0 && bytes.length <= 1024 * 1024 && bytes.toString('base64') === entry.bytes && hash(bytes) === entry.sha256, 'local rollback snapshot hash mismatch')
    }
    requireRelease(record.plan.files.filter(file => file?.name === name).length === 1, 'local rollback plan metadata is invalid')
  }
  return record
}
async function readRecords(records, channel) {
  const result = []
  for (const name of await readdir(records)) {
    if (name.startsWith('.temporary-')) continue
    requireRelease(name.endsWith('.json') && RECORD_ID.test(name.slice(0, -5)), 'unexpected local release state file')
    const record = validateRecord(parse(await readReleaseBytes(records, name, 8 * 1024 * 1024)), channel)
    requireRelease(record.id === name.slice(0, -5), 'local record identity mismatch')
    result.push(record)
  }
  return result
}
async function saveRecord(records, record) {
  await atomicJson(records, `${record.id}.json`, record)
}
function requireRecovered(records) {
  requireRelease(!records.some(record => pendingStatuses.has(record.status)), 'local recovery is required before another operation')
}
async function verifyPlanFiles(feed, files) {
  for (const file of files) requireRelease(sameReleaseFile(await hashReleaseFile(feed, file.name), file), 'local published file hash mismatch')
}
async function verifyRollbackTarget(context, record) {
  const manifests = MANIFEST_NAMES.filter(name => record.before[name]).map(name => ({
    name, manifest: parseManifest(Buffer.from(record.before[name].bytes, 'base64'), name),
  }))
  if (!manifests.length) return
  validateManifestSet(manifests, { requireAllPlatforms: true })
  for (const { manifest } of manifests) for (const file of manifest.files) {
    const actual = await hashReleaseFile(context.feed, file.url)
    requireRelease(actual.size === file.size && actual.sha512 === file.sha512, 'rollback target artifact integrity mismatch')
  }
  const buildSnapshot = record.before['release-builds.json']
  if (!buildSnapshot) return
  const receipts = parse(Buffer.from(buildSnapshot.bytes, 'base64'))
  requireRelease(Array.isArray(receipts) && receipts.length === 2, 'rollback target build receipts are invalid')
  const identity = { channel: record.channel, version: manifests[0].manifest.version, commit: receipts[0]?.commit }
  for (const platform of ['darwin', 'win32']) {
    requireRelease(receipts.filter(receipt => receipt?.platform === platform).length === 1, 'rollback target receipts must be unique')
    const receipt = validateBuildReceipt(receipts.find(receipt => receipt?.platform === platform), identity, platform)
    for (const file of receipt.files) {
      if (MANIFEST_NAMES.includes(file.name)) {
        const entry = record.before[file.name]
        const bytes = Buffer.from(entry.bytes, 'base64')
        requireRelease(bytes.length === file.size && entry.sha256 === file.sha256 && createHash('sha512').update(bytes).digest('base64') === file.sha512, 'rollback target manifest differs from its receipt')
      } else requireRelease(sameReleaseFile(await hashReleaseFile(context.feed, file.name), file), 'rollback target artifact differs from its receipt')
    }
  }
}
async function restoreBefore(context, record, hook) {
  await hook('before-restore')
  await verifyRollbackTarget(context, record)
  // Restore manifests first to withdraw the bad version; metadata follows.
  const names = ['latest.yml', 'latest-mac.yml', ...mutableNames(record.channel).filter(name => !name.startsWith('latest'))]
  for (const name of names) {
    const entry = record.before[name]
    if (entry === null) {
      const current = await exists(resolve(context.feed, name))
      requireRelease(!current || current.isFile(), 'cannot restore non-regular fixture metadata')
      await rm(resolve(context.feed, name), { force: true })
    } else await atomicBytes(context.feed, name, Buffer.from(entry.bytes, 'base64'))
  }
  requireRelease(JSON.stringify(await snapshot(context.feed, record.channel)) === JSON.stringify(record.before), 'local rollback snapshot verification failed')
  if (record.before['latest.yml'] || record.before['latest-mac.yml']) await verifyUpdateDirectory(context.feed, { requireAllPlatforms: true })
}
async function recoverableState(context, record) {
  const current = await snapshot(context.feed, record.channel)
  for (const name of mutableNames(record.channel)) {
    const old = record.before[name]
    const expected = record.plan.files.find(file => file.name === name)
    requireRelease(current[name]?.sha256 === old?.sha256 || current[name]?.sha256 === expected.sha256, 'fixture changed outside recorded transaction; recovery refused')
  }
}
export async function publishLocal({ fixture, hook = async () => {}, ...identityAndSource }) {
  const plan = await buildReleasePlan(identityAndSource)
  const source = await releaseDirectory(identityAndSource.directory)
  return withLock(fixture, plan.channel, async context => {
    const contains = (parent, child) => {
      const difference = relative(parent, child)
      return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
    }
    requireRelease(!contains(context.root, source) && !contains(source, context.root), 'source and fixture directories must not overlap')
    const existing = await readRecords(context.records, plan.channel)
    requireRecovered(existing)
    requireRelease(existing.every(record => semver.gt(plan.version, record.version)), 'release version reuse or non-increasing version is forbidden')
    const before = await snapshot(context.feed, plan.channel)
    if (before['latest.yml'] || before['latest-mac.yml']) {
      const current = await verifyUpdateDirectory(context.feed, { requireAllPlatforms: true })
      requireRelease(current.every(manifest => semver.gt(plan.version, manifest.version)), 'release version must increase over the current feed')
    }
    const record = { schemaVersion: 1, mode: 'local-rehearsal', id: randomUUID(), releaseApproved: false, channel: plan.channel, version: plan.version, commit: plan.commit, createdAt: new Date().toISOString(), status: 'publishing-local', plan, before }
    await saveRecord(context.records, record)
    try {
      for (const file of plan.files.filter(file => file.phase === 'artifact')) {
        await hook('before-artifact', file.name)
        await copyReleaseFile(source, context.feed, file)
      }
      for (const file of plan.files.filter(file => file.phase === 'metadata')) {
        await hook('before-metadata', file.name)
        const bytes = await readReleaseBytes(source, file.name)
        requireRelease(hash(bytes) === file.sha256, 'release metadata changed after planning')
        await atomicBytes(context.feed, file.name, bytes)
      }
      const manifests = plan.files.filter(file => file.phase === 'manifest')
      for (const [index, file] of manifests.entries()) {
        await hook('before-manifest', file.name)
        await verifyPlanFiles(context.feed, plan.files.filter(file => file.phase !== 'manifest'))
        const bytes = await readReleaseBytes(source, file.name)
        requireRelease(hash(bytes) === file.sha256, 'manifest changed after planning')
        await atomicBytes(context.feed, file.name, bytes)
        if (index === 0) await hook('after-first-manifest', file.name)
      }
      await hook('before-final-verification')
      await verifyPlanFiles(context.feed, plan.files)
      await verifyUpdateDirectory(context.feed, { requireAllPlatforms: true })
      record.status = 'published-local'
      record.completedAt = new Date().toISOString()
      await saveRecord(context.records, record)
      return record
    } catch {
      try {
        await restoreBefore(context, record, hook)
        record.status = 'failed-restored-local'
        await saveRecord(context.records, record)
      } catch {
        record.status = 'recovery-required'
        await saveRecord(context.records, record)
        throw new Error('local publication failed; explicit recovery is required')
      }
      throw new Error('local publication failed; previous manifests and metadata restored')
    }
  })
}
export async function rollbackLocal({ channel, fixture, record: id, hook = async () => {} }) {
  requireRelease(typeof id === 'string' && RECORD_ID.test(id), 'rollback requires a local record UUID')
  return withLock(fixture, channel, async context => {
    const records = await readRecords(context.records, channel)
    requireRecovered(records)
    const record = records.find(record => record.id === id)
    requireRelease(record?.status === 'published-local', 'record is not an active local publication')
    await verifyPlanFiles(context.feed, record.plan.files.filter(file => file.phase !== 'artifact'))
    await verifyRollbackTarget(context, record)
    record.status = 'rolling-back-local'
    await saveRecord(context.records, record)
    try {
      await restoreBefore(context, record, hook)
      record.status = 'rolled-back-local'
      await saveRecord(context.records, record)
      return record
    } catch {
      record.status = 'recovery-required'
      await saveRecord(context.records, record)
      throw new Error('local rollback failed; explicit recovery is required')
    }
  })
}
export async function recoverLocal({ channel, fixture, hook = async () => {} }) {
  return withLock(fixture, channel, async context => {
    const records = await readRecords(context.records, channel)
    const pending = records.filter(record => pendingStatuses.has(record.status))
    requireRelease(pending.length === 1, 'recovery requires exactly one unfinished local transaction')
    const record = pending[0]
    await recoverableState(context, record)
    await restoreBefore(context, record, hook)
    record.status = 'recovered-local'
    await saveRecord(context.records, record)
    return record
  })
}
