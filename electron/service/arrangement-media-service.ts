import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ArrangementMediaLink, ArrangementMediaLinkStorePort } from '../domain/arrangement-media'
import type { ArrangementMediaAssetsPort, ArrangementMediaPort, ArrangementMediaSession } from '../domain/arrangement-media-runtime'
import { ArrangementMediaSubmissionError } from '../domain/arrangement-media-runtime'
import type { MediaStorePort } from '../domain/media'
import type { VideoStorePort } from '../domain/video-media'
import { videoSpecAcceptance } from '../domain/video-media'
import type { MediaJobCreated, MediaRunPort } from '../domain/media-tools'
import type { WorkPlanStorePort } from '../data/work-plan-store'
import type { ArrangementCheckpointStorePort } from '../data/arrangement-checkpoint-store'
import type { TaskRunStorePort } from '../data/task-run-store'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'
import { WriteChain } from '../data/write-chain'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'
import { resolveArrangementMediaSpec } from '../domain/arrangement-media-spec'
import type { ArrangementMediaRequirement } from '../domain/arrangement-plan'
import { mediaSpecsEqual } from '../../src/shared/media-spec-contract'

export interface ArrangementMediaServiceOptions {
  scope: ScopeSource
  plans: WorkPlanStorePort
  checkpoints: ArrangementCheckpointStorePort
  runs: TaskRunStorePort
  links: ArrangementMediaLinkStorePort
  images: MediaStorePort
  videos?: VideoStorePort
  assets: ArrangementMediaAssetsPort
  media: MediaRunPort
  getTask(taskId: string): Promise<{ subscriptionId?: string | null } | null>
}

const idsSchema = z.array(z.string().min(1)).refine(ids => new Set(ids).size === ids.length)

/** Coordinates existing hosts; generation, authorization and billing stay host-owned. */
export class ArrangementMediaService implements ArrangementMediaPort {
  constructor(private readonly options: ArrangementMediaServiceOptions) {}

  async prepareNode(input: Parameters<ArrangementMediaPort['prepareNode']>[0]): Promise<ArrangementMediaSession> {
    const scope = requireScope(this.options.scope)
    const task = await this.options.getTask(input.taskId)
    const plan = await this.options.plans.get(scope, input.taskId)
    const assert = () => {
      input.signal.throwIfAborted()
      if (!isDeepStrictEqual(scope, requireScope(this.options.scope))) throw new AppError('AUTH_REQUIRED')
    }
    const check = async () => {
      assert()
      const [currentTask, currentPlan, currentCheckpoint] = await Promise.all([
        this.options.getTask(input.taskId), this.options.plans.get(scope, input.taskId), this.options.checkpoints.get(scope, input.taskId),
      ])
      assert()
      if (!task || !currentTask || currentTask.subscriptionId !== task.subscriptionId || !currentPlan || currentPlan.planHash !== input.planHash ||
        !isDeepStrictEqual(currentPlan.nodes.find(node => node.id === input.node.id), input.node)) throw new AppError('AUTH_REQUIRED')
      const revisions = currentCheckpoint?.planHash === input.planHash ? currentCheckpoint.state.nodes.find(node => node.nodeId === input.node.id)?.mediaSpecRevisions ?? {} : {}
      if (!isDeepStrictEqual(revisions, input.specRevisions ?? {}) || Object.entries(revisions).some(([id, revision]) => {
        const requirement = input.node.mediaRequirements?.find(item => item.id === id)
        return !requirement || !Number.isSafeInteger(revision) || revision < (requirement.specRevision ?? 1)
      })) throw new AppError('SPEC_CONFLICT', { message: '媒体规格版本与当前检查点不一致，请刷新后继续。' })
    }
    await check()
    if (!plan || !plan.workspace.path) throw new AppError('INVALID_STATE', { message: '媒体编排需要已分配的共享工作区。' })
    const all = await this.options.links.list(scope, input.taskId)
    const nodeRuns = new Set((await this.options.runs.list(scope, input.taskId))
      .filter(run => run.arrangementNodeId === input.node.id && run.subscriptionId === input.node.subscriptionId).map(run => run.id))
    const imageJobs = (await this.options.images.listJobs(scope, input.taskId)).filter(job => nodeRuns.has(job.runId) && job.submission !== 'NOT_SENT')
    const videoJobs = (await this.options.videos?.listJobs({ ...scope, subscriptionId: input.node.subscriptionId }) ?? [])
      .filter(job => job.taskId === input.taskId && job.runId && nodeRuns.has(job.runId) && job.submission !== 'NOT_SENT')
    if (imageJobs.some(job => !all.some(link => link.kind === 'image' && link.jobId === job.jobId)) ||
      videoJobs.some(job => !all.some(link => link.kind === 'video' && link.jobId === job.jobId))) {
      throw new AppError('INVALID_STATE', { message: '原媒体任务的编排关联证据缺失，请恢复关联记录后继续，不能重新提交生成。' })
    }
    const links = new Map<string, ArrangementMediaLink>()
    const submittingRequirements = new Map<MediaJobCreated['operation'], ArrangementMediaRequirement>()
    const effectiveRequirements = (input.node.mediaRequirements ?? []).map(requirement => ({ ...requirement,
      ...(input.specRevisions?.[requirement.id] ? { specRevision: input.specRevisions[requirement.id] } : {}) }))
    for (const link of all.filter(link => link.nodeId === input.node.id)) {
      const run = await this.options.runs.get(scope, input.taskId, link.nodeRunId)
      if (run?.arrangementNodeId !== input.node.id || run.subscriptionId !== input.node.subscriptionId || link.subscriptionId !== input.node.subscriptionId) throw new AppError('INVALID_STATE')
      if (link.kind === 'video') {
        const job = await this.options.videos?.getJob({ ...scope, subscriptionId: link.subscriptionId }, input.taskId, link.jobId)
        if (!job || job.runId !== link.nodeRunId) throw new AppError('INVALID_STATE')
      } else {
        const job = await this.options.images.getJob(scope, input.taskId, link.jobId)
        if (!job || job.runId !== link.nodeRunId || job.subscriptionId !== link.subscriptionId) throw new AppError('INVALID_STATE')
      }
      links.set(link.kind + ':' + link.jobId, link)
    }
    const references = new Map<string, { artifactId: string; sha256: string; sourceNodeId?: string }>()
    for (const binding of input.node.inputRefs ?? []) {
      if (binding.kind !== 'attachment' || binding.purpose !== 'media-source') continue
      if (!this.options.assets.attachmentReference) throw new AppError('SERVICE_UNAVAILABLE')
      const reference = await this.options.assets.attachmentReference(scope, input.taskId, binding.attachment, input.signal, assert)
      references.set(reference.artifactId, reference)
    }
    const checkpoint = await this.options.checkpoints.get(scope, input.taskId)
    for (const requirement of input.node.mediaRequirements ?? []) {
      const source = requirement.inputFrom
      if (!source) continue
      let artifactId = source.artifactId
      let expectedHash: string | undefined
      if (source.nodeId) {
        const predecessor = checkpoint?.planHash === input.planHash ? checkpoint.state.nodes.find(node => node.nodeId === source.nodeId) : undefined
        if (!input.node.dependsOn.includes(source.nodeId) || predecessor?.status !== 'completed' || predecessor.pendingConfirmation) throw new AppError('INVALID_STATE')
        const files = (predecessor.delivery?.finalFiles ?? []).filter(file => file.sourceArtifact?.kind === 'image' &&
          (!source.deliverableId || file.id === source.deliverableId) && (!artifactId || file.sourceArtifact.artifactId === artifactId))
        if (files.length !== 1) throw new AppError('INVALID_ARGUMENT', { message: '请选择明确的前置图片交付物后继续，原媒体无需重新生成。' })
        artifactId = files[0]!.sourceArtifact!.artifactId
        expectedHash = files[0]!.sha256
        if (!all.some(link => link.nodeId === source.nodeId && link.kind === 'image' &&
          link.outputs.some(output => output.artifactId === artifactId && output.sha256 === expectedHash))) throw new AppError('INVALID_STATE')
      }
      if (!artifactId) throw new AppError('INVALID_ARGUMENT')
      const reference = await this.options.assets.reference(scope, input.taskId, artifactId, input.signal, assert)
      if (expectedHash && expectedHash !== reference.sha256) throw new AppError('INVALID_STATE')
      references.set(reference.artifactId, { artifactId, sha256: reference.sha256, ...(source.nodeId ? { sourceNodeId: source.nodeId } : {}) })
    }
    const writes = new WriteChain()
    const save = async (link: ArrangementMediaLink) => {
      await check()
      const saved = await this.options.links.upsert(scope, { ...link, updatedAt: Math.max(Date.now(), link.updatedAt) })
      links.set(link.kind + ':' + link.jobId, saved)
      assert()
      return saved
    }
    const refresh = async () => {
      await check()
      for (const link of links.values()) {
        const assets = await this.options.assets.outputs(scope, input.taskId, link)
        const outputs = new Map<string, ArrangementMediaLink['outputs'][number]>(link.outputs.map(output => [output.artifactId, { ...output, status: 'missing' }]))
        for (const asset of assets) outputs.set(asset.artifactId, { artifactId: asset.artifactId, sha256: asset.sha256, status: asset.status })
        await save({ ...link, outputs: [...outputs.values()] })
      }
    }
    const recoverJobIds = [...links.values()].map(link => link.jobId)
    const assertAcceptedOutput = async (link: ArrangementMediaLink) => {
      const mismatched = link.kind === 'image'
        ? (await this.options.images.getJob(scope, input.taskId, link.jobId))?.errorCode === 'OUTPUT_SPEC_MISMATCH'
        : await (async () => {
          const job = await this.options.videos?.getJob({ ...scope, subscriptionId: input.node.subscriptionId }, input.taskId, link.jobId)
          return job ? videoSpecAcceptance(job).acceptance === 'mismatched' : false
        })()
      if (mismatched) throw new ArrangementMediaSubmissionError('原媒体输出与请求规格不符，不能作为最终交付。已保留原任务和文件，请处理规格差异后继续，不要重新提交生成。')
    }
    const describe = async () => {
      await writes.run('links', refresh)
      return [...links.values()].map(link => ({ kind: link.kind, jobId: link.jobId, operation: link.operation,
        assets: link.outputs.map(output => ({ ...output })) }))
    }
    const onJobCreated = async (job: MediaJobCreated) => writes.run('links', async () => {
      await check()
      if (job.localAssetIds.some(id => !references.has(id))) throw new AppError('PERMISSION_DENIED')
      if (job.kind === 'image') {
        const record = await this.options.images.getJob(scope, input.taskId, job.jobId)
        if (record?.runId !== input.nodeRunId || record.subscriptionId !== input.node.subscriptionId) throw new AppError('AUTH_REQUIRED')
      } else {
        const record = await this.options.videos?.getJob({ ...scope, subscriptionId: input.node.subscriptionId }, input.taskId, job.jobId)
        if (record?.runId !== input.nodeRunId) throw new AppError('AUTH_REQUIRED')
      }
      await save({ version: 1, owner: scope, taskId: input.taskId, arrangementRunId: input.arrangementRunId,
        nodeId: input.node.id, nodeRunId: input.nodeRunId, attempt: input.attempt, subscriptionId: input.node.subscriptionId,
        kind: job.kind, operation: job.operation, jobId: job.jobId, inputs: job.localAssetIds.map(id => references.get(id)!),
        ...(submittingRequirements.get(job.operation) ? { requirementId: submittingRequirements.get(job.operation)!.id,
          specRevision: submittingRequirements.get(job.operation)!.specRevision } : {}),
        outputs: [], materializations: [], createdAt: Date.now(), updatedAt: Date.now() })
    })
    const normalize = async (raw: unknown, operation: MediaJobCreated['operation']): Promise<Record<string, unknown> | { recovered: true; jobId: string }> => {
      await check()
      const originals = [...links.values()].filter(link => link.operation === operation)
      const requiredCount = Math.max(1, input.node.mediaRequirements?.filter(requirement => requirement.operation === operation && requirement.required !== false).length ?? 0)
      const value = z.record(z.string(), z.unknown()).parse(raw)
      const requirements = effectiveRequirements.filter(requirement => requirement.operation === operation && requirement.specRevision !== undefined)
      let spec: ReturnType<typeof resolveArrangementMediaSpec>
      let selectedRequirement: ArrangementMediaRequirement | undefined
      // Historical links without a requirement identity cannot prove which request is still missing.
      // Keep their original conservative recovery behavior instead of risking another paid submission.
      if ((!requirements.length || originals.some(link => !link.requirementId ||
        !requirements.some(requirement => requirement.id === link.requirementId))) &&
        (originals.some(link => link.nodeRunId !== input.nodeRunId) || originals.length >= requiredCount)) {
        return { recovered: true, jobId: originals[0]!.jobId }
      }
      if (requirements.length) {
        if (submittingRequirements.has(operation)) throw new AppError('INVALID_STATE', { message: '当前媒体需求正在提交，请等待原任务绑定完成后继续。' })
        if (value.requirementId !== undefined) {
          if (!requirements.some(requirement => requirement.id === value.requirementId)) {
            throw new AppError('SPEC_CONFLICT', { message: '媒体需求 ID 与当前操作不匹配，请使用本节点计划中的需求 ID。' })
          }
          const original = originals.find(link => link.requirementId === value.requirementId)
          if (original) return { recovered: true, jobId: original.jobId }
        }
        const candidates = requirements.filter(requirement => !originals.some(link => link.requirementId === requirement.id))
        if (value.requirementId === undefined && !candidates.length && originals.length === 1) {
          return { recovered: true, jobId: originals[0]!.jobId }
        }
        const explicitSpec = value.requestedSpec ?? value.parameters
        const matching = explicitSpec && typeof explicitSpec === 'object' && !Array.isArray(explicitSpec)
          ? candidates.filter(requirement => {
            try {
              const resolved = resolveArrangementMediaSpec(requirement, value)
              return resolved && mediaSpecsEqual(resolved.requestedSpec, explicitSpec as Record<string, unknown>)
            } catch { return false }
          }) : []
        // A requirement ID is accepted only by this trusted bridge and never forwarded to a provider.
        const selected = value.requirementId !== undefined ? candidates.find(requirement => requirement.id === value.requirementId) :
          candidates.length === 1 ? candidates[0] : matching.length === 1 ? matching[0] : undefined
        if (!selected) throw new AppError('SPEC_CONFLICT', { message: '存在多项媒体需求，请明确对应的需求 ID 后继续，不能猜测规格或重复生成。' })
        spec = resolveArrangementMediaSpec(selected, value)
        selectedRequirement = selected
      }
      const ids = value.localAssetIds === undefined ? [...references.keys()] : idsSchema.parse(value.localAssetIds)
      if (ids.some(id => !references.has(id))) throw new AppError('PERMISSION_DENIED', { message: '媒体输入必须来自本节点计划声明的资产。' })
      if (selectedRequirement) submittingRequirements.set(operation, selectedRequirement)
      const { requirementId: _requirementId, parameters: _parameters, ...rest } = value
      return { ...rest, ...(!spec && value.parameters !== undefined ? { parameters: value.parameters } : {}), ...spec,
        localAssetIds: operation === 'text-to-video' ? [] : ids }
    }
    const assertJob = async (kind: 'image' | 'video', raw: unknown, optional = false) => {
      await check()
      const value = z.object({ jobId: z.string().min(1).optional() }).passthrough().parse(raw)
      if ((!optional || value.jobId) && !links.has(kind + ':' + value.jobId)) throw new AppError('PERMISSION_DENIED')
    }
    const mediaOnly = !!input.node.deliverables?.length && input.node.deliverables.every(file => file.artifact?.source === 'media-output')
    const requiredMediaSubmitted = () => (input.node.mediaRequirements ?? []).every(requirement => {
      if (requirement.required === false) return true
      const matches = [...links.values()].filter(link => link.kind === requirement.kind && link.operation === requirement.operation)
      return requirement.specRevision !== undefined ? matches.some(link => link.requirementId === requirement.id) :
        matches.length >= input.node.mediaRequirements!.filter(item => item.required !== false && item.kind === requirement.kind && item.operation === requirement.operation).length
    })
    return {
      inputPrompt: JSON.stringify({ referenceAssets: [...references].map(([localAssetId, original]) => ({ localAssetId, ...original })), recoverJobIds }),
      recoverJobIds,
      readyForTracking: () => mediaOnly && input.node.deliverables!.every(file => [...links.values()].some(link => link.kind === file.artifact?.kind)) &&
        !!input.node.mediaRequirements?.length && requiredMediaSubmitted(),
      artifactSummary: describe,
      automaticSubmission: async () => writes.run('links', async () => {
        if (!mediaOnly || !requiredMediaSubmitted()) return undefined
        await refresh()
        for (const link of links.values()) if (link.outputs.some(output => output.status === 'saved')) await assertAcceptedOutput(link)
        const mappings: Array<{ deliverableId: string; artifactId: string }> = []
        for (const kind of ['image', 'video'] as const) {
          const deliverables = (input.node.deliverables ?? []).filter(file => file.artifact?.kind === kind && file.artifact.source === 'media-output')
          const outputs = [...links.values()].filter(link => link.kind === kind).flatMap(link => link.outputs.filter(output => output.status === 'saved'))
          // Multiple candidates need a business choice; never silently pick one.
          if (outputs.length !== deliverables.length || outputs.length > 1) return undefined
          deliverables.forEach((file, index) => mappings.push({ deliverableId: file.id, artifactId: outputs[index]!.artifactId }))
        }
        if (!mappings.length) return undefined
        return { nodeId: input.node.id, summary: `${input.node.title}：媒体已生成并保存。`,
          finalDeliverables: (input.node.deliverables ?? []).map(file => ({ id: file.id, path: file.path })), mediaDeliverables: mappings }
      }),
      onJobCreated,
      bind: (media, video) => {
        for (const requirement of input.node.mediaRequirements ?? []) {
          if (requirement.required === false) continue
          const tool = requirement.kind === 'image' ? 'media_generate_image' : requirement.operation === 'image-to-video' ? 'video_from_image' : 'video_generate'
          if (!(requirement.kind === 'image' ? media?.names : video?.names)?.some(name => name === tool)) throw new AppError('PERMISSION_DENIED', { message: '当前节点员工没有获准执行计划中的媒体操作，请调整员工或计划。' })
        }
        return {
        media: media ? { names: media.names, execute: async (name, raw, signal) => {
          if (name === 'media_generate_image') {
            const operation = (raw as { operation?: string } | null)?.operation
            const value = await normalize(raw, operation === 'generate' ? 'generate' : operation === 'edit' || references.size ? 'edit' : 'generate')
            if ('recovered' in value) {
              return media.execute('media_get_job', { jobId: value.jobId }, signal)
            }
            try { return await media.execute(name, value, signal) } finally {
              submittingRequirements.delete(operation === 'generate' ? 'generate' : operation === 'edit' || references.size ? 'edit' : 'generate')
            }
          }
          if (name === 'media_get_job' || name === 'media_cancel_job') await assertJob('image', raw)
          const result = await media.execute(name, raw, signal)
          if (name === 'media_get_capabilities' && result && typeof result === 'object') {
            const referenceAssets = await Promise.all([...references.keys()].map(id => this.options.images.getAsset(scope, input.taskId, id)))
            return { ...result, referenceAssets: referenceAssets.filter(asset => asset !== null).map(asset => ({ localAssetId: asset.localAssetId,
              taskId: asset.taskId, jobId: null, outputId: null, source: 'reference', mime: asset.mime, size: asset.size,
              width: asset.width, height: asset.height, status: asset.status })) }
          }
          return result
        } } : undefined,
        video: video ? { names: video.names, execute: async (name, raw, signal) => {
          const augment = async (result: unknown): Promise<unknown> => {
            const jobs = await describe()
            const attach = (job: Record<string, unknown>) => ({ ...job,
              artifacts: jobs.find(item => item.kind === 'video' && item.jobId === job.jobId)?.assets ?? [] })
            if (!result || typeof result !== 'object') return result
            const value = result as Record<string, unknown>
            return Array.isArray(value.jobs) ? { ...value,
              referenceAssets: Array.isArray(value.referenceAssets) ? value.referenceAssets.filter(asset => asset && typeof asset === 'object' && references.has(asset.localAssetId)) : [],
              jobs: value.jobs.filter((job): job is Record<string, unknown> => !!job && typeof job === 'object' && links.has('video:' + job.jobId)).map(attach) } : attach(value)
          }
          if (name !== 'video_get_job') {
            const value = await normalize(raw, name === 'video_from_image' ? 'image-to-video' : 'text-to-video')
            if ('recovered' in value) {
              return augment(await video.execute('video_get_job', { jobId: value.jobId }, signal))
            }
            try { return await augment(await video.execute(name, value, signal)) } finally {
              submittingRequirements.delete(name === 'video_from_image' ? 'image-to-video' : 'text-to-video')
            }
          }
          await assertJob('video', raw, true)
          return augment(await video.execute(name, raw, signal))
        } } : undefined,
        }
      },
      materialize: async submission => writes.run('links', async () => {
        if (!requiredMediaSubmitted()) throw new ArrangementMediaSubmissionError('还有必须完成的媒体需求尚未关联原任务，请完成剩余需求后再交付，不要重复提交已有任务。')
        await refresh()
        const files: FinalDeliveryFile[] = []
        for (const mapping of submission.mediaDeliverables ?? []) {
          const deliverable = input.node.deliverables?.find(item => item.id === mapping.deliverableId)
          const link = [...links.values()].find(link => link.kind === deliverable?.artifact?.kind &&
            link.outputs.some(output => output.artifactId === mapping.artifactId && output.status === 'saved'))
          if (!deliverable || !link || deliverable.artifact?.source === 'workspace' ||
            (deliverable.artifact?.operation && link.operation !== deliverable.artifact.operation)) throw new ArrangementMediaSubmissionError('媒体交付必须来自当前节点匹配操作的已保存输出，请查询原任务并修正资产映射，不要重新生成。')
          await assertAcceptedOutput(link)
          const prior = link.materializations.find(item => item.deliverableId === deliverable.id)
          const materialization = { deliverableId: deliverable.id, path: prior?.path ?? deliverable.path, sourceArtifactId: mapping.artifactId, status: 'pending' as const }
          await save({ ...link, materializations: [...link.materializations.filter(item => item.deliverableId !== deliverable.id), { ...materialization, ...(prior?.sha256 ? { sha256: prior.sha256 } : {}) }] })
          const materializeDeliverable = materialization.path === deliverable.path ? deliverable : { ...deliverable, path: materialization.path }
          const file = await this.options.assets.materialize(scope, input.taskId, plan.workspace.path!, materializeDeliverable, link,
            mapping.artifactId, input.nodeRunId, input.signal, assert)
          const currentLink = links.get(link.kind + ':' + link.jobId)!
          await save({ ...currentLink, materializations: [
            ...currentLink.materializations.filter(item => item.deliverableId !== deliverable.id), { ...materialization, path: file.path, sha256: file.sha256, status: 'saved' },
          ] })
          files.push(file)
        }
        return files
      }),
    }
  }
}
