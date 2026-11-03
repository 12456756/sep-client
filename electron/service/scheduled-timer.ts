import { nextWakeAt } from '../domain/scheduled-task'
import { logger } from '../common/logger'
const log = logger.child('scheduled-timer')

/** At most one timer and one scan; mutations coalesce into another immediate scan. */
export class ScheduledTimer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private enabled = false
  private scanning = false
  private requested = false
  private generation = 0
  private failed = false
  get state(): 'running' | 'stopped' | 'error' { return this.failed ? 'error' : this.enabled ? 'running' : 'stopped' }
  constructor(private readonly scan: () => Promise<void>, private readonly deadlines: () => Promise<number[]>, private readonly now: () => number) {}
  start(): void { this.failed = false; this.enabled = true; this.generation++; this.request() }
  stop(): void { this.enabled = false; this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = null }
  request(): void {
    if (!this.enabled) return
    this.requested = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.scanning) void this.tick()
  }
  private async tick(): Promise<void> {
    if (!this.enabled || this.scanning) return
    this.scanning = true
    const generation = this.generation
    try {
      do { this.requested = false; await this.scan() } while (this.requested && this.enabled && generation === this.generation)
      if (!this.enabled || generation !== this.generation) return
      const next = nextWakeAt(this.now(), await this.deadlines())
      if (next !== null && this.enabled && generation === this.generation) {
        this.timer = setTimeout(() => { this.timer = null; void this.tick() }, Math.max(20, next - this.now()))
        this.timer.unref?.()
      }
    } catch (error) {
      if (generation !== this.generation) return
      // Stop dispatch on persistence/unknown infrastructure faults; no blind rescan/replay.
      this.enabled = false
      this.failed = true
      log.error('========== [SCHEDULED TASK] SCHEDULER STOPPED ==========', {
        reason: 'scan-or-deadline-calculation-failed', errorType: error instanceof Error ? error.name : 'unknown',
      })
    } finally {
      this.scanning = false
      if (this.enabled && (this.requested || generation !== this.generation)) this.request()
    }
  }
}
