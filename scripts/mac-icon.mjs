import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { executeAppBuilderAsJson, executeAppBuilderAndWriteJson } from 'app-builder-lib/out/util/appBuilder.js'

const execute = promisify(execFile)
const iconName = 'mac-icon'

async function requireFile(file, label) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size === 0) throw new Error(`Missing or empty ${label}`)
}

/** Compile before signing; retain the existing ICNS as the older macOS fallback. */
export async function afterMacIconPack(context, { runner = execute } = {}) {
  if (context.electronPlatformName !== 'darwin') return
  const source = join(context.packager.projectDir, 'build', `${iconName}.icon`)
  await requireFile(join(source, 'icon.json'), 'Mac icon source')
  const contents = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
  const resources = join(contents, 'Resources')
  const plistFile = join(contents, 'Info.plist')
  const [plist] = await executeAppBuilderAsJson(['decode-plist', '-f', plistFile])
  const legacy = plist?.CFBundleIconFile
  if (typeof legacy !== 'string' || basename(legacy) !== legacy || !legacy.endsWith('.icns')) {
    throw new Error('Missing or invalid legacy icon reference')
  }
  await requireFile(join(resources, legacy), 'legacy icon')
  const destination = join(resources, 'Assets.car')
  if (await access(destination).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error
    return false
  })) throw new Error('Refusing to replace an existing Mac asset catalog')

  const temporary = await mkdtemp(join(tmpdir(), 'sep-mac-icon-'))
  try {
    const partial = join(temporary, 'icon-info.plist')
    try {
      await runner('/usr/bin/xcrun', ['actool', source,
        '--compile', temporary, '--output-format', 'human-readable-text',
        '--output-partial-info-plist', partial, '--app-icon', iconName,
        '--include-all-app-icons', '--enable-on-demand-resources', 'NO',
        '--platform', 'macosx', '--minimum-deployment-target', '11.0', '--target-device', 'mac',
      ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false })
    } catch (error) {
      throw new Error('Mac icon compilation failed. Select Xcode 26 or newer before packaging.', { cause: error })
    }
    const catalog = join(temporary, 'Assets.car')
    await requireFile(catalog, 'compiled Mac icon asset catalog')
    await requireFile(partial, 'compiled Mac icon metadata')
    const [compiled] = await executeAppBuilderAsJson(['decode-plist', '-f', partial])
    if (compiled?.CFBundleIconName !== iconName) throw new Error('Compiled Mac icon name does not match the asset catalog')

    await copyFile(catalog, destination, constants.COPYFILE_EXCL)
    await executeAppBuilderAndWriteJson(['encode-plist'], {
      [plistFile]: { ...plist, CFBundleIconName: iconName },
    })
    console.log(`Embedded layered Mac icon: ${iconName}; legacy fallback: ${legacy}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
