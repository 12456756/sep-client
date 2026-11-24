import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export const CLIENT_RELEASE_NAME = 'client-release.json'
export const RELEASE_POINTER_NAMES = Object.freeze(['latest.yml', 'latest-mac.yml', CLIENT_RELEASE_NAME])
const MAX_BYTES = 64 * 1024
const platforms = [
  ['macos-arm64', 'mac-arm64.dmg', 'macOS · Apple 芯片', 'ARM64', 'macOS 12 或更高版本'],
  ['macos-x64', 'mac-x64.dmg', 'macOS · Intel 芯片', 'x64', 'macOS 12 或更高版本'],
  ['windows-x64', 'win-x64.exe', 'Windows · 64 位', 'x64', 'Windows 10 64 位或更高版本'],
]

export function createClientRelease({ version, feed, artifacts }) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid website catalog version')
  if (!['https://sep.longdaoec.com/sep-client/stable/', 'https://sep.longdaoec.com/sep-client/beta/'].includes(feed)) throw new Error('Invalid website catalog feed')
  return { version, artifacts: platforms.map(([platform, suffix, label, architecture, minimumOsVersion]) => {
    const fileName = `SEP-Client-${version}-${suffix}`
    const url = `${feed}${version}/${fileName}`
    const matches = artifacts.filter(item => item.name === fileName)
    if (matches.length !== 1 || matches[0].destination !== `${version}/${fileName}` || matches[0].url !== url) throw new Error('Website catalog installer is missing or differs from verified plan')
    return { platform, label, fileName, url, architecture, minimumOsVersion }
  }) }
}

export function parseClientRelease(bytes, plan) {
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Website catalog exceeds maximum size')
  let value
  try { value = JSON.parse(bytes.toString()) } catch { throw new Error('Invalid website catalog JSON') }
  if (!isDeepStrictEqual(value, createClientRelease(plan))) throw new Error('Website catalog differs from verified release plan')
  return value
}

export async function readClientRelease(directory, plan) {
  const file = join(directory, CLIENT_RELEASE_NAME)
  const info = await lstat(file)
  if (!info.isFile() || info.size <= 0 || info.size > MAX_BYTES) throw new Error('Unsafe or oversized website catalog')
  return parseClientRelease(await readFile(file), plan)
}
