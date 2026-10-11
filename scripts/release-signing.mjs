import { spawnSync } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

function required(env, name) {
  const value = env[name]
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error(`${name} must be explicitly configured without surrounding whitespace or control characters`)
  }
  return value
}

function password(env, name) {
  if (typeof env[name] !== 'string') throw new Error(`${name} must be explicitly configured (an empty password is allowed)`)
}

function notarizationMethod(env) {
  // Match builder 25.1.8 precedence so a partial higher-priority group cannot silently fall back.
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) {
    for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) required(env, key)
    if (env.APPLE_TEAM_ID !== env.SEP_MAC_TEAM_ID) throw new Error('APPLE_TEAM_ID must match SEP_MAC_TEAM_ID')
    return 'apple-id'
  }
  if (env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER) {
    for (const key of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) required(env, key)
    return 'api-key'
  }
  required(env, 'APPLE_KEYCHAIN_PROFILE')
  return 'keychain-profile'
}

export function signingConfiguration(env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    const team = required(env, 'SEP_MAC_TEAM_ID')
    if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('SEP_MAC_TEAM_ID must be a 10-character Apple team ID')
    notarizationMethod(env)
    if (env.CSC_LINK) password(env, 'CSC_KEY_PASSWORD')
    if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') throw new Error('CSC_IDENTITY_AUTO_DISCOVERY=false is not allowed for signed releases')
    return {
      forceCodeSigning: true,
      mac: {
        type: 'distribution',
        identity: team,
        hardenedRuntime: true,
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.plist',
        notarize: true,
      },
      dmg: { sign: true },
    }
  }
  if (platform === 'win32') {
    const publisherName = required(env, 'SEP_WINDOWS_PUBLISHER')
    const link = env.WIN_CSC_LINK || env.CSC_LINK
    const thumbprint = env.SEP_WINDOWS_CERTIFICATE_SHA1
    if (Boolean(link) === Boolean(thumbprint)) throw new Error('configure exactly one Windows certificate source: WIN_CSC_LINK/CSC_LINK or SEP_WINDOWS_CERTIFICATE_SHA1')
    if (link) password(env, env.WIN_CSC_KEY_PASSWORD !== undefined ? 'WIN_CSC_KEY_PASSWORD' : 'CSC_KEY_PASSWORD')
    if (thumbprint && !/^[a-fA-F0-9]{40}$/.test(thumbprint)) throw new Error('SEP_WINDOWS_CERTIFICATE_SHA1 must be a 40-character certificate thumbprint')
    return {
      forceCodeSigning: true,
      win: {
        target: [{ target: 'nsis', arch: ['x64'] }],
        signAndEditExecutable: true,
        verifyUpdateCodeSignature: true,
        signtoolOptions: {
          publisherName,
          signingHashAlgorithms: ['sha256'],
          ...(thumbprint ? { certificateSha1: thumbprint.toUpperCase() } : {}),
        },
      },
    }
  }
  throw new Error('signed releases must be built on native macOS or Windows; Linux remains a manual local package')
}

export function runSigningCommand(command, args, env) {
  return spawnSync(command, args, { env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
}

function checked(run, command, args, env, message) {
  let result
  try { result = run(command, args, env) } catch { throw new Error(message) }
  if (result.status !== 0 || result.error) throw new Error(message)
  return result.stdout || ''
}

function readable(path, name, read) {
  try { read(path, constants.R_OK) } catch { throw new Error(`${name} must refer to a readable local file`) }
}

function certificateFile(link, name, read) {
  if (!link) return
  if (link.startsWith('file:')) {
    let path
    try { path = fileURLToPath(link) } catch { throw new Error(`${name} contains an invalid file URL`) }
    readable(path, name, read)
  } else if (!link.startsWith('https://') && (/^(?:[A-Za-z]:[\\/]|\.?\.?[\\/]|\/)/.test(link) || /\.(?:p12|pfx)$/i.test(link))) {
    readable(link, name, read)
  }
  // Builder also accepts base64 and HTTPS certificate links; it resolves those during signing.
}

export function preflightSigning({ env = process.env, platform = process.platform, arch = process.arch, run = runSigningCommand, read = accessSync } = {}) {
  const config = signingConfiguration(env, platform)
  if (platform === 'win32' && arch !== 'x64') throw new Error('Windows signed releases require an x64 build host')
  if (platform === 'darwin' && !['arm64', 'x64'].includes(arch)) throw new Error('unsupported macOS release host architecture')
  for (const key of ['TRAVIS_PULL_REQUEST', 'CIRCLE_PULL_REQUEST', 'BITRISE_PULL_REQUEST', 'APPVEYOR_PULL_REQUEST_NUMBER', 'GITHUB_BASE_REF']) {
    if (env[key] && env[key] !== 'false') throw new Error('release signing is not allowed in pull-request builds')
  }
  if (['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME)) throw new Error('release signing is not allowed in pull-request builds')
  if (platform === 'darwin') {
    checked(run, 'xcrun', ['--find', 'notarytool'], env, 'notarytool is required; install the Xcode command-line tools')
    const method = notarizationMethod(env)
    if (method === 'api-key') readable(env.APPLE_API_KEY, 'APPLE_API_KEY', read)
    if (env.CSC_LINK) certificateFile(env.CSC_LINK, 'CSC_LINK', read)
    else {
      const identities = checked(run, 'security', ['find-identity', '-v', '-p', 'codesigning'], env, 'cannot inspect macOS signing identities')
      if (!identities.split('\n').some(line => line.includes('Developer ID Application:') && line.includes(`(${env.SEP_MAC_TEAM_ID})`) && !line.includes('CSSMERR_'))) {
        throw new Error('no valid Developer ID Application identity for SEP_MAC_TEAM_ID; install a private-key identity or configure CSC_LINK')
      }
    }
  } else {
    const thumbprint = env.SEP_WINDOWS_CERTIFICATE_SHA1
    if (thumbprint) {
      const script = "$ErrorActionPreference = 'Stop'; $cert = @(Get-ChildItem -Recurse Cert: -CodeSigningCert | Where-Object { $_.Thumbprint -eq $env:SEP_WINDOWS_CERTIFICATE_SHA1 -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) -and $_.NotBefore -le (Get-Date) }); if ($cert.Count -ne 1) { exit 1 }"
      checked(run, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], env, 'Windows certificate store must contain one current code-signing identity with the requested thumbprint and private key')
    } else {
      certificateFile(env.WIN_CSC_LINK || env.CSC_LINK, env.WIN_CSC_LINK ? 'WIN_CSC_LINK' : 'CSC_LINK', read)
    }
  }
  return config
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('usage: node scripts/release-signing.mjs')
    preflightSigning()
    console.log(`signing preflight passed for ${process.platform}/${process.arch}; certificate authentication is verified by the actual build`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
