import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { createConnectorBundle } from './connector-assets.mjs'
import { connectorArtifactPlan } from './verify-connector-assets.mjs'

test('connector bundles preserve licenses, publish all targets and detect corruption', async t => {
  const root = await mkdtemp(join(process.env.CSEP_TEST_TEMP ?? tmpdir(), 'connector-bundles-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'input')
  const output = join(root, 'connector-assets')
  await mkdir(input)
  await writeFile(join(input, 'tool'), 'native fixture')
  await writeFile(join(input, 'tool.exe'), 'native fixture')
  await writeFile(join(input, 'dws-skills.zip'), 'fixture skills')
  await writeFile(join(input, 'LICENSE'), 'fixture notice')
  let first
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    const components = []
    for (const id of ['dingtalk', 'feishu', 'wecom']) {
      const component = await createConnectorBundle({ id, version: '1.0.0', binary: 'tool' }, input, output, platform, arch)
      components.push(component)
      first ??= component
    }
    await writeFile(join(output, `${platform}-${arch}.json`), JSON.stringify({ schemaVersion: 1, components }))
  }
  assert.equal((await connectorArtifactPlan(root, { required: true })).length, 9)
  const zip = unzipSync(await readFile(join(output, first.archive)))
  assert.equal(Buffer.from(zip.LICENSE).toString(), 'fixture notice')
  await writeFile(join(output, first.archive), 'tampered')
  await assert.rejects(connectorArtifactPlan(root, { required: true }), /missing or unsafe/)
})

test('missing component sets cannot be published as a complete release', async t => {
  const root = await mkdtemp(join(process.env.CSEP_TEST_TEMP ?? tmpdir(), 'connector-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await connectorArtifactPlan(root), [])
  await assert.rejects(connectorArtifactPlan(root, { required: true }), { code: 'ENOENT' })
  await mkdir(join(root, 'connector-assets'))
  await writeFile(join(root, 'connector-assets/win32-x64.json'), JSON.stringify({ schemaVersion: 1, components: [] }))
  await assert.rejects(connectorArtifactPlan(root, { required: true }), /Invalid connector manifest/)
})

test('packaging excludes CLI payloads and the trusted manifest is produced before app signing', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(!pkg.build.extraResources.some(item => /dws-skills/.test(item.from)))
  const hook = await readFile(new URL('./speech-after-pack.cjs', import.meta.url), 'utf8')
  assert.match(hook, /afterConnectorPack/)
  assert.doesNotMatch(hook, /afterDingTalkPack|afterFeishuPack|afterWecomPack/)
})
