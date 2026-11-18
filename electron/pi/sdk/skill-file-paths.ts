import { posix, win32 } from 'node:path'
import { AppError } from '../../errors/app-error'

/** Check both final and staging paths before inflating or writing package entries. */
export function assertSkillFilePaths(roots: readonly string[], paths: readonly string[], platform: NodeJS.Platform = process.platform): void {
  const windows = platform === 'win32'
  const pathApi = windows ? win32 : posix
  const lengthOf = (value: string): number => windows ? value.length : Buffer.byteLength(value, 'utf8')
  const pathLimit = windows ? 32760 : platform === 'darwin' ? 1023 : 4095
  let longest = { path: '', length: 0 }
  for (const root of roots) {
    for (const relativePath of paths) {
      const fullPath = pathApi.resolve(root, relativePath)
      const components = fullPath.slice(pathApi.parse(fullPath).root.length).split(pathApi.sep)
      const componentLength = Math.max(0, ...components.map(lengthOf))
      const pathLength = lengthOf(windows ? win32.toNamespacedPath(fullPath) : fullPath)
      if (componentLength > 255) {
        throw new AppError('SKILL_PATH_UNSUPPORTED', {
          message: `技能文件或文件夹名称长度为 ${componentLength}，超过系统支持的 255 上限。请缩短名称，或联系管理员调整缓存位置。`,
          details: { platform, relativePath, componentLength, componentLimit: 255 },
        })
      }
      if (pathLength > longest.length) longest = { path: relativePath, length: pathLength }
    }
  }
  if (longest.length > pathLimit) {
    throw new AppError('SKILL_PATH_UNSUPPORTED', {
      message: `技能完整路径长度为 ${longest.length}，超过系统支持的 ${pathLimit} 上限。请减少技能包内的目录层级，或联系管理员调整缓存位置。`,
      details: { platform, relativePath: longest.path, pathLength: longest.length, pathLimit },
    })
  }
}
