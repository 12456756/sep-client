import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import semver from 'semver'

class ReleaseVersionError extends Error {}

function requireVersion(value) {
  const parsed = typeof value === 'string' ? semver.parse(value) : null
  const canonical = parsed && `${parsed.version}${parsed.build.length ? `+${parsed.build.join('.')}` : ''}`
  if (!parsed || canonical !== value) throw new ReleaseVersionError('versions must be canonical SemVer')
  return value
}

export function createReleaseVersionPlan({ packageJson, packageLock, targetVersion } = {}) {
  const currentVersion = requireVersion(packageJson?.version)
  requireVersion(targetVersion)
  if (packageLock?.version !== currentVersion || packageLock?.packages?.['']?.version !== currentVersion) {
    throw new ReleaseVersionError('package and lockfile root versions must match')
  }
  if (!semver.gt(targetVersion, currentVersion)) throw new ReleaseVersionError('target version must be strictly greater by SemVer precedence')
  return {
    dryRun: true,
    currentVersion,
    targetVersion,
    changes: [
      { file: 'package.json', field: 'version', from: currentVersion, to: targetVersion },
      { file: 'package-lock.json', field: 'version', from: currentVersion, to: targetVersion },
      { file: 'package-lock.json', field: 'packages[""].version', from: currentVersion, to: targetVersion },
    ],
  }
}

async function main(args) {
  if (args.length !== 1 || args[0].startsWith('-')) {
    throw new ReleaseVersionError('usage: node scripts/release-version.mjs <target-version> (dry-run only)')
  }
  const [packageJson, packageLock] = await Promise.all(
    ['package.json', 'package-lock.json'].map(async file => JSON.parse(await readFile(file, 'utf8'))),
  )
  const plan = createReleaseVersionPlan({ packageJson, packageLock, targetVersion: args[0] })
  console.log(JSON.stringify(plan, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof ReleaseVersionError ? error.message : 'cannot read or validate release version manifests')
    process.exitCode = 1
  }
}
