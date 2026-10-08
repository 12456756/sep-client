# 自动编排日志排查

本次只增强后端诊断，不扩展 IPC、`lastPlanning` 或客户端提示。

## 如何定位

1. 找到 `arrangement-service` 的 `planning failed`，按 `planningId` 搜索同一次编排的所有日志；`runId` 与 `planningId` 一致。
2. 查看 `round` 和 `employeeScope`：1 / authorized、2 / enterprise、3 / platform。
3. 查看 `arrangement-planner` 的 `planning phase failed`：`phase` 是具体失败阶段，`reason` 是不包含原文的技术原因。
4. 若只有服务层失败日志，优先查看 `employee-loading`（员工或能力目录加载）及 `finalization`（读取、保存草稿或推送结果）。

每个阶段都有 `planning phase started/completed` 和耗时。Provider 调用记录的是完整 `worker.run()` 边界，并不把 worker 返回成功等同于 HTTP 200。

## 重点字段

- `planningId`、`runId`、`draftId`、`draftRevision`、`round`、`employeeScope`、`modelId`：关联信息；运行器在选定模型后补全模型 ID。
- `phase`：初始化、员工加载、worker 调用、响应组装、JSON 提取/解析、输出/员工/模型/DAG 校验、收尾或清理。
- `reason`：例如 `empty-response`、`json-not-found`、`invalid-json`、`employee-unavailable`、`model-not-allowed`、`invalid-draft`、`network-error`、`model-not-configured`。
- `eventCount`、`eventTypes`、`textDeltaCount`、`messageEndCount`、`textDeltaLength`、`messageTextLength`：判断有没有收到事件，以及是否组装出文本。
- `completedNodeCount`、`unresolvedStepCount`：失败时内存中已匹配节点和剩余步骤数，**不表示这些中间结果已持久化**。
- `providerStatus`、`causeCode`：能从错误对象或标准状态前缀中可靠识别时记录；不根据任意字符串中的数字猜测状态。
- `causeType`、`stack`：异常类型及调用位置；`causeMessage` 是安全原因标签，不是原始异常消息。保留消息长度和不可逆指纹用于关联重复错误。

示例：`phase=response-assembly`、`reason=empty-response`、`textDeltaLength=0`、`messageTextLength=0`，说明 worker 已结束，但没有可用的规划文本。

## 安全与业务边界

- 使用统一 logger 和共享脱敏，不记录完整目标、Prompt、员工目录、模型原文、Provider 响应正文或凭据。
- JSON 解析异常可能包含模型原文，因此只保留安全原因、异常类型、调用位置、长度和指纹。
- 用户主动取消记为正常取消；清理异常另记 `planning cleanup failed`，不覆盖主错误。
- 未解决步骤仍进入 `awaiting-employee`，日志记为正常完成，不是系统失败。
- 不虚构 Provider 请求 ID：当前规划器端口没有可靠暴露该字段，使用已有 `runId` 串联 SDK 日志。

## 回归命令

```powershell
npx tsx --test electron/errors/planning-diagnostics.test.ts electron/runtime/arrangement-planner.test.ts electron/runtime/pi-arrangement-planner.test.ts electron/service/arrangement-service.test.ts
npm run typecheck
npm run check:boundaries
npm run test:tasks
npm run test:invariants
npm run build
```
