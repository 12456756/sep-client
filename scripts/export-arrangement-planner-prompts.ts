import { readFile, writeFile } from 'node:fs/promises'
import { ARRANGEMENT_PLANNER_RULES, buildArrangementPlannerInput, buildArrangementPlannerRepairPrompt, buildArrangementPlannerUserPrompt, type ArrangementPlannerValidationPhase } from '../electron/domain/arrangement-planner-prompts'
import type { ArrangementPlannerDraft, ArrangementPlannerEmployee } from '../electron/domain/arrangement-planner'
import { planningContractFailure, planningFailure, planningFieldFailure } from '../electron/errors/planning-diagnostics'

const systemFile = new URL('../prompts/arrangement-planner-prompts.md', import.meta.url)
const old = await readFile(systemFile, 'utf8')
const marker = '# 硅基员工自动编排规划 Agent'
if (!old.includes(marker)) throw new Error('Planning document has no system-rule marker')
await writeFile(systemFile, old.slice(0, old.indexOf(marker)).replace(/\r\n/g, '\n') + ARRANGEMENT_PLANNER_RULES + '\n')

const employee: ArrangementPlannerEmployee = { subscriptionId: 'sub-creator', employeeId: 'employee-creator', name: '商品视频创作员工', status: 'ACTIVE', source: 'authorized', canExecute: true, allowedModels: ['CURRENT_MODEL_ID'] }
const attachment = { attachmentId: 'user-photo', sha256: 'a'.repeat(64) }
const draft: ArrangementPlannerDraft = {
  id: 'example-draft', schemaVersion: 1, revision: 1, owner: { memberId: 'example-member', enterpriseId: 'example-enterprise' },
  mode: 'auto', status: 'planning', title: '', goal: '做个一分钟的智能花盆宣传视频', confirmedInputs: [],
  sharedSkillIds: [], conversation: null, nodes: [], workspace: { mode: 'shared', path: null }, permissions: { preset: 'read-only' },
  createdAt: 1, updatedAt: 1, lastPlanning: null, attachmentCandidates: [{ attachment, mustUse: true }],
  plannerAttachmentMaterials: [{ attachment, displayName: 'product.png', mediaType: 'image/png', byteLength: 100,
    summary: '用户上传的商品图片，规划阶段仅有附件元数据。', warnings: [], mustUse: true }],
}
const input = buildArrangementPlannerInput(draft, [employee], 'authorized')
const phases: Array<[ArrangementPlannerValidationPhase, unknown]> = [
  ['response-assembly', planningFailure('response-assembly', 'output-truncated')],
  ['json-extraction', planningFailure('json-extraction', 'json-not-found')],
  ['json-parse', planningFailure('json-parse', 'invalid-json')],
  ['output-validation', planningContractFailure(0, [{ path: ['inputRefs', 0, 'kind'], code: 'invalid_union' }])],
  ['employee-validation', planningFieldFailure('employee-validation', 'employee-unavailable', ['nodes', 0, 'subscriptionId'], '使用本轮目录中可执行的有效员工订阅。')],
  ['model-validation', planningFieldFailure('model-validation', 'model-not-allowed', ['nodes', 0, 'modelId'], '使用当前员工 allowedModels 中的模型。')],
  ['dag-validation', planningFieldFailure('dag-validation', 'invalid-draft', ['nodes', 0, 'dependsOn', 0], '依赖必须引用存在的其他节点，不能自引用、重复或形成循环。')],
]
const sections = phases.map(([phase, error]) => `## ${phase}\n\n\`\`\`text\n${buildArrangementPlannerRepairPrompt(phase, input, error)}\n\`\`\``)
for (const stage of ['enterprise', 'platform'] as const) {
  const pending = { ...draft, intentAnalysis: { summary: '制作宣传视频', steps: [{ id: 'video-step', title: '制作成片', requiredCapabilities: ['视频制作'], requiredCapabilityIds: [], dependsOn: [] }] },
    unresolvedSteps: [{ stepId: 'video-step', reason: '等待合适员工授权', requiredCapabilities: ['视频制作'], requiredCapabilityIds: [] }] }
  const candidate = { ...employee, subscriptionId: `${stage}-candidate`, source: stage, canExecute: false, canApply: true, allowedModels: [] }
  sections.push(`## ${stage} 阶段修正示例\n\n\`\`\`text\n${buildArrangementPlannerRepairPrompt('output-validation', buildArrangementPlannerInput(pending, [candidate], stage))}\n\`\`\``)
}
await writeFile(new URL('../prompts/arrangement-planner-repair-prompts.md', import.meta.url),
  '# 规划失败后的完整修正消息\n\n由 `npx tsx scripts/export-arrangement-planner-prompts.ts` 从当前代码生成。数据为演示值，实际消息使用本轮真实数据与校验诊断。内容修正不设次数上限；用户取消、认证与服务请求异常保持独立处理。\n\n' +
  '## 首次用户消息示例\n\n```text\n' + buildArrangementPlannerUserPrompt(input) + '\n```\n\n' + sections.join('\n\n') + '\n')
