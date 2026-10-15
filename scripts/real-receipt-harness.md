# 显式 real receipt Electron 验收

此入口只接管已有真实 generate/edit 回执，复用 MediaService、MediaStore、SepRealMediaGateway、生产 preload / media routes 和 MediaArtifactsPanel。不启动 Pi、不登录、不购买订阅、不发起新报价或生成；fixture 不证明 Pi 会话、员工授权或人工审批流程。

## 2026-10-15 真实回执验收结果

run `live20261015_8b6cf22a0241`，证据在 `outputs/electron-real-live-2026-10-15/live20261015_8b6cf22a0241-recovery/evidence.json`，`passed:true`、`source:supplied-real-receipts`、`provesPiFlow:false`。图片为真实 gpt-image-2 白底红杯生成和以该图为参考编辑的蓝杯，各1024x1024。SEP 使用隔离 synthetic 订阅/批准 Skill/钱包夹具，上游 sub2api 调用及美元收费真实；没有生产 SEP 自然购买、Pi 对话或人工审批证据。

两个下载在发送 content GET 前被阻断，正常退出落盘 `INTERRUPTED/SAVE_FAILED`；同一 userData 重启，不重新 seed 或自动访问网络。从面板显式恢复后仅发出两次原 content GET，两项均 `SAVED`。原 job/run/client/receipt/profile/config/requestHash/immutableHash 保持一致，实际 UI 预览解码和导出 hash 匹配：

| 结果 | SHA256 | 字节数 |
| --- | --- | --- |
| 红杯生成图 | d5ee4a94f027d873078a8db5c323983ca9570fdf274c66d4b01071c6c2107479 | 951049 |
| 蓝杯编辑图 | 1a6b4c77d436688189f214eed0a235b10092c49b80fdda55bef2cf76f9ec6d05 | 964920 |

同目录保留 `saved-panel.png`、两张 preview 截图和两张 export PNG，已实际目视检查。文件对话框目的路径由 harness 注入，不代表人工选择文件夹验收。面板没有启用新图片 capability，历史恢复仍可用；截图中能力不可用提示不代表生产员工配置完成。

SEP 另行按原请求查询两笔 settled 账单：各 USD0.29346，冻结汇率7.2，SEP 测试钱包各 CNY2.112912；恢复后请求/消费/用量仍各两条，余额不变。harness 自身不独立认证结算，GET 白名单和零 POST 计数也不是外部抓包证据，应结合 SEP 账务和请求数量核验。详情见 `../SEP/docs/progress/2026-10-15-电商图片员工真实生成编辑与计费验收.md`。

首次真实回执验证因短期 token 到期停止，没有图片请求。只读重启同一 SEP 夹具取得短期授权后通过，未充值或延长订阅。本次私有授权文件已在验收后删除。

针对性 fixture 测试及 opt-in memory Electron 测试最终5项全通过，零真实网络；main/renderer typecheck、修改范围 ESLint、架构边界检查通过。专用 electron-vite 配置已构建，未运行会重写用户 runtime-config 的完整构建；独立 review 无阻断项。图片与私有 fixture 不纳入源码提交。

## 运行

```bash
cd /Users/yao/LLM/sep-client
chmod 700 /absolute/private
chmod 600 /absolute/private/fixture.json
npx --no-install electron-vite build --config electron.real-receipt.config.ts
SEP_REAL_RECEIPT_FIXTURE=/absolute/private/fixture.json \
  node scripts/test-electron-real-receipt.mjs
```

不要用 `npm run build`，它会生成 runtime-config。本 config 只写 `out/real-receipt/`，不覆盖正常应用构建。Runner 自动创建 `0700` 独立 `sep-electron-real-receipt-*` userData，同一次验收两次启动使用相同目录，不接触正常用户数据。

可选 `SEP_REAL_RECEIPT_OUTPUT=/absolute/evidence-directory`、`SEP_REAL_RECEIPT_SHOW=1`。结果默认存入 `outputs/electron-real-receipt-<timestamp>/`：两张 preview 截图、面板截图、两张导出 PNG、`evidence.json`。图片包含业务结果，按业务数据管理；凭据不进入截图/evidence。私有 fixture 仅 Electron 主进程打开，runner 不读取内容。无 trace/HAR/network header dump。

## 私有 JSON

父目录必须属于当前用户、权限恰为 `0700`、非软链接；文件属于当前用户、权限恰为 `0600`、非软/硬链接、绝对路径，最大 4MiB。不要把该文件放入 Git 或 evidence 目录。不要通过命令行传 token。

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:3001/api",
  "employmentToken": "<private employmentToken>",
  "owner": { "enterpriseId": "<actual>", "memberId": "<actual>" },
  "task": { "taskId": "fixture-media-task", "subscriptionId": "<actual>" },
  "provenance": {
    "kind": "external-receipt-adoption",
    "provesPiFlow": false,
    "approvals": [
      { "jobId": "fixture-generate", "kind": "fixture-automatic", "source": "SEP isolated fixture automatic execution; no manual approval" },
      { "jobId": "fixture-edit", "kind": "fixture-automatic", "source": "SEP isolated fixture automatic execution; no manual approval" }
    ]
  },
  "jobs": ["<complete generate LocalMediaJob>", "<complete edit LocalMediaJob>"]
}
```

`baseUrl` 必须正好以 `/api` 结尾，无末尾 `/`、userinfo、query、hash；HTTP 仅允许 loopback，其他地址必须 HTTPS。输入只支持两个 `SUCCEEDED` job，generate/edit 各一个，每个恰一张有效未过期 PNG 输出。原有审批记录可声明 `recorded-manual` / `recorded-automatic` 并提供原记录 `recordSha256` 和 `source`；harness 检查声明一致性，不独立证明记录真实性。`fixture-automatic` 必须匹配 `approval:"automatic"`，不接受伪造 `manual`。

完整 job（按真实数据替换占位符；禁止复制合成测试数据作为真实来源）：

```ts
const parameters = { aspectRatio: '1:1', size: '1024x1024', count: 1, quality: 'medium' }
// 使用已有客户端 hash；若首次从 SEP 外部 fixture 接管，按现有 gateway 算法建立本地身份。
// 属性顺序须保持，quality 不在现有 gateway 的 hash 输入中。
const requestHash = sha256(JSON.stringify({
  profileId, configVersion, operation, creativeBrief,
  parameters: { size: parameters.size, count: parameters.count },
  references: referenceHashes,
}))
const job = {
  version: 1, owner, jobId, taskId, runId, subscriptionId,
  clientRequestId, requestHash,
  input: { profileId, operation, localAssetIds, creativeBrief, parameters },
  profile: {
    profileId, kind: 'image', displayName, configVersion,
    operations: ['generate', 'edit'], executionMode: 'sync-response',
    capabilities: { referenceImage: true, cancel: false, recoverByRequestId: true },
    allowedAspectRatios: ['1:1'], allowedSizes: ['1024x1024'], maxCount: 1,
  },
  request: {
    clientRequestId, requestHash, quoteId, profileId, configVersion,
    operation, referenceIds, referenceHashes, creativeBrief, parameters,
  },
  quote: {
    quoteId, requestHash, expiresAt: quoteExpiresAtEpochMs,
    status: 'quoted', amount: originalQuote.amountCny, currency: 'CNY',
    authorized: true, budgetAuthorized: true, allowUnknownCost: false,
  },
  approval: 'automatic', receiptId, submission: 'RECEIPTED',
  generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'PENDING',
  outputs: [{ outputId, mime: 'image/png', size: originalOutput.byteLength,
    width, height, sha256: originalOutput.sha256,
    expiresAt: originalOutput.expiresAt === null ? null : Date.parse(originalOutput.expiresAt),
  }],
  billingStatus: originalReceipt.billingStatus, recovery: originalReceipt.recovery,
  nextPollAt: 0, attempts: 0, error: null,
  createdAt: originalCreatedAtEpochMs, updatedAt: originalUpdatedAtEpochMs,
}
```

`jobId/taskId/runId/clientRequestId/receiptId/outputId/subscriptionId` 等请求路径 ID 使用 `[A-Za-z0-9_-]{1,128}`。`jobId` / `clientRequestId` / `receiptId` 两条之间分别不重复。owner/task/subscription 与顶层一致。`quoteId/requestHash/profileId/configVersion/input/request/profile` 需符合真实 MediaStore 的所有一致性约束。

SEP wire 映射：输出 `mimeType→mime`、`byteLength→size`、ISO 日期→epoch ms；quote `amountCny→amount`、`currency=CNY`，其余 quote 标记与现有 `SepRealMediaGateway.quote()` 相同。quote 可以已过期，此验收不重新提交、不重新报价。不直接假定上游 `semanticSha256` 等于客户端本地 requestHash。保留原价、quoteId、request 参数、参考图 hash 和 profile/configVersion。

实际 profile 的 sizes→allowedSizes；约分宽高→allowedAspectRatios；supportsReferenceImage→referenceImage；maxOutputs→maxCount（最多 4），不要为了匹配示例改变实际规格。capabilities 只用于历史任务元数据；harness 不授予生成能力，UI 不出现重做/生成表单。

generate 通常三个参考图数组为空；edit 必须有实际上传的 referenceIds 与对应原图 referenceHashes，`input.localAssetIds` 数组长度一致。若外部 SEP fixture 从未有客户端本地图，可分配稳定的 fixture 引用 ID，说明这是接管时本地身份；此流程不会读这些参考图或声称恢复了本地参考图文件。若从未有客户端 job/run/task，可分配稳定 fixture job/run/task ID，保留真实 SEP clientRequestId/receiptId。不能声称恢复了原 Pi 会话或伪造原运行快照。

## 验收顺序与网络边界

1. 真实 store 校验/保存完整 job；主进程 GET 原回执，核对 receipt/client/profile/config/status 和完整输出元数据。
2. 从真实面板点击两个“恢复跟踪”。下载在主进程 fetch 白名单后阻断，未向服务端发送 content GET；等待两个 job `SAVING`。
3. 正常 `app.quit()` → 生产 shutdown handler → `MediaService.stopAll()` → 落盘 `INTERRUPTED/SAVE_FAILED`，写完成标记。没有杀进程代替正常关闭。
4. 同一 userData 重启；不重新 seed、不自动 resumePending、不在启动时发网络。比较原 job/run/client/receipt/profile/config/hash 与不可变元数据 hash。
5. 从真实面板显式恢复；只 GET 原 output content，校验 SHA256、PNG 类型、字节数/尺寸；真实 UI blob 预览解码、点击导出，通过注入原生保存 dialog 固定目的路径；校验预览和导出 hash/尺寸/字节数。

fetch 白名单只包括输入两条 job 的 `/api/gateway/v1/media/real/requests/{receiptId}`、`/requests/by-client-id/{clientRequestId}` 和 `/requests/{receiptId}/outputs/{outputId}/content`，只准 GET、同 origin、无 query/hash，不跟随重定向。所有 POST、profiles/quote/reference/model/其他 ID 都被拒绝。renderer 只准本地构建静态资源与 blob，无 HTTP 权限。IPC 的 generate/redo/cancel/import 被明确拒绝，真实 preview/export/resume/retry/query routes 原样复用。

## 本地无网络验证

```bash
npx --no-install tsx --test scripts/real-receipt-fixture.test.ts
npx --no-install electron-vite build --config electron.real-receipt.config.ts
SEP_RUN_RECEIPT_ELECTRON_TEST=1 \
  npx --no-install tsx --test scripts/real-receipt-fixture.test.ts
```

Electron 回归用合成完整 job、1px PNG、内存协议响应；真实 gateway 解析、hash、store、preload、IPC、面板、正常关闭与重启均保留，`actualNetworkRequests` 必须为 0。evidence 标注 `memory-protocol-test`，不能用它宣称真实媒体成功。真实输入请勿设置 `SEP_REAL_RECEIPT_MEMORY_TEST`。

## 已有连接点

runner 使用 `_electron.launch({executablePath: electron,args:['out/real-receipt/main/index.js']})`；`application.evaluate()` 只调用主进程 `__sepRealReceiptTest.summary/verifyReceipts/shutdown`；`firstWindow()` 取得真实 renderer。`page.evaluate()` 调用生产 `window.electronAPI`，没有 fake preload API。

调试时可在本 runner 内通过 `application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.openDevTools())` 打开 DevTools。不要把私有 fixture 内容、主进程变量或请求 Authorization 输出到 DevTools/终端。此入口无需完整聊天 UI 或订阅/授权 API，但输入 token 的读权限仍由 SEP 服务端验证。
