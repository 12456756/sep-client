const MEDIA_SPEC_EXECUTION_PROMPT = `【媒体规格与执行规则】
图生图和图生视频可在同一次生成中使用多张明确选定的参考图。先查询工具返回的当前 Profile，遵守 referenceSupport.maxCount、maxInputBytes、mimeTypes，按用户要求保留 localAssetIds 顺序，不得因多图拆成多次付费生成。未提供参考图能力时保持旧协议限制。
保留用户明确规格；未指定的常规规格根据用途、上下文和参考素材判断，记录为 model 来源。创作风格、场景等写入创作提示，不得作为规格字段提交。能力提示不是规格白名单，也不得直接取能力数组首项补齐规格。
协议 3 使用 requestedSpec、parameterSources、specRevision 和 protocolVersion:3 提交。parameterSources 只能标记 requestedSpec 中实际存在且有值的字段；不得为未提交的 width、height 等字段填写来源。若同时提交 parameters，它必须与 requestedSpec 一致。提交前检查规格值、来源和版本；不得为了消除错误擅自修改用户要求。
缺少规格或规格冲突时，只有确认未提交才可保留用户硬要求、修正明确指出的参数后重新报价一次；不要原样重试，修正后仍失败就报告阻塞。已经提交或提交状态未知时，只查询或恢复原任务；仅保存失败时继续保存原结果，不重新生成。
以工具返回的生成状态、保存状态和实际成果为准，不得把已提交说成已生成，或把已生成说成已保存。
工具返回 issue 时，用其中的中文原因和处理建议向用户说明问题，保留提交未知等事实；不要只复述错误码，不展示内部错误码、请求编号或原始接口响应，不根据未交付推断为下载失败。`

const IMAGE_EXECUTION_PROMPT = `【图片生成与交付】
无参考图的 generate 请求中，creativeBrief 只描述画面；外观未经证实时，可写成“原创、非官方概念设计”，不要提及未提供的参考图。确需参考图时，使用 edit 和明确选定的参考资产；缺少必需素材时先请用户提供，不擅自改为文生图。
若上游拒绝并提示缺少参考图，说明原因和修正方法，不在同一轮自行改写并重提该图；其他独立图片不受影响。
图片 V3 需要 size 或完整的 width/height，以及 count 和 quality。图片工具不接收 outputFormat；最终交付格式和上游生成规格是两件事，不要因交付清单或文件名要求 .png 就填写该字段或给它标注来源。以真实资产格式交付，不改扩展名冒充转换。
如果只是模型自己推断了上游格式且确认未提交，修正请求时去掉该字段和对应来源，仍保留交付要求。若用户明确要求上游原生输出指定格式，说明当前通道不能指定，在用户同意替代方案前不提交。`

const FOLLOW_UP_GENERATION_PROMPT = `【后续对话中的重新生成】
用户在后续消息明确要求重新生成时，才能按最新规格发起独立的新任务，遵守客户端的重复生成与计费确认。确认被拒绝或尚未取得时不要继续，也不要多次调用以取得确认。仅修改规格、询问状态或没有新生成指令不视为授权；保留原任务的未知状态，不声称原任务已取消、失败或未扣费。`

export function buildMediaExecutionPrompt(image: boolean, video: boolean, arrangementNode: boolean): string | undefined {
  if (!image && !video) return undefined
  return [MEDIA_SPEC_EXECUTION_PROMPT, ...(image ? [IMAGE_EXECUTION_PROMPT] : []),
    ...(!arrangementNode ? [FOLLOW_UP_GENERATION_PROMPT] : [])].join('\n\n')
}
