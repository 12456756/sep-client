# SEP 客户端监控全链路对接文档 v1

> 面向：Electron / 桌面客户端开发者
> 适用环境：联调环境
> 文档日期：2026-09-20
> API 根地址：`https://sep-dev.longdaoSEP.cn/api`

本文只说明“客户端执行任务 → 云端保存任务镜像 → 企业 Web 查看监控”的完整链路。

当前云端的职责是**保存客户端执行镜像**，不是执行客户端任务。客户端必须在本地完成任务执行、暂停、恢复、失败处理和本地数据保护；云端只接收用于监控的脱敏字段。

---

## 1. 当前链路总览

```text
客户端登录
    ↓
获取 accessToken
    ↓
获取可用 subscriptionId
    ↓
创建本地任务
    ↓
POST /client/tasks
    ↓
保存云端 mirrorId
    ↓
上报 QUEUED
    ↓
上报 RUNNING
    ├── 定时发送 heartbeat
    ├── 按 sequence 上报执行事件
    └── 网络中断时写入本地同步队列
    ↓
任务完成 / 失败 / 取消
    ↓
上报 COMPLETED / FAILED / CANCELLED
    ↓
企业 Web：工作安排 → 客户端监控
    ↓
GET /client/tasks
GET /client/tasks/:id
```

客户端本地任务和云端任务镜像不是同一个 ID：

| 名称 | 含义 | 由谁生成 | 用途 |
| --- | --- | --- | --- |
| `clientTaskId` | 客户端本地任务 ID | 客户端 | 创建镜像时用于幂等；同一用户下必须稳定唯一 |
| `clientRunId` | 本次本地执行运行 ID | 客户端 | 标识一次具体执行运行和事件流 |
| 云端 `id` / `mirrorId` | 云端任务镜像 ID | 服务端 | 后续状态、心跳、事件接口的路径参数 |

客户端创建镜像后，必须保存服务端返回的云端 `id`。后续上报不能继续使用 `clientTaskId` 或 `clientRunId` 代替云端 `id`。

---

## 2. 认证链路

### 2.1 客户端登录

```http
POST /client/auth/login
Content-Type: application/json
```

请求示例：

```json
{
  "email": "member@example.com",
  "password": "******",
  "fingerprint": "device-fingerprint-xxx",
  "platform": "darwin-arm64",
  "clientVersion": "0.1.0"
}
```

响应中需要保存：

```json
{
  "accessToken": "<短期访问令牌>",
  "refreshToken": "<长期刷新令牌>",
  "accessTokenExpiresIn": 3600,
  "refreshTokenExpiresIn": 2592000,
  "user": {},
  "enterprise": {},
  "devices": []
}
```

客户端要求：

1. `accessToken` 用于调用后续 `/client/*` 接口。
2. 每次请求增加：

   ```http
   Authorization: Bearer <accessToken>
   ```

3. `refreshToken` 只保存在 Electron 主进程的安全存储中，不交给 renderer，不写入普通日志。
4. `accessToken` 过期收到 `401` 时，先调用刷新接口，再重试原请求一次。
5. 刷新失败时停止同步队列，并提示用户重新登录。

### 2.2 刷新 accessToken

```http
POST /client/auth/refresh
Content-Type: application/json
```

请求：

```json
{
  "refreshToken": "<refreshToken>"
}
```

刷新成功后替换内存中的 `accessToken`。不要因为一次网络超时就清除本地任务队列；只有明确认证失败或设备被吊销时，才停止发送并提示重新授权。

### 2.3 获取可用订阅

创建任务镜像前，需要确认任务使用的订阅对当前用户有效：

```http
GET /client/subscriptions
Authorization: Bearer <accessToken>
```

客户端应使用响应中的有效订阅 ID 作为 `subscriptionId`。如果订阅不存在、已过期、已撤销或当前用户没有授权，创建任务镜像会失败。

---

## 3. 创建任务镜像

### 3.1 接口

```http
POST /client/tasks
Authorization: Bearer <accessToken>
Content-Type: application/json
```

请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `clientTaskId` | string | 是 | 客户端本地任务唯一 ID，长度 1～160 |
| `clientRunId` | string | 是 | 本次运行唯一 ID，长度 1～160 |
| `subscriptionId` | string | 是 | 当前用户有权限使用的订阅 ID |
| `title` | string | 是 | 展示给企业 Web 的任务标题，长度 1～200 |
| `taskType` | string | 否 | 任务类型；未传时服务端默认为 `conversation` |
| `modelId` | string/null | 否 | 使用的模型 ID |
| `clientVersion` | string/null | 否 | 客户端版本 |

请求示例：

```json
{
  "clientTaskId": "local-task-01JABC",
  "clientRunId": "run-01JABC",
  "subscriptionId": "sub_xxx",
  "title": "整理本周客户反馈",
  "taskType": "scheduled",
  "modelId": "gemini-3.5-flash-high",
  "clientVersion": "0.1.0"
}
```

### 3.2 服务端校验

服务端会校验：

- 当前 access token 对应的用户身份；
- 用户所属企业；
- `subscriptionId` 是否属于当前企业；
- 订阅是否为 `ACTIVE`；
- 订阅是否在有效期内；
- 当前用户是否有直接或部门授权。

校验失败时不会创建可用任务镜像，客户端应记录错误原因但不要无限重试。

### 3.3 响应与本地保存

成功响应会返回云端任务镜像对象，核心字段类似：

```json
{
  "id": "cmirror_xxx",
  "clientTaskId": "local-task-01JABC",
  "clientRunId": "run-01JABC",
  "userId": "user_xxx",
  "enterpriseId": "enterprise_xxx",
  "subscriptionId": "sub_xxx",
  "title": "整理本周客户反馈",
  "taskType": "scheduled",
  "modelId": "gemini-3.5-flash-high",
  "status": "QUEUED",
  "progress": 0,
  "lastSequence": 0,
  "lastHeartbeatAt": null,
  "startedAt": null,
  "completedAt": null
}
```

客户端本地任务至少保存：

```text
clientTaskId
clientRunId
cloudMirrorId = response.id
lastSequence
syncQueue
```

### 3.4 幂等规则

服务端使用以下组合做创建幂等：

```text
(userId, clientTaskId)
```

因此：

- 网络超时后可以使用相同的 `clientTaskId` 重试创建；
- 不要因为没有收到响应就马上生成新的 `clientTaskId`；
- 同一个本地任务实例不要重复生成多个任务 ID；
- 新的一次独立执行应使用新的 `clientTaskId` 和新的 `clientRunId`。

建议规则：

```text
一次本地任务实例 = 一个 clientTaskId
一次实际运行 = 一个 clientRunId
```

---

## 4. 任务状态链路

### 4.1 状态接口

```http
PATCH /client/tasks/:id/status
Authorization: Bearer <accessToken>
Content-Type: application/json
```

这里的 `:id` 是创建镜像响应中的云端 `id`，即 `cloudMirrorId`。

请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `status` | enum | 是 | 任务状态 |
| `progress` | integer 0～100 | 否 | 当前进度 |
| `currentStep` | string/null | 否 | 当前步骤标识或名称 |
| `activity` | string/null | 否 | 当前活动摘要 |
| `errorSummary` | string/null | 否 | 脱敏后的错误摘要 |
| `startedAt` | ISO datetime/null | 否 | 开始时间 |
| `completedAt` | ISO datetime/null | 否 | 完成时间 |

支持状态：

```text
QUEUED
RUNNING
WAITING_APPROVAL
PAUSED
COMPLETED
FAILED
CANCELLED
```

### 4.2 推荐状态流转

```text
QUEUED
  ↓
RUNNING
  ├── WAITING_APPROVAL → RUNNING
  ├── PAUSED → RUNNING
  ├── COMPLETED
  ├── FAILED
  └── CANCELLED
```

客户端应避免反复发送相同状态，除非这是同步重试。终态为：

```text
COMPLETED
FAILED
CANCELLED
```

进入终态后，不再发送普通心跳；如果业务需要补充错误信息，应在进入 `FAILED` 时一并发送 `errorSummary`。

### 4.3 状态请求示例

进入排队：

```json
{
  "status": "QUEUED",
  "progress": 0,
  "currentStep": "queued",
  "activity": "任务已进入客户端执行队列"
}
```

开始执行：

```json
{
  "status": "RUNNING",
  "progress": 10,
  "currentStep": "collect-feedback",
  "activity": "正在收集客户反馈",
  "startedAt": "2026-09-20T10:00:00.000Z"
}
```

执行失败：

```json
{
  "status": "FAILED",
  "progress": 65,
  "currentStep": "summarize",
  "activity": "摘要生成失败",
  "errorSummary": "模型请求超时，请稍后重试",
  "completedAt": "2026-09-20T10:08:00.000Z"
}
```

错误摘要只能包含适合展示给企业管理员的信息，不要上传 token、Cookie、完整 prompt、本地绝对路径或文件内容。

---

## 5. 心跳链路

### 5.1 接口

```http
POST /client/tasks/:id/heartbeat
Authorization: Bearer <accessToken>
Content-Type: application/json
```

请求示例：

```json
{
  "progress": 45,
  "currentStep": "summarize",
  "activity": "正在生成客户反馈摘要",
  "clientVersion": "0.1.0"
}
```

所有字段均可选，但客户端建议至少发送：

```text
progress
currentStep
activity
clientVersion
```

服务端收到心跳后会更新：

```text
lastHeartbeatAt
progress
currentStep
activity
clientVersion
```

### 5.2 发送频率

建议：

```text
运行中每 15～30 秒一次
```

不要使用过短周期持续发送，例如每 1 秒一次。心跳只用于表示任务仍在执行，不是完整日志通道。

### 5.3 Web 端的超时判断

当前 Web 监控逻辑：

```text
任务未进入终态
且 lastHeartbeatAt 距今超过 60 秒
→ 显示“离线/未知”
```

这不是服务端主动把任务状态改成了 `UNKNOWN`，而是 Web 展示层根据最后心跳时间计算出来的状态。

客户端恢复心跳后，Web 下一次刷新即可显示实际任务状态。

### 5.4 休眠、退出和断网

以下情况不要直接删除本地任务：

- 网络断开；
- 系统休眠；
- Electron 窗口关闭但主进程仍在运行；
- 请求超时；
- 服务端暂时不可用。

应将待发送的心跳或状态写入本地同步队列，并在网络恢复后补传。任务本身是否继续执行，由客户端本地执行器决定。

---

## 6. 事件链路

### 6.1 接口

```http
POST /client/tasks/:id/events
Authorization: Bearer <accessToken>
Content-Type: application/json
```

请求示例：

```json
{
  "sequence": 1,
  "type": "step.completed",
  "stepKey": "summarize",
  "message": "已生成摘要",
  "progress": 80,
  "occurredAt": "2026-09-20T10:02:00.000Z"
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `sequence` | positive integer | 是 | 当前任务事件序号，从 1 开始递增 |
| `type` | string | 是 | 事件类型，长度 1～64 |
| `stepKey` | string/null | 否 | 步骤标识 |
| `message` | string/null | 否 | 脱敏后的事件摘要，最长 1000 字符 |
| `progress` | integer 0～100 | 否 | 事件发生时的进度 |
| `occurredAt` | ISO datetime/null | 否 | 客户端事件发生时间 |

### 6.2 sequence 规则

客户端必须为每个任务维护独立的 `lastSequence`：

```text
第一条事件：sequence = 1
第二条事件：sequence = 2
第三条事件：sequence = 3
```

建议事件先持久化，再发送：

```text
生成事件
  ↓
写入本地事件队列
  ↓
分配 sequence
  ↓
异步发送
  ↓
服务端确认成功后删除队列项
```

服务端会按任务和序号做幂等处理：

- 已经处理过的序号不会重复创建事件；
- 网络超时后可以使用同一个序号重试；
- 不要因为重试而生成新的序号；
- 不要跨不同任务复用同一套序号。

### 6.3 事件对任务状态的影响

事件成功接收后，服务端会更新任务的：

```text
lastSequence
progress（当事件携带 progress 时）
lastHeartbeatAt
```

事件上报本身会刷新任务心跳时间，但客户端仍应按正常频率发送 heartbeat，不能只依赖事件维持在线状态。

### 6.4 推荐事件类型

服务端不会限制具体业务事件类型，客户端可以使用稳定、可读的命名，例如：

```text
task.queued
task.started
step.started
step.progress
step.completed
approval.required
approval.resolved
task.completed
task.failed
task.cancelled
```

事件类型要保持稳定，避免同一含义在不同版本中随意更名。

---

## 7. 断网补传与本地同步队列

### 7.1 客户端必须保证的原则

```text
本地执行不依赖云端成功响应
云端同步失败不阻塞本地任务
同步数据先落盘，再异步发送
网络恢复后按依赖顺序补传
```

推荐的同步顺序：

```text
1. 创建云端任务镜像
2. 补传最新状态
3. 按 sequence 顺序补传事件
4. 补传最近一次心跳
```

如果创建镜像还没有成功，不能发送：

```text
PATCH /client/tasks/:id/status
POST /client/tasks/:id/heartbeat
POST /client/tasks/:id/events
```

因为这些接口的 `:id` 必须是云端镜像 ID。

### 7.2 推荐本地队列结构

```ts
interface ClientTaskSyncItem {
  id: string;
  kind: 'create' | 'status' | 'heartbeat' | 'event';
  clientTaskId: string;
  clientRunId: string;
  cloudMirrorId?: string;
  sequence?: number;
  payload: unknown;
  retryCount: number;
  nextRetryAt: string;
  createdAt: string;
}
```

本地数据库或持久化文件至少应支持：

- 进程重启后恢复；
- 断网后保留；
- 按任务查询；
- 按事件序号排序；
- 成功后删除或标记完成；
- 失败后指数退避；
- 不重复生成事件序号。

### 7.3 成功和失败处理

可视为同步成功：

```text
2xx 响应
```

重复事件也视为同步成功，因为服务端已经保证幂等。

建议处理：

| 响应 | 客户端处理 |
| --- | --- |
| `200/201` | 删除对应队列项，继续下一项 |
| `400` | 参数或状态不合法；记录错误，不要无限重试 |
| `401` | 刷新 access token 后重试一次；刷新失败则暂停同步 |
| `403` | 授权失效或订阅不可用；暂停任务同步并提示用户 |
| `404` | 云端镜像不存在；重新确认镜像 ID，不要盲目重复发送事件 |
| `408/429/5xx` | 指数退避后重试 |
| 网络超时 | 保留队列，网络恢复后重试 |

---

## 8. Web 监控读取链路

客户端不需要调用 Web 专用查询接口。企业 Web 会自动读取：

### 8.1 查询任务列表

```http
GET /client/tasks
Authorization: Bearer <accessToken>
```

当前行为：

- 按 `updatedAt` 倒序返回；
- 最多返回 100 条；
- 企业管理员可查看本企业任务；
- 普通企业成员只能查看自己上报的任务；
- 当前没有分页、状态筛选和游标参数。

### 8.2 查询任务详情

```http
GET /client/tasks/:id
Authorization: Bearer <accessToken>
```

响应包含任务镜像和全部事件：

```json
{
  "id": "cmirror_xxx",
  "status": "RUNNING",
  "progress": 45,
  "currentStep": "summarize",
  "activity": "正在生成客户反馈摘要",
  "lastSequence": 3,
  "lastHeartbeatAt": "2026-09-20T10:02:15.000Z",
  "events": [
    {
      "id": "event_xxx",
      "sequence": 1,
      "type": "step.started",
      "stepKey": "summarize",
      "message": "开始生成摘要",
      "progress": 30,
      "occurredAt": "2026-09-20T10:01:00.000Z"
    }
  ]
}
```

Web 页面位置：

```text
企业端 → 工作安排 → 客户端监控
```

当前 Web 刷新策略：

```text
任务列表：15 秒轮询
任务详情：10 秒轮询
```

客户端不需要为了让 Web 刷新而额外调用任何通知接口。

---

## 9. 完整联调示例

以下示例假设客户端已经取得：

```text
API_ROOT=https://sep-dev.longdaoSEP.cn/api
ACCESS_TOKEN=<accessToken>
SUBSCRIPTION_ID=sub_xxx
```

### 9.1 创建任务镜像

```bash
curl -X POST "$API_ROOT/client/tasks" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "clientTaskId": "local-task-01JABC",
    "clientRunId": "run-01JABC",
    "subscriptionId": "sub_xxx",
    "title": "整理本周客户反馈",
    "taskType": "scheduled",
    "modelId": "gemini-3.5-flash-high",
    "clientVersion": "0.1.0"
  }'
```

保存响应中的：

```text
id → cloudMirrorId
```

假设返回：

```text
cloudMirrorId=cmirror_xxx
```

### 9.2 上报 QUEUED

```bash
curl -X PATCH "$API_ROOT/client/tasks/cmirror_xxx/status" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "QUEUED",
    "progress": 0,
    "currentStep": "queued",
    "activity": "任务已进入客户端执行队列"
  }'
```

### 9.3 上报 RUNNING

```bash
curl -X PATCH "$API_ROOT/client/tasks/cmirror_xxx/status" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "RUNNING",
    "progress": 10,
    "currentStep": "collect-feedback",
    "activity": "正在收集客户反馈"
  }'
```

### 9.4 上报事件

```bash
curl -X POST "$API_ROOT/client/tasks/cmirror_xxx/events" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sequence": 1,
    "type": "step.completed",
    "stepKey": "collect-feedback",
    "message": "已收集客户反馈",
    "progress": 45,
    "occurredAt": "2026-09-20T10:02:00.000Z"
  }'
```

### 9.5 上报心跳

```bash
curl -X POST "$API_ROOT/client/tasks/cmirror_xxx/heartbeat" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "progress": 45,
    "currentStep": "summarize",
    "activity": "正在生成客户反馈摘要",
    "clientVersion": "0.1.0"
  }'
```

### 9.6 上报完成

```bash
curl -X PATCH "$API_ROOT/client/tasks/cmirror_xxx/status" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "COMPLETED",
    "progress": 100,
    "currentStep": "done",
    "activity": "任务执行完成"
  }'
```

### 9.7 Web 查询

```bash
curl "$API_ROOT/client/tasks" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

curl "$API_ROOT/client/tasks/cmirror_xxx" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

然后在企业 Web 打开：

```text
工作安排 → 客户端监控
```

应能看到任务状态、进度、当前活动，并在展开详情后看到事件流水。

---

## 10. 联调验收清单

### 10.1 认证和授权

- [ ] 客户端登录成功。
- [ ] 能够使用 `accessToken` 调用 `/client/*` 接口。
- [ ] `accessToken` 过期后能够刷新并重试。
- [ ] 能够获取有效 `subscriptionId`。
- [ ] 无权限订阅创建任务时能够正确提示。

### 10.2 任务镜像

- [ ] 创建镜像成功。
- [ ] 客户端保存了云端 `cloudMirrorId`。
- [ ] 创建请求超时后使用相同 `clientTaskId` 重试，不重复创建本地任务。
- [ ] `clientTaskId` 和 `clientRunId` 的生命周期定义清楚。

### 10.3 状态和心跳

- [ ] 能够上报 `QUEUED`。
- [ ] 能够上报 `RUNNING`。
- [ ] 能够上报 `WAITING_APPROVAL`。
- [ ] 能够上报 `PAUSED` 并恢复到 `RUNNING`。
- [ ] 能够每 15～30 秒发送心跳。
- [ ] 能够上报 `COMPLETED`、`FAILED`、`CANCELLED`。
- [ ] 停止心跳超过 60 秒后 Web 显示“离线/未知”。

### 10.4 事件和重试

- [ ] 事件从 `sequence=1` 开始。
- [ ] 多个事件按任务独立递增。
- [ ] 重复发送同一 sequence 不产生重复事件。
- [ ] 网络错误时事件进入本地队列。
- [ ] 网络恢复后按照序号补传。

### 10.5 Web 展示

- [ ] Web 的“工作安排 → 客户端监控”能看到任务。
- [ ] 进度和当前活动能够更新。
- [ ] 详情能够显示事件流水。
- [ ] 错误摘要能够展示。
- [ ] 终态能够正确显示。

---

## 11. 不允许上传的数据

客户端监控接口只允许上传脱敏后的执行摘要。禁止上传：

- 完整 prompt；
- 对话上下文全文；
- 知识库正文；
- 本地文件内容；
- 本地绝对路径；
- Cookie；
- access token、refresh token、employment token；
- API key、密码或其他密钥；
- 未脱敏的第三方接口响应；
- 可直接暴露企业隐私的原始执行结果。

允许上传的内容：

- 任务标题；
- 任务类型；
- 订阅 ID；
- 模型 ID；
- 客户端版本；
- 状态；
- 进度；
- 步骤标识；
- 当前活动摘要；
- 脱敏后的错误摘要；
- 事件类型、序号和简短消息。

---

## 12. 当前边界与后续接口规划

当前版本已经支持客户端任务镜像，但暂不支持：

```text
Web 远程取消任务
Web 远程暂停 / 恢复任务
客户端设备在线列表
客户端版本分布
客户端崩溃监控
客户端健康度统计
WebSocket / SSE 实时推送
任务列表分页和状态筛选
事件增量查询
```

当前任务列表固定最多返回 100 条，详情接口会返回全部事件。联调阶段可以直接使用；当企业任务量和事件量增大后，再增加：

```http
GET /client/tasks?status=RUNNING&limit=50
GET /client/tasks/:id/events?afterSequence=123
```

这些属于后续扩展，不是当前客户端任务监控首期联调的前置条件。

---

## 13. 问题排查

### Web 显示“暂无客户端任务”

依次检查：

1. 客户端是否成功调用 `POST /client/tasks`；
2. 是否保存并使用了响应中的云端 `id`；
3. 创建时使用的 `subscriptionId` 是否有效；
4. 后续请求是否携带了正确的 `Authorization`；
5. 当前 Web 登录用户是否与上报任务的用户属于同一企业；
6. 普通成员是否正在查看其他成员创建的任务；
7. Web 是否已经完成 15 秒轮询。

### Web 显示“离线/未知”

检查：

1. 客户端是否仍在发送 heartbeat；
2. heartbeat 的路径参数是否为云端 `id`；
3. access token 是否已过期；
4. 本地同步队列是否卡住；
5. 任务实际上是否已进入终态；
6. 客户端系统是否休眠或网络不可用。

### 事件详情为空

检查：

1. 是否调用了 `/client/tasks/:id/events`；
2. `:id` 是否为云端 mirror ID；
3. `sequence` 是否从 1 开始；
4. 事件请求是否返回 2xx；
5. 是否在本地队列成功后误删了未确认的事件；
6. Web 详情是否在事件上报后等待了下一次刷新。

### 重复事件没有新增记录

这是预期行为。服务端按任务和 `sequence` 做幂等去重。客户端应把重复 sequence 的 2xx 响应视为已同步，不要为同一个事件生成新的 sequence。

---

## 14. 当前联调结论

客户端开发完成以下部分后，即可和现有 Web 监控对接：

```text
登录与 token 管理
订阅选择
本地任务 ID 管理
创建云端任务镜像
状态上报
定时心跳
事件序列化与上报
断网本地队列
恢复后的补传
终态上报
```

云端当前已经提供：

```text
认证接口
订阅查询接口
任务镜像创建接口
任务状态接口
任务心跳接口
任务事件接口
企业任务列表接口
任务详情和事件接口
Web 客户端任务监控页面
```

当前建议客户端先完成这条最小闭环：

```text
登录
→ 创建镜像
→ QUEUED
→ RUNNING
→ heartbeat
→ event sequence=1
→ COMPLETED / FAILED
→ Web 查看
```

完成最小闭环后，再验证断网补传、重复事件、心跳超时和授权失效等异常场景。
