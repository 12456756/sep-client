import { safeStorage, app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'

// 非敏感元数据（用户名、enterpriseId 等）存 JSON 明文
// 敏感凭据（refresh token）走 safeStorage OS 级加密，不落渲染进程
export interface AuthMeta {
  memberId: string
  enterpriseId: string
  displayName: string
  enterpriseName: string
}

const AUTH_DIR = join(app.getPath('userData'), 'auth')
const RT_FILE = join(AUTH_DIR, 'rt.enc')
const META_FILE = join(AUTH_DIR, 'meta.json')

function ensureDir() {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true })
}

// ── Refresh Token ─────────────────────────────────────────────

export function saveRefreshToken(token: string): void {
  ensureDir()
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS safeStorage not available — cannot persist credentials')
  }
  writeFileSync(RT_FILE, safeStorage.encryptString(token))
}

export function getRefreshToken(): string | null {
  if (!existsSync(RT_FILE)) return null
  try {
    const buf = readFileSync(RT_FILE)
    return safeStorage.decryptString(buf)
  } catch {
    // 解密失败（key 轮换 / 系统迁移），视为未登录
    return null
  }
}

// ── Auth Metadata ─────────────────────────────────────────────

export function saveAuthMeta(meta: AuthMeta): void {
  ensureDir()
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8')
}

export function getAuthMeta(): AuthMeta | null {
  if (!existsSync(META_FILE)) return null
  try {
    return JSON.parse(readFileSync(META_FILE, 'utf-8')) as AuthMeta
  } catch {
    return null
  }
}

// ── Logout ────────────────────────────────────────────────────

export function clearCredentials(): void {
  // 先覆写再删，减少数据残留
  for (const f of [RT_FILE, META_FILE]) {
    if (existsSync(f)) {
      writeFileSync(f, Buffer.alloc(existsSync(f) ? readFileSync(f).length : 0))
      unlinkSync(f)
    }
  }
}
