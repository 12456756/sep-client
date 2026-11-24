import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import yaml from 'js-yaml'
import { artifactIdentity, githubRequest, main, preparePullBundle, publishByServerPull, runRemote, validateArtifactMetadata, validateDownloadUrl } from './server-pull-release.mjs'
import { createClientRelease } from './client-release-manifest.mjs'

const env = { GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'example/client' }

test('artifact identity binds the exact run attempt and commit', () => {
  assert.deepEqual(artifactIdentity(env), { runId: '1234', runAttempt: '2', commit: 'a'.repeat(40), artifactName: 'sep-client-server-pull-1234-2' })
  for (const field of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA']) {
    assert.throws(() => artifactIdentity({ ...env, [field]: '../bad' }), /identity/)
  }
})

test('metadata rejects expired artifacts, wrong commits, run IDs, names and missing checksums', () => {
  const metadata = { id: 77, name: 'sep-client-server-pull-1234-2', expired: false, size_in_bytes: 100, digest: `sha256:${'b'.repeat(64)}`, workflow_run: { id: 1234, head_sha: env.GITHUB_SHA } }
  assert.deepEqual(validateArtifactMetadata(metadata, '77', env), { artifactId: '77', archiveSize: 100, archiveSha256: 'b'.repeat(64) })
  for (const override of [{ id: 78 }, { name: 'other' }, { expired: true }, { size_in_bytes: 0 }, { size_in_bytes: 9 * 1024 ** 3 }, { digest: null }, { workflow_run: { id: 999, head_sha: env.GITHUB_SHA } }, { workflow_run: { id: 1234, head_sha: 'c'.repeat(40) } }]) {
    assert.throws(() => validateArtifactMetadata({ ...metadata, ...override }, '77', env), /artifact/)
  }
})

test('signed URLs allow only HTTPS GitHub artifact storage without credentials or shell control characters', () => {
  const valid = 'https://productionresultssa1.blob.core.windows.net/artifacts/file.zip?sig=secret'
  assert.equal(validateDownloadUrl(valid), valid)
  for (const url of ['http://productionresultssa1.blob.core.windows.net/a', 'https://example.com/a', 'https://user:pass@productionresultssa1.blob.core.windows.net/a', 'https://productionresultssa1.blob.core.windows.net:444/a', `${valid}\n`, `${valid}#fragment`]) {
    assert.throws(() => validateDownloadUrl(url), /download URL/)
  }
})

test('bundle includes only verified installers, connectors and prepared manifests with bound identities', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-pull-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), prepared = join(root, 'prepared'), output = join(root, 'bundle')
  await mkdir(source); await mkdir(prepared); await mkdir(join(source, 'connector-assets'))
  const version = '1.2.3'
  const names = [`SEP-Client-${version}-win-x64.exe`, ...['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(ext => `SEP-Client-${version}-mac-${arch}.${ext}`))]
  const entries = [], artifacts = []
  for (const name of names) {
    for (const file of [name, `${name}.blockmap`]) {
      const bytes = Buffer.from(`fixture:${file}`)
      await writeFile(join(source, file), bytes)
      artifacts.push({ name: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), destination: `${version}/${file}`, url: `https://sep.longdaoec.com/sep-client/stable/${version}/${file}` })
      if (file === name) entries.push({ url: file, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') })
    }
  }
  const connectors = []
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    const components = []
    for (const id of ['dingtalk', 'feishu', 'wecom']) {
      const bytes = Buffer.from(`${id}-${platform}-${arch}`), hash = createHash('sha256').update(bytes).digest('hex')
      const name = `${id}-1.0.0-${platform}-${arch}-${hash}.zip`
      await writeFile(join(source, 'connector-assets', name), bytes)
      components.push({ id, version: '1.0.0', platform, arch, archive: name, bytes: bytes.length, sha256: hash })
      connectors.push({ name, size: bytes.length, sha256: hash })
    }
    await writeFile(join(source, 'connector-assets', `${platform}-${arch}.json`), JSON.stringify({ schemaVersion: 1, components }))
  }
  for (const manifestName of ['latest.yml', 'latest-mac.yml']) {
    const files = entries.filter(item => manifestName === 'latest.yml' ? item.url.includes('-win-') : item.url.includes('-mac-'))
    await writeFile(join(source, manifestName), yaml.dump({ version, files }))
    await writeFile(join(prepared, manifestName), yaml.dump({ version, files: files.map(item => ({ ...item, url: `${version}/${item.url}` })), releaseNotes: '- A release note.' }))
  }
  const plan = { schemaVersion: 1, mode: 'unsigned-download-update', version, channel: 'stable', feed: 'https://sep.longdaoec.com/sep-client/stable/', artifacts, connectorArtifacts: connectors, publishLast: ['latest.yml', 'latest-mac.yml', 'client-release.json'] }
  await writeFile(join(prepared, 'client-release.json'), JSON.stringify(createClientRelease(plan)))
  await writeFile(join(prepared, 'upload-plan.json'), JSON.stringify(plan))
  const result = await preparePullBundle({ source, prepared, output, env })
  assert.equal(result.version, version)
  assert.equal(result.artifacts.length, 10)
  assert.equal(result.connectorArtifacts.length, 9)
  assert.equal(result.downloads.length, 5)
  assert.equal(result.commit, env.GITHUB_SHA)
  assert.equal(result.runAttempt, '2')
  assert.deepEqual(result.manifests.map(item => item.name), plan.publishLast)
  for (const item of result.manifests) assert.equal(createHash('sha256').update(await readFile(join(output, item.name))).digest('hex'), item.sha256)
  assert.equal((await main(['--prepare', source, prepared, `${output}-cli`], env)).version, version)
  await writeFile(join(prepared, 'client-release.json'), JSON.stringify({ ...createClientRelease(plan), version: '1.2.2' }))
  await assert.rejects(preparePullBundle({ source, prepared, output: `${output}-stale`, env }), /catalog/)
  await writeFile(join(prepared, 'client-release.json'), JSON.stringify(createClientRelease(plan)))
  await writeFile(join(source, names[0]), 'tampered')
  await assert.rejects(preparePullBundle({ source, prepared, output: `${output}-bad`, env }), /size mismatch|SHA512|hash|changed/)
  await assert.rejects(readFile(join(`${output}-bad`, 'server-pull-plan.json')), { code: 'ENOENT' })
})

test('CLI rejects unsupported invocations and invalid preflight versions', async () => {
  await assert.rejects(main([]), /usage/)
  await assert.rejects(main(['--preflight', '../unsafe']), /invalid preflight/)
  await assert.rejects(main(['--preflight', '1.2.3'], {}), /SEP_UPLOAD_HOST/)
})

test('GitHub requests use the workflow token only for the GitHub API and keep redirect handling explicit', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/example/client/actions/artifacts/77/zip')
    assert.equal(options.headers.Authorization, 'Bearer secret')
    assert.equal(options.redirect, 'manual')
    return new Response(null, { status: 302 })
  }
  assert.equal((await githubRequest('/actions/artifacts/77/zip', { ...env, GH_TOKEN: 'secret' }, 'manual')).status, 302)
  globalThis.fetch = async () => new Response('private response must not be logged', { status: 403 })
  await assert.rejects(githubRequest('/actions/artifacts/77', { ...env, GH_TOKEN: 'secret' }), error => error.message.includes('HTTP 403') && !error.message.includes('private response'))
  await assert.rejects(githubRequest('/actions/artifacts/77', { ...env, GITHUB_REPOSITORY: '../unsafe' }), /repository/)
})

test('SSH worker streams script and private request on stdin, requires a receipt, and rejects disconnects and timeout', async () => {
  const context = { config: '/tmp/pinned-ssh-config', root: '/tmp/public' }
  const request = { mode: 'download', url: 'https://productionresultssa1.blob.core.windows.net/a?sig=private' }
  const fake = behavior => (command, args) => {
    assert.equal(command, 'ssh')
    assert(!args.join(' ').includes('sig=private'))
    assert(args.includes(context.config))
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin.once('data', bytes => {
      const data = JSON.parse(bytes.toString())
      assert.equal(data.request.url, request.url)
      assert.equal(data.request.root, context.root)
      assert(data.script.includes('def supervise'))
    })
    child.kill = () => { setImmediate(() => child.emit('close', null)); return true }
    setImmediate(() => behavior(child))
    return child
  }
  assert.equal((await runRemote(context, request, { start: fake(child => { child.stdout.write('SEP_RELEASE_RESULT={"status":"ready"}\n'); child.emit('close', 0) }) })).status, 'ready')
  await assert.rejects(runRemote(context, request, { start: fake(child => child.emit('close', 255)) }), /SSH exit 255/)
  await assert.rejects(runRemote(context, request, { start: fake(child => child.emit('close', 0)) }), /no completion receipt/)
  await assert.rejects(runRemote(context, request, { start: fake(child => { child.stdout.write('SEP_RELEASE_RESULT=bad\n'); child.emit('close', 0) }) }), /Invalid server release receipt/)
  await assert.rejects(runRemote(context, request, { start: fake(() => {}), timeoutMs: 5 }), /timed out/)
  await assert.rejects(runRemote(context, request, { start: fake(child => child.emit('error', new Error('spawn unavailable'))) }), /spawn unavailable/)
})

test('server publisher regression suite runs without third party dependencies', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', 'scripts/server-pull-publisher.test.py'], { encoding: 'utf8', timeout: 60000 })
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
})

test('SSH preflight can import without npm installation or third party modules', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sep-preflight-import-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const name of ['server-pull-release.mjs', 'upload-download-update.mjs', 'verify-connector-assets.mjs', 'client-release-manifest.mjs']) {
    await writeFile(join(directory, name), await readFile(`scripts/${name}`))
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(directory, 'server-pull-release.mjs')).href)})`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
})

test('download orchestration refreshes temporary URLs, waits for publication and never sends GitHub credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sep-pull-orchestrate-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'server-pull-plan.json'), JSON.stringify({ ...artifactIdentity(env), version: '1.2.3' }))
  let urls = 0, downloads = 0, publications = 0
  const metadata = { id: 77, name: artifactIdentity(env).artifactName, expired: false, size_in_bytes: 100, digest: `sha256:${'b'.repeat(64)}`, workflow_run: { id: 1234, head_sha: env.GITHUB_SHA } }
  const api = async path => path.endsWith('/zip')
    ? { status: 302, headers: new Headers({ location: `https://productionresultssa1.blob.core.windows.net/a?sig=${++urls}` }) }
    : { json: async () => metadata }
  const remote = async (_context, request) => {
    assert(!JSON.stringify(request).includes('github-secret'))
    if (request.mode === 'download') {
      assert(request.url.endsWith(`sig=${urls}`))
      downloads += 1
      return { status: downloads === 1 ? 'retry' : 'ready' }
    }
    publications += 1
    return { status: 'published', version: '1.2.3', verifiedInstallers: 5, verifiedComponents: 9 }
  }
  const options = { api, remote, ssh: async (_env, action) => action({}) }
  assert.equal((await publishByServerPull('77', directory, { ...env, GH_TOKEN: 'github-secret' }, options)).status, 'published')
  assert.equal(urls, 2)
  assert.equal(publications, 1)
  publications = 0
  await assert.rejects(publishByServerPull('77', directory, env, { ...options, remote: async () => ({ status: 'retry' }) }), /did not complete/)
  assert.equal(publications, 0)
  await assert.rejects(publishByServerPull('77', directory, env, { ...options, remote: async (_context, request) => request.mode === 'download' ? { status: 'ready' } : { status: 'published', version: '9.0.0' } }), /incomplete publication/)
})
