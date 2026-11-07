import { execFile } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const MANIFESTS = ['latest.yml', 'latest-mac.yml']

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function shellQuote(value) {
  requireValue(typeof value === 'string' && value.length > 0 && !value.includes('\0'), 'invalid remote path')
  return `'${value.replaceAll("'", "'\\''")}'`
}

function flatName(value) {
  requireValue(typeof value === 'string' && value === basename(value) && value.length > 0 && !/[\\/\0]/.test(value), 'release file name must be flat')
  return value
}

function requiredEnv(env, name) {
  const value = env[name]
  requireValue(typeof value === 'string' && value.trim() === value && value.length > 0, `${name} is required`)
  return value
}

function decodePrivateKey(env) {
  const encoded = requiredEnv(env, 'SEP_UPLOAD_SSH_KEY_BASE64')
  requireValue(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'SEP_UPLOAD_SSH_KEY_BASE64 is not valid base64')
  const bytes = Buffer.from(encoded, 'base64')
  requireValue(bytes.toString('base64') === encoded, 'SEP_UPLOAD_SSH_KEY_BASE64 is not valid base64')
  const decoded = bytes.toString('utf8')
  requireValue(decoded.includes('BEGIN OPENSSH PRIVATE KEY') || decoded.includes('BEGIN RSA PRIVATE KEY'), 'SEP_UPLOAD_SSH_KEY_BASE64 does not contain a supported private key')
  return decoded
}

async function command(command, args, options = {}) {
  try {
    return await execute(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options })
  } catch (error) {
    const detail = [error?.stderr, error?.stdout]
      .filter(value => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .replaceAll(/\s+/g, ' ')
      .trim()
    const status = Number.isInteger(error?.code) ? ` (exit ${error.code})` : error?.signal ? ` (signal ${error.signal})` : ''
    throw new Error(`${command} failed${status}${detail ? `: ${detail.slice(-500)}` : ''}`)
  }
}

async function localFile(root, name) {
  const file = resolve(root, flatName(name))
  const metadata = await lstat(file)
  requireValue(metadata.isFile() && metadata.size > 0, `release file is missing, symlinked or empty: ${name}`)
  return { file, size: metadata.size }
}

function sshConfig(context) {
  return [
    `HostName ${context.host}`,
    `User ${context.user}`,
    `Port ${context.port}`,
    `IdentityFile ${context.key}`,
    'IdentitiesOnly yes',
    'BatchMode yes',
    'StrictHostKeyChecking yes',
    `UserKnownHostsFile ${context.knownHosts}`,
    'LogLevel ERROR',
  ].join('\n') + '\n'
}

async function ssh(context, script, phase) {
  try {
    return await command('ssh', ['-F', context.config, 'sep-upload', `bash -c ${shellQuote(script)}`])
  } catch (error) {
    throw new Error(`${phase}: ${error.message}`)
  }
}

function rsyncArguments(context, source, destination) {
  return ['--archive', '--checksum', '--protect-args', '-e', `ssh -F ${shellQuote(context.config)}`, source, `sep-upload:${destination}`]
}

async function rsync(context, source, destination, phase) {
  try {
    return await command('rsync', rsyncArguments(context, source, destination))
  } catch (error) {
    throw new Error(`${phase}: ${error.message}`)
  }
}

async function upload({ source, prepared, channel, env = process.env }) {
  requireValue(channel === 'stable', 'only the stable channel is publishable')
  const planPath = resolve(prepared, 'upload-plan.json')
  const plan = JSON.parse(await readFile(planPath, 'utf8'))
  requireValue(plan.schemaVersion === 1 && plan.channel === channel && typeof plan.version === 'string', 'upload plan identity is invalid')
  requireValue(Array.isArray(plan.artifacts) && plan.artifacts.length === 10, 'upload plan must contain the complete three-platform artifact set')
  const artifacts = plan.artifacts.map(item => ({ ...item, name: flatName(item.name) }))
  for (const item of artifacts) {
    requireValue(Number.isSafeInteger(item.size) && item.size > 0 && /^[a-f0-9]{64}$/.test(item.sha256), `upload plan hash or size is invalid: ${item.name}`)
    const local = await localFile(source, item.name)
    requireValue(local.size === item.size, `local artifact size does not match upload plan: ${item.name}`)
  }
  for (const name of MANIFESTS) await localFile(prepared, name)

  const temp = await mkdtemp(join(tmpdir(), 'sep-client-upload-'))
  const key = join(temp, 'id_ed25519')
  const knownHosts = join(temp, 'known_hosts')
  const config = join(temp, 'ssh_config')
  const context = {
    host: requiredEnv(env, 'SEP_UPLOAD_HOST'),
    user: requiredEnv(env, 'SEP_UPLOAD_USER'),
    root: requiredEnv(env, 'SEP_UPLOAD_ROOT').replace(/\/+$/, ''),
    port: env.SEP_UPLOAD_PORT || '22',
    key,
    knownHosts,
    config,
  }
  requireValue(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(context.host), 'SEP_UPLOAD_HOST contains invalid characters')
  requireValue(/^[A-Za-z_][A-Za-z0-9._-]*$/.test(context.user), 'SEP_UPLOAD_USER contains invalid characters')
  requireValue(context.root.startsWith('/') && context.root !== '/', 'SEP_UPLOAD_ROOT must be a non-root absolute path')
  requireValue(/^\d+$/.test(context.port) && Number(context.port) >= 1 && Number(context.port) <= 65535, 'SEP_UPLOAD_PORT must be between 1 and 65535')
  const runId = (env.GITHUB_RUN_ID || `${Date.now()}`).replace(/[^A-Za-z0-9_.-]/g, '-')
  const staging = `${context.root}/.sep-client-staging-${plan.version}-${runId}`
  const versionRoot = `${context.root}/${plan.version}`
  const manifestStaging = `${context.root}/.sep-client-manifests-${plan.version}-${runId}`
  try {
    await writeFile(key, decodePrivateKey(env), { mode: 0o600 })
    await writeFile(knownHosts, requiredEnv(env, 'SEP_UPLOAD_KNOWN_HOSTS'), { mode: 0o600 })
    await writeFile(config, `Host sep-upload\n${sshConfig(context)}`, { mode: 0o600 })
    await chmod(key, 0o600)
    await chmod(knownHosts, 0o600)
    await chmod(config, 0o600)
    await ssh(context, `set -eu; test -d ${shellQuote(context.root)}; test ! -e ${shellQuote(versionRoot)}; mkdir ${shellQuote(staging)} ${shellQuote(manifestStaging)}`, 'SSH preflight (remote directory check and staging creation)')
    for (const item of artifacts) await rsync(context, (await localFile(source, item.name)).file, `${staging}/${item.name}`, `artifact upload (${item.name})`)
    const remoteChecks = artifacts.map(item => `printf '%s  %s\\n' ${shellQuote(item.sha256)} ${shellQuote(`${staging}/${item.name}`)} | sha256sum -c -`)
    await ssh(context, `set -eu; ${remoteChecks.join('; ')}; mv ${shellQuote(staging)} ${shellQuote(versionRoot)}`, 'remote artifact checksum verification and version directory publish')
    for (const name of MANIFESTS) await rsync(context, (await localFile(prepared, name)).file, `${manifestStaging}/${name}`, `update manifest upload (${name})`)
    const backup = `${context.root}/.sep-client-backup-${plan.version}-${runId}`
    const publish = [
      'set -eu',
      `root=${shellQuote(context.root)}`,
      `stage=${shellQuote(manifestStaging)}`,
      `backup=${shellQuote(backup)}`,
      'mkdir "$backup"',
      'restore() { status=$?; if [ "$status" -ne 0 ]; then for name in latest.yml latest-mac.yml; do rm -f -- "$root/$name"; if [ -e "$backup/$name" ]; then mv -- "$backup/$name" "$root/$name"; fi; done; fi; rm -rf -- "$stage" "$backup"; exit "$status"; }',
      'trap restore EXIT',
      'for name in latest.yml latest-mac.yml; do if [ -e "$root/$name" ]; then mv -- "$root/$name" "$backup/$name"; fi; done',
      'mv -- "$stage/latest.yml" "$root/latest.yml"',
      'mv -- "$stage/latest-mac.yml" "$root/latest-mac.yml"',
      'trap - EXIT',
      'rm -rf -- "$stage" "$backup"',
    ].join('; ')
    await ssh(context, publish, 'update manifest publication')
    return { channel, version: plan.version, artifacts: artifacts.length, remote: `${context.host}:${versionRoot}` }
  } catch (error) {
    try { await ssh(context, `rm -rf -- ${shellQuote(staging)} ${shellQuote(manifestStaging)}`, 'temporary upload cleanup') } catch { /* cleanup is best effort after the primary failure */ }
    throw error
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

async function preflight({ version, env = process.env }) {
  requireValue(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version), 'preflight requires a stable release version')
  const context = {
    host: requiredEnv(env, 'SEP_UPLOAD_HOST'),
    user: requiredEnv(env, 'SEP_UPLOAD_USER'),
    root: requiredEnv(env, 'SEP_UPLOAD_ROOT').replace(/\/+$/, ''),
    port: env.SEP_UPLOAD_PORT || '22',
  }
  requireValue(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(context.host), 'SEP_UPLOAD_HOST contains invalid characters')
  requireValue(/^[A-Za-z_][A-Za-z0-9._-]*$/.test(context.user), 'SEP_UPLOAD_USER contains invalid characters')
  requireValue(context.root.startsWith('/') && context.root !== '/', 'SEP_UPLOAD_ROOT must be a non-root absolute path')
  requireValue(/^\d+$/.test(context.port) && Number(context.port) >= 1 && Number(context.port) <= 65535, 'SEP_UPLOAD_PORT must be between 1 and 65535')

  const temp = await mkdtemp(join(tmpdir(), 'sep-client-ssh-preflight-'))
  const key = join(temp, 'id_ed25519')
  const knownHosts = join(temp, 'known_hosts')
  const config = join(temp, 'ssh_config')
  Object.assign(context, { key, knownHosts, config })
  try {
    await writeFile(key, decodePrivateKey(env), { mode: 0o600 })
    await writeFile(knownHosts, requiredEnv(env, 'SEP_UPLOAD_KNOWN_HOSTS'), { mode: 0o600 })
    await writeFile(config, `Host sep-upload\n${sshConfig(context)}`, { mode: 0o600 })
    await chmod(key, 0o600)
    await chmod(knownHosts, 0o600)
    await chmod(config, 0o600)
    const identity = await command('ssh-keygen', ['-lf', key])
    console.log(`SSH identity loaded: ${identity.stdout.trim()}`)
    const remoteCheck = `set -eu; test -d ${shellQuote(context.root)}; test ! -e ${shellQuote(`${context.root}/${version}`)}; printf 'remote directory and version slot are ready\\n'`
    await command('ssh', ['-F', config, 'sep-upload', `bash -c ${shellQuote(remoteCheck)}`])
    console.log(`SSH preflight passed for ${context.user}@${context.host}:${context.root}, version ${version}`)
  } catch (error) {
    throw new Error(`SSH preflight failed: ${error.message}`)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

export function parseArguments(args = process.argv.slice(2)) {
  requireValue(args.length === 3 && args.every(value => typeof value === 'string' && value.length > 0 && !value.startsWith('--')), 'usage: node scripts/upload-download-update.mjs <source-dir> <prepared-dir> <stable>')
  requireValue(args[2] === 'stable', 'usage: node scripts/upload-download-update.mjs <source-dir> <prepared-dir> <stable>')
  return { source: args[0], prepared: args[1], channel: args[2] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--preflight' && process.argv.length === 4) {
      await preflight({ version: process.argv[3] })
    } else {
      const result = await upload(parseArguments())
      console.log(`uploaded ${result.artifacts} client artifacts for ${result.channel} ${result.version}; manifests published last`)
    }
  } catch (error) {
    console.error(`client download upload failed: ${error.message}`)
    process.exitCode = 1
  }
}

export { upload, preflight, shellQuote, sshConfig, rsyncArguments, decodePrivateKey }
