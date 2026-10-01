import { AuthenticationRequiredError } from './authentication-required-error'

export interface RefreshTokenRotationResponse {
  refreshToken: string
}

export class RefreshTokenRotationQueue {
  private queue: Promise<void> = Promise.resolve()
  private requiresAuthentication = false
  private generation = 0

  constructor(
    private readonly getCurrentRefreshToken: () => string,
    private readonly persistRefreshToken: (refreshToken: string) => void,
  ) {}

  invalidate(): void {
    this.requiresAuthentication = true
    this.generation += 1
  }

  reset(): void {
    this.requiresAuthentication = false
    this.generation += 1
  }

  async run<T extends RefreshTokenRotationResponse>(
    request: (refreshToken: string) => Promise<T>,
  ): Promise<T> {
    const previousRotation = this.queue
    let releaseRotation!: () => void
    this.queue = new Promise<void>(resolve => { releaseRotation = resolve })

    await previousRotation
    let requestGeneration: number | null = null
    try {
      if (this.requiresAuthentication) throw new AuthenticationRequiredError()
      requestGeneration = this.generation
      const currentRefreshToken = this.getCurrentRefreshToken()
      const response = await request(currentRefreshToken)
      const nextRefreshToken: unknown = response && response.refreshToken
      if (typeof nextRefreshToken !== 'string' || nextRefreshToken.trim().length === 0) {
        throw new AuthenticationRequiredError()
      }
      if (requestGeneration !== this.generation || this.requiresAuthentication) {
        throw new AuthenticationRequiredError()
      }

      try {
        this.persistRefreshToken(nextRefreshToken)
      } catch {
        throw new AuthenticationRequiredError()
      }
      return response
    } catch (error) {
      if (requestGeneration === this.generation && isUnauthorized(error)) this.invalidate()
      throw error
    } finally {
      releaseRotation()
    }
  }
}

let sharedRotationQueue: RefreshTokenRotationQueue | null = null

export function registerSharedRefreshTokenRotation(queue: RefreshTokenRotationQueue): void {
  sharedRotationQueue = queue
}

export function runSharedRefreshTokenRotation<T extends RefreshTokenRotationResponse>(
  request: (refreshToken: string) => Promise<T>,
): Promise<T> {
  if (!sharedRotationQueue) return Promise.reject(new AuthenticationRequiredError())
  return sharedRotationQueue.run(request)
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof AuthenticationRequiredError || (
    typeof error === 'object' && error !== null &&
    'statusCode' in error && error.statusCode === 401
  )
}
