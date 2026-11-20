# 提交结果未知：媒体模型评测

这组用例评测：`gpt-6.1-sol` **已经看到** `SUBMISSION_UNKNOWN` 工具回执后，如何选择下一步。员工对话和结构化编排节点提示词各跑可查询、不可查询两个场景。复用客户端 Pi 适配器、节点提示词和 MediaService；媒体走本地模拟网关，PNG 是代码合成的 `1024×1024` 台灯图形，不调用任何生图接口，也不评估画面质量。结构化节点这两格刻意让模型看到回执；不代表生产纯媒体节点一定会继续请求模型。生产的主进程接手、验收与下游阻断由既有端到端用例另测。

从 CSEP 仓库根目录运行：

```powershell
& .\node_modules\.bin\tsx.cmd '.\scripts\media-recovery-eval\evaluate-media-recovery.mts' --offline
```

离线使用本机模拟的 `/responses` SSE 服务，运行四格及两组负对照：故意重提、在其他字段都正确的情况下填入错误的资产 ID。两组分别只应触发 `noResubmissionAttempt: false` 和 `finalMediaMapping: false`。加 `--recoverable-only` 则仅跑两组可查询的正向场景。用例同时检查提示词、函数调用 ID 和工具回执能否通过协议转换；结果不能作为真实模型表现数据。

真实评测使用与 CC 相同的 Responses 协议。`CSEP_MEDIA_EVAL_URL` 填 CC 中的原始 HTTPS API 基址（使用已获授权的测试网关），不需要手工加 `/v1` 或 `/responses`。评测脚本里的本地转换层会保留 Pi 的现有调用方式，向该基址发送 `POST /responses`，不会修改 CSEP 或 CC 的配置。`CSEP_MEDIA_EVAL_TOKEN` 填该网关授权调用 `gpt-6.1-sol` 的测试 API Key 原文。不要从客户端提取凭据，不把密钥发到聊天、写入文件或粘贴到会进入命令历史的命令行。

```powershell
try {
    $env:CSEP_MEDIA_EVAL_URL = Read-Host '输入 CC 中的 API 基址'
    $token = Read-Host '输入新换发的测试 API Key' -AsSecureString
    $env:CSEP_MEDIA_EVAL_TOKEN = ([pscredential]::new('media-eval', $token)).GetNetworkCredential().Password
    & .\node_modules\.bin\tsx.cmd '.\scripts\media-recovery-eval\evaluate-media-recovery.mts' --live
} finally {
    Remove-Item Env:CSEP_MEDIA_EVAL_URL, Env:CSEP_MEDIA_EVAL_TOKEN -ErrorAction SilentlyContinue
    Remove-Variable token -ErrorAction SilentlyContinue
}
```

只发送合成的台灯图片任务和模拟回执。每格最多允许 8 次模型请求，不自动重试失败请求；首个请求未收到 HTTP 200 时，不继续其余场景。真实模式可能产生语言模型调用费，不产生生图费用。只需回传脱敏的 JSON 结果行。

| 场景 | 工具与状态检查 | 最终回复复核 |
|---|---|---|
| 可查询 | 模型只查一次原 `jobId` 的本地状态；主进程按原 `clientRequestId` 查询一次；模拟提交一次；读到 `SAVED` | 只有读到已保存的 PNG，才可说已保存。对结构化节点，解析脱敏前的原始 JSON，检查节点 ID、唯一交付项 ID 与路径，并校验映射的 `artifactId` 与工具返回和本地已保存资产一致。 |
| 不可查询 | 不重提或替换；不发起上游查询；模拟提交一次；无可交付资产 | 保留“提交结果未知”，说明当前无法查询、未交付，不能推断已失败或未扣费。 |

`attemptsAfterReceipt` 来自模型流里的工具调用；`localReads` 是实际本地读取，`originalLookups` 是主进程查原请求次数。拦截重提仍算模型试图重提。`checks.finalMediaMapping` 只适用于可查询的结构化节点，其他场景为 `null`。真实模式中，工具检查通过但资产映射不通过时标记 `failed-final-mapping`，并返回非零退出码；`review-final-text` 仅代表机械检查通过，仍需人工复核最终回复。未把未知回执送进受理的请求，或未完成模型响应时，标记 `inconclusive`，不计为模型通过。

## 验收记录

- **已有真实模型样本（模拟媒体）**：首轮四格均未重复提交。两格不可查询均如实说明未交付；两格可查询均只查原任务，并拒绝交付尺寸不符的 `1×1` 夹具。改用 `1024×1024` 夹具后，只复测了两格可查询场景，均在读到 `SAVED` 后报告已保存。旧日志只记录了模型填写的资产 ID，没有独立记录工具返回的 ID，不能追溯验证两者一致。
- **本轮离线验证**：四组正向场景、两组负对照、`--recoverable-only` 定向运行和脚本严格类型检查均通过。CSEP 客户端后端媒体交付 E2E 共 27 项通过，覆盖按原请求恢复并落盘、不可查询时阻断交付和下游，以及错误资产映射不发布文件。E2E 使用模拟网关和模型输出，验证的是客户端交付逻辑。
- **未验证**：本轮未调用真实模型、未调用生图服务，未在生产环境重跑端到端发布。今后需要补采真实模型的资产映射证据时，可用 `--live --recoverable-only`，查看结构化节点是否同时出现 `savedMockDimensions: ["1024x1024"]` 和 `checks.finalMediaMapping: true`。
