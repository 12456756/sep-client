import { z } from 'zod'
import type { ElectronAPI, UpdateState } from '../../shared/ipc'
import {
  canUpdate, parseUpdateState, projectUpdateRelease, projectUpdateState, updateErrorMessages, updateSnapshotError,
  type UpdateOperation, type UpdateRelease,
} from './update-state'

export interface UpdateModel {
  state: UpdateState | null
  release: UpdateRelease | null
  pending: UpdateOperation | null
  error: string | null
  check(): Promise<void>
  download(): Promise<void>
  cancel(): Promise<void>
  install(): Promise<void>
}

export type UpdateAPI = Pick<ElectronAPI,
  'getUpdateState' | 'onUpdateStateChanged' | 'checkForUpdate' |
  'downloadUpdate' | 'cancelUpdateDownload' | 'installUpdate'>

interface Lifetime { unsubscribe: (() => void) | null; revision: number }
interface Command { operation: UpdateOperation }

const successSchema = z.object({ success: z.literal(true) })
const snapshotSchema = successSchema.extend({ state: z.unknown() })

/** No DOM dependency. connect() owns the IPC lifetime; subscribe() owns store listeners. */
export function createUpdateController(api: UpdateAPI): {
  getSnapshot(): UpdateModel
  subscribe(listener: () => void): () => void
  connect(): () => void
} {
  const listeners = new Set<() => void>()
  let lifetime: Lifetime | null = null
  let snapshotSequence = 0
  let actualState: UpdateState | null = null
  let command: Command | null = null
  let downloadCommand: Command | null = null
  let model: UpdateModel = {
    state: null, release: null, pending: null, error: null,
    check: () => run('check'), download: () => run('download'),
    cancel: () => run('cancel'), install: () => run('install'),
  }

  function publish(patch: Partial<UpdateModel>): void {
    model = { ...model, ...patch }
    for (const listener of listeners) listener()
  }

  function accept(value: unknown): void {
    const state = parseUpdateState(value)
    if (!state) { publish({ error: updateSnapshotError }); return }
    actualState = state
    publish({
      state: projectUpdateState(state, model.state),
      release: projectUpdateRelease(state, model.release),
      error: state.status === 'error' ? state.message : null,
    })
  }

  function subscribeToMain(owner: Lifetime): void {
    if (owner.unsubscribe) return
    try {
      owner.unsubscribe = api.onUpdateStateChanged(value => {
        if (lifetime !== owner) return
        owner.revision++
        accept(value)
      })
    } catch { if (lifetime === owner) publish({ error: updateSnapshotError }) }
  }

  async function refresh(owner: Lifetime, revision = owner.revision): Promise<void> {
    const sequence = ++snapshotSequence
    try {
      const result: unknown = await api.getUpdateState()
      if (lifetime !== owner || owner.revision !== revision || sequence !== snapshotSequence) return
      const parsed = snapshotSchema.safeParse(result)
      if (!parsed.success) { publish({ error: updateSnapshotError }); return }
      accept(parsed.data.state)
    } catch {
      if (lifetime === owner && owner.revision === revision && sequence === snapshotSequence) publish({ error: updateSnapshotError })
    }
  }

  async function run(operation: UpdateOperation): Promise<void> {
    const owner = lifetime
    if (!owner || !canUpdate(actualState, operation)) return
    // downloadUpdate waits for the entire download. Cancellation may interrupt that command.
    if (command && !(operation === 'cancel' && command === downloadCommand)) return
    const current: Command = { operation }
    command = current
    if (operation === 'download') downloadCommand = current
    publish({ pending: operation, error: null })
    subscribeToMain(owner)
    try {
      const result: unknown = await (operation === 'check' ? api.checkForUpdate() :
        operation === 'download' ? api.downloadUpdate() :
          operation === 'cancel' ? api.cancelUpdateDownload() : api.installUpdate())
      if (lifetime !== owner || command !== current) return
      if (!successSchema.safeParse(result).success) {
        publish({ error: updateErrorMessages[operation] })
      } else {
        // Recover missing terminal events or subscriptions; never infer status from a command result.
        await refresh(owner)
      }
    } catch {
      if (lifetime === owner && command === current) publish({ error: updateErrorMessages[operation] })
    } finally {
      if (downloadCommand === current) downloadCommand = null
      if (command === current) {
        command = operation === 'cancel' ? downloadCommand : null
        // Locks survive StrictMode reconnects; old errors and snapshots do not.
        if (lifetime) publish({ pending: command?.operation ?? null })
      }
    }
  }

  return {
    getSnapshot: () => model,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    connect() {
      const owner: Lifetime = { unsubscribe: null, revision: 0 }
      // Each cleanup belongs to its own connection, including a StrictMode setup/cleanup/setup cycle.
      lifetime = owner
      publish({ pending: command?.operation ?? null })
      subscribeToMain(owner)
      void refresh(owner, 0)
      return () => {
        if (lifetime !== owner) return
        lifetime = null
        try { owner.unsubscribe?.() } catch { /* Cleanup must not expose IPC details or interrupt unmount. */ }
        owner.unsubscribe = null
      }
    },
  }
}
