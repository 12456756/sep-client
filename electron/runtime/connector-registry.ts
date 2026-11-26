import type { ConnectorId } from '../../src/shared/connectors'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ConnectorBinding, ConnectorRegistryPort, ConnectorRuntimePort } from '../domain/connectors'

/** Providers load independently so an unavailable integration cannot disable another. */
export class ConnectorRegistry implements ConnectorRegistryPort {
  private readonly loaded = new Map<ConnectorId, Promise<ConnectorRuntimePort>>()
  private readonly active = new Set<ConnectorRuntimePort>()
  private generation = 0
  constructor(private readonly factories: Record<ConnectorId, () => Promise<ConnectorRuntimePort>>) {}
  provider(id: ConnectorId): Promise<ConnectorRuntimePort> {
    let pending = this.loaded.get(id)
    if (!pending) {
      const generation = this.generation
      pending = this.factories[id]().then(runtime => {
        if (generation !== this.generation) runtime.cancel()
        this.active.add(runtime)
        return runtime
      }).catch(error => { this.loaded.delete(id); throw error })
      this.loaded.set(id, pending)
    }
    return pending
  }
  async binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined> {
    const results = await Promise.allSettled((Object.keys(this.factories) as ConnectorId[]).sort().map(async id => ({ id, binding: await (await this.provider(id)).binding(scope) })))
    const bindings = results.flatMap(result => result.status === 'fulfilled' && result.value.binding ? [result.value] : [])
    if (!bindings.length) return undefined
    const endpoints = new Map<string, ConnectorBinding>()
    for (const { binding } of bindings) for (const server of binding!.servers) {
      const endpoint = new URL(server.transport.url).href
      if (endpoints.has(endpoint)) throw new Error('Ambiguous connector endpoint.')
      endpoints.set(endpoint, binding!)
    }
    return {
      revision: JSON.stringify(bindings.map(({ id, binding }) => [id, binding!.revision])),
      servers: bindings.flatMap(({ binding }) => binding!.servers),
      remoteReadOnlyTools: Object.fromEntries(bindings.flatMap(({ binding }) => Object.entries(binding!.remoteReadOnlyTools ?? {}))),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input)).href
        const binding = endpoints.get(url)
        if (!binding) throw new Error('Unknown connector endpoint.')
        return binding.fetch(input, init)
      },
      commands: bindings.flatMap(({ binding }) => binding!.commands ?? []),
    }
  }
  cancel(): void { this.generation++; for (const runtime of this.active) runtime.cancel() }
}
