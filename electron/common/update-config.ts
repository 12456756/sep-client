/** 更新源由 electron-builder 写入 app-update.yml，运行时不根据登录或业务环境切换。 */
export const UPDATE_STARTUP_DELAY_MS = 3_000
export const UPDATE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const

export function supportsAppUpdates(isPackaged: boolean, platform: string, arch: string): boolean {
  return isPackaged && (
    (platform === 'win32' && arch === 'x64') ||
    (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
  )
}
