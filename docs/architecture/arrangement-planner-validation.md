# 规划提示词与校验程序

## 完整提示词

- [系统提示词全文](../../prompts/arrangement-planner-prompts.md)：Pi 原生系统提示词的说明与完整规划规则，媒体示例已展开。原生工具列表、目录和 SDK 文档路径由 Pi 动态提供。
- [首次请求与七种失败阶段的完整修正消息](../../prompts/arrangement-planner-repair-prompts.md)：还包含企业、平台推荐阶段的修正消息。演示数据不是生产默认配置。
- `npx tsx scripts/export-arrangement-planner-prompts.ts` 根据实际构造函数重新生成这两份文档；系统规则全文由同步测试核对。

系统规则只负责规划，禁止执行任务、调用工具、创建文件和宣称完成。任务数据单独传入用户消息，不改变员工授权。主 JSON 示例展示用户附件、图片编辑、图生视频、规格来源、媒体交付物及依赖的完整结构；四种操作只列差异表，字段规则集中说明。普通文档节点按需省略媒体结构，示例参数不是默认值。

## 校验顺序和代码

| 顺序 | 程序 | 检查内容 |
| --- | --- | --- |
| 1 | `electron/runtime/pi-arrangement-planner.ts` 的 `validateSettledResponse` | 回复非空、正常结束、未因长度截断；服务或认证错误不进入内容修正。 |
| 2 | `electron/domain/arrangement-planner.ts` 的 `extractJson`、`parseArrangementPlannerOutput` | 提取并解析 JSON；顶层和节点基本结构、节点数量、意图和未解决步骤。历史兼容解析不等于允许模型省略系统必填要求。 |
| 3 | `electron/domain/arrangement-planner-media.ts` 的 `normalizePlannerMediaContract` | 仅对原有模型输出兼容形式进行规范化，不更改用户规格或伪造附件、资产 ID。 |
| 4 | `electron/domain/arrangement-plan.ts` 的 `arrangementNodeWorkContractSchema` | 交付物、附件引用、媒体需求的字段类型、数量、格式、严格子对象结构。 |
| 5 | 同文件的 `arrangementMediaRequirementSchema`、`arrangementDeliverableArtifactSchema`；`src/shared/media-spec-contract.ts` | 媒体操作与类型、输入对象、规格版本、参数来源、尺寸比例和图像/视频规格匹配、媒体交付来源。 |
| 6 | `parseArrangementPlannerOutput` 的附件及媒体输入检查 | 附件必须属于本草稿且指纹一致；必用附件必须绑定。编辑或图生视频需要明确来源，或唯一、已核验的图片附件绑定。多图来源不明确时继续反馈，不猜测选择。 |
| 7 | `parseArrangementPlannerOutput` 的员工、模型检查 | 执行员工有效且可执行；模型属于该员工的 allowedModels。 |
| 8 | `electron/domain/arrangement-plan.ts` 的 `validateArrangementDraft`、`validateArrangementNodes` | 节点 ID、直接依赖、重复/自依赖/循环、媒体来源节点和交付物引用。依赖失败携带具体字段诊断。 |
| 9 | `parseCandidateMatches` | 推荐是建议性数据：无效候选会被过滤，不把候选转成已授权执行员工。 |
| 10 | `electron/domain/arrangement-delivery.ts` 的 `deliveryPlanIssues`，由 `electron/service/arrangement-service.ts` 在启动前调用 | 完整目标与交付合同、交付 ID/路径冲突、当前媒体交付格式与来源限制。此项是启动前检查，不冒充规划响应阶段已通过的检查。 |

系统协议说明了比历史解析最低要求更完整的新规划要求；本次不强制迁移历史草稿，不将所有业务原则改成新增的拒绝规则。

## 错误反馈和连续修正

`electron/errors/planning-diagnostics.ts` 为字段、节点合同、附件、员工/模型和依赖错误构造允许的诊断路径、错误类型及预期要求。字段路径覆盖附件与结构化媒体规格；未知字段名仍被脱敏，不发送原始模型输出、异常正文、堆栈或凭据。

`buildArrangementPlannerRepairPrompt` 使用失败阶段、实际诊断、当前阶段完整输出结构和原有本轮数据构造修正消息。已授权阶段的示例直接包含媒体和附件结构，不再额外重复附件片段，并说明普通文档应省略媒体字段；推荐阶段仍返回 nodes=[]。消息要求保留已有有效规划，只修正失败项及关联引用，返回完整 JSON；只有实际检查过的阶段才能宣称通过。

`PiArrangementPlanner.plan` 将实际错误传给提示构造函数，返回 `continueWith`；`PiTaskWorker.run` 在同一会话继续请求并再次完整校验。内容修正不设置次数或累计时间上限，保留用户取消；认证、网络、网关等待策略仍按原流程处理。

修正反馈参考员工交付模块的分阶段设计，但不要求规划器执行工具、修复文件、生成资产、读 Skill 或提交执行交付结果。

## 验证范围

回归覆盖附件嵌套格式、精确诊断、单图与多图来源、文档不能充当图片、指纹/归属检查、图像和视频示例的真实解析、员工模型和依赖错误反馈、连续八次以上修正、用户取消，以及无原始异常泄漏。具体通过结果以本次交付汇报为准。

## 本次验证记录（2026-11-03）

- 整合媒体主示例后，规划规则从 17547 字符、563 行缩减为 14342 字符、418 行（不含 Pi 动态前缀，字符减少约 18%）。校验程序及连续修正策略没有因本次精简而改变。
- 规划相关领域、运行时与诊断专项回归 149 项通过；完整媒体主示例及四种操作的变体经实际解析器验证。
- 覆盖率专项的 41 项测试全部通过；`arrangement-planner-prompts.ts` 行覆盖率 99.36%、分支覆盖率 81.08%、函数覆盖率 100%，均通过 80% 门槛。
- 不变量回归、`npm run typecheck`、`npm run build`、`npm run check:boundaries` 和本次全部修改 TypeScript 文件的 ESLint 检查通过。
- 此前的全量 `npm run test:tasks`：2501 项通过、26 项失败、5 项跳过。失败涉及 Windows 符号链接权限、文件替换/占用、长路径、测试进程通信及员工交付状态断言；Office 运行时测试进程长时间未退出，已手动终止该测试进程，不能宣称全量通过。本轮提示词调整重跑专项回归，没有重跑这套全量测试。
- 全量 `npm run lint` 未通过，错误位于本次未修改的附件测试、POC 及 UI 验收脚本；没有修改这些文件来消除失败。
- 本次验证使用本地解析器和模拟模型/网关，尚未完成真实线上模型及运行中客户端的人工验收。
