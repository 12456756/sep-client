import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ArrangementMediaLink, ArrangementMediaLinkStorePort } from '../domain/arrangement-media'
import type { ArrangementMediaAsset, ArrangementMediaAssetsPort, ArrangementMediaPort, ArrangementMediaSession } from '../domain/arrangement-media-runtime'
import { ArrangementMediaSubmissionError, ArrangementMediaRecoveryError } from '../domain/arrangement-media-runtime'
import { arrangementMediaMimeByFormat } from '../domain/arrangement-plan'
import type { MediaStorePort } from '../domain/media'
import type { VideoStorePort } from '../domain/video-media'
import type { VideoReferencePort } from '../domain/video-references'
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
import { mediaCapabilitiesSchema } from '../common/platform/media-contract'
import { mediaToolGenerationInputSchema } from '../../src/shared/media-host'

export interface ArrangementMediaServiceOptions {
  scope: ScopeSource
  plans: WorkPlanStorePort
  checkpoints: ArrangementCheckpointStorePort
  runs: TaskRunStorePort
  links: ArrangementMediaLinkStorePort
  images: MediaStorePort
  videos?: VideoStorePort
  videoReferences?: VideoReferencePort
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
    const recoveryCheckpoint = await this.options.checkpoints.get(scope, input.taskId)
    const replacement = recoveryCheckpoint?.planHash === input.planHash
      ? recoveryCheckpoint.state.nodes.find(node => node.nodeId === input.node.id)?.employeeReplacement : undefined
    const subscriptions = new Set([input.node.subscriptionId])
    if (replacement?.status === 'replaced' && replacement.nodeId === input.node.id && replacement.replacementSubscriptionId === input.node.subscriptionId) {
      subscriptions.add(replacement.originalSubscriptionId)
      for (const id of replacement.previousSubscriptionIds ?? []) subscriptions.add(id)
    }
    const nodeRuns = new Set((await this.options.runs.list(scope, input.taskId))
      .filter(run => run.arrangementNodeId === input.node.id && subscriptions.has(run.subscriptionId)).map(run => run.id))
    const imageJobs = (await this.options.images.listJobs(scope, input.taskId)).filter(job => nodeRuns.has(job.runId) && job.submission !== 'NOT_SENT')
    const videoJobs = (await Promise.all([...subscriptions].map(subscriptionId => this.options.videos?.listJobs({ ...scope, subscriptionId }) ?? []))).flat()
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
      if (run?.arrangementNodeId !== input.node.id || run.subscriptionId !== link.subscriptionId || !subscriptions.has(link.subscriptionId)) throw new AppError('INVALID_STATE')
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
    const referenceVideos = new Map((await this.options.videoReferences?.list({ ...scope, subscriptionId: input.node.subscriptionId }, input.taskId) ?? [])
      .filter(asset => asset.status === 'SAVED').map(asset => [asset.localAssetId, asset]))
    if (effectiveRequirements.some(requirement => requirement.operation === 'video-to-video')) {
      for (const asset of referenceVideos.values()) references.set(asset.localAssetId, { artifactId: asset.localAssetId, sha256: asset.sha256 })
    }
    const requirementReferences = new Map<string, string>()
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
      if (requirement.operation === 'video-to-video') {
        const asset = source.artifactId ? referenceVideos.get(source.artifactId) : undefined
        if (source.nodeId || !asset) throw new AppError('INVALID_ARGUMENT', { message: '视频生视频需要本任务已导入的参考视频，请先导入并选择原视频。' })
        requirementReferences.set(requirement.id, asset.localAssetId)
        continue
      }
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
      requirementReferences.set(requirement.id, reference.artifactId)
    }
    const writes = new WriteChain()
    const save = async (link: ArrangementMediaLink) => {
      await check()
      const saved = await this.options.links.upsert(scope, { ...link, updatedAt: Math.max(Date.now(), link.updatedAt) })
      links.set(link.kind + ':' + link.jobId, saved)
      assert()
      return saved
    }
    const assetDetails = new Map<string, ArrangementMediaAsset>()
    const refresh = async () => {
      await check()
      for (const link of links.values()) {
        const assets = await this.options.assets.outputs(scope, input.taskId, link)
        const outputs = new Map<string, ArrangementMediaLink['outputs'][number]>(link.outputs.map(output => [output.artifactId, { ...output, status: 'missing' }]))
        for (const asset of assets) {
          assetDetails.set(asset.artifactId, asset)
          outputs.set(asset.artifactId, { artifactId: asset.artifactId, sha256: asset.sha256, status: asset.status })
        }
        await save({ ...link, outputs: [...outputs.values()] })
      }
    }
    const recoverJobIds = [...links.values()].map(link => link.jobId)
    const assertAcceptedOutput = async (link: ArrangementMediaLink) => {
      if (link.kind === 'image' && (await this.options.images.getJob(scope, input.taskId, link.jobId))?.errorCode === 'OUTPUT_SPEC_MISMATCH') {
        throw new ArrangementMediaSubmissionError('原图片输出与请求规格不符，不能作为最终交付。已保留原任务和文件，请处理规格差异后继续，不要重新提交生成。')
      }
    }
    const describe = async () => {
      await writes.run('links', refresh)
      return [...links.values()].map(link => ({ kind: link.kind, jobId: link.jobId, operation: link.operation,
        assets: link.outputs.map(output => {
          const detail = assetDetails.get(output.artifactId)
          return { ...output, ...(detail ? { mime: detail.mime, size: detail.size } : {}) }
        }) }))
    }
    const inheritedJob = async (kind: 'image' | 'video', jobId: string) => {
      const link = links.get(kind + ':' + jobId)
      if (!link || link.subscriptionId === input.node.subscriptionId) return undefined
      await writes.run('links', refresh)
      const assets = links.get(kind + ':' + jobId)!.outputs.filter(output => output.status === 'saved')
      if (!assets.length) throw new ArrangementMediaRecoveryError('download', new Error('Original employee media is not saved; keep the original job and do not regenerate.'))
      return { jobId, generationStatus: 'SUCCEEDED', saveStatus: 'SAVED', artifacts: assets, reused: true }
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
      const image = operation === 'edit' || operation === 'generate'
      const legacyRequirement = effectiveRequirements.filter(requirement => requirement.operation === operation &&
        (value.requirementId === undefined || requirement.id === value.requirementId))
      const requirementReference = requirementReferences.get((selectedRequirement ?? (legacyRequirement.length === 1 ? legacyRequirement[0] : undefined))?.id ?? '')
      const localIds = operation === 'video-to-video' ? value.localVideoAssetIds : value.localAssetIds
      const candidates = [...references.keys()].filter(id => operation === 'video-to-video' ? referenceVideos.has(id) : !referenceVideos.has(id))
      if (localIds === undefined && !requirementReference && candidates.length > 1 && operation !== 'generate' && operation !== 'text-to-video') {
        throw new AppError('INVALID_ARGUMENT', { message: '存在多张候选参考图，请通过 localAssetIds 明确选择并保留顺序。' })
      }
      const ids = localIds === undefined
        ? operation === 'generate' || operation === 'text-to-video' ? [] : requirementReference ? [requirementReference] : candidates
        : idsSchema.parse(localIds)
      if (ids.some(id => !references.has(id))) throw new AppError('PERMISSION_DENIED', { message: '媒体输入必须来自本节点计划声明的资产。' })
      if (ids.some(id => !candidates.includes(id)) || (operation === 'video-to-video' ? idsSchema.parse(value.localAssetIds ?? []).length > 0 : idsSchema.parse(value.localVideoAssetIds ?? []).length > 0)) throw new AppError('INVALID_ARGUMENT', { message: '请按媒体操作选择对应的参考图片或参考视频，不能混用。' })
      if (operation === 'edit' && ids.length === 0) throw new AppError('INVALID_ARGUMENT', {
        message: '图生图需要明确选择本节点参考图，请通过 localAssetIds 按顺序指定；候选来源不明确时先询问用户。',
      })
      if ((operation === 'edit' || operation === 'video-to-video') && requirementReference && ids[0] !== requirementReference) throw new AppError('SPEC_CONFLICT', {
        message: '参考图与当前媒体需求指定的输入不一致，请使用该需求绑定的原图片。',
      })
      if (operation === 'generate' && ids.length) throw new AppError('INVALID_ARGUMENT', { message: '文生图不应传入参考图；编辑图片请使用 edit 操作。' })
      if (selectedRequirement) submittingRequirements.set(operation, selectedRequirement)
      const { requirementId: _requirementId, parameters: _parameters, ...rest } = value
      return { ...rest, ...(!spec && value.parameters !== undefined ? { parameters: value.parameters } : {}), ...spec,
        ...(image ? { operation } : {}), localAssetIds: operation === 'text-to-video' || operation === 'video-to-video' ? [] : ids,
        ...(operation === 'video-to-video' ? { localVideoAssetIds: ids } : {}) }
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
      inputPrompt: JSON.stringify({ referenceAssets: [...references].filter(([id]) => !referenceVideos.has(id)).map(([localAssetId, original]) => ({ localAssetId, ...original })),
        ...(referenceVideos.size ? { referenceVideos: [...references].filter(([id]) => referenceVideos.has(id)).map(([localAssetId, original]) => ({ localAssetId, ...original })) } : {}), recoverJobIds }),
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
          const tool = requirement.operation === 'video-to-video' ? 'video_from_video' : requirement.kind === 'image' ? 'media_generate_image' : requirement.operation === 'image-to-video' ? 'video_from_image' : 'video_generate'
          if (!(requirement.kind === 'image' ? media?.names : video?.names)?.some(name => name === tool)) throw new AppError('PERMISSION_DENIED', { message: '当前节点员工没有获准执行计划中的媒体操作，请调整员工或计划。' })
        }
        return {
        media: media ? { names: media.names, execute: async (name, raw, signal) => {
          if (name === 'media_generate_image') {
            const parsed = mediaToolGenerationInputSchema.parse(raw)
            const requirements = effectiveRequirements.filter(requirement => requirement.kind === 'image' &&
              (parsed.requirementId === undefined || requirement.id === parsed.requirementId))
            if (parsed.requirementId !== undefined && !requirements.length) throw new AppError('SPEC_CONFLICT')
            const operations = new Set(requirements.map(requirement => requirement.operation))
            if (!parsed.operation && operations.size > 1) throw new AppError('INVALID_ARGUMENT', { message: '当前节点同时有新建和编辑图片的需求，请明确 operation 或 requirementId。' })
            const operation = parsed.operation ?? (operations.has('edit') ? 'edit' : 'generate')
            if (operations.size && !operations.has(operation)) throw new AppError('SPEC_CONFLICT', { message: '图片操作与当前计划需求不一致，请按计划的新建或编辑操作执行。' })
            const value = await normalize(parsed, operation)
            if ('recovered' in value) {
              return await inheritedJob('image', String(value.jobId)) ?? media.execute('media_get_job', { jobId: value.jobId }, signal)
            }
            try {
              if (operation === 'edit') {
                const view = z.object({ capabilities: mediaCapabilitiesSchema }).parse(await media.execute('media_get_capabilities', {}, signal))
                await check()
                const profile = parsed.profileId ? view.capabilities.profiles.find(profile => profile.profileId === parsed.profileId) :
                  view.capabilities.profiles.find(profile => profile.profileId === view.capabilities.defaultProfileId) ?? view.capabilities.profiles[0]
                if (!profile?.operations.includes('edit') || !profile.capabilities.referenceImage) throw new AppError('PERMISSION_DENIED', {
                  message: '当前节点员工的图片配置未授权参考图编辑，不能改用文生图代替。',
                })
              }
              return await media.execute(name, value, signal)
            } finally {
              submittingRequirements.delete(operation)
            }
          }
          if (name === 'media_get_job' || name === 'media_cancel_job') await assertJob('image', raw)
          if (name === 'media_get_job') {
            const inherited = await inheritedJob('image', (raw as { jobId: string }).jobId)
            if (inherited) return inherited
          }
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
              referenceVideos: Array.isArray(value.referenceVideos) ? value.referenceVideos.filter(asset => asset && typeof asset === 'object' && referenceVideos.has(asset.localAssetId) && references.has(asset.localAssetId)) : [],
              jobs: value.jobs.filter((job): job is Record<string, unknown> => !!job && typeof job === 'object' && links.has('video:' + job.jobId)).map(attach) } : attach(value)
          }
          if (name !== 'video_get_job') {
            const operation = name === 'video_from_video' ? 'video-to-video' : name === 'video_from_image' ? 'image-to-video' : 'text-to-video'
            const value = await normalize(raw, operation)
            if ('recovered' in value) {
              return augment(await inheritedJob('video', String(value.jobId)) ?? await video.execute('video_get_job', { jobId: value.jobId }, signal))
            }
            try { return await augment(await video.execute(name, value, signal)) } finally {
              submittingRequirements.delete(operation)
            }
          }
          await assertJob('video', raw, true)
          const jobId = (raw as { jobId?: string }).jobId
          if (jobId) {
            const inherited = await inheritedJob('video', jobId)
            if (inherited) return augment(inherited)
          }
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
          const confirmed = [...links.values()].flatMap(item => item.materializations)
            .find(item => item.deliverableId === deliverable.id && (item.status === 'saved' || item.sha256))
          if (confirmed && confirmed.sourceArtifactId !== mapping.artifactId) throw new ArrangementMediaSubmissionError(
            '交付物 ' + JSON.stringify(deliverable.id) + ' 已确认原资产 ' + JSON.stringify(confirmed.sourceArtifactId) +
            '，请保留该资产映射，不要替换已确认内容。')
          const asset = assetDetails.get(mapping.artifactId)
          const expectedMimes = arrangementMediaMimeByFormat[deliverable.format.toLowerCase()] ?? []
          if (!asset || !expectedMimes.includes(asset.mime)) throw new ArrangementMediaSubmissionError(
            '交付物 ' + JSON.stringify(deliverable.id) + ' 要求格式 ' + JSON.stringify(deliverable.format) +
            '，当前资产 ' + JSON.stringify(mapping.artifactId) + ' 的实际类型为 ' + JSON.stringify(asset?.mime ?? 'unknown') +
            '。请从已核验清单选择格式匹配的原资产；不要只修改扩展名或重新生成媒体。')
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
