import { logger } from '../common/logger'
import type { ScopeSource } from './scope-guard'

export interface SessionRecoveryStep {
  name: 'history' | 'images' | 'videos'
  run: (signal: AbortSignal) => Promise<void>
}

interface ActiveRecovery {
  scopeKey: string
  controller: AbortController
  promise: Promise<void>
}

const log = logger.child('session-recovery')

/** Coordinates one recovery per login; each service retains its own durable queue. */
export class SessionRecovery {
  private active: ActiveRecovery | null = null

  constructor(private readonly scope: ScopeSource, private readonly steps: readonly SessionRecoveryStep[]) {}

  resume(): Promise<void> {
    const owner = this.scope.currentScope()
    if (!owner) return Promise.resolve()
    const scopeKey = JSON.stringify([owner.enterpriseId, owner.memberId])
    if (this.active?.scopeKey === scopeKey) return this.active.promise
    this.stop()
    const recovery: ActiveRecovery = { scopeKey, controller: new AbortController(), promise: Promise.resolve() }
    this.active = recovery
    const isCurrent = (): boolean => {
      const current = this.scope.currentScope()
      return this.active === recovery && !recovery.controller.signal.aborted
        && current?.enterpriseId === owner.enterpriseId && current.memberId === owner.memberId
    }
    recovery.promise = Promise.all(this.steps.map(step => Promise.resolve().then(async () => {
      if (!isCurrent()) return
      try {
        await step.run(recovery.controller.signal)
      } catch (error) {
        if (isCurrent()) log.warn('background recovery failed', {
          recovery: step.name, errorType: error instanceof Error ? error.name : 'unknown',
        })
      }
    }))).then(() => undefined).finally(() => {
      if (this.active === recovery) this.active = null
    })
    return recovery.promise
  }

  stop(): void {
    const recovery = this.active
    this.active = null
    recovery?.controller.abort()
  }
}
