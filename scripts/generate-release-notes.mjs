import { constants, realpathSync } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'

export const MAX_CHANGES_BYTES = 64 * 1024
class ReleaseNotesError extends Error {}

function requireChannel(channel) {
  if (!['beta', 'stable'].includes(channel)) throw new ReleaseNotesError('channel must be beta or stable')
  return channel
}

function requireChanges(changes) {
  if (typeof changes !== 'string' || Buffer.byteLength(changes, 'utf8') > MAX_CHANGES_BYTES) {
    throw new ReleaseNotesError('changes must be UTF-8 plain text of at most 64 KiB without binary/control characters')
  }
  for (const char of changes) {
    const code = char.charCodeAt(0)
    if ((code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159)) {
      throw new ReleaseNotesError('changes must be UTF-8 plain text without binary/control characters')
    }
  }
  return changes
}

export function parseReleaseNotesArguments(args, env = {}) {
  const positional = []
  let changesFile
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--changes-file') {
      const value = args[++index]
      if (changesFile !== undefined || !value || value.startsWith('-')) throw new ReleaseNotesError('usage: node scripts/generate-release-notes.mjs [beta|stable] [outputDir] [--changes-file <file>]')
      changesFile = value
    } else if (!arg || arg.startsWith('-') || positional.length >= 2) {
      throw new ReleaseNotesError('usage: node scripts/generate-release-notes.mjs [beta|stable] [outputDir] [--changes-file <file>]')
    } else {
      positional.push(arg)
    }
  }
  const explicitChannel = positional[0]
  if (explicitChannel !== undefined) requireChannel(explicitChannel)
  if (env.SEP_RELEASE_CHANNEL !== undefined) requireChannel(env.SEP_RELEASE_CHANNEL)
  if (explicitChannel && env.SEP_RELEASE_CHANNEL && explicitChannel !== env.SEP_RELEASE_CHANNEL) {
    throw new ReleaseNotesError('SEP_RELEASE_CHANNEL conflicts with the explicit channel')
  }
  return { channel: explicitChannel ?? env.SEP_RELEASE_CHANNEL ?? 'beta', outputDir: positional[1] ?? 'dist', changesFile }
}

export function createReleaseNotes({ version, channel = 'beta', environment = channel === 'stable' ? 'production' : 'integration', generatedAt, changes = '' } = {}) {
  requireChannel(channel)
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ReleaseNotesError('package version must be a release version string')
  }
  if (typeof environment !== 'string' || environment.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(environment)) {
    throw new ReleaseNotesError('release environment must be a short single-line identifier')
  }
  if (typeof generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(generatedAt) || !Number.isFinite(Date.parse(generatedAt))) {
    throw new ReleaseNotesError('notes generation time must be an ISO timestamp')
  }
  requireChanges(changes)
  const changeSection = changes.trim() ? `${changes}${changes.endsWith('\n') ? '' : '\n'}` : '尚未提供变更清单。\n'
  return `# SEP Client ${version} (${channel})\n\n- 配置环境：${environment}（未核验运行时配置）\n- 说明生成时间：${generatedAt}\n- 产物、代码签名、公证、上传和发布状态：本脚本未验证，请以独立校验结果及发布记录为准。\n\n## 变更清单\n\n${changeSection}\n变更清单由提供方维护，本脚本未核验内容。\n`
}

async function readChangesFile(file) {
  // Bound the read itself, including a file that grows after stat; reject non-files.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_CHANGES_BYTES) throw new ReleaseNotesError('changes file must be a regular file of at most 64 KiB')
    const buffer = Buffer.alloc(MAX_CHANGES_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > MAX_CHANGES_BYTES) throw new ReleaseNotesError('changes file exceeds 64 KiB')
    let changes
    try {
      changes = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))
    } catch {
      throw new ReleaseNotesError('changes file must contain valid UTF-8 text')
    }
    return requireChanges(changes)
  } finally {
    await handle.close()
  }
}

async function main(args, env) {
  const { channel, outputDir, changesFile } = parseReleaseNotesArguments(args, env)
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const changes = changesFile === undefined ? '' : await readChangesFile(changesFile)
  const notes = createReleaseNotes({ version: pkg?.version, channel, environment: env.SEP_RELEASE_ENVIRONMENT, generatedAt: new Date().toISOString(), changes })
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, `RELEASE-NOTES-${channel}.md`), notes, 'utf8')
  console.log(`release notes generated for ${channel}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2), process.env)
  } catch (error) {
    console.error(error instanceof ReleaseNotesError ? error.message : 'cannot read release inputs or write release notes')
    process.exitCode = 1
  }
}
