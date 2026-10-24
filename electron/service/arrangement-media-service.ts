import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ArrangementMediaLink, ArrangementMediaLinkStorePort } from '../domain/arrangement-media'
import type { ArrangementMediaAssetsPort, ArrangementMediaPort, ArrangementMediaSession } from '../domain/arrangement-media-runtime'
import { ArrangementMediaSubmissionError } from '../domain/arrangement-media-runtime'
import type { MediaStorePort } from '../domain/media'
import type { VideoStorePort } from '../domain/video-media'
import type { MediaJobCreated, MediaRunPort } from '../domain/media-tools'
import type { WorkPlanStorePort } from '../data/work-plan-store'
import type { ArrangementCheckpointStorePort } from '../data/arrangement-checkpoint-store'
import type { TaskRunStorePort } from '../data/task-run-store'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'
import { WriteChain } from '../data/write-chain'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'

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
      const [currentTask, currentPlan] = await Promise.all([
        this.options.getTask(input.taskId), this.options.plans.get(scope, input.taskId),
      ])
      assert()
      if (!task || !currentTask || currentTask.subscriptionId !== task.subscriptionId || !currentPlan || currentPlan.planHash !== input.planHash ||
        !isDeepStrictEqual(currentPlan.nodes.find(node => node.id === input.node.id), input.node)) throw new AppError('AUTH_REQUIRED')
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
        outputs: [], materializations: [], createdAt: Date.now(), updatedAt: Date.now() })
    })
    const normalize = async (raw: unknown, operation: MediaJobCreated['operation']): Promise<Record<string, unknown> | { recovered: true; jobs: unknown[] }> => {
      await check()
      const originals = [...links.values()].filter(link => link.operation === operation)
      const requiredCount = Math.max(1, input.node.mediaRequirements?.filter(requirement => requirement.operation === operation && requirement.required !== false).length ?? 0)
      if (originals.some(link => link.nodeRunId !== input.nodeRunId) || originals.length >= requiredCount) return { recovered: true, jobs: await describe() }
      const value = z.record(z.string(), z.unknown()).parse(raw)
      const ids = value.localAssetIds === undefined ? [...references.keys()] : idsSchema.parse(value.localAssetIds)
      if (ids.some(id => !references.has(id))) throw new AppError('PERMISSION_DENIED', { message: '媒体输入必须来自本节点计划声明的资产。' })
      return { ...value, localAssetIds: operation === 'text-to-video' ? [] : ids }
    }
    const assertJob = async (kind: 'image' | 'video', raw: unknown, optional = false) => {
      await check()
      const value = z.object({ jobId: z.string().min(1).optional() }).passthrough().parse(raw)
      if ((!optional || value.jobId) && !links.has(kind + ':' + value.jobId)) throw new AppError('PERMISSION_DENIED')
    }
    const mediaOnly = !!input.node.deliverables?.length && input.node.deliverables.every(file => file.artifact?.source === 'media-output')
    return {
      inputPrompt: JSON.stringify({ referenceAssets: [...references].map(([localAssetId, original]) => ({ localAssetId, ...original })), recoverJobIds }),
      recoverJobIds,
      readyForTracking: () => mediaOnly && input.node.deliverables!.every(file => [...links.values()].some(link => link.kind === file.artifact?.kind)) &&
        !!input.node.mediaRequirements?.length && input.node.mediaRequirements.every(requirement =>
          requirement.required === false || [...links.values()].filter(link => link.kind === requirement.kind && link.operation === requirement.operation).length >=
            input.node.mediaRequirements!.filter(item => item.required !== false && item.kind === requirement.kind && item.operation === requirement.operation).length),
      artifactSummary: describe,
      automaticSubmission: async () => writes.run('links', async () => {
        if (!mediaOnly) return undefined
        await refresh()
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
              const requested = operation === 'generate' ? 'generate' : operation === 'edit' || references.size ? 'edit' : 'generate'
              const original = [...links.values()].find(link => link.kind === 'image' && link.operation === requested)!
              return media.execute('media_get_job', { jobId: original.jobId }, signal)
            }
            return media.execute(name, value, signal)
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
              const operation = name === 'video_from_image' ? 'image-to-video' : 'text-to-video'
              const original = [...links.values()].find(link => link.kind === 'video' && link.operation === operation)!
              return augment(await video.execute('video_get_job', { jobId: original.jobId }, signal))
            }
            return augment(await video.execute(name, value, signal))
          }
          await assertJob('video', raw, true)
          return augment(await video.execute(name, raw, signal))
        } } : undefined,
        }
      },
      materialize: async submission => writes.run('links', async () => {
        await refresh()
        const files: FinalDeliveryFile[] = []
        for (const mapping of submission.mediaDeliverables ?? []) {
          const deliverable = input.node.deliverables?.find(item => item.id === mapping.deliverableId)
          const link = [...links.values()].find(link => link.kind === deliverable?.artifact?.kind &&
            link.outputs.some(output => output.artifactId === mapping.artifactId && output.status === 'saved'))
          if (!deliverable || !link || deliverable.artifact?.source === 'workspace') throw new ArrangementMediaSubmissionError('媒体交付必须来自当前节点已保存的输出，请查询原任务并修正资产映射，不要重新生成。')
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
