/**
 * electron/data/atomic-file.ts — 唯一的原子写实现
 *
 * 此前有三套（方案 1.3 节 / 第 6 章）：`task-store` 的 tmp + `.bak` + 回滚 + `quarantine`、
 * `task-run-store` 的 tmp + rename、`workflow-store` 的 tmp + rename 什么都不做。
 * 行为细节不一致，而"哪个 store 值得保护"从来不是一个应该由文件大小决定的问题。
 *
 * 按方案要求，**`task-store` 的语义成为默认**：写之前把现有文件复制成 `.bak`，
 * 写失败时用它回滚；读不出来时先试 `.bak`，再把损坏文件隔离到
 * `<file>.corrupt-<kind>-<时间戳>-<uuid>.json`。
 *
 * 目录布局是硬约束（第 11 章），所以这里只多出 `.bak` 兄弟文件，数据文件本身的
 * 路径与格式一个字符都没动。`.bak` 与 `.corrupt-*` 都不会被 run 列表扫到：
 * 前者不以 `.json` 结尾，后者的 runId 段含点号，过不了 `SAFE_ID`。
 */
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 持久化文件一律 0600：userData 目录之外不该有人读得到。 */
const FILE_MODE = 0o600

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export function backupPath(file: string): string {
  return `${file}.bak`
}

export interface AtomicWriteOptions {
  /**
   * 写入前把现有文件复制成 `.bak`，写失败时用它回滚。默认开启。
   * 只有"丢了也无所谓、且写入极频繁"的文件才该关掉它。
   */
  backup?: boolean
}

/**
 * 原子写一个 JSON 文件：写临时文件 → 备份现有文件 → rename 覆盖。
 * rename 在同一文件系统内是原子的，所以任何时刻读到的都是完整的旧版或新版。
 */
export async function writeJsonAtomic(
  file: string,
  value: unknown,
  { backup = true }: AtomicWriteOptions = {},
): Promise<void> {
  const temporaryFile = `${file}.${randomUUID()}.tmp`
  const backupFile = backupPath(file)
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporaryFile, JSON.stringify(value), { encoding: 'utf8', mode: FILE_MODE })
    try {
      await chmod(temporaryFile, FILE_MODE)
    } catch {
      // 不支持 chmod 的文件系统上，操作系统用户数据目录仍是主要隔离边界。
    }
    if (backup && await pathExists(file)) {
      await copyFile(file, backupFile)
      // Windows 上 rename 覆盖已存在的文件会失败，所以先删。
      await rm(file, { force: true })
    }
    await rename(temporaryFile, file)
  } catch (error) {
    try {
      await rm(temporaryFile, { force: true })
      // 回滚：目标文件已经没了而备份还在，就把备份放回去。
      if (backup && !await pathExists(file) && await pathExists(backupFile)) {
        await copyFile(backupFile, file)
      }
    } catch {
      // 保留原始持久化错误，回滚失败不该盖掉它。
    }
    throw error
  }
}

/** 读 JSON。文件不存在、读失败、或不是合法 JSON 都返回 null。 */
export async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

/**
 * 把损坏的文件挪到一边，让应用能以空数据继续启动，同时保留现场供排查。
 * 隔离失败也不抛：一个读不出来的文件不该阻止应用加载。
 */
export async function quarantineFile(file: string, kind: string): Promise<void> {
  if (!await pathExists(file)) return
  try {
    await rename(file, `${file}.corrupt-${kind}-${Date.now()}-${randomUUID()}.json`)
  } catch {
    // 损坏的文件不能阻止应用加载空的数据范围。
  }
}

/**
 * 带 `.bak` 回退与隔离的读取。`parse` 返回 null 表示"内容不可信"，与读不出来同等对待。
 *
 * 顺序是：主文件 → `.bak` → 把 `.bak` 复制回主文件 → 都不行就隔离并返回 null。
 * 这是 `task-store` 原有的语义，现在是唯一实现。
 */
export async function readJsonWithBackup<T>(
  file: string,
  parse: (value: unknown) => T | null,
): Promise<T | null> {
  const backupFile = backupPath(file)

  if (!await pathExists(file)) {
    if (!await pathExists(backupFile)) return null
    const recovered = parse(await readJsonFile(backupFile) as never)
    if (recovered) return recovered
    await quarantineFile(backupFile, 'backup')
    return null
  }

  const primary = parse(await readJsonFile(file) as never)
  if (primary) return primary

  const recovered = await pathExists(backupFile)
    ? parse(await readJsonFile(backupFile) as never)
    : null
  if (recovered) {
    try {
      await copyFile(backupFile, file)
    } catch {
      // 保留备份文件，供下一次加载时使用。
    }
    return recovered
  }

  await quarantineFile(file, 'store')
  return null
}
