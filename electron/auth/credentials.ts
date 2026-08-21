import { app, safeStorage } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import type { RememberedAccount } from '../../src/shared/types'

// Non-sensitive identity data is JSON. Tokens and remembered passwords are
// encrypted by the OS and are only ever decrypted in the Electron main process.
export interface AuthMeta {
  memberId: string
  enterpriseId: string
  displayName: string
  enterpriseName: string
  email: string
}

interface PasswordVault {
  [email: string]: string
}

const AUTH_DIR = join(app.getPath('userData'), 'auth')
const RT_FILE = join(AUTH_DIR, 'rt.enc')
const LEGACY_TOKENS_FILE = join(AUTH_DIR, 'tokens.enc')
const META_FILE = join(AUTH_DIR, 'meta.json')
const ACCOUNTS_FILE = join(AUTH_DIR, 'accounts.json')
const PASSWORDS_FILE = join(AUTH_DIR, 'passwords.enc')
const MAX_REMEMBERED_ACCOUNTS = 8

function ensureDir(): void {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true })
}

function writeFileAtomically(file: string, data: string | Buffer): void {
  ensureDir()
  const temporaryFile = `${file}.tmp`
  writeFileSync(temporaryFile, data)
  if (existsSync(file)) unlinkSync(file)
  renameSync(temporaryFile, file)
}

function securelyDelete(file: string): void {
  if (!existsSync(file)) return
  writeFileSync(file, Buffer.alloc(readFileSync(file).length))
  unlinkSync(file)
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function readRememberedAccounts(): RememberedAccount[] {
  if (!existsSync(ACCOUNTS_FILE)) return []

  try {
    const value = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8')) as unknown
    if (!Array.isArray(value)) return []

    const seen = new Set<string>()
    return value
      .filter((account): account is RememberedAccount => {
        if (!account || typeof account !== 'object') return false
        const item = account as Partial<RememberedAccount>
        return (
          typeof item.email === 'string' &&
          typeof item.displayName === 'string' &&
          typeof item.enterpriseName === 'string' &&
          typeof item.lastLoginAt === 'string' &&
          Number.isFinite(Date.parse(item.lastLoginAt))
        )
      })
      .map((account) => ({
        email: normalizeEmail(account.email),
        displayName: account.displayName,
        enterpriseName: account.enterpriseName,
        lastLoginAt: account.lastLoginAt,
        hasSavedPassword: false,
      }))
      .filter((account) => {
        if (seen.has(account.email)) return false
        seen.add(account.email)
        return true
      })
      .sort((left, right) => Date.parse(right.lastLoginAt) - Date.parse(left.lastLoginAt))
      .slice(0, MAX_REMEMBERED_ACCOUNTS)
  } catch {
    return []
  }
}

function readPasswordVault(): PasswordVault {
  if (!existsSync(PASSWORDS_FILE) || !safeStorage.isEncryptionAvailable()) return {}

  try {
    const value = JSON.parse(
      safeStorage.decryptString(readFileSync(PASSWORDS_FILE)),
    ) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

function writePasswordVault(vault: PasswordVault): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS safeStorage not available - cannot persist credentials')
  }

  if (Object.keys(vault).length === 0) {
    securelyDelete(PASSWORDS_FILE)
    return
  }

  writeFileAtomically(
    PASSWORDS_FILE,
    safeStorage.encryptString(JSON.stringify(vault)),
  )
}

export function saveRefreshToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS safeStorage not available - cannot persist credentials')
  }

  writeFileAtomically(RT_FILE, safeStorage.encryptString(token))

  // Remove the short-lived tokens file created by versions before this policy.
  securelyDelete(LEGACY_TOKENS_FILE)
}

export function getRefreshToken(): string | null {
  if (!existsSync(RT_FILE) || !safeStorage.isEncryptionAvailable()) return null

  try {
    return safeStorage.decryptString(readFileSync(RT_FILE))
  } catch {
    // Key rotation or moving this file to another OS account invalidates it.
    return null
  }
}

export function saveAuthMeta(meta: AuthMeta): void {
  writeFileAtomically(META_FILE, JSON.stringify(meta, null, 2))
}

export function getAuthMeta(): AuthMeta | null {
  if (!existsSync(META_FILE)) return null
  try {
    const meta = JSON.parse(readFileSync(META_FILE, 'utf-8')) as Partial<AuthMeta>
    if (
      typeof meta.memberId !== 'string' ||
      typeof meta.enterpriseId !== 'string' ||
      typeof meta.displayName !== 'string' ||
      typeof meta.enterpriseName !== 'string'
    ) {
      return null
    }
    return { ...meta, email: typeof meta.email === 'string' ? meta.email : '' } as AuthMeta
  } catch {
    return null
  }
}

export function listRememberedAccounts(): RememberedAccount[] {
  const vault = readPasswordVault()
  return readRememberedAccounts().map((account) => ({
    ...account,
    hasSavedPassword: typeof vault[account.email] === 'string' && vault[account.email].length > 0,
  }))
}

export function saveRememberedAccount(
  account: Omit<RememberedAccount, 'lastLoginAt' | 'hasSavedPassword'>,
  password: string,
  rememberPassword: boolean,
): void {
  const email = normalizeEmail(account.email)
  const encryptionAvailable = safeStorage.isEncryptionAvailable()
  if (rememberPassword && !encryptionAvailable) {
    throw new Error('OS safeStorage not available - cannot persist credentials')
  }

  const vault = encryptionAvailable ? readPasswordVault() : {}
  if (encryptionAvailable) {
    if (rememberPassword) {
      if (!password) throw new Error('Password is required to remember this account')
      vault[email] = password
    } else {
      delete vault[email]
    }
    writePasswordVault(vault)
  }

  const nextAccount: RememberedAccount = {
    ...account,
    email,
    lastLoginAt: new Date().toISOString(),
    hasSavedPassword: rememberPassword,
  }
  const accounts = [
    nextAccount,
    ...readRememberedAccounts().filter(item => normalizeEmail(item.email) !== email),
  ].slice(0, MAX_REMEMBERED_ACCOUNTS)

  const retainedEmails = new Set(accounts.map(item => normalizeEmail(item.email)))
  const prunedVault = Object.fromEntries(
    Object.entries(vault).filter(([savedEmail]) => retainedEmails.has(savedEmail)),
  )
  if (
    encryptionAvailable &&
    Object.keys(prunedVault).length !== Object.keys(vault).length
  ) {
    writePasswordVault(prunedVault)
  }

  writeFileAtomically(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2))
}

export function getRememberedPassword(email: string): string | null {
  return readPasswordVault()[normalizeEmail(email)] ?? null
}

export function forgetRememberedAccount(email: string): void {
  const normalizedEmail = normalizeEmail(email)
  const accounts = readRememberedAccounts().filter(
    account => normalizeEmail(account.email) !== normalizedEmail,
  )
  if (safeStorage.isEncryptionAvailable()) {
    const vault = readPasswordVault()
    delete vault[normalizedEmail]
    writePasswordVault(vault)
  }

  if (accounts.length === 0) securelyDelete(ACCOUNTS_FILE)
  else writeFileAtomically(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2))
}

export function clearCredentials(): void {
  for (const file of [RT_FILE, LEGACY_TOKENS_FILE, META_FILE]) securelyDelete(file)
}
