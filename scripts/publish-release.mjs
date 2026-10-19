import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { buildReleasePlan, collectRelease, requireRelease } from './release-plan.mjs'
import { initializeFixture, publishLocal, recoverLocal, rollbackLocal } from './local-release-store.mjs'

const usage = 'usage: publish-release.mjs plan|collect|publish-local|rollback-local|recover-local beta|stable [options], or init --fixture <empty-directory>'
const flags = {
  plan: ['source', 'version', 'commit'],
  collect: ['mac', 'win', 'output', 'version', 'commit', 'notes'],
  'publish-local': ['source', 'fixture', 'version', 'commit'],
  'rollback-local': ['fixture', 'record'],
  'recover-local': ['fixture'],
  init: ['fixture'],
}
export async function main(args = process.argv.slice(2), { env = process.env } = {}) {
  const [action, ...rest] = args
  requireRelease(Object.hasOwn(flags, action), usage)
  const channel = action === 'init' ? undefined : rest.shift()
  requireRelease(action === 'init' || channel === 'beta' || channel === 'stable', usage)
  requireRelease(!channel || !env.SEP_RELEASE_CHANNEL || env.SEP_RELEASE_CHANNEL === channel, 'release channel conflicts with the environment')
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index].startsWith('--') ? rest[index].slice(2) : ''
    const value = rest[index + 1]
    requireRelease(flags[action].includes(key) && !Object.hasOwn(options, key) && typeof value === 'string' && value.length > 0 && !value.startsWith('--'), usage)
    options[key] = value
  }
  let result
  if (action === 'init') {
    requireRelease(options.fixture, usage)
    result = await initializeFixture(options.fixture)
  } else if (action === 'rollback-local' || action === 'recover-local') {
    requireRelease(options.fixture && (action !== 'rollback-local' || options.record), usage)
    result = await (action === 'rollback-local' ? rollbackLocal : recoverLocal)({ channel, ...options })
  } else {
    requireRelease(options.commit, 'explicit build commit is required')
    const version = options.version || JSON.parse(await readFile('package.json', 'utf8')).version
    if (action === 'collect') {
      requireRelease(options.mac && options.win && options.output, usage)
      result = await collectRelease({ channel, ...options, version })
    } else {
      requireRelease(options.source && (action !== 'publish-local' || options.fixture), usage)
      result = await (action === 'plan' ? buildReleasePlan : publishLocal)({ channel, ...options, version, directory: options.source })
    }
  }
  // Snapshots stay on disk; do not echo previous release content into CI logs.
  const output = result.id ? {
    schemaVersion: result.schemaVersion, mode: result.mode, releaseApproved: false,
    id: result.id, channel: result.channel, version: result.version, commit: result.commit, status: result.status,
  } : result
  console.log(JSON.stringify(output, null, 2))
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { await main() } catch {
    console.error('Local release operation failed. Check the command, complete artifact set, build receipts, fixture lock and recovery records. Remote publishing is disabled.')
    process.exitCode = 1
  }
}
