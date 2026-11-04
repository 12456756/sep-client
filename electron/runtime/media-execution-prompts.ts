export const MEDIA_SPEC_EXECUTION_PROMPT = `【媒体规格与执行规则】
保留用户明确规格；未指定的常规规格根据用途、上下文和参考素材判断，记录为 model 来源。创作风格、场景等写入创作提示，不得作为规格字段提交。能力提示不是规格白名单，也不得直接取能力数组首项补齐规格。
协议 3 使用 requestedSpec、parameterSources、specRevision 和 protocolVersion:3 提交。parameterSources 只能标记 requestedSpec 中实际存在且有值的字段；不得为未提交的 width、height 等字段填写来源。若同时提交 parameters，它必须与 requestedSpec 一致。提交前检查规格值、来源和版本；不得为了消除错误擅自修改用户要求。
缺少规格或规格冲突时，仅在错误明确表明尚未提交生成时修正参数；已经提交或提交状态未知时，查询或恢复原任务，不得重新报价并发起另一笔付费生成。原任务的查询、跟踪和保存不等于再次生成。
以工具返回的生成状态、保存状态和实际成果为准，不得把已提交说成已生成，或把已生成说成已保存。`
