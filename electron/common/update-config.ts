/** 更新源由 electron-builder 写入 app-update.yml，运行时不根据登录或业务环境切换。 */
export const UPDATE_STARTUP_DELAY_MS = 3_000
export const UPDATE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const

/** Download hosts are build policy, never a renderer-provided URL or protocol. */
export function externalUpdateDownloadUrl(channel: 'beta' | 'stable', version: string, platform: string, arch: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!['beta', 'stable'].includes(channel) || version.length > 100 || !match || match[0] !== version ||
    (match[4] && match[4].split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) ||
    !supportsAppUpdates(true, platform, arch)) {
    throw new Error('Unsupported update download')
  }
  const artifact = platform === 'darwin' ? 'mac-' + arch + '.dmg' : 'win-x64.exe'
  return 'https://download.longdaosep.cn/sep-client/' + channel + '/' + version + '/SEP-Client-' + version + '-' + artifact
}

export function supportsAppUpdates(isPackaged: boolean, platform: string, arch: string): boolean {
  return isPackaged && (
    (platform === 'win32' && arch === 'x64') ||
    (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
  )
}
