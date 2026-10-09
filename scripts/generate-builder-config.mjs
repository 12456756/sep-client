import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Candidate feeds from the update plan; deployment and signing are release prerequisites.
export const UPDATE_FEEDS = Object.freeze({
  beta: 'https://download.longdaosep.cn/sep-client/beta/',
  stable: 'https://download.longdaosep.cn/sep-client/stable/',
})

export function createBuilderConfig(build, channel) {
  if (!Object.hasOwn(UPDATE_FEEDS, channel)) throw new Error('channel must be beta or stable')
  if (!build || typeof build !== 'object' || Array.isArray(build)) throw new Error('package.json must contain build configuration')
  const config = structuredClone(build)
  for (const platform of ['mac', 'win', 'linux']) {
    if (config[platform]?.publish != null) throw new Error(`${platform}.publish must not override the channel feed`)
  }
  config.directories = { ...config.directories, output: `dist/${channel}` }
  config.publish = [{ provider: 'generic', url: UPDATE_FEEDS[channel], channel: 'latest' }]
  config.detectUpdateChannel = false
  config.generateUpdatesFilesForAllChannels = false
  config.mac = {
    ...config.mac,
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
  }
  return config
}

export async function generateBuilderConfig(channel, root = process.cwd()) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const config = createBuilderConfig(pkg.build, channel)
  const directory = resolve(root, '.release')
  const file = resolve(directory, `electron-builder.${channel}.json`)
  await mkdir(directory, { recursive: true })
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`)
  return file
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/generate-builder-config.mjs beta|stable')
    const channel = process.argv[2]
    if (process.env.SEP_RELEASE_CHANNEL && process.env.SEP_RELEASE_CHANNEL !== channel) {
      throw new Error('SEP_RELEASE_CHANNEL conflicts with the requested build channel')
    }
    await generateBuilderConfig(channel)
    console.log(`builder config: .release/electron-builder.${channel}.json (output: dist/${channel}, publishing disabled by packaging command)`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
