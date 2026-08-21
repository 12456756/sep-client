import type { LoginResponse } from './auth-api'
import {
  clearCredentials,
  getAuthMeta,
  getRefreshToken,
  saveAuthMeta,
  saveRefreshToken,
  type AuthMeta,
} from './credentials'

const EXPIRY_SKEW_MS = 30_000

export class AuthenticationRequiredError extends Error {
  readonly statusCode = 401

  constructor(message = 'Authentication required. Please sign in again.') {
    super(message)
    this.name = 'AuthenticationRequiredError'
  }
}

export class AuthSessionManager {
  private accessToken: string | null = null
  private accessTokenExpiresAt = 0
  private refreshToken: string | null = null
  private meta: AuthMeta | null = null

  setLogin(response: LoginResponse): AuthMeta {
    if (!response.enterprise) {
      throw new Error('Your account is not associated with an enterprise.')
    }

    const expiresIn = Number.isFinite(response.expiresIn) && response.expiresIn > 0
      ? response.expiresIn
      : 60 * 60

    this.accessToken = response.accessToken
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000
    this.refreshToken = response.refreshToken
    this.meta = {
      memberId: response.user.id,
      enterpriseId: response.enterprise.id,
      displayName: response.user.name,
      enterpriseName: response.enterprise.name,
      email: response.user.email,
    }

    try {
      saveRefreshToken(response.refreshToken)
      saveAuthMeta(this.meta)
    } catch (error) {
      this.clear()
      throw error
    }
    return this.meta
  }

  getStoredMeta(): AuthMeta | null {
    return getAuthMeta()
  }

  getMeta(): AuthMeta | null {
    return this.meta
  }

  getAccessToken(): string {
    if (!this.accessToken || this.isAccessTokenExpired()) {
      throw new AuthenticationRequiredError()
    }
    return this.accessToken
  }

  getRefreshToken(): string {
    if (!this.refreshToken) this.refreshToken = getRefreshToken()
    if (!this.refreshToken) {
      throw new AuthenticationRequiredError()
    }
    return this.refreshToken
  }

  clear(): void {
    this.accessToken = null
    this.accessTokenExpiresAt = 0
    this.refreshToken = null
    this.meta = null
    clearCredentials()
  }

  private isAccessTokenExpired(): boolean {
    return !this.accessToken || Date.now() + EXPIRY_SKEW_MS >= this.accessTokenExpiresAt
  }
}
