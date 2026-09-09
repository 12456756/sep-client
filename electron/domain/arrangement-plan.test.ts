import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  effectivePermissionPolicy,
  preflightSubscription,
  validateArrangementNodes,
  validateNodeModels,
  type ArrangementNode,
  validateArrangementDraft,
} from './arrangement-plan'
import { AppError } from '../errors/app-error'

const node = (id: string, dependsOn: string[] = [], modelId = 'model-a'): ArrangementNode => ({
  id,
  subscriptionId: 'sub-a',
  modelId,
  title: id,
  instruction: `do ${id}`,
  expectedOutput: 'result',
  dependsOn,
  skillIds: [],
  requiresUserConfirmation: false,
})

describe('arrangement plan domain', () => {
  it('allows an auto draft to wait for the planner before nodes exist', () => {
    assert.doesNotThrow(() => validateArrangementDraft({
      id: 'draft-a', schemaVersion: 1, revision: 1, owner: { memberId: 'm', enterpriseId: 'e' },
      mode: 'auto', status: 'editing', title: 'Report', goal: 'Build a report', confirmedInputs: [], sharedSkillIds: [],
      conversation: null, nodes: [], workspace: { mode: 'shared', path: null }, permissions: { preset: 'read-only' },
      createdAt: 1, updatedAt: 1, lastPlanning: null,
    }))
  })

  it('accepts a DAG with parallel branches and multiple dependencies', () => {
    assert.doesNotThrow(() => validateArrangementNodes([
      node('a'), node('b'), node('c', ['a', 'b']),
    ]))
  })

  it('rejects duplicate, missing and cyclic dependencies', () => {
    assert.throws(() => validateArrangementNodes([node('a'), node('a')]), AppError)
    assert.throws(() => validateArrangementNodes([node('a', ['missing'])]), AppError)
    assert.throws(() => validateArrangementNodes([node('a', ['b']), node('b', ['a'])]), AppError)
  })

  it('maps permission presets to a bounded tool policy', () => {
    const policy = effectivePermissionPolicy({ preset: 'full-local', commandPolicy: 'confirm-each' }, 'workspace-edit')
    assert.deepEqual(policy.allowedTools, ['read', 'grep', 'find', 'ls', 'write', 'edit'])
    assert.deepEqual(policy.requireApprovalFor, ['write', 'edit', 'bash'])
    assert.equal(policy.commandPolicy, 'confirm-each')
    assert.equal(policy.approvalMode, 'confirm-each')
    assert.equal(effectivePermissionPolicy({ preset: 'full-local', allowWithoutApproval: true }).approvalMode, 'auto-approve')
  })

  it('checks subscription status and threshold without converting quota to time', () => {
    const now = 1_000_000
    const result = preflightSubscription({
      subscriptionId: 'sub-a', employeeId: 'employee-a', status: 'ACTIVE',
      endDate: now + 10_000, allowedModels: ['model-a'],
    }, now, 15_000)
    assert.equal(result.passesThreshold, false)
    assert.equal(result.reasonCode, 'expiring')
    assert.equal(result.remainingTimeMs, 10_000)
  })

  it('reports model allow-list violations per node', () => {
    const issues = validateNodeModels([node('a', [], 'model-b')], [{
      subscriptionId: 'sub-a', status: 'ACTIVE', endDate: null, allowedModels: ['model-a'],
    }])
    assert.deepEqual(issues, ['a:model-not-allowed'])
  })
})
