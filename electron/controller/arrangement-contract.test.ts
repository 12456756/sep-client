import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import * as arrangementPlan from '../domain/arrangement-plan'
import { INVOKE_CHANNELS } from './channels'
import type { Route } from './router'

function loadRoutes(): Route[] {
  const source = readFileSync(new URL('./routes/arrangement.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} as { arrangementRoutes?: Route[] } }
  const dependencies: Record<string, unknown> = {
    zod: { z },
    '../channels': { INVOKE_CHANNELS },
    '../../domain/arrangement-plan': arrangementPlan,
    '../router': { NO_INPUT: z.undefined(), route: (channel: string, schema: z.ZodType, handle: Route['handle']) => ({ channel, schema, handle }) },
  }
  compileFunction(compiled, ['require', 'exports', 'module'])((id: string) => {
    assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`)
    return dependencies[id]
  }, module.exports, module)
  assert.ok(module.exports.arrangementRoutes)
  return module.exports.arrangementRoutes
}

const node = {
  id: 'node-1', stepId: 'step-1', subscriptionId: 'sub-a', modelId: 'model-a', title: 'Research',
  objective: 'Identify market opportunities', instruction: 'Compare competitors', expectedOutput: 'Word report',
  deliverables: [{ id: 'report', name: 'Report', format: 'docx', path: 'deliverables/report.docx', contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }],
  dependsOn: [], skillIds: [], requiresUserConfirmation: false,
}
const document = {
  mode: 'manual', title: 'Report', goal: 'Build report', confirmedInputs: [], sharedSkillIds: [], conversation: null,
  nodes: [node], workspace: { mode: 'shared', path: null }, permissions: { preset: 'read-only' }, lastPlanning: null,
}

describe('arrangement work contract IPC', () => {
  it('preserves the work contract when creating a manual draft', () => {
    const route = loadRoutes().find(entry => entry.channel === INVOKE_CHANNELS.ARRANGE_CREATE_DRAFT)!
    const parsed = route.schema.parse(document) as { nodes: unknown[] }
    assert.deepEqual(parsed.nodes, [node])
  })

  it('preserves media intent and media deliverable metadata through IPC validation', () => {
    const route = loadRoutes().find(entry => entry.channel === INVOKE_CHANNELS.ARRANGE_CREATE_DRAFT)!
    const mediaNode = {
      ...node,
      mediaRequirements: [{ id: 'image-motion', kind: 'video', operation: 'image-to-video', inputFrom: { nodeId: 'node-1', artifactId: 'asset_abc-123' } }],
      deliverables: [{ ...node.deliverables[0], artifact: { kind: 'video', source: 'media-output', operation: 'image-to-video' } }],
    }
    const parsed = route.schema.parse({ ...document, nodes: [mediaNode] }) as { nodes: unknown[] }
    assert.deepEqual(parsed.nodes, [mediaNode])
    assert.equal(route.schema.safeParse({ ...document, nodes: [{ ...mediaNode, mediaRequirements: [{ ...mediaNode.mediaRequirements[0], preferred: { count: 0 } }] }] }).success, false)
  })

  it('accepts legacy nodes and rejects malformed delivery metadata', () => {
    const route = loadRoutes().find(entry => entry.channel === INVOKE_CHANNELS.ARRANGE_CREATE_DRAFT)!
    const { objective: _objective, deliverables: _deliverables, ...legacy } = node
    assert.equal(route.schema.safeParse({ ...document, nodes: [legacy] }).success, true)
    for (const extra of [
      { objective: 42 }, { deliverables: [] },
      { deliverables: [{ ...node.deliverables[0], path: '../outside.docx' }] },
      { deliverables: [{ ...node.deliverables[0], contentOutline: [42] }] },
    ]) assert.equal(route.schema.safeParse({ ...document, nodes: [{ ...node, ...extra }] }).success, false)
  })

  it('rejects duplicate media requirement IDs at the IPC boundary without imposing a fixed requirement count', () => {
    const route = loadRoutes().find(entry => entry.channel === INVOKE_CHANNELS.ARRANGE_CREATE_DRAFT)!
    const requirement = { id: 'image', kind: 'image', operation: 'generate' }
    assert.equal(route.schema.safeParse({ ...document, nodes: [{ ...node, mediaRequirements: [requirement, requirement] }] }).success, false)
    const mediaRequirements = Array.from({ length: 65 }, (_, index) => ({ ...requirement, id: 'image-' + index }))
    assert.equal(route.schema.safeParse({ ...document, nodes: [{ ...node, mediaRequirements }] }).success, true)
  })
})
