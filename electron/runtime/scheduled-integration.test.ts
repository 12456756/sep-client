import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { ArrangementWorkPlan, EmployeeWorkPlan, ScheduleInput, ScheduledOccurrence } from '../../src/shared/scheduled-tasks'
import { ScheduledTaskStore } from '../data/scheduled-task-store'
import { ConnectorInputError } from '../domain/connectors'
import { WorkPlanStore } from '../data/work-plan-store'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { TaskRunStore } from '../data/task-run-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { ScheduledTaskService } from '../service/scheduled-task-service'
import { ScheduledTaskRunner } from '../service/scheduled-task-runner'
import { ScheduledOperations } from '../service/scheduled-operations'
import { attachConnectorTools } from '../pi/sdk/pi-connector-tools'
import type { McpRuntime } from '../pi/sdk/pi-mcp-client'
import { describeScheduledDingTalkOperation, dingTalkFailureReason, evaluateDingTalkCommand, isScheduledDingTalkReadOnly } from './dingtalk-command'
import { PiCodingAgentAdapter } from '../pi/sdk/pi-coding-agent-adapter'
import { PiTaskWorker } from '../pi/sdk/pi-task-worker'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'
import type { EmployeeRuntimeConfig } from './run-types'

const scope = { memberId: 'member', enterpriseId: 'enterprise' }
const plan: EmployeeWorkPlan = { status: 'ready', objective: 'Deliver a report', instruction: 'Write the report file', expectedOutput: 'A usable file',
  deliverables: [{ id: 'report', name: 'Report', format: 'txt', path: 'report.txt', contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }] }
const dingtalkGoal = '每天上午11:55，使用已连接的钉钉账号，分别向胡锐、赵宇杭各发送一条私聊消息，消息正文严格为：定时任务钉钉测试。通过钉钉官方工具执行，发送前读取所需指南和命令契约；若收件人存在同名歧义则不猜测、不误发，报告需澄清。发送后核验结果，分别记录两位收件人的成功或失败情况；结果不明不得自动重复发送。\n\nDeliverables:\n- 分别向胡锐、赵宇杭发送钉钉私聊消息：定时任务钉钉测试\n- 报告每位收件人的发送与核验结果'

const naturalGoals = {
  '12:43': '通过钉钉分别给胡锐和赵宇杭发送测试消息，内容为「定时任务钉钉测试」，并做好发送记录。',
  '13:24': '在指定时间通过钉钉分别给胡锐和赵宇杭发送一条测试消息：定时任务钉钉测试。',
}
const tableSearchResult = JSON.stringify({ success: true, status: 'success', error: {}, data: { items: [{ name: '销售1' }] } })
const tableSearchArgs = ['aitable', 'base', 'search', '--query', '销售1']
const sqlArgs = ['aitable', 'psql', '-d', 'base', '-c', 'SELECT * FROM "销售1"']
for (const mode of ['sent', '12:43', '13:24', 'generic-connector', 'remote-connector', 'changed-account', 'unknown', 'table-search', 'partial', 'ambiguous', 'stopped-before-submit', 'file-only', 'report-only'] as const) {
  test(`scheduled messages run within the task without approval: ${mode}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'sep-scheduled-message-'))
    const runs = new TaskRunStore(root), tasks = new TaskManager(root, null, undefined, runs)
    const workPlans = new WorkPlanStore(root), metadata = new TaskMetadataStore(root)
    const checkpoints = new ArrangementCheckpointStore(root), storage = new ScheduledTaskStore(root)
    const scopePort = { currentScope: () => tasks.getCurrentUserScope() }
    const employee = { subscriptionId: 'sub', modelId: 'model', gatewayUrl: 'http://gateway.invalid' }
    const targets: string[] = []
    let now = 1000, approvals = 0, connectionRevision = 'connected-1'
    let stopInjected = false
    const operations = new ScheduledOperations({ read: owner => storage.read(owner), update: async (owner, mutate) => {
      const result = await storage.update(owner, mutate)
      if (mode === 'stopped-before-submit' && result === 'started' && !stopInjected) {
        stopInjected = true
        await storage.update(owner, snapshot => { snapshot.occurrences[0].stopReason = 'cancelled' })
      }
      return result
    } }, scopePort.currentScope)
    const runtime = new TaskRuntime({ taskManager: tasks, taskRunStore: runs, workPlanStore: workPlans, arrangementCheckpointStore: checkpoints,
      getRefreshToken: () => 'test', resolveEmployee: () => employee, onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() { approvals++ },
      scheduledOperations: operations,
      connectorBinding: async () => mode === 'remote-connector'
        ? { revision: connectionRevision, fetch, servers: [{ name: 'test', transport: { type: 'streamable-http', url: 'https://connector.invalid/' }, enabledTools: ['publish'] }] }
        : { revision: connectionRevision, servers: [], fetch, commands: [{ id: mode === 'generic-connector' ? 'qqmail' : 'dingtalk', name: 'Test Connector',
        instructions: { reference: '', schema: '', execute: '' }, reference: async () => '', schema: async () => ({ text: '', isError: false }),
        evaluateCommand: evaluateDingTalkCommand,
        isScheduledReadOnly: isScheduledDingTalkReadOnly,
        scheduledOperation: describeScheduledDingTalkOperation,
        execute: async args => {
          if (mode === 'generic-connector') {
            assert.deepEqual(args, ['message', 'reply', '--json', '{"text":"received"}'])
            targets.push('mail-reply')
            return { text: 'mail reply submitted', isError: false }
          }
          if (mode === 'table-search') {
            assert.deepEqual(args, tableSearchArgs)
            targets.push('table-search')
            return { text: tableSearchResult, isError: false }
          }
          if (mode === 'ambiguous' && args[3] === '胡锐') throw new ConnectorInputError('收件人同名，未调用发送接口。')
          targets.push(args[3])
          assert.equal(args[5], '定时任务钉钉测试')
          const firstTarget = args[3] === '胡锐'
          const rejected = mode === 'partial' && targets.length === 2
          const text = rejected ? '{"error":{"category":"auth","message":"private connector diagnostic"}}' : 'send result'
          return { text, isError: mode === 'unknown' && firstTarget || rejected,
            ...(rejected ? { scheduledReason: dingTalkFailureReason(text) } : {}),
            ...(mode === 'unknown' && firstTarget ? { executionUncertain: true } : {}) }
        },
      }] },
      createWorker: options => ({ async run() {
        const binding = await options.context.resolveConnectorBinding?.()
        const occurrence = (await storage.read(scope)).occurrences[0]
        assert.equal(binding?.revision, mode === 'changed-account' ? undefined : 'connected-1',
          `Live ${connectionRevision}; saved ${occurrence.connectorRevision}; resolved ${binding?.revision}`)
        const remoteTool = 'mcp__test__publish'
        const base: McpRuntime = mode === 'remote-connector' ? { permissions: new Map([[remoteTool, 'confirm-each']]), dispose: async () => {}, tools: [{
          name: remoteTool, label: 'Test', description: 'Test', promptSnippet: 'Test',
          parameters: Type.Unsafe<Record<string, unknown>>({ type: 'object' }), executionMode: 'sequential',
          execute: async (_id, params) => {
            assert.deepEqual(params, { title: 'Update', text: 'New status' })
            targets.push('remote-publish')
            return { content: [{ type: 'text', text: 'remote update submitted' }], details: { toolName: remoteTool, serverName: 'test', isError: false } }
          },
        }] } : { tools: [], permissions: new Map(), dispose: async () => {} }
        const connector = attachConnectorTools(base, binding, options.context.workspaceDir, options.context.scheduledTools)
        const send = connector.tools.find(tool => tool.name === 'dingtalk_execute')
        if (mode === 'remote-connector') {
          assert.equal(binding?.servers[0]?.name, 'test')
          assert.equal(connector.scheduledConnectorExecutors?.has(remoteTool), true)
          const first = await connector.tools[0].execute('publish', { title: 'Update', text: 'New status' }, undefined)
          assert.equal(first.details.isError, false)
          assert.deepEqual(first.content, [{ type: 'text', text: 'remote update submitted' }])
          assert.equal((await connector.tools[0].execute('duplicate', { text: 'New status', title: 'Update' }, undefined)).details.isError, false)
        } else if (mode === 'generic-connector') {
          const reply = connector.tools.find(tool => tool.name === 'qqmail_execute')!
          const args = ['message', 'reply', '--json', '{"text":"received"}']
          for (const id of ['initial', 'duplicate']) assert.equal((await reply.execute(id, { args }, undefined)).details.isError, false)
        } else if (mode === 'table-search') {
          for (const id of ['search', 'search-again']) {
            const result = await send!.execute(id, { args: tableSearchArgs }, undefined)
            assert.equal(result.details.isError, false)
            assert.deepEqual(result.content, [{ type: 'text', text: tableSearchResult }])
          }
        } else if (send && mode !== 'file-only' && mode !== 'report-only') {
          for (const target of ['胡锐', '胡锐', '赵宇杭']) {
            const result = await send.execute(target, { args: ['chat', '+dm', '--to', target, '--content', '定时任务钉钉测试'] }, undefined)
            if (result.details.isError) await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: employee.subscriptionId,
              type: 'scheduled_operation_failed', data: { toolName: send.name }, occurredAt: now, sequence: 1 })
          }
        }
        await writeFile(join(options.context.workspaceDir, 'report.txt'), 'Report findings')
        const reply = JSON.stringify({ nodeId: 'employee-work', summary: 'Report ready', finalDeliverables: [{ id: 'report', path: 'report.txt' }],
          ...(!binding || mode === 'report-only' ? { externalWorkBlocked: true } : {}) })
        assert.equal(await options.onResponseSettled?.({ text: reply, stopReason: 'stop' }), undefined)
      }, async abort() {}, async dispose() {} }),
    })
    const runner = new ScheduledTaskRunner({ scope: scopePort, tasks, workPlans, metadata, checkpoints, runs, storage,
      authorize: async () => employee, now: () => now, execution: async () => runtime })
    const service = new ScheduledTaskService({ scope: scopePort, repository: storage, employee: async () => employee,
      planner: async () => plan, runner, connectorRevision: async () => connectionRevision, now: () => now })
    t.after(async () => { service.stop(); await runtime.stopAll(); await rm(root, { recursive: true, force: true }) })
    await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
    const input: ScheduleInput = { name: 'Report', goal: mode === 'file-only' ? 'Produce a report' : mode === 'generic-connector'
      ? '用已连接的邮箱在原邮件线程里回复收到。' : mode === 'remote-connector' ? 'Publish the status update.'
        : mode === 'table-search' ? '查找钉钉 AI 表格销售1，生成报告。' : mode === '12:43' || mode === '13:24' ? naturalGoals[mode] : dingtalkGoal,
      subscriptionId: 'sub', modelId: 'model', workDir: root, scheduledAt: 2000, timezone: 'Asia/Shanghai',
      permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
    const created = await service.create('message-test', input)
    const planned = await service.plan(created.id, created.revision)
    const enabled = await service.confirm(created.id, planned.revision)
    assert.equal(enabled.connectorRevision, 'connected-1')
    if (mode === 'changed-account') connectionRevision = 'connected-2'
    now = 2000
    await service.scan()
    const limit = Date.now() + 5000
    let occurrence = (await service.list()).occurrences[0]!
    while (Date.now() < limit && ['launching', 'running'].includes(occurrence.status)) {
      await new Promise(resolve => setTimeout(resolve, 15))
      await service.scan()
      occurrence = (await service.list()).occurrences[0]!
    }
    const unknown = mode === 'unknown'
    const completed = ['sent', '12:43', '13:24', 'generic-connector', 'remote-connector', 'table-search', 'file-only'].includes(mode)
    assert.equal(occurrence.status, completed ? 'completed' : unknown ? 'review' : mode === 'stopped-before-submit' ? 'cancelled' : 'failed')
    assert.equal((await tasks.getTask(occurrence.taskId))?.status, completed ? 'completed' : unknown ? 'interrupted' : 'failed')
    assert.equal(occurrence.error?.code, completed ? undefined : unknown ? 'SCHEDULED_OPERATION_UNKNOWN'
      : mode === 'partial' ? 'SCHEDULED_OPERATION_FAILED' : 'SCHEDULED_OPERATION_NOT_EXECUTED')
    const expectedTargets = mode === 'changed-account' || mode === 'file-only' || mode === 'report-only' || mode === 'stopped-before-submit' ? []
      : mode === 'generic-connector' ? ['mail-reply'] : mode === 'remote-connector' ? ['remote-publish'] : mode === 'table-search' ? ['table-search', 'table-search'] : mode === 'ambiguous' ? ['赵宇杭'] : ['胡锐', '赵宇杭']
    assert.deepEqual(targets, expectedTargets)
    assert.equal(approvals, 0)
    const expectedResults = mode === 'stopped-before-submit' ? [['胡锐', 'not-executed']]
      : !expectedTargets.length || mode === 'generic-connector' || mode === 'remote-connector' || mode === 'table-search' ? [] : [
        ['胡锐', mode === 'ambiguous' ? 'not-executed' : unknown ? 'unknown' : 'succeeded'],
        ['赵宇杭', mode === 'partial' ? 'failed' : 'succeeded'],
      ]
    const blocked = occurrence.operations?.filter(item => !item.target) ?? []
    assert.deepEqual(blocked.map(item => [item.tool, item.status]), mode === 'generic-connector' ? [['qqmail_execute', 'succeeded']]
      : mode === 'remote-connector' ? [['mcp__test__publish', 'succeeded']]
        : mode === 'changed-account' || mode === 'report-only' ? [['scheduled_external_work', 'not-executed']] : [])
    assert.deepEqual((occurrence.operations ?? []).filter(item => item.target).map(item => [item.target, item.status]), expectedResults)
    if (mode === 'partial') {
      const saved = (await storage.read(scope)).occurrences[0].operations
      assert.deepEqual(saved?.map(item => [item.dingTalkAction, item.reason]), [['chat +dm', undefined], ['chat +dm', 'authentication-required']])
      assert.doesNotMatch(JSON.stringify(saved), /private connector diagnostic|定时任务钉钉测试/)
    }
    if (mode === 'ambiguous') assert.equal(occurrence.operations?.[0]?.reason, 'target-unverified')
    assert.ok(occurrence.operations?.every(item => item.receipt === undefined) ?? true)
    await service.recover()
    await service.scan()
    assert.deepEqual(targets, expectedTargets)
  })
}

for (const mode of ['success', 'publication-denied', 'publication-interrupted', 'general-conflict', 'empty-file', 'missing-file', 'invalid-submission', 'admission-uncertain', 'legacy-path', 'missing-workspace-read', 'missing-outside-read', 'tool-path-denied', 'skill-cache-path-denied', 'skill-alias', 'skill-alias-changed', 'daily-report-read-fallback'] as const) {
  test(`scheduled execution uses the existing runtime and validates actual delivery: ${mode}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'sep-scheduled-integration-'))
    const runs = new TaskRunStore(root)
    const tasks = new TaskManager(root, null, undefined, runs)
    const workPlans = new WorkPlanStore(root)
    const metadata = new TaskMetadataStore(root)
    const checkpoints = new ArrangementCheckpointStore(root)
    const storage = new ScheduledTaskStore(root)
    let executions = 0
    let validations = 0
    let skillLoads = 0
    let plannerCalls = 0
    const liveSkill = mode === 'skill-alias' || mode === 'skill-alias-changed'
    const missingWorkspaceRead = mode === 'missing-workspace-read'
    const dailyReport = mode === 'daily-report-read-fallback'
    const reportPath = dailyReport ? '销售1每日统计-20-12-00.md' : missingWorkspaceRead ? '钉钉发送结果.md' : liveSkill ? 'deliverables/金价日报.md' : 'report.txt'
    const scheduledAt = mode === 'empty-file' || dailyReport ? Date.parse('2026-11-20T04:00:00Z') : 2000
    const workPlan = mode === 'empty-file' ? { ...plan, instruction: '按本次运行开始时间生成空白文本文件，文件名使用 yyyyMMdd-HHmm.txt。',
      deliverables: [{ ...plan.deliverables[0], path: 'yyyyMMdd-HHmm.txt', acceptanceCriteria: ['文件大小为 0 字节。'] }] }
      : liveSkill || missingWorkspaceRead || dailyReport ? { ...plan, deliverables: [{ ...plan.deliverables[0],
        path: dailyReport ? '销售1每日统计-dd-HH-mm.md' : reportPath, format: 'md', ...(dailyReport ? { scheduledFilenameTime: 'scheduled' as const } : {}) }] } : plan
    let now = scheduledAt - 1000
    const employee: EmployeeRuntimeConfig = { subscriptionId: 'sub', modelId: 'model', gatewayUrl: 'http://gateway.invalid' }
    let requests = 0
    const eventTypes: string[] = []
    const livePathDenial = mode === 'tool-path-denied' || mode === 'missing-outside-read' || mode === 'skill-cache-path-denied'
    const usePi = liveSkill || livePathDenial || missingWorkspaceRead || dailyReport
    const skillContent = '---\nname: report-research\ndescription: Research notes for reports.\n---\nUnique skill instruction: include verified findings.'
    const reportContent = 'Verified research findings'
    let aliasAdvertised = false
    let leakedSkillPath = false
    let readSkillContent = false
    let sawMissingFile = false
    const queryCalls: string[][] = []
    const readResponses: string[] = []
    let recordedSkillLabel: unknown
    if (usePi) {
      const outside = mode === 'skill-cache-path-denied' ? join(root, 'runtime', 'skills-v2', 'wrong-cache-id', 'report-research', 'SKILL.md') : join(root, 'not-the-run-workspace.txt')
      if (mode === 'tool-path-denied') await writeFile(outside, 'Outside the run workspace')
      const skillDir = join(root, 'approved-skill')
      const skillEntry = join(skillDir, 'SKILL.md')
      if (liveSkill) {
        await mkdir(skillDir)
        await writeFile(skillEntry, skillContent)
        employee.additionalSkillPaths = [skillDir]
        employee.runtimeSnapshot = {
          manifestVersion: 1, subscriptionId: 'sub', enterpriseId: scope.enterpriseId, employeeId: 'employee',
          templateVersion: '1', employeeVersion: '1', maxSteps: 10, systemPrompt: '', modelId: 'model', allowedModels: ['model'],
          approvedSkills: [{ capabilityId: 'cap', name: 'report-research', versionId: 'v1', version: '1', content: skillContent, description: 'Research notes' }],
          skills: [{ capabilityId: 'cap', versionId: 'platform-v1', baseSkillVersionId: 'v1', source: 'approved', version: '1',
            name: 'report-research', description: 'Research notes', content: skillContent, path: skillDir,
            sha256: createHash('sha256').update(skillContent).digest('hex') }],
        }
      }
      const server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', async () => {
          const payload = Buffer.concat(chunks).toString('utf8')
          const round = ++requests
          if (round === 1) {
            aliasAdvertised = payload.includes('@skill/report-research')
            leakedSkillPath = payload.includes('approved-skill')
            if (mode === 'skill-alias-changed') await writeFile(skillEntry, skillContent + '\nChanged outside this run.')
          }
          if (payload.includes('Unique skill instruction: include verified findings.')) readSkillContent = true
          if (payload.includes('File not found in the task workspace.')) sawMissingFile = true
          if (dailyReport && round >= 2 && round <= 4) {
            const body = JSON.parse(payload) as { messages: { role: string; content: string }[] }
            readResponses.push(body.messages.filter(message => message.role === 'tool').at(-1)?.content ?? '')
          }
          const submission = JSON.stringify({ nodeId: 'employee-work', summary: 'Report ready', finalDeliverables: [{ id: 'report', path: reportPath }] })
          // A write prepared before a denied read must not run in the same Pi tool batch.
          const toolCalls = liveSkill ? round === 1 && mode === 'skill-alias' ? [{ name: 'read', args: { path: '@skill/report-research/../private.txt' } }]
            : round <= 2 ? [{ name: 'read', args: { path: '@skill/report-research' } }]
              : round === 3 ? [{ name: 'write', args: { path: reportPath, content: reportContent } }] : []
            : missingWorkspaceRead ? round === 1 ? [{ name: 'read', args: { path: reportPath } }]
              : round === 2 ? [{ name: 'write', args: { path: reportPath, content: reportContent } }] : []
            : dailyReport ? round <= 3 ? [{ name: 'dingtalk_execute', args: { args: round === 1 ? sqlArgs : tableSearchArgs } }]
              : round === 4 ? [{ name: 'write', args: { path: reportPath, content: reportContent } }] : []
            : round === 1 ? [
            { name: 'write', args: { path: 'report.txt', content: 'Fallback' } },
            { name: 'read', args: { path: outside } },
          ] : [{ name: 'write', args: { path: 'report.txt', content: 'Fallback after refusal' } }]
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const delta = toolCalls.length ? { role: 'assistant', tool_calls: toolCalls.map(({ name, args }, index) => ({ index, id: `call-${requests}-${index}`,
            type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : { role: 'assistant', content: submission }
          for (const [value, reason] of [[delta, null], [{}, toolCalls.length ? 'tool_calls' : 'stop']] as const) {
            response.write(`data: ${JSON.stringify({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'model', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`)
          }
          response.end('data: [DONE]\n\n')
        })
      })
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
      t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      employee.gatewayUrl = `http://127.0.0.1:${address.port}/v1`
    }
    const runtime = new TaskRuntime({ taskManager: tasks, taskRunStore: runs, workPlanStore: workPlans, arrangementCheckpointStore: checkpoints,
      getRefreshToken: () => 'test-only', onAuthenticationRequired() {}, onEvent(event) {
        eventTypes.push(event.type)
        if (event.type === 'tool_execution_start') {
          const data = event.data as { skillDetails?: unknown }
          if (data.skillDetails) recordedSkillLabel = data.skillDetails
        }
      }, onApprovalRequest() {},
      ...(dailyReport ? {
        scheduledOperations: new ScheduledOperations(storage, () => tasks.getCurrentUserScope()),
        connectorBinding: async () => ({ revision: 'daily-report', fetch, servers: [], commands: [{ id: 'dingtalk' as const, name: '钉钉',
          instructions: { reference: 'reference', schema: 'schema', execute: 'execute' }, reference: async () => '', schema: async () => ({ text: '', isError: false }),
          isScheduledReadOnly: isScheduledDingTalkReadOnly, execute: async (args: string[]) => {
            queryCalls.push(args)
            return args[1] === 'psql' ? { text: 'SQL query failed', isError: true } : { text: tableSearchResult, isError: false }
          },
        }] }),
      } : {}),
      resolveEmployee: () => employee,
      authorizeScheduledModel: async (model, id) => { assert.equal(model, employee.modelId); assert.equal(id, employee.subscriptionId); return employee },
      authorizeEmployee: async (_id, model) => { assert.equal(model, 'model'); skillLoads++; return usePi ? employee : { ...employee, additionalSkillPaths: ['current-employee-skills'] } },
      createWorker: options => usePi ? new PiTaskWorker({ ...options,
        runtime: { createSession: config => new PiCodingAgentAdapter().createSession({ ...config, mcpServers: [] }) },
        createTokenManager: () => ({ async initialize() {}, async getValidToken() { return 'test-only' }, stop() {} }),
        async onResponseSettled(response) { validations++; return options.onResponseSettled?.(response) },
      }) : ({
        async run() {
          executions++
          assert.deepEqual(options.context.additionalSkillPaths, ['current-employee-skills'])
          const path = mode === 'empty-file' ? executions === 1 ? '20261120-1200.txt' : '20261120-1205.txt' : 'report.txt'
          assert.ok(options.context.fixedSystemPrompt?.includes(path))
          if (mode === 'empty-file') await writeFile(join(options.context.workspaceDir, path), Buffer.alloc(0), { flag: 'wx' })
          if (mode === 'success' || mode === 'publication-denied' || mode === 'publication-interrupted') await writeFile(join(options.context.workspaceDir, path), reportContent, 'utf8')
          for (let i = 0; i < 5; i++) {
            validations++
            const response = mode === 'invalid-submission' ? { status: 'blocked', reason: 'Required sales input is missing' }
              : { nodeId: 'employee-work', summary: 'Report ready', finalDeliverables: [{ id: 'report', path }] }
            const correction = await options.onResponseSettled?.({ text: JSON.stringify(response), stopReason: 'stop' })
            if (!correction) return
            assert.ok(mode === 'missing-file' || mode === 'invalid-submission')
          }
          assert.fail('Invalid delivery should have terminated the same-session validation loop')
        },
        async abort() {}, async dispose() {},
      }),
    })
    const runner = new ScheduledTaskRunner({ scope: { currentScope: () => tasks.getCurrentUserScope() }, tasks, workPlans, metadata, checkpoints, runs, storage,
      authorize: async () => employee, authorizeModel: async () => employee, now: () => now, execution: async () => ({
        executeTask: async (id, options) => {
          if (mode === 'general-conflict') await writeFile(join((await tasks.getTask(id))!.workDir!, reportPath), 'previous content', { flag: 'wx' })
          let checks = 0
          return runtime.executeTask(id, { beforeAdmission: () => {
            options?.beforeAdmission?.()
            if (mode === 'admission-uncertain' && ++checks === 3) throw new Error('Admission state became uncertain')
          } })
        }, cancelTask: (id, reason) => runtime.cancelTask(id, reason),
      }) })
    const makeService = () => new ScheduledTaskService({ repository: new ScheduledTaskStore(root), scope: { currentScope: () => tasks.getCurrentUserScope() },
      employee: async () => employee, authorizeModel: async () => employee, planner: async () => { plannerCalls++; return workPlan }, runner, now: () => now,
      ...(dailyReport ? { connectorRevision: async () => 'daily-report' } : {}),
      arrangementPlanner: async () => {
        plannerCalls++
        return { status: 'ready', kind: 'arrangement', title: 'Empty file', intentAnalysis: null,
          nodes: [{ id: 'employee-work', title: 'Empty file', subscriptionId: 'sub', modelId: 'model', objective: workPlan.objective,
            instruction: workPlan.instruction, expectedOutput: workPlan.expectedOutput, deliverables: workPlan.deliverables,
            dependsOn: [], skillIds: [], requiresUserConfirmation: false }] }
      } })
    const service = makeService()
    t.after(async () => { service.stop(); await runtime.stopAll(); await rm(root, { recursive: true, force: true }) })
    await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
    const output = ['success', 'publication-denied', 'publication-interrupted'].includes(mode) || dailyReport ? join(await realpath(root), 'output') : undefined
    if (output) {
      await mkdir(output)
      await writeFile(join(output, reportPath), 'previous report')
    }
    const input: ScheduleInput = { name: 'Report', goal: mode === 'legacy-path' ? String.raw`在 C:\Users\demo\Desktop 下创建报告` : 'Produce a report',
      ...(mode === 'general-conflict' ? { mode: 'general' as const } : { subscriptionId: 'sub', mode: mode === 'empty-file' || liveSkill ? 'auto' as const : undefined }), modelId: 'model', workDir: root,
      scheduledAt, timezone: 'Asia/Shanghai', permissions: { preset: 'workspace-edit', approvalMode: mode === 'tool-path-denied' ? 'auto-approve' : 'confirm-each' },
      ...(output ? { outputDirectory: { path: output } } : {}),
      ...(mode === 'empty-file' ? { recurrence: { frequency: 'cron', interval: 1, expression: '*/5 * * * *', preset: 'custom' } } : {}) }
    const created = await service.create('request', input, undefined, async path => path)
    const planned = await service.plan(created.id, created.revision)
    await service.confirm(created.id, planned.revision)
    now = scheduledAt
    await service.scan()
    let occurrence = (await service.list()).occurrences[0]
    if (mode === 'legacy-path') {
      assert.equal(occurrence.status, 'blocked')
      assert.equal(occurrence.error?.code, 'SCHEDULED_PATH_NOT_ALLOWED')
      assert.equal(await tasks.getTask(occurrence.taskId), null)
      assert.ok(!(await readdir(root)).includes(`scheduled-${occurrence.id}`))
      assert.equal(skillLoads, 0)
      assert.equal(executions, 0)
      return
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const task = await tasks.getTask(occurrence.taskId)
      const current = (await service.list()).occurrences[0]
      if (current?.status === 'review') break
      if (task && ['completed', 'failed'].includes(task.status) && !task.activeRunId) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (mode === 'publication-denied') {
      await rename(output!, join(root, 'original-output'))
      await mkdir(output!)
    }
    if (mode === 'publication-interrupted') {
      const key = createHash('sha256').update(JSON.stringify(['scheduled_file_publish', occurrence.input.outputDirectory?.identity, reportPath])).digest('hex')
      await storage.update(scope, snapshot => { snapshot.occurrences[0].operations = [{ key, tool: 'scheduled_file_publish', status: 'submitting', target: reportPath }] })
    }
    await service.scan()
    occurrence = (await service.list()).occurrences[0]
    assert.equal(occurrence.status, mode === 'success' || mode === 'empty-file' || mode === 'skill-alias' || missingWorkspaceRead || dailyReport ? 'completed' : mode === 'admission-uncertain' || mode === 'publication-interrupted' ? 'review' : 'failed')
    if (mode === 'publication-denied' || mode === 'publication-interrupted') {
      assert.equal(occurrence.error?.code, mode === 'publication-denied' ? 'SCHEDULED_OUTPUT_NOT_DELIVERED' : 'SCHEDULED_OUTPUT_UNCERTAIN')
      assert.deepEqual(occurrence.operations?.map(({ tool, target, status }) => ({ tool, target, status })), [{
        tool: 'scheduled_file_publish', target: reportPath, status: mode === 'publication-denied' ? 'not-executed' : 'unknown',
      }])
      const task = await tasks.getTask(occurrence.taskId)
      assert.equal(task?.status, 'completed')
      assert.equal(await readFile(join(task!.workDir!, reportPath), 'utf8'), reportContent)
      await service.scan()
      if (mode === 'publication-interrupted') assert.equal(await readFile(join(output!, reportPath), 'utf8'), 'previous report')
      else assert.deepEqual(await readdir(output!), [])
      return
    }
    if (mode === 'general-conflict') {
      assert.equal(occurrence.error?.code, 'FILE_ALREADY_EXISTS')
      assert.equal(executions, 0)
      assert.equal(await readFile(join((await tasks.getTask(occurrence.taskId))!.workDir!, reportPath), 'utf8'), 'previous content')
      assert.deepEqual((await checkpoints.get(scope, occurrence.taskId))?.state.nodes[0]?.delivery?.finalFiles, [])
      return
    }
    if (livePathDenial || mode === 'skill-alias-changed') {
      assert.equal(occurrence.error?.code, mode === 'skill-cache-path-denied' || mode === 'skill-alias-changed' ? 'SCHEDULED_SKILL_UNAVAILABLE' : 'SCHEDULED_PATH_NOT_ALLOWED')
      assert.equal(readSkillContent, false)
      assert.equal(occurrence.error?.action, 'blocked')
      assert.equal(requests, 1)
      assert.equal(validations, 0)
      assert.ok(eventTypes.includes('tool_call_blocked'))
      assert.ok(!eventTypes.includes('arrangement_node_completed'))
      const task = await tasks.getTask(occurrence.taskId)
      assert.ok(!(await readdir(task!.workDir!)).includes(liveSkill ? 'deliverables' : reportPath))
      const checkpoint = await checkpoints.get(scope, occurrence.taskId)
      assert.deepEqual(checkpoint?.state.nodes[0]?.delivery?.finalFiles, [])
      return
    }
    if (missingWorkspaceRead || dailyReport) {
      assert.equal(requests, dailyReport ? 5 : 3)
      if (dailyReport) {
        assert.deepEqual(queryCalls, [sqlArgs, tableSearchArgs, tableSearchArgs])
        assert.deepEqual(readResponses, ['SQL query failed', tableSearchResult, tableSearchResult])
        assert.deepEqual(occurrence.operations?.map(({ tool, status, target }) => [tool, status, target]), [['scheduled_file_publish', 'succeeded', reportPath]])
        assert.ok(!eventTypes.includes('scheduled_operation_failed'))
        assert.equal(await readFile(join(output!, reportPath), 'utf8'), reportContent)
        const names = await readdir(output!)
        assert.ok(!names.includes('销售1每日统计-dd-HH-mm.md'))
        const backup = names.find(name => name.startsWith('CSEP-备份-'))
        assert.ok(backup)
        assert.equal(await readFile(join(output!, backup), 'utf8'), 'previous report')
      } else assert.equal(sawMissingFile, true)
      assert.equal(validations, 1)
      assert.ok(!eventTypes.includes('tool_call_blocked'))
      const task = await tasks.getTask(occurrence.taskId)
      assert.equal(await readFile(join(task!.workDir!, reportPath), 'utf8'), reportContent)
      const checkpoint = await checkpoints.get(scope, occurrence.taskId)
      assert.equal(checkpoint?.state.nodes[0]?.delivery?.finalFiles[0]?.path, reportPath)
      return
    }
    if (mode === 'skill-alias') {
      assert.equal(requests, 4)
      assert.equal(validations, 1)
      assert.equal(aliasAdvertised, true)
      assert.equal(leakedSkillPath, false)
      assert.equal(readSkillContent, true)
      assert.deepEqual(recordedSkillLabel, { name: 'report-research', description: 'Research notes' })
      const task = await tasks.getTask(occurrence.taskId)
      assert.equal(await readFile(join(task!.workDir!, reportPath), 'utf8'), reportContent)
      const checkpoint = await checkpoints.get(scope, occurrence.taskId)
      assert.equal(checkpoint?.state.nodes[0]?.delivery?.finalFiles[0]?.path, reportPath)
      return
    }
    assert.equal(executions, 1)
    assert.equal(plannerCalls, 1)
    assert.ok(skillLoads >= 1)
    assert.equal(validations, mode === 'missing-file' || mode === 'invalid-submission' ? 2 : 1)
    if (mode === 'success') {
      assert.deepEqual(occurrence.operations?.map(({ tool, status, target }) => [tool, status, target]), [['scheduled_file_publish', 'succeeded', reportPath]])
      const task = await tasks.getTask(occurrence.taskId)
      assert.equal(await readFile(join(task!.workDir!, 'report.txt'), 'utf8'), 'Verified research findings')
      assert.equal(await readFile(join(output!, reportPath), 'utf8'), 'Verified research findings')
      const backups = (await readdir(output!)).filter(name => name.startsWith('CSEP-备份-'))
      assert.equal(backups.length, 1)
      assert.equal(await readFile(join(output!, backups[0]!), 'utf8'), 'previous report')
    } else if (mode === 'empty-file') {
      const task = await tasks.getTask(occurrence.taskId)
      assert.deepEqual(await readdir(task!.workDir!), ['20261120-1200.txt'])
      assert.equal((await readFile(join(task!.workDir!, '20261120-1200.txt'))).length, 0)
      const checkpoint = await checkpoints.get(scope, occurrence.taskId)
      assert.equal(checkpoint?.state.nodes[0]?.delivery?.finalFiles[0]?.snapshot?.size, 0)
    } else assert.equal(occurrence.error?.code, mode === 'missing-file' ? 'FILE_MISSING' : mode === 'invalid-submission' ? 'INVALID_SUBMISSION' : 'EXECUTION_UNCERTAIN')
    service.stop()
    const restarted = makeService()
    await restarted.recover(); await restarted.scan(); restarted.stop()
    assert.equal((await restarted.list()).occurrences.length, 1)
    assert.equal(executions, 1)
    assert.equal(plannerCalls, 1)
    const reloaded = new TaskManager(root)
    await reloaded.initialize(); await reloaded.setCurrentUser(scope.memberId, scope.enterpriseId)
    const receipt = await reloaded.getTask(occurrence.taskId)
    assert.equal(receipt?.scheduledOrigin?.occurrenceId, occurrence.id)
    assert.ok(receipt?.scheduledAdmission)
    if (mode === 'empty-file') {
      now += 300000
      await restarted.scan()
      const next = (await restarted.list()).occurrences.find(item => item.scheduledAt === now)!
      assert.notEqual(next.taskId, occurrence.taskId)
      const until = Date.now() + 5000
      while (Date.now() < until && (await tasks.getTask(next.taskId))?.status !== 'completed') await new Promise(resolve => setTimeout(resolve, 20))
      await restarted.scan()
      assert.equal((await restarted.list()).occurrences.find(item => item.id === next.id)?.status, 'completed')
      const task = await tasks.getTask(next.taskId)
      assert.deepEqual(await readdir(task!.workDir!), ['20261120-1205.txt'])
      assert.equal((await readFile(join(task!.workDir!, '20261120-1205.txt'))).length, 0)
    }
  })
}

test('reserved task IDs are idempotent and durable admission prevents a second execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-scheduled-receipt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manager = new TaskManager(root)
  await manager.initialize(); await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  const reservation = { id: 'reserved-task', origin: { definitionId: 'schedule', occurrenceId: 'occurrence' } }
  const [task, simultaneous] = await Promise.all([
    manager.createTask('Title', 'Goal', root, 'sub', reservation),
    manager.createTask('Title', 'Goal', root, 'sub', reservation),
  ])
  assert.equal(simultaneous.id, task.id)
  assert.equal((await manager.createTask('Title', 'Goal', root, 'sub', reservation)).id, task.id)
  await assert.rejects(manager.createTask('Title', 'Goal', root, 'sub', { ...reservation, origin: { ...reservation.origin, occurrenceId: 'other' } }))
  await assert.rejects(manager.admitTask(task.id, 'cancelled', () => { throw new Error('lifecycle changed') }))
  assert.equal((await manager.getTask(task.id))?.scheduledAdmission, undefined)
  await manager.admitTask(task.id, 'first')
  await manager.clearTaskRun(task.id, 'first')
  await assert.rejects(manager.admitTask(task.id, 'second'))
  assert.equal((await manager.getTask(task.id))?.scheduledAdmission?.runId, 'first')
})

test('scheduled preflight rejects missing authorization results before creating a task', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-scheduled-auth-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = new TaskManager(root)
  await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
  const runner = new ScheduledTaskRunner({ scope: { currentScope: () => tasks.getCurrentUserScope() }, tasks,
    workPlans: new WorkPlanStore(root), metadata: new TaskMetadataStore(root), checkpoints: new ArrangementCheckpointStore(root),
    runs: new TaskRunStore(root), storage: new ScheduledTaskStore(root), authorize: async () => null,
    execution: async () => { throw new Error('must not reach runtime') } })
  const occurrence: ScheduledOccurrence = { id: 'auth-occurrence', definitionId: 'auth-definition', revision: 1, scheduledAt: 2000,
    taskId: 'auth-task', input: { name: 'Report', goal: 'Produce a report', subscriptionId: 'sub', modelId: 'model', workDir: root,
      scheduledAt: 2000, timezone: 'UTC', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } },
    plan, status: 'preparing', firstEligibleAt: 2000, startDeadline: 5000, startedAt: null, finishedAt: null, nextRetryAt: null,
    error: null, attempts: [], stopReason: null }

  await assert.rejects(runner.prepare(occurrence), { code: 'EMPLOYEE_UNAVAILABLE' })
  assert.equal(await tasks.getTask(occurrence.taskId), null)

  for (const missingAuthorization of [undefined, false]) {
    const invalidRunner = new ScheduledTaskRunner({ scope: { currentScope: () => tasks.getCurrentUserScope() }, tasks,
      workPlans: new WorkPlanStore(root), metadata: new TaskMetadataStore(root), checkpoints: new ArrangementCheckpointStore(root),
      runs: new TaskRunStore(root), storage: new ScheduledTaskStore(root), authorize: async () => missingAuthorization,
      execution: async () => { throw new Error('must not reach runtime') } })
    await assert.rejects(invalidRunner.prepare({ ...occurrence, id: `auth-${String(missingAuthorization)}`, taskId: `task-${String(missingAuthorization)}` }), { code: 'EMPLOYEE_UNAVAILABLE' })
    assert.equal(await tasks.getTask(`task-${String(missingAuthorization)}`), null)
  }
})

test('scheduled automatic plans preserve a multi-employee DAG in the existing WorkPlan store', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-scheduled-dag-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = new TaskManager(root)
  await tasks.initialize(); await tasks.setCurrentUser(scope.memberId, scope.enterpriseId)
  const workPlans = new WorkPlanStore(root)
  const storage = new ScheduledTaskStore(root)
  const authorized: string[] = []
  const runner = new ScheduledTaskRunner({ scope: { currentScope: () => tasks.getCurrentUserScope() }, tasks, workPlans,
    metadata: new TaskMetadataStore(root), checkpoints: new ArrangementCheckpointStore(root), runs: new TaskRunStore(root), storage,
    authorize: async subscriptionId => { authorized.push(subscriptionId); return {} }, execution: async () => { throw new Error('not launched in this test') } })
  const arrangement: ArrangementWorkPlan = { status: 'ready', kind: 'arrangement', title: 'Research and report', intentAnalysis: null,
    nodes: [
      { id: 'research', subscriptionId: 'sub-a', modelId: 'model-a', title: 'Research', instruction: 'Gather evidence', expectedOutput: 'Evidence', deliverables: [{ id: 'evidence', name: 'Evidence', format: 'md', path: 'evidence.md', contentOutline: ['Sources'], acceptanceCriteria: ['Cited'] }], dependsOn: [], skillIds: [], requiresUserConfirmation: false },
      { id: 'report', subscriptionId: 'sub-b', modelId: 'model-b', title: 'Report', instruction: 'Write report', expectedOutput: 'Report', deliverables: [{ id: 'report-file', name: 'Report', format: 'md', path: 'report.md', contentOutline: ['Summary'], acceptanceCriteria: ['Complete'] }], dependsOn: ['research'], skillIds: [], requiresUserConfirmation: false },
    ] }
  const input: ScheduleInput = { mode: 'auto', name: 'Report', goal: 'Produce a report', subscriptionId: 'sub-a', modelId: 'model-a', workDir: root,
    scheduledAt: 2000, timezone: 'UTC', permissions: { preset: 'workspace-edit', approvalMode: 'confirm-each' } }
  const occurrence: ScheduledOccurrence = { id: 'occurrence', definitionId: 'definition', revision: 3, scheduledAt: 2000, taskId: 'scheduled-task',
    input, plan: arrangement, status: 'preparing', firstEligibleAt: 2000, startDeadline: 5000, startedAt: null, finishedAt: null,
    nextRetryAt: null, error: null, attempts: [], stopReason: null }
  await runner.prepare(occurrence)
  const plan = await workPlans.get(scope, occurrence.taskId)
  assert.deepEqual(plan?.nodes.map(node => [node.id, node.subscriptionId, node.dependsOn]), [['research', 'sub-a', []], ['report', 'sub-b', ['research']]])
  assert.deepEqual(authorized, ['sub-a', 'sub-b'])
})
