import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { shellQuote, withSshContext } from './upload-download-update.mjs'
import { readClientRelease, RELEASE_POINTER_NAMES } from './client-release-manifest.mjs'

const FEED = 'https://sep.longdaoec.com/sep-client/stable/'
const MANIFESTS = ['latest.yml', 'latest-mac.yml']

export function artifactIdentity(env) {
  assert(/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''), 'invalid GitHub release identity')
  return { runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, commit: env.GITHUB_SHA, artifactName: `sep-client-server-pull-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` }
}

export function validateArtifactMetadata(metadata, id, env) {
  const identity = artifactIdentity(env)
  assert(/^[1-9]\d*$/.test(id) && String(metadata.id) === id && metadata.name === identity.artifactName && metadata.expired === false, 'unexpected or expired artifact')
  assert(String(metadata.workflow_run?.id) === identity.runId && metadata.workflow_run?.head_sha === identity.commit, 'artifact belongs to another run or commit')
  assert(Number.isSafeInteger(metadata.size_in_bytes) && metadata.size_in_bytes > 0 && metadata.size_in_bytes <= 8 * 1024 ** 3 && /^sha256:[a-f0-9]{64}$/.test(metadata.digest ?? ''), 'artifact size or checksum unavailable')
  return { artifactId: id, archiveSize: metadata.size_in_bytes, archiveSha256: metadata.digest.slice(7) }
}

export function validateDownloadUrl(value) {
  assert(typeof value === 'string' && !/[\s\x00-\x1f\\"]/.test(value), 'invalid artifact download URL')
  let url
  try { url = new URL(value) } catch { throw new Error('invalid artifact download URL') }
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port && ['.blob.core.windows.net', '.actions.githubusercontent.com'].some(suffix => url.hostname.endsWith(suffix)), 'invalid artifact download URL')
  return value
}

async function fileRecord(path, name = basename(path)) {
  const metadata = await lstat(path)
  assert(metadata.isFile() && metadata.size > 0, 'unsafe or empty release file')
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) { size += chunk.length; hash.update(chunk) }
  assert.equal(size, metadata.size, 'release file changed while hashing')
  return { name, size, sha256: hash.digest('hex') }
}

export async function preparePullBundle({ source, prepared, output, env = process.env }) {
  const { connectorArtifactPlan } = await import('./verify-connector-assets.mjs')
  const { parseManifest, validateManifestSet, verifyUpdateDirectory } = await import('./verify-update-manifest.mjs')
  const identity = artifactIdentity(env)
  const plan = JSON.parse(await readFile(join(prepared, 'upload-plan.json'), 'utf8'))
  assert(plan.schemaVersion === 1 && plan.mode === 'unsigned-download-update' && plan.channel === 'stable' && plan.feed === FEED && /^\d+\.\d+\.\d+$/.test(plan.version), 'invalid stable upload plan')
  assert.equal(plan.artifacts.length, 10)
  assert.deepEqual(plan.publishLast, RELEASE_POINTER_NAMES)
  await readClientRelease(prepared, plan)
  await verifyUpdateDirectory(source, { requireAllPlatforms: true })
  assert.deepEqual(await connectorArtifactPlan(source, { required: true }), plan.connectorArtifacts)
  assert.equal(plan.connectorArtifacts.length, 9)
  for (const item of plan.artifacts) {
    assert(item.name === basename(item.name) && /^[A-Za-z0-9.-]+$/.test(item.name), 'unsafe release file name')
    assert.equal(item.destination, `${plan.version}/${item.name}`)
    assert.equal(item.url, new URL(item.destination, FEED).href)
    assert.deepEqual(await fileRecord(join(source, item.name)), { name: item.name, size: item.size, sha256: item.sha256 }, 'artifact changed after verification')
  }
  const manifests = [], downloads = [], sourceFiles = new Map()
  for (const name of MANIFESTS) {
    for (const file of parseManifest(await readFile(join(source, name)), name).files) sourceFiles.set(file.url, file)
    const bytes = await readFile(join(prepared, name)), manifest = parseManifest(bytes, name)
    assert.equal(manifest.version, plan.version)
    assert(typeof manifest.releaseNotes === 'string' && manifest.releaseNotes.length > 0, 'missing version release notes')
    manifests.push({ name, manifest })
    for (const file of manifest.files) {
      const original = sourceFiles.get(basename(file.url))
      assert(original && file.url === `${plan.version}/${original.url}` && file.size === original.size && file.sha512 === original.sha512, 'prepared manifest differs from verified source')
      downloads.push({ url: file.url, size: file.size, sha512: file.sha512 })
    }
  }
  validateManifestSet(manifests, { requireAllPlatforms: true })
  assert.equal(downloads.length, 5, 'all five installers must appear in update manifests')
  const manifestRecords = await Promise.all(RELEASE_POINTER_NAMES.map(name => fileRecord(join(prepared, name))))
  const result = { schemaVersion: 1, ...identity, version: plan.version, channel: 'stable', feed: FEED, artifacts: plan.artifacts, connectorArtifacts: plan.connectorArtifacts, manifests: manifestRecords, downloads }
  await mkdir(output)
  await mkdir(join(output, 'artifacts'))
  await mkdir(join(output, 'connector-assets'))
  const transfer = async (from, to) => {
    try { await link(from, to) } catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error
      await copyFile(from, to)
    }
  }
  for (const item of plan.artifacts) await transfer(join(source, item.name), join(output, 'artifacts', item.name))
  for (const item of plan.connectorArtifacts) await transfer(join(source, 'connector-assets', item.name), join(output, 'connector-assets', item.name))
  for (const name of RELEASE_POINTER_NAMES) await copyFile(join(prepared, name), join(output, name))
  await writeFile(join(output, 'server-pull-plan.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  return result
}

export async function runRemote(context, request, { timeoutMs = 25 * 60 * 1000, start = spawn } = {}) {
  const script = await readFile(fileURLToPath(new URL('./server-pull-publisher.py', import.meta.url)), 'utf8')
  const bootstrap = 'import sys,json; data=json.loads(sys.stdin.readline()); exec(compile(data["script"], "sep-release-worker", "exec")); supervise(data["request"])'
  return new Promise((resolveResult, reject) => {
    const child = start('ssh', ['-F', context.config, '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', 'sep-upload', `python3 -u -c ${shellQuote(bootstrap)}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    child.stdin.on('error', () => {})
    child.stdin.write(`${JSON.stringify({ script, request: { ...request, root: context.root } })}\n`)
    const heartbeat = setInterval(() => { if (!child.stdin.destroyed) child.stdin.write('heartbeat\n') }, 10000)
    const timeout = setTimeout(() => { timedOut = true; child.stdin.destroy(); child.kill('SIGTERM') }, timeoutMs)
    const cancel = () => { child.stdin.destroy(); child.kill('SIGTERM') }
    process.once('SIGTERM', cancel)
    process.once('SIGINT', cancel)
    child.stdout.on('data', chunk => {
      output = (output + chunk.toString()).slice(-65536)
      process.stdout.write(chunk)
    })
    child.stderr.on('data', chunk => process.stderr.write(chunk))
    const clean = () => {
      clearInterval(heartbeat); clearTimeout(timeout)
      process.off('SIGTERM', cancel); process.off('SIGINT', cancel)
    }
    child.once('error', error => { clean(); reject(error) })
    child.once('close', code => {
      clean()
      if (code !== 0 || timedOut) return reject(new Error(timedOut ? 'Server release timed out; inspect the retained release transaction before retrying' : `Server release failed (SSH exit ${code}); see the stage above`))
      const line = output.split(/\r?\n/).findLast(value => value.startsWith('SEP_RELEASE_RESULT='))
      if (!line) return reject(new Error('Server release returned no completion receipt'))
      try { resolveResult(JSON.parse(line.slice('SEP_RELEASE_RESULT='.length))) } catch { reject(new Error('Invalid server release receipt')) }
    })
  })
}

export async function githubRequest(path, env, redirect = 'follow') {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') && env.GH_TOKEN, 'GitHub repository or workflow token unavailable')
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect, signal: AbortSignal.timeout(30000) })
  assert(response.ok || response.status === 302, `GitHub artifact request failed (HTTP ${response.status})`)
  return response
}

export async function publishByServerPull(id, bundle, env = process.env, { api = githubRequest, remote = runRemote, ssh = withSshContext } = {}) {
  const identity = artifactIdentity(env)
  assert(/^[1-9]\d*$/.test(id), 'invalid artifact ID')
  const metadata = await (await api(`/actions/artifacts/${id}`, env)).json()
  const archive = validateArtifactMetadata(metadata, id, env)
  const plan = JSON.parse(await readFile(join(bundle, 'server-pull-plan.json'), 'utf8'))
  for (const [key, value] of Object.entries(identity)) assert.equal(plan[key], value, 'local bundle identity mismatch')
  const request = { ...identity, ...archive, version: plan.version, planSha256: (await fileRecord(join(bundle, 'server-pull-plan.json'))).sha256, workRoot: env.SEP_RELEASE_WORK_ROOT || '/www/sep/.sep-client-releases' }
  return ssh(env, async context => {
    let ready = false
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      console.log(`Server artifact download: attempt ${attempt}/4 (cached bytes are retained)`)
      const response = await api(`/actions/artifacts/${id}/zip`, env, 'manual')
      assert.equal(response.status, 302, 'GitHub artifact download did not provide a temporary URL')
      const url = validateDownloadUrl(response.headers.get('location'))
      const result = await remote(context, { ...request, mode: 'download', url }, { timeoutMs: 7 * 60 * 1000 })
      if (result.status === 'ready') { ready = true; break }
      assert.equal(result.status, 'retry', 'unexpected server download state')
    }
    assert(ready, 'Server download did not complete; partial data is retained, no update manifests were published')
    const result = await remote(context, { ...request, mode: 'publish' })
    assert(result.status === 'published' && result.version === plan.version && result.verifiedInstallers === 5 && result.verifiedComponents === 9, 'incomplete publication receipt')
    return result
  })
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args[0] === '--prepare' && args.length === 4) {
    const result = await preparePullBundle({ source: args[1], prepared: args[2], output: args[3], env })
    console.log(`Prepared server-pull bundle ${result.version}: 10 release files and 9 connector components`)
    return result
  }
  if (args[0] === '--preflight' && args.length === 2) {
    assert(/^\d+\.\d+\.\d+$/.test(args[1]), 'invalid preflight version')
    return withSshContext(env, context => runRemote(context, { mode: 'preflight', version: args[1], workRoot: env.SEP_RELEASE_WORK_ROOT || '/www/sep/.sep-client-releases' }, { timeoutMs: 120000 }))
  }
  if (args[0] === '--publish' && args.length === 3) return publishByServerPull(args[1], args[2], env)
  throw new Error('usage: server-pull-release.mjs --prepare <source> <prepared> <bundle> | --preflight <version> | --publish <artifact-id> <bundle>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { await main() } catch (error) {
    console.error(`Server-pull release failed: ${error.message}`)
    process.exitCode = 1
  }
}
