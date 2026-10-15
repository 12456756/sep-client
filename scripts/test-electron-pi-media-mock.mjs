/* global window */
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMediaMockEnvironment } from './electron-media-mock-policy.mjs'

const skillName = 'ecommerce-image-mock'
const submissionPath = '/api/gateway/v1/media/requests'
const gateway = 'http://127.0.0.1:1/pi-media-model-mock'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (condition, code) => { if (!condition) throw new Error(code) }
const equal = (actual, expected, code) => check(JSON.stringify(actual) === JSON.stringify(expected), code)
const metadata = skills => skills.map(({ name, versionId, sha256 }) => ({ name, versionId, sha256 }))

export function verifyPausedRestartAudit(audit, identity) {
  check(audit && audit.requests && typeof audit.requests === 'object', 'RESTART_AUDIT_MISSING')
  const relevant = path => path === submissionPath || path === '/api/gateway/v1/media/quotes'
    || path.startsWith(`${submissionPath}/${identity.receiptId}`)
    || path === `${submissionPath}/by-client-id/${identity.clientRequestId}`
  check(Object.entries(audit.requests).every(([path, count]) => !relevant(path) || count === 0), 'RESTART_NETWORK_RETRY')
  verifyFailureModelAudit(audit.piModel, 0)
}

export function verifyPiTimeline(events, { taskId, runId, subscriptionId, scenario, skillPath, referenceId, jobId }) {
  check(['DENY', 'SYNC', 'ASYNC', 'GENERATE', 'PARTIAL'].includes(scenario), 'INVALID_SCENARIO')
  check(Array.isArray(events) && events.length > 0, 'TIMELINE_MISSING')
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    check(event.taskId === taskId && event.runId === runId && event.subscriptionId === subscriptionId, 'TIMELINE_IDENTITY')
    check(Number.isSafeInteger(event.occurredAt) && event.occurredAt > 0, 'TIMELINE_TIMESTAMP')
    check(Number.isInteger(event.sequence) && (i === 0 || event.sequence > events[i - 1].sequence), 'TIMELINE_SEQUENCE')
    check(!['auto_retry_start', 'side_effect_unknown'].includes(event.type), 'UNEXPECTED_RETRY')
  }
  const starts = events.filter(event => event.type === 'tool_execution_start')
  const ends = events.filter(event => event.type === 'tool_execution_end')
  const expected = ['read', 'media_get_capabilities', 'media_generate_image', ...(scenario === 'DENY' ? [] : ['media_get_job'])]
  equal(starts.map(event => event.data.toolName), expected, 'PI_TOOL_ORDER')
  check(ends.length === starts.length && new Set(starts.map(event => event.data.toolId)).size === starts.length, 'PI_TOOL_PAIR_COUNT')
  starts.forEach((start, index) => {
    check(typeof start.data.toolId === 'string' && start.data.toolId.length > 0, 'PI_TOOL_ID')
    const matches = ends.filter(end => end.data.toolId === start.data.toolId)
    check(matches.length === 1, 'PI_TOOL_PAIR')
    const end = matches[0]
    check(end.data.toolName === start.data.toolName && end.sequence > start.sequence, 'PI_TOOL_PAIR')
    check(!starts[index + 1] || end.sequence < starts[index + 1].sequence, 'PI_TOOL_SERIAL_ORDER')
    check(end.data.success === !(scenario === 'DENY' && start.data.toolName === 'media_generate_image'), 'PI_TOOL_RESULT')
  })
  equal(starts[0].data.input, { path: skillPath }, 'PI_REAL_SKILL_READ')
  equal(starts[1].data.input, {}, 'PI_CAPABILITIES_INPUT')
  const generation = starts[2].data.input
  check(generation.profileId === (scenario === 'ASYNC' ? 'mock-async' : 'mock-sync'), 'PI_PROFILE')
  check(generation.operation === (scenario === 'SYNC' ? 'edit' : 'generate'), 'PI_OPERATION')
  if (scenario === 'SYNC') check(typeof referenceId === 'string' && referenceId.length > 0, 'REFERENCE_REQUIRED')
  equal(generation.localAssetIds, scenario === 'SYNC' ? [referenceId] : [], 'PI_REFERENCES')
  equal(generation.parameters, { aspectRatio: '1:1', count: scenario === 'PARTIAL' ? 2 : 1, size: '1x1' }, 'PI_PARAMETERS')
  if (scenario !== 'DENY') {
    check(typeof jobId === 'string' && jobId.length > 0, 'JOB_REQUIRED')
    equal(starts[3].data.input, { jobId }, 'PI_ORIGINAL_JOB')
  }
  const requested = events.filter(event => event.type === 'approval_requested')
  const resolved = events.filter(event => event.type === 'approval_resolved')
  equal(requested.map(event => event.data.input.operation), scenario === 'SYNC' ? ['upload-references', 'edit'] : ['generate'], 'APPROVAL_ORDER')
  check(resolved.length === requested.length && new Set(requested.map(event => event.data.requestId)).size === requested.length, 'APPROVAL_PAIR_COUNT')
  requested.forEach((request, index) => {
    const matches = resolved.filter(event => event.data.requestId === request.data.requestId)
    check(matches.length === 1 && request.data.toolName === 'media_generate_image', 'APPROVAL_PAIR')
    const result = matches[0]
    check(result.data.toolName === request.data.toolName && result.data.approved === (scenario !== 'DENY'), 'APPROVAL_DECISION')
    // Host approvals and buffered worker events have separate producers; sequence is persistence order.
    const generationEnd = ends.find(end => end.data.toolId === starts[2].data.toolId)
    check(request.occurredAt >= starts[2].occurredAt && result.occurredAt >= request.occurredAt
      && result.occurredAt <= generationEnd.occurredAt && result.sequence > request.sequence
      && result.sequence < generationEnd.sequence, 'APPROVAL_TOOL_ORDER')
    check(!requested[index + 1] || result.sequence < requested[index + 1].sequence, 'APPROVAL_SERIAL_ORDER')
    check(request.data.input.referenceCount === (scenario === 'SYNC' ? 1 : 0), 'APPROVAL_REFERENCES')
  })
  const finished = events.filter(event => event.type === 'agent_end')
  check(finished.length === 1 && !finished[0].data?.willRetry && finished[0].sequence > ends.at(-1).sequence, 'PI_FINAL_MISSING')
  check(events.some(event => event.type === 'text_delta' && typeof event.data?.text === 'string' && event.data.text.trim()), 'PI_FINAL_TEXT_MISSING')
  // Persist only structural evidence, never tool bodies, prompts, or Skill paths.
  return {
    taskId, runId, scenario, finalTextObserved: true,
    tools: starts.map(start => ({ toolName: start.data.toolName, toolId: start.data.toolId,
      success: ends.find(end => end.data.toolId === start.data.toolId).data.success })),
    approvals: requested.map(request => ({ requestId: request.data.requestId,
      operation: request.data.input.operation, approved: scenario !== 'DENY' })),
    profileId: generation.profileId, operation: generation.operation, referenceCount: generation.localAssetIds.length,
  }
}

export function verifySkillSnapshot(snapshot, task, runId, prepared) {
  check(snapshot.version === 1 && snapshot.taskId === task.id && snapshot.runId === runId
    && snapshot.subscriptionId === task.subscriptionId, 'SNAPSHOT_IDENTITY')
  check(snapshot.owner?.memberId === task.ownerId && snapshot.owner?.enterpriseId === task.ownerEnterpriseId, 'SNAPSHOT_OWNER')
  const runtime = snapshot.runtimeSnapshot
  check(runtime?.manifestVersion === 1 && runtime.subscriptionId === task.subscriptionId
    && runtime.enterpriseId === task.ownerEnterpriseId && runtime.memberId === task.ownerId, 'RUNTIME_SNAPSHOT_IDENTITY')
  check(snapshot.systemPrompt === runtime.systemPrompt, 'SNAPSHOT_SYSTEM_PROMPT')
  check(Array.isArray(runtime.skills) && runtime.skills.length === prepared.skills.length, 'SNAPSHOT_SKILLS')
  equal(snapshot.skills, runtime.skills.map(({ path, sha256, version }) => ({ path, sha256, version })), 'SNAPSHOT_SKILL_PROJECTION')
  for (const skill of runtime.skills) {
    const installed = prepared.skills.filter(item => item.name === skill.name && item.versionId === skill.versionId)
    check(installed.length === 1 && installed[0].sha256 === skill.sha256
      && installed[0].path === join(skill.path, 'SKILL.md') && hash(skill.content) === skill.sha256, 'SNAPSHOT_SKILL_HASH')
  }
  const selected = runtime.skills.filter(skill => skill.name === skillName)
  check(selected.length === 1 && selected[0].source === 'approved', 'SNAPSHOT_APPROVED_SKILL')
  const skill = selected[0]
  check(skill.content.includes('SEP_ECOMMERCE_IMAGE_MOCK_V1'), 'SNAPSHOT_SKILL_MARKER')
  const approved = runtime.approvedSkills.filter(item => item.capabilityId === skill.capabilityId)
  // Platform display names and local version IDs differ from installed frontmatter and raw IDs.
  check(approved.length === 1 && approved[0].versionId === skill.baseSkillVersionId
    && skill.version === approved[0].version, 'SNAPSHOT_APPROVED_VERSION')
  const artifact = skill.artifact, approvedArtifact = approved[0].artifact
  check(artifact?.status === 'AVAILABLE' && approvedArtifact?.status === 'AVAILABLE'
    && artifact.capabilityId === skill.capabilityId && approvedArtifact.capabilityId === skill.capabilityId
    && artifact.versionId === skill.baseSkillVersionId && approvedArtifact.versionId === skill.baseSkillVersionId, 'SNAPSHOT_ARTIFACT_IDENTITY')
  check(artifact.entrySha256 === skill.sha256 && approvedArtifact.entrySha256 === skill.sha256
    && artifact.approvedContentSha256 === hash(approved[0].content)
    && approvedArtifact.approvedContentSha256 === artifact.approvedContentSha256
    && /^[a-f0-9]{64}$/.test(artifact.artifactSha256)
    && approvedArtifact.artifactSha256 === artifact.artifactSha256, 'SNAPSHOT_ARTIFACT_HASH')
  return { taskId: task.id, runId, skills: metadata(runtime.skills), selected: {
    name: skill.name, versionId: skill.versionId, baseSkillVersionId: skill.baseSkillVersionId,
    version: skill.version, sha256: skill.sha256, source: skill.source,
  } }
}

export function verifyModelAudit(audit, recovery = false) {
  check(audit && typeof audit === 'object', 'MODEL_AUDIT_MISSING')
  equal(audit.steps, recovery
    ? { read: 0, media_get_capabilities: 0, media_generate_image: 0, media_get_job: 0, final: 0, businessError: 0 }
    : { read: 3, media_get_capabilities: 3, media_generate_image: 3, media_get_job: 2, final: 3, businessError: 1 }, 'MODEL_AUDIT_STEPS')
  check(audit.skillReadVerified === !recovery && audit.generationCount === (recovery ? 0 : 3), 'MODEL_AUDIT_GENERATION')
  check(Number.isInteger(audit.requests) && (recovery ? audit.requests === 0 : audit.requests >= 14), 'MODEL_AUDIT_REQUESTS')
  return { requests: audit.requests, steps: { ...audit.steps }, skillReadVerified: audit.skillReadVerified, generationCount: audit.generationCount }
}

export function verifyCleanClose(error, code, signal) {
  check(code === 0 && signal === null, 'PROCESS_EXIT_NOT_CLEAN')
  const targetClosed = error instanceof Error && /Target (?:page, context or browser has been closed|closed)|Session closed/.test(error.message)
  check(error === undefined || targetClosed, 'AUTOMATION_CLOSE_FAILED')
  return { code, signal, automationTargetClosed: targetClosed }
}

export function verifyShutdownMarker(value, shutdownId) {
  check(value?.completed === true && value.shutdownId === shutdownId, 'PROCESS_CLEANUP_NOT_VERIFIED')
  return { cleanupCompleted: true }
}

export function verifyPersistedJobIdentity(job, task, jobId, runId) {
  check(job?.owner?.memberId === task.ownerId && job.owner.enterpriseId === task.ownerEnterpriseId
    && job.taskId === task.id && job.subscriptionId === task.subscriptionId
    && job.jobId === jobId && job.runId === runId && job.submission === 'RECEIPTED', 'PERSISTED_JOB_IDENTITY')
  check([job.receiptId, job.clientRequestId, job.profile?.configVersion].every(value =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))
    && /^[a-f0-9]{64}$/.test(job.requestHash ?? '')
    && job.request?.clientRequestId === job.clientRequestId && job.request.requestHash === job.requestHash
    && job.request.configVersion === job.profile.configVersion, 'PERSISTED_RECEIPT_IDENTITY')
  return { jobId, runId, receiptId: job.receiptId, clientRequestId: job.clientRequestId,
    requestHash: job.requestHash, configVersion: job.profile.configVersion,
    frozenProfileSha256: hash(Buffer.from(JSON.stringify(job.profile))) }
}

export function verifyFailureJobIdentity(job, task, jobId, runId) {
  const identity = verifyPersistedJobIdentity(job, task, jobId, runId)
  check(job.approval === 'manual' && job.quote?.quoteId === job.request?.quoteId
    && job.quote?.requestHash === job.requestHash, 'PERSISTED_APPROVAL_IDENTITY')
  return { ...identity, requestSha256: hash(Buffer.from(JSON.stringify(job.request))),
    quoteSha256: hash(Buffer.from(JSON.stringify(job.quote))), approval: job.approval }
}

export function verifyFailureModelAudit(audit, tasks) {
  check(audit?.steps && Number.isSafeInteger(tasks) && tasks >= 0, 'MODEL_AUDIT_MISSING')
  equal(audit.steps, { read: tasks, media_get_capabilities: tasks, media_generate_image: tasks,
    media_get_job: tasks, final: tasks, businessError: audit.steps.businessError }, 'MODEL_AUDIT_STEPS')
  check(Number.isSafeInteger(audit.steps.businessError) && audit.steps.businessError >= 0
    && audit.steps.businessError <= tasks && audit.generationCount === tasks
    && audit.skillReadVerified === (tasks > 0) && (tasks > 0 ? audit.requests >= tasks * 5 : audit.requests === 0), 'MODEL_AUDIT_GENERATION')
}

export async function openWorkRecord(page, title) {
  await page.getByRole('button', { name: /^工作记录(?:\s*\d+)?$/ }).click()
  for (const name of ['按状态筛选工作记录', '按类型筛选工作记录']) {
    await page.getByRole('group', { name, exact: true }).getByRole('button', { name: /^全部/ }).click()
  }
  await page.getByRole('searchbox', { name: '搜索工作记录', exact: true }).fill('')
  await page.getByText(title, { exact: true }).first().click({ timeout: 20_000 })
  await page.getByRole('region', { name: '图片创作与成果' }).waitFor({ timeout: 20_000 })
}

async function poll(read, code, { timeout = 30_000, interval = 80 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await new Promise(done => setTimeout(done, interval))
  }
  throw new Error(code)
}

function localRoot(value) {
  const url = new URL(value)
  check(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/api', 'LOOPBACK_API_REQUIRED')
  return value
}

export async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const output = process.env.SEP_ELECTRON_MOCK_OUTPUT ? resolve(process.env.SEP_ELECTRON_MOCK_OUTPUT)
    : join(root, 'outputs', `electron-pi-media-mock-${Date.now()}`)
  await mkdir(output, { recursive: true })
  const failureScenarios = process.env.SEP_ELECTRON_PI_MEDIA_FAILURES === 'true'
  const evidence = { explicitMock: true, failureScenarios, realLogin: false, gateway, mcpEnabled: false,
    phases: [], processes: [], lifecycle: [], screenshots: [], step: 'preflight', passed: false }
  let application, page, profile, shutdownId, processNumber = 0
  const control = (fn, arg) => application.evaluate(fn, arg)
  const shot = async name => {
    await page.screenshot({ path: join(output, `${name}.png`) })
    evidence.screenshots.push(`${name}.png`)
  }
  async function ipc(method, ...args) {
    const result = await page.evaluate(([name, inputs]) => window.electronAPI[name](...inputs), [method, args])
    check(result?.success === true, 'IPC_FAILED')
    return result
  }
  async function launch() {
    evidence.step = 'launch-login'
    shutdownId = randomUUID()
    const [{ _electron }, { default: electron }] = await Promise.all([import('playwright-core'), import('electron')])
    application = await _electron.launch({ executablePath: electron, cwd: root, args: [join(root, 'out/main/media-mock.js')],
      env: { ...createMediaMockEnvironment(process.env), SEP_ELECTRON_MEDIA_MOCK: 'true', SEP_ELECTRON_PI_MEDIA_MOCK: 'true',
        SEP_ELECTRON_MOCK_SHUTDOWN_ID: shutdownId,
        SEP_ELECTRON_MOCK_PROFILE: profile, SEP_BASE_URL: localRoot(process.env.SEP_BASE_URL ?? 'http://127.0.0.1:3001/api'),
        SEP_ELECTRON_MOCK_MEDIA_URL: localRoot(process.env.SEP_ELECTRON_MOCK_MEDIA_URL ?? 'http://127.0.0.1:3002/api'),
        SEP_WEB_ORIGIN: 'http://localhost:3000', SEP_GATEWAY_URL: gateway }, timeout: 30_000 })
    const currentProcess = ++processNumber
    application.process().on('exit', (code, signal) => evidence.lifecycle.push({ process: currentProcess, event: 'process-exit', code, signal }))
    page = await application.firstWindow()
    page.on('close', () => evidence.lifecycle.push({ process: currentProcess, event: 'page-close' }))
    await page.waitForFunction(() => Boolean(window.electronAPI))
    const blockedBefore = (await control(() => globalThis.__sepMediaTest.evidence())).rendererBlockedRequests
    const externalImageBlocked = await page.evaluate(() => new Promise(resolve => {
      const image = new window.Image()
      image.onload = () => resolve(false)
      image.onerror = () => resolve(true)
      image.src = 'https://sep-media-mock-network-probe.invalid/image.png'
    }))
    const networkAudit = await control(() => globalThis.__sepMediaTest.evidence())
    check(externalImageBlocked && networkAudit.rendererNetworkRestricted === true && !networkAudit.mcpConfigured
      && networkAudit.rendererBlockedRequests > blockedBefore, 'RENDERER_NETWORK_BOUNDARY')
    await control(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) { win.on('show', () => win.hide()); win.hide() }
    })
    evidence.step = 'launch-await-auth-screen'
    const email = page.getByLabel('邮箱', { exact: true })
    await poll(async () => {
      if (await email.isVisible()) return 'login'
      const result = await page.evaluate(() => window.electronAPI.getSubscriptions())
      return result.success && result.data.length > 0 ? 'authenticated' : false
    }, 'LOGIN_SCREEN_TIMEOUT')
    if (await email.isVisible()) {
      evidence.step = 'launch-fill-login'
      await email.fill(process.env.SEP_ELECTRON_TEST_EMAIL ?? 'staff@acme.local')
      await page.getByLabel('密码', { exact: true }).fill(process.env.SEP_ELECTRON_TEST_PASSWORD ?? 'Demo123456')
      evidence.step = 'launch-submit-login'
      await page.getByRole('button', { name: '登录', exact: true }).click()
      evidence.step = 'launch-await-login'
      await email.waitFor({ state: 'hidden', timeout: 20_000 })
      evidence.realLogin = true
    }
    evidence.step = 'launch-await-subscriptions'
    await poll(async () => {
      const result = await page.evaluate(() => window.electronAPI.getSubscriptions())
      return result.success && Array.isArray(result.data) && result.data.length > 0
    }, 'LOGIN_SUBSCRIPTIONS_TIMEOUT', { timeout: 20_000, interval: 250 })
  }
  async function close() {
    if (!application) return
    const current = application
    try {
      const raw = await control(() => globalThis.__sepMediaTest.evidence())
      evidence.processes.push({ process: processNumber, requests: raw.requests, responses: raw.responses,
        blockedRequests: raw.blockedRequests, mediaErrorCount: raw.mediaErrors.length, runtimeLoaded: raw.runtimeLoaded,
        rendererBlockedRequests: raw.rendererBlockedRequests, rendererNetworkRestricted: raw.rendererNetworkRestricted,
        mcpConfigured: raw.mcpConfigured, piModel: raw.piModel, piErrors: raw.piErrors ?? [], faults: raw.faults })
    } finally {
      evidence.step = 'close-process'
      const child = current.process()
      let closeError
      try { await current.close() } catch (error) { closeError = error } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise(done => {
            const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); done() }
            const timer = setTimeout(finish, 5000)
            child.once('exit', finish)
          })
        }
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise(done => { child.once('exit', done); child.kill('SIGKILL') })
        }
        application = undefined
      }
      evidence.lifecycle.push({ process: processNumber, event: 'automation-close',
        ...verifyCleanClose(closeError, child.exitCode, child.signalCode) })
      const marker = await readFile(join(profile, `media-mock-shutdown-${shutdownId}.json`), 'utf8')
        .catch(() => { throw new Error('PROCESS_CLEANUP_NOT_VERIFIED') })
      evidence.lifecycle.push({ process: processNumber, event: 'cleanup-verified',
        ...verifyShutdownMarker(JSON.parse(marker), shutdownId) })
    }
  }
  async function viewTask(title) {
    evidence.step = 'open-work-record'
    await openWorkRecord(page, title)
  }
  async function prepare(subscriptionId) {
    evidence.step = 'prepare-approved-skill'
    const prepared = await control((_, id) => globalThis.__sepMediaTest.prepare(id), subscriptionId)
    check(prepared.subscriptionId === subscriptionId && prepared.productionExecutionAvailable === false, 'EXPLICIT_MOCK_REQUIRED')
    check(Array.isArray(prepared.skills) && prepared.skills.filter(skill => skill.name === skillName).length === 1, 'APPROVED_SKILL_REQUIRED')
    for (const skill of prepared.skills) check(hash(await readFile(skill.path)) === skill.sha256, 'INSTALLED_SKILL_HASH')
    const skill = prepared.skills.find(item => item.name === skillName)
    check((await readFile(skill.path, 'utf8')).includes('SEP_ECOMMERCE_IMAGE_MOCK_V1'), 'INSTALLED_SKILL_MARKER')
    check(typeof prepared.referenceFixtureBase64 === 'string' && /^[a-f0-9]{64}$/.test(prepared.referenceFixtureSha256), 'FIXTURE_REQUIRED')
    check(hash(Buffer.from(prepared.referenceFixtureBase64, 'base64')) === prepared.referenceFixtureSha256, 'FIXTURE_HASH')
    return prepared
  }
  async function create(scenario, subscriptionId) {
    evidence.step = `create-${scenario.toLowerCase()}`
    const title = `Pi media mock ${scenario} ${Date.now()}`
    const result = await ipc('createConversation', { title, subscriptionId,
      prompt: `[SEP_PI_MEDIA_MOCK_${scenario}] ecommerce-image-mock 独立验收，仅使用已批准 Skill 和媒体工具。` })
    check(result.task?.subscriptionId === subscriptionId && result.task.prompt.includes(`[SEP_PI_MEDIA_MOCK_${scenario}]`), 'INITIAL_PROMPT_BINDING')
    check((await ipc('listTaskRuns', result.task.id)).runs.length === 0, 'NEW_TASK_ALREADY_EXECUTED')
    await viewTask(title)
    return { ...result.task, title }
  }
  async function timeline(task) {
    const runs = (await ipc('listTaskRuns', task.id)).runs
    if (!runs.length) return null
    check(runs.length === 1 && runs[0].subscriptionId === task.subscriptionId, 'INDEPENDENT_PI_RUN_REQUIRED')
    return { run: runs[0], events: (await ipc('getTaskTimeline', task.id, runs[0].id)).events }
  }
  async function decide(task, operation, approved, name) {
    evidence.step = `${operation}-approval`
    const pending = await poll(async () => {
      const state = await timeline(task)
      if (!state) return false
      return state.events.find(event => event.type === 'approval_requested'
        && !state.events.some(result => result.type === 'approval_resolved' && result.data.requestId === event.data.requestId))
    }, 'APPROVAL_TIMEOUT')
    check(pending.data.toolName === 'media_generate_image' && pending.data.input.operation === operation, 'UNEXPECTED_UI_APPROVAL')
    const button = page.getByRole('button', { name: approved ? '允许工具执行' : '拒绝工具执行', exact: true })
    await button.waitFor({ timeout: 20_000 })
    await shot(name)
    await button.click()
    await poll(async () => {
      const state = await timeline(task)
      const result = state.events.find(event => event.type === 'approval_resolved' && event.data.requestId === pending.data.requestId)
      if (result) check(result.data.approved === approved, 'UI_APPROVAL_NOT_APPLIED')
      return result
    }, 'UI_APPROVAL_RESOLUTION_TIMEOUT')
  }
  async function completedTimeline(task, scenario, prepared, jobId, referenceId) {
    evidence.step = `${scenario.toLowerCase()}-verify-timeline`
    const state = await poll(async () => {
      const current = await timeline(task)
      return current?.events.some(event => event.type === 'agent_end' && !event.data?.willRetry) ? current : false
    }, 'PI_COMPLETION_TIMEOUT')
    return { runId: state.run.id, evidence: verifyPiTimeline(state.events, {
      taskId: task.id, runId: state.run.id, subscriptionId: task.subscriptionId, scenario,
      skillPath: prepared.skills.find(skill => skill.name === skillName).path, jobId, referenceId,
    }) }
  }
  function mediaRoot(task) {
    check(/^[A-Za-z0-9_-]{1,128}$/.test(task.id), 'UNSAFE_SNAPSHOT_ID')
    check(typeof task.ownerId === 'string' && typeof task.ownerEnterpriseId === 'string', 'TASK_OWNER_MISSING')
    return join(profile, 'task-data/v3', Buffer.from(task.ownerEnterpriseId).toString('base64url'),
      Buffer.from(task.ownerId).toString('base64url'), 'tasks', task.id, 'media')
  }
  async function snapshot(task, runId, prepared) {
    check(/^[A-Za-z0-9_-]{1,128}$/.test(runId), 'UNSAFE_SNAPSHOT_ID')
    const path = join(mediaRoot(task), 'snapshots', `${runId}.json`)
    const bytes = await readFile(path)
    return { ...verifySkillSnapshot(JSON.parse(bytes.toString('utf8')), task, runId, prepared), snapshotSha256: hash(bytes) }
  }
  async function persistedIdentity(task, jobId, runId) {
    check(/^[A-Za-z0-9_-]{1,128}$/.test(jobId), 'UNSAFE_JOB_ID')
    const value = JSON.parse(await readFile(join(mediaRoot(task), 'jobs', `${jobId}.json`), 'utf8'))
    return verifyPersistedJobIdentity(value, task, jobId, runId)
  }
  async function savedJob(task, profileId, count = 1) {
    return poll(async () => {
      const view = (await ipc('getTaskMedia', task.id)).data
      check(view.jobs.length <= 1, 'DUPLICATE_GENERATION')
      const job = view.jobs[0]
      if (!job || job.saveStatus !== 'SAVED') return false
      check(job.profileId === profileId && job.generationStatus === 'SUCCEEDED'
        && job.billingStatus === 'MOCK_NOT_CHARGED' && job.assets.filter(asset => asset.source === 'output').length === count, 'SAVED_MOCK_JOB_INVALID')
      return { view, job }
    }, 'MEDIA_SAVE_TIMEOUT', { timeout: 60_000 })
  }
  const jobEvidence = job => ({ jobId: job.jobId, taskId: job.taskId, runId: job.runId, profileId: job.profileId,
    operation: job.operation, generationStatus: job.generationStatus, saveStatus: job.saveStatus, billingStatus: job.billingStatus })
  async function exportImage(name, expectedHash) {
    await page.getByRole('button', { name: '放大查看成果 1', exact: true }).click()
    await page.getByRole('dialog', { name: '图片大图预览' }).waitFor()
    await poll(() => page.locator('.media-preview-dialog img').evaluate(image => image.complete && image.naturalWidth === 1 && image.naturalHeight === 1), 'PREVIEW_DECODE_TIMEOUT')
    await shot(`${name}-preview`)
    const exportPath = join(output, `${name}-export.png`)
    await control(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, exportPath)
    await page.getByRole('button', { name: '导出图片', exact: true }).click()
    await poll(async () => {
      try { check(hash(await readFile(exportPath)) === expectedHash, 'EXPORT_HASH'); return true }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }, 'EXPORT_TIMEOUT')
    await page.getByRole('button', { name: '关闭大图预览', exact: true }).click()
    return { file: `${name}-export.png`, sha256: expectedHash, decoded: true }
  }
  const submitted = async () => (await control(() => globalThis.__sepMediaTest.evidence())).requests[submissionPath] ?? 0
  async function failureIdentity(task, job, runId) {
    check(job.runId === runId, 'JOB_PI_RUN_MISMATCH')
    const stored = JSON.parse(await readFile(join(mediaRoot(task), 'jobs', `${job.jobId}.json`), 'utf8'))
    return verifyFailureJobIdentity(stored, task, job.jobId, runId)
  }
  async function diskEvidence(task, expectedCount, expectedHash) {
    const names = await readdir(mediaRoot(task), { recursive: true })
    check(!names.some(name => name.endsWith('.part')), 'UNCOMMITTED_MEDIA_PART')
    const images = names.filter(name => name.startsWith('files/') && name.endsWith('.png')).sort()
    check(images.length === expectedCount, 'DISK_OUTPUT_COUNT')
    return Promise.all(images.map(async name => {
      check(/^files\/[A-Za-z0-9_-]+\.png$/.test(name), 'UNSAFE_MEDIA_FILE')
      const path = join(mediaRoot(task), name), bytes = await readFile(path), info = await stat(path)
      check(hash(bytes) === expectedHash, 'DISK_OUTPUT_HASH')
      return { file: name, sha256: hash(bytes), bytes: bytes.length, inode: info.ino, mtimeMs: info.mtimeMs }
    }))
  }
  async function runFailures(subscriptionId, initialPreparation) {
    let prepared = initialPreparation
    const scenarios = [
      { fault: 'AUTH_QUERY', scenario: 'ASYNC', count: 1, saved: 0, auth: true, restart: true },
      { fault: 'AUTH_DOWNLOAD', scenario: 'GENERATE', count: 1, saved: 0, auth: true, restart: true },
      { fault: 'CORRUPT_DOWNLOAD', scenario: 'GENERATE', count: 1, saved: 0, auth: false, restart: false },
      { fault: 'PARTIAL_DOWNLOAD', scenario: 'PARTIAL', count: 2, saved: 1, auth: false, restart: true },
    ]
    for (const [index, scenario] of scenarios.entries()) {
      if (index) {
        evidence.step = 'wait-failure-auth-window'
        await new Promise(done => setTimeout(done, 62_000))
      }
      const label = scenario.fault.toLowerCase()
      const task = await create(scenario.scenario, subscriptionId)
      await control((_, kind) => globalThis.__sepMediaTest.fault(kind), scenario.fault)
      const beforePosts = await submitted()
      await ipc('executeTask', task.id)
      await decide(task, 'generate', true, `${label}-approval`)
      evidence.step = `${label}-wait-persisted-failure`
      const failed = await poll(async () => {
        const view = (await ipc('getTaskMedia', task.id)).data
        check(view.jobs.length <= 1, 'DUPLICATE_GENERATION')
        const job = view.jobs[0]
        if (!job || (scenario.auth ? job.trackingStatus !== 'AUTH_REQUIRED'
          : job.saveStatus !== 'SAVE_FAILED' || job.trackingStatus !== 'STOPPED')) return false
        check(job.assets.length === scenario.saved && job.billingStatus === 'MOCK_NOT_CHARGED', 'FAILED_ASSET_COUNT')
        return { view, job }
      }, 'EXPECTED_MEDIA_FAILURE_TIMEOUT')
      const run = await completedTimeline(task, scenario.scenario, prepared, failed.job.jobId)
      const eventSha256 = hash(Buffer.from(JSON.stringify((await timeline(task)).events)))
      const identity = await failureIdentity(task, failed.job, run.runId)
      const frozen = await snapshot(task, run.runId, prepared)
      const originalFiles = await diskEvidence(task, scenario.saved, prepared.referenceFixtureSha256)
      const audit = await control(() => globalThis.__sepMediaTest.evidence())
      check(audit.faults.injected > 0 && audit.faults.targetReceiptId === identity.receiptId
        && audit.faults.targetClientRequestId === identity.clientRequestId && await submitted() === beforePosts + 1, 'FAULT_NOT_BOUND_TO_ACCEPTED_REQUEST')
      const jobUi = () => page.locator('.media-job').filter({ hasText: failed.job.jobId })
      await jobUi().getByText(scenario.auth ? '需要恢复认证' : '本地保存失败', { exact: true }).waitFor()
      await jobUi().scrollIntoViewIfNeeded()
      await shot(`${label}-paused`)
      const phase = { name: label, job: jobEvidence(failed.job), trackingStatus: failed.job.trackingStatus,
        identity, timeline: run.evidence, snapshot: frozen, faults: audit.faults, filesBefore: originalFiles, originalProcess: processNumber }
      evidence.phases.push(phase)

      // Restored permission alone never resumes a persisted authorization pause.
      await control(() => globalThis.__sepMediaTest.fault(null))
      if (scenario.restart) {
        await close()
        evidence.step = `${label}-wait-restart-auth-window`
        await new Promise(done => setTimeout(done, 62_000))
        await launch()
        prepared = await prepare(subscriptionId)
        equal(metadata(prepared.skills), metadata(initialPreparation.skills), 'RECOVERY_SKILL_VERSION_CHANGED')
        await viewTask(task.title)
      }
      const idleBefore = await control(() => globalThis.__sepMediaTest.evidence())
      if (scenario.restart) verifyPausedRestartAudit(idleBefore, identity)
      await control(() => globalThis.__sepMediaTest.scanPending())
      await new Promise(done => setTimeout(done, 3500))
      const idle = (await ipc('getTaskMedia', task.id)).data.jobs[0]
      check(idle.jobId === failed.job.jobId && idle.trackingStatus === failed.job.trackingStatus
        && idle.saveStatus === failed.job.saveStatus && idle.assets.length === scenario.saved, 'PAUSED_JOB_AUTO_RESUMED')
      equal(await failureIdentity(task, idle, run.runId), identity, 'IDLE_RECEIPT_IDENTITY_CHANGED')
      equal(await diskEvidence(task, scenario.saved, prepared.referenceFixtureSha256), originalFiles, 'IDLE_FILES_CHANGED')
      const idleAfter = await control(() => globalThis.__sepMediaTest.evidence())
      const relevant = path => path === submissionPath || path === '/api/gateway/v1/media/quotes'
        || path.startsWith(`${submissionPath}/${identity.receiptId}`) || path === `${submissionPath}/by-client-id/${identity.clientRequestId}`
      equal(Object.entries(idleAfter.requests).filter(([path]) => relevant(path)),
        Object.entries(idleBefore.requests).filter(([path]) => relevant(path)), 'IDLE_NETWORK_RETRY')
      await jobUi().getByText(scenario.auth ? '需要恢复认证' : '本地保存失败', { exact: true }).waitFor()
      await jobUi().scrollIntoViewIfNeeded()
      await shot(`${label}-restored-not-resumed`)
      const action = scenario.auth ? '恢复跟踪' : '重新保存'
      const postsBeforeResume = await submitted()
      await jobUi().getByRole('button', { name: action, exact: true }).click()
      const result = await savedJob(task, scenario.scenario === 'ASYNC' ? 'mock-async' : 'mock-sync', scenario.count)
      equal(await failureIdentity(task, result.job, run.runId), identity, 'RECOVERY_RECEIPT_IDENTITY_CHANGED')
      const afterSnapshot = await snapshot(task, run.runId, prepared)
      check(afterSnapshot.snapshotSha256 === frozen.snapshotSha256 && await submitted() === postsBeforeResume, 'RECOVERY_REGENERATED')
      check(hash(Buffer.from(JSON.stringify((await timeline(task)).events))) === eventSha256, 'RECOVERY_TIMELINE_CHANGED')
      const afterRun = await completedTimeline(task, scenario.scenario, prepared, result.job.jobId)
      equal(afterRun, run, 'RECOVERY_PI_RERUN')
      const finalFiles = await diskEvidence(task, scenario.count, prepared.referenceFixtureSha256)
      for (const file of originalFiles) equal(finalFiles.find(item => item.file === file.file), file, 'SAVED_FIRST_IMAGE_REWRITTEN')
      const resumedAudit = await control(() => globalThis.__sepMediaTest.evidence())
      equal(resumedAudit.piModel, idleAfter.piModel, 'RESUME_CALLED_MODEL')
      check((resumedAudit.requests['/api/gateway/v1/media/quotes'] ?? 0) === (idleAfter.requests['/api/gateway/v1/media/quotes'] ?? 0), 'RESUME_REQUOTED')
      if (scenario.saved) {
        const firstPath = `${submissionPath}/${identity.receiptId}/outputs/${audit.faults.allowedOutputId}/content`
        check((resumedAudit.requests[firstPath] ?? 0) === (idleAfter.requests[firstPath] ?? 0), 'SAVED_FIRST_IMAGE_REDOWNLOADED')
      }
      await jobUi().getByText('已保存到本地', { exact: true }).waitFor()
      await jobUi().scrollIntoViewIfNeeded()
      await shot(`${label}-saved`)
      phase.recovery = { process: processNumber, action, originalIdentityUnchanged: true, snapshotUnchanged: true,
        modelUnchanged: true, extraSubmissions: 0, firstImageUnchanged: originalFiles.length > 0,
        files: finalFiles, export: await exportImage(label, prepared.referenceFixtureSha256) }
    }
    await close()
    const modelTasks = evidence.processes.map(item => item.piModel?.generationCount)
    check(modelTasks.reduce((sum, count) => sum + count, 0) === 4, 'TOTAL_PI_GENERATIONS')
    evidence.processes.forEach(item => {
      verifyFailureModelAudit(item.piModel, item.piModel.generationCount)
      check(item.piErrors.length === 0 && item.blockedRequests === 0 && item.rendererNetworkRestricted
        && item.rendererBlockedRequests >= 1 && !item.mcpConfigured, 'PROCESS_AUDIT_INVALID')
    })
    evidence.totalSubmissionPosts = evidence.processes.reduce((sum, item) => sum + (item.requests[submissionPath] ?? 0), 0)
    const accepted = evidence.processes.reduce((sum, item) => sum + Object.entries(item.responses[submissionPath] ?? {})
      .reduce((count, [status, total]) => count + (Number(status) >= 200 && Number(status) < 300 ? total : 0), 0), 0)
    check(accepted === 4, 'TOTAL_ACCEPTED_SUBMISSIONS')
    check(evidence.totalSubmissionPosts === 4, 'TOTAL_SUBMISSION_POSTS')
    const exits = evidence.lifecycle.filter(item => item.event === 'process-exit')
    check(exits.length === evidence.processes.length && exits.every(item => item.code === 0 && item.signal === null), 'PROCESS_EXIT_NOT_CLEAN')
    evidence.step = 'complete'
    evidence.passed = true
  }
  try {
    await access(join(root, 'out/main/media-mock.js')).catch(() => { throw new Error('OPT_IN_BUNDLE_MISSING') })
    profile = await realpath(await mkdtemp(join(tmpdir(), 'sep-electron-media-mock-')))
    evidence.profile = profile
    await launch()
    check(evidence.realLogin, 'REAL_LOGIN_REQUIRED')
    const subscriptions = (await ipc('getSubscriptions')).data
    const selectedId = process.env.SEP_ELECTRON_TEST_SUBSCRIPTION_ID
    const selected = selectedId ? subscriptions.find(item => item.subscriptionId === selectedId)
      : subscriptions.find(item => item.name === '国内电商运营专家' || item.template?.name === '国内电商运营专家')
    check(selected, 'EXISTING_ECOMMERCE_SUBSCRIPTION_REQUIRED')
    evidence.subscriptionId = selected.subscriptionId
    evidence.step = 'prepare-approved-skill'
    const prepared = await prepare(selected.subscriptionId)
    evidence.skills = metadata(prepared.skills)
    check(await submitted() === 0, 'PREFLIGHT_SUBMISSION')

    if (failureScenarios) {
      await runFailures(selected.subscriptionId, prepared)
      return evidence
    }

    const denied = await create('DENY', selected.subscriptionId)
    await ipc('executeTask', denied.id)
    await decide(denied, 'generate', false, 'deny-approval')
    const denial = await completedTimeline(denied, 'DENY', prepared)
    const denialView = (await ipc('getTaskMedia', denied.id)).data
    check(denialView.jobs.length === 0 && denialView.assets.length === 0 && await submitted() === 0, 'DENIAL_SUBMITTED')
    await shot('deny-result')
    evidence.phases.push({ name: 'deny-no-submission', timeline: denial.evidence, snapshot: await snapshot(denied, denial.runId, prepared), submissions: 0 })

    // Runtime retains the real auth throttle (10/minute). Independent scenarios must not share its window.
    evidence.step = 'wait-sync-auth-window'
    await new Promise(done => setTimeout(done, 62_000))
    const sync = await create('SYNC', selected.subscriptionId)
    evidence.step = 'sync-native-reference-import'
    const fixturePath = join(output, 'reference.png')
    await writeFile(fixturePath, Buffer.from(prepared.referenceFixtureBase64, 'base64'))
    await control(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, fixturePath)
    await page.getByRole('button', { name: '从系统选择参考图', exact: true }).click()
    await page.getByLabel('参考图 1', { exact: true }).waitFor()
    const references = (await ipc('getTaskMedia', sync.id)).data.assets.filter(asset => asset.source === 'reference')
    check(references.length === 1, 'NATIVE_REFERENCE_IMPORT')
    await shot('sync-reference-import')
    await ipc('executeTask', sync.id)
    await decide(sync, 'upload-references', true, 'sync-upload-approval')
    check(await submitted() === 0, 'SUBMITTED_BEFORE_GENERATION_APPROVAL')
    await decide(sync, 'edit', true, 'sync-generation-approval')
    const saved = await savedJob(sync, 'mock-sync')
    const syncRun = await completedTimeline(sync, 'SYNC', prepared, saved.job.jobId, references[0].localAssetId)
    check(saved.job.runId === syncRun.runId && saved.job.operation === 'edit' && await submitted() === 1, 'SYNC_SUBMISSION_BINDING')
    evidence.phases.push({ name: 'pi-reference-edit', job: jobEvidence(saved.job), timeline: syncRun.evidence,
      snapshot: await snapshot(sync, syncRun.runId, prepared), export: await exportImage('sync', prepared.referenceFixtureSha256), submissions: 1 })

    evidence.step = 'wait-async-auth-window'
    await new Promise(done => setTimeout(done, 62_000))
    const asyncTask = await create('ASYNC', selected.subscriptionId)
    check((await ipc('getTaskMedia', asyncTask.id)).data.assets.length === 0, 'ASYNC_HAS_REFERENCES')
    await ipc('executeTask', asyncTask.id)
    evidence.step = 'async-queued-disconnect'
    // Arm before the UI decision; capture and disconnect in one main-process turn.
    const queuedPromise = poll(() => control(async (_, taskId) => {
      const view = await globalThis.__sepMediaTest.inspect(taskId)
      if (!view.jobs.length) return false
      if (view.jobs.length !== 1) return { invalid: true }
      const job = view.jobs[0]
      if (job.generationStatus === 'SUBMITTING') return false
      if (job.generationStatus !== 'QUEUED' || job.saveStatus !== 'PENDING') return { invalid: true }
      globalThis.__sepMediaTest.disconnect(true)
      return { job, referenceCount: view.assets.filter(asset => asset.source === 'reference').length }
    }, asyncTask.id), 'QUEUED_CAPTURE_TIMEOUT', { interval: 20 })
    void queuedPromise.catch(() => undefined)
    await decide(asyncTask, 'generate', true, 'async-generation-approval')
    const queued = await queuedPromise
    check(!queued.invalid && queued.referenceCount === 0 && queued.job.profileId === 'mock-async'
      && queued.job.operation === 'generate' && queued.job.billingStatus === 'MOCK_NOT_CHARGED', 'EXACT_QUEUED_REQUIRED')
    const asyncRun = await completedTimeline(asyncTask, 'ASYNC', prepared, queued.job.jobId)
    check(queued.job.runId === asyncRun.runId && await submitted() === 2, 'ASYNC_SUBMISSION_BINDING')
    const before = await snapshot(asyncTask, asyncRun.runId, prepared)
    const originalIdentity = await persistedIdentity(asyncTask, queued.job.jobId, asyncRun.runId)
    await shot('async-queued-disconnected')
    evidence.phases.push({ name: 'queued-disconnect', job: jobEvidence(queued.job), identity: originalIdentity,
      timeline: asyncRun.evidence, snapshot: before, submissions: 2 })
    await close()
    check(evidence.lifecycle.some(item => item.process === 1 && item.event === 'process-exit'), 'PROCESS_NOT_CLOSED')

    evidence.step = 'wait-recovery-auth-window'
    await new Promise(done => setTimeout(done, 62_000))
    await launch()
    evidence.step = 'recover-prepare-approved-skill'
    const restoredPreparation = await prepare(selected.subscriptionId)
    equal(metadata(restoredPreparation.skills), metadata(prepared.skills), 'RECOVERY_SKILL_VERSION_CHANGED')
    check(restoredPreparation.referenceFixtureSha256 === prepared.referenceFixtureSha256, 'RECOVERY_FIXTURE_CHANGED')
    evidence.step = 'recover-open-original-task'
    await viewTask(asyncTask.title)
    evidence.step = 'recover-save-original-job'
    const restored = await savedJob(asyncTask, 'mock-async')
    check(restored.job.jobId === queued.job.jobId && restored.job.runId === asyncRun.runId
      && restored.view.assets.every(asset => asset.source === 'output'), 'RECOVERY_REGENERATED')
    const recoveredRun = await completedTimeline(asyncTask, 'ASYNC', restoredPreparation, queued.job.jobId)
    check(recoveredRun.runId === asyncRun.runId, 'RECOVERY_RUN_CHANGED')
    const after = await snapshot(asyncTask, asyncRun.runId, restoredPreparation)
    check(after.snapshotSha256 === before.snapshotSha256, 'RECOVERY_SNAPSHOT_CHANGED')
    const restoredIdentity = await persistedIdentity(asyncTask, restored.job.jobId, restored.job.runId)
    equal(restoredIdentity, originalIdentity, 'RECOVERY_RECEIPT_IDENTITY_CHANGED')
    const jobUi = page.locator('.media-job').filter({ hasText: queued.job.jobId })
    await jobUi.getByText('已保存到本地', { exact: true }).waitFor({ timeout: 15_000 })
    await jobUi.scrollIntoViewIfNeeded()
    await shot('async-restarted-saved')
    evidence.phases.push({ name: 'restart-original-job-recovery', job: jobEvidence(restored.job), timeline: recoveredRun.evidence,
      identity: restoredIdentity, snapshot: after, snapshotUnchanged: true, export: await exportImage('async', prepared.referenceFixtureSha256) })
    check(await submitted() === 0, 'RECOVERY_RESUBMITTED')
    await close()
    const exits = evidence.lifecycle.filter(item => item.event === 'process-exit')
    check(exits.length === 2 && [1, 2].every(number => exits.filter(item => item.process === number).length === 1)
      && exits.every(item => item.code === 0 && item.signal === null), 'PROCESS_EXIT_NOT_CLEAN')
    check(evidence.processes.length === 2 && evidence.processes[0].runtimeLoaded === true
      && evidence.processes.every(item => item.blockedRequests === 0 && item.rendererNetworkRestricted === true
        && item.rendererBlockedRequests >= 1 && item.mcpConfigured === false), 'PROCESS_AUDIT_INVALID')
    for (const item of evidence.processes) {
      verifyModelAudit(item.piModel, item.process === 2)
      check(item.piErrors.length === 0, 'MODEL_MOCK_ERRORS')
    }
    evidence.totalSubmissionPosts = evidence.processes.reduce((sum, item) => sum + (item.requests[submissionPath] ?? 0), 0)
    check(evidence.totalSubmissionPosts === 2, 'TOTAL_SUBMISSION_POSTS')
    const accepted = evidence.processes.reduce((sum, item) => sum + Object.entries(item.responses[submissionPath] ?? {})
      .reduce((count, [status, total]) => count + (Number(status) >= 200 && Number(status) < 300 ? total : 0), 0), 0)
    check(accepted === 2, 'TOTAL_ACCEPTED_SUBMISSIONS')
    evidence.step = 'complete'
    evidence.passed = true
  } catch (error) {
    evidence.error = { step: evidence.step, code: /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'RUNNER_OPERATION_FAILED',
      kind: ['Error', 'TypeError', 'TimeoutError'].includes(error?.name) ? error.name : 'Unknown',
      api: /^([A-Za-z]+\.[A-Za-z]+):/.exec(error?.message ?? '')?.[1] ?? null }
    if (page && !page.isClosed()) await shot('failure').catch(() => undefined)
    if (application) await close().catch(() => undefined)
    process.exitCode = 1
  } finally {
    await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
    process.stdout.write(`${JSON.stringify({ passed: evidence.passed, phases: evidence.phases.map(phase => phase.name), error: evidence.error, output })}\n`)
  }
  return evidence
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
