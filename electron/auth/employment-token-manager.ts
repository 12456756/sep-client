import { AuthApiError, getEmploymentToken } from './auth-api'
import { config } from '../infrastructure/config'

const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60
const RETRY_DELAY_MS = 5_000

export interface EmploymentTokenManagerOptions {
  getRefreshToken: () => string
  onAuthenticationRequired?: () => void
}

export class EmploymentTokenManager {
  private employmentToken: string | null = null
  private expiresAt = 0
  private refreshTimer: NodeJS.Timeout | null = null
  private refreshPromise: Promise<string> | null = null
  private subscriptionId: string | null = null
  private generation = 0
  private controller: AbortController | null = null

  constructor(private readonly options: EmploymentTokenManagerOptions) {}

  async initialize(subscriptionId: string): Promise<void> {
    this.stop()
    this.subscriptionId = subscriptionId
    this.controller = new AbortController()
    await this.refreshNow()
  }

  async getValidToken(): Promise<string> {
    if (!this.subscriptionId) throw new Error('Employment token manager is not initialized')
    if (!this.employmentToken || Date.now() + config.EMPLOYMENT_TOKEN_REFRESH_BEFORE_MS >= this.expiresAt) {
      return this.refreshNow()
    }
    return this.employmentToken
  }

  /** Force one refresh after the gateway reports that the cached JWT is invalid. */
  async forceRefresh(): Promise<string> {
    if (!this.subscriptionId) throw new Error('Employment token manager is not initialized')
    this.expiresAt = 0
    return this.refreshNow()
  }

  stop(): void {
    this.generation += 1
    this.controller?.abort()
    this.controller = null
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.refreshPromise = null
    this.employmentToken = null
    this.expiresAt = 0
    this.subscriptionId = null
  }

  private refreshNow(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise

    const generation = this.generation
    const subscriptionId = this.subscriptionId
    const controller = this.controller
    if (!subscriptionId || !controller) {
      return Promise.reject(new Error('Employment token manager is not initialized'))
    }

    const request = this.performRefresh(generation, subscriptionId, controller.signal)
    const trackedRequest = request.finally(() => {
      if (this.refreshPromise === trackedRequest) this.refreshPromise = null
    })
    this.refreshPromise = trackedRequest
    return trackedRequest
  }

  private async performRefresh(
    generation: number,
    subscriptionId: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const response = await getEmploymentToken({
        refreshToken: this.options.getRefreshToken(),
        subscriptionId,
      }, signal)

      if (!this.isCurrent(generation, subscriptionId, signal)) {
        throw new DOMException('Stale employment token request', 'AbortError')
      }

      this.employmentToken = response.employmentToken
      const expiresIn = response.expiresIn > 0 ? response.expiresIn : DEFAULT_TOKEN_TTL_SECONDS
      this.expiresAt = Date.now() + expiresIn * 1000
      this.scheduleRefresh(expiresIn * 1000, generation, subscriptionId)
      return response.employmentToken
    } catch (error) {
      if (this.isAbort(error) || !this.isCurrent(generation, subscriptionId, signal)) throw error

      if (error instanceof AuthApiError && error.isUnauthorized) {
        this.stop()
        this.options.onAuthenticationRequired?.()
      } else if (this.employmentToken && Date.now() < this.expiresAt) {
        this.scheduleRetry(generation, subscriptionId)
      }
      throw error
    }
  }

  private isCurrent(generation: number, subscriptionId: string, signal: AbortSignal): boolean {
    return generation === this.generation &&
      subscriptionId === this.subscriptionId &&
      signal === this.controller?.signal &&
      !signal.aborted
  }

  private isAbort(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError'
  }

  private scheduleRefresh(tokenLifetimeMs: number, generation: number, subscriptionId: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const refreshLeadMs = Math.min(config.EMPLOYMENT_TOKEN_REFRESH_BEFORE_MS, tokenLifetimeMs / 3)
    const delay = Math.max(1_000, this.expiresAt - refreshLeadMs - Date.now())
    this.refreshTimer = setTimeout(() => {
      if (this.generation !== generation || this.subscriptionId !== subscriptionId) return
      void this.refreshNow().catch((error: unknown) => {
        if (!this.isAbort(error)) console.error('[employment-token-manager] automatic refresh failed:', error)
      })
    }, delay)
  }

  private scheduleRetry(generation: number, subscriptionId: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const remainingLifetime = this.expiresAt - Date.now()
    if (remainingLifetime <= 0) return
    this.refreshTimer = setTimeout(() => {
      if (this.generation !== generation || this.subscriptionId !== subscriptionId) return
      void this.refreshNow().catch((error: unknown) => {
        if (!this.isAbort(error)) console.error('[employment-token-manager] refresh retry failed:', error)
      })
    }, Math.min(RETRY_DELAY_MS, remainingLifetime))
  }
}
