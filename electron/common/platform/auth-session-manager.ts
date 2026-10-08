import { logger } from '../logger'
import { AuthenticationRequiredError } from './authentication-required-error'
import { refreshAccessToken, type LoginResponse } from './platform-api'
import { RefreshTokenRotationQueue, registerSharedRefreshTokenRotation } from './refresh-token-rotation'
import {
  clearCredentials,
  getAuthMeta,
  getRefreshToken,
  saveAuthMeta,
  saveRefreshToken,
  type AuthMeta,
} from './credential-vault'

const EXPIRY_SKEW_MS = 30_000

export class AuthSessionManager {
  private readonly accessTokenListeners = new Set<(token: string | null) => void>()
  private accessToken: string | null = null
  private accessTokenExpiresAt = 0
  private refreshToken: string | null = null
  private meta: AuthMeta | null = null
  private refreshPromise: Promise<string> | null = null
  private readonly refreshTokenRotation: RefreshTokenRotationQueue

  constructor() {
    this.refreshTokenRotation = new RefreshTokenRotationQueue(
      () => this.getRefreshToken(),
      refreshToken => {
        saveRefreshToken(refreshToken)
        this.refreshToken = refreshToken
      },
    )
    registerSharedRefreshTokenRotation(this.refreshTokenRotation)
  }

  setLogin(response: LoginResponse): AuthMeta {
    if (!response.enterprise) {
      throw new Error('Your account is not associated with an enterprise.')
    }

    const expiresIn = Number.isFinite(response.accessTokenExpiresIn) && response.accessTokenExpiresIn > 0
      ? response.accessTokenExpiresIn
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
      this.refreshTokenRotation.reset()
    } catch (error) {
      this.clear()
      throw error
    }
    this.publishAccessToken()
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

  async getValidAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.accessToken && !this.isAccessTokenExpired()) return this.accessToken
    if (this.refreshPromise) return this.refreshPromise
    const request = this.refreshTokenRotation.run(
      refreshToken => refreshAccessToken(refreshToken),
    ).then(response => {
      if (!response.accessToken || !response.enterprise) throw new AuthenticationRequiredError()
      this.accessToken = response.accessToken
      this.accessTokenExpiresAt = Date.now() + (response.accessTokenExpiresIn > 0 ? response.accessTokenExpiresIn : 3600) * 1000
      this.meta = {
        memberId: response.user.id,
        enterpriseId: response.enterprise.id,
        displayName: response.user.name,
        enterpriseName: response.enterprise.name,
        email: response.user.email,
      }
      saveAuthMeta(this.meta)
      this.publishAccessToken()
      return response.accessToken
    }).catch(error => {
      if (error instanceof AuthenticationRequiredError || (error && typeof error === 'object' && (error as { statusCode?: number }).statusCode === 401)) {
        this.clear()
        throw new AuthenticationRequiredError()
      }
      throw error
    })
    this.refreshPromise = request
    return request.finally(() => { if (this.refreshPromise === request) this.refreshPromise = null })
  }

  getRefreshToken(): string {
    this.refreshToken = getRefreshToken()
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
    this.refreshTokenRotation.invalidate()
    this.publishAccessToken()
    clearCredentials()
  }

  /** Main-process observers only: a refreshed token must replace the old WS connection. */
  subscribeAccessToken(callback: (token: string | null) => void): () => void {
    this.accessTokenListeners.add(callback)
    return () => { this.accessTokenListeners.delete(callback) }
  }

  private publishAccessToken(): void {
    for (const callback of this.accessTokenListeners) {
      try { callback(this.accessToken) } catch {
        // Never log a callback error: it could contain credentials supplied to the observer.
        logger.child('auth-session').warn('access token observer failed')
      }
    }
  }

  private isAccessTokenExpired(): boolean {
    return !this.accessToken || Date.now() + EXPIRY_SKEW_MS >= this.accessTokenExpiresAt
  }
}

