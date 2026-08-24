import { refreshAccessToken, type LoginResponse, type RefreshResponse } from './auth-api'
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
  private refreshPromise: Promise<string> | null = null

  setLogin(response: LoginResponse): AuthMeta {
    if (!response.enterprise) {
      throw new Error('Your account is not associated with an enterprise.')
    }

    const expiresIn = Number.isFinite(response.accessTokenExpiresIn) && response.accessTokenExpiresIn! > 0
      ? response.accessTokenExpiresIn!
      : Number.isFinite(response.expiresIn) && response.expiresIn! > 0
        ? response.expiresIn!
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

  async getValidAccessToken(): Promise<string> {
    if (this.accessToken && !this.isAccessTokenExpired()) return this.accessToken
    if (this.refreshPromise) return this.refreshPromise
    const refreshToken = this.getRefreshToken()
    const request = this.refresh(refreshToken)
    const tracked = request.finally(() => {
      if (this.refreshPromise === tracked) this.refreshPromise = null
    })
    this.refreshPromise = tracked
    return tracked
  }

  async restore(): Promise<AuthMeta | null> {
    const refreshToken = getRefreshToken()
    const meta = getAuthMeta()
    if (!refreshToken || !meta) return null
    this.refreshToken = refreshToken
    this.meta = meta
    try {
      await this.getValidAccessToken()
      return this.meta
    } catch {
      this.clear()
      return null
    }
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
    this.refreshPromise = null
    clearCredentials()
  }

  private async refresh(refreshToken: string): Promise<string> {
    let response: RefreshResponse
    try {
      response = await refreshAccessToken(refreshToken)
    } catch (error) {
      this.clear()
      throw error
    }
    if (!response.accessToken || !response.user || !response.enterprise) {
      this.clear()
      throw new AuthenticationRequiredError('The refresh response was invalid.')
    }
    const expiresIn = Number.isFinite(response.accessTokenExpiresIn) && response.accessTokenExpiresIn! > 0
      ? response.accessTokenExpiresIn!
      : Number.isFinite(response.expiresIn) && response.expiresIn! > 0 ? response.expiresIn! : 3600
    this.accessToken = response.accessToken
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000
    this.meta = {
      memberId: response.user.id,
      enterpriseId: response.enterprise.id,
      displayName: response.user.name,
      enterpriseName: response.enterprise.name,
      email: response.user.email,
    }
    if (response.refreshToken && response.refreshToken !== refreshToken) {
      this.refreshToken = response.refreshToken
      saveRefreshToken(response.refreshToken)
    }
    saveAuthMeta(this.meta)
    return response.accessToken
  }

  private isAccessTokenExpired(): boolean {
    return !this.accessToken || Date.now() + EXPIRY_SKEW_MS >= this.accessTokenExpiresAt
  }
}
