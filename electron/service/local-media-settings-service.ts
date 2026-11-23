import { lstat, mkdir, mkdtemp, realpath, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalMediaSettings } from '../../src/shared/local-media-settings'
import type { LocalMediaSettingsStore } from '../data/local-media-settings-store'
import { localMediaTarget } from '../domain/local-media-platform'
import { appError } from '../errors/app-error'

export class LocalMediaSettingsService {
  constructor(private readonly store: LocalMediaSettingsStore, private readonly defaultPath: string,
    readonly supported = localMediaTarget(process.platform, process.arch) !== undefined) {}

  async settings(): Promise<LocalMediaSettings> {
    const custom = this.supported ? await this.store.read() : null
    return { supported: this.supported, path: custom ?? this.defaultPath, defaultPath: this.defaultPath, custom: custom !== null }
  }

  async configure(path: string | null, assertActive: () => void): Promise<LocalMediaSettings> {
    if (!this.supported) throw appError('INVALID_STATE')
    if (path !== null) {
      try {
        path = await realpath(path)
        const probe = await mkdtemp(join(await localDirectory(path), '.csep-write-'))
        await rmdir(probe)
      } catch (cause) {
        throw appError('INVALID_ARGUMENT', { message: '所选目录不可写或不可用，请选择其他本地文件夹。', cause })
      }
    }
    await this.store.write(path, assertActive)
    return { supported: true, path: path ?? this.defaultPath, defaultPath: this.defaultPath, custom: path !== null }
  }

  async prepare(): Promise<string> {
    const setting = await this.settings()
    if (!setting.supported) throw appError('INVALID_STATE')
    try {
      if (!setting.custom) await mkdir(setting.path, { recursive: true })
      const actual = await localDirectory(await realpath(setting.path))
      if (setting.custom && actual !== setting.path) throw new Error('The selected directory has moved.')
      return actual
    } catch (cause) {
      throw appError('INVALID_STATE', { message: '音视频临时目录不可用，请在设置中更改位置后重试。', cause })
    }
  }
}

async function localDirectory(path: string): Promise<string> {
  if (process.platform === 'win32' && !/^[a-z]:\\/i.test(path)) throw new Error('A local drive path is required.')
  if (!(await lstat(path)).isDirectory()) throw new Error('Not a directory.')
  return path
}
