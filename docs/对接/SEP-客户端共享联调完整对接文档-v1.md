# SEP 客户端共享联调完整对接文档

> 文档版本：v1.0
> 更新时间：2026-09-11
> 适用对象：`sep-client` Electron 客户端开发者、SEP 后端开发者、联调测试人员
> 当前联调环境：`https://sep-dev.longdaoSEP.cn`
> 对应 SEP 代码：`8ffd7d2`

本文是客户端接入 SEP 的当前联调基线。接口、字段和状态以当前后端代码为准；旧文档中出现的 `instanceId`、`client-instance` token、`/gateway/chat` 和云端任务执行语义均属于历史版本，不能直接复制。

## 1. 联调结论

SEP 与客户端是控制面和执行面的分工：

```text
sep-client Electron 主进程
  ├─ 登录、令牌和设备管理
  ├─ 员工包与技能下载、校验、隔离安装
  ├─ 本地工作区、任务队列、Pi Agent、工具审批
  └─ 通过 employmentToken 调用 SEP 模型网关

SEP 云端
  ├─ 企业、成员、订阅和授权
  ├─ 员工包元数据、技能版本与审核状态
  ├─ 知识库授权与检索
  ├─ 模型白名单、余额、用量和审计
  └─ sub2api 模型转发
```

客户端任务正文、本地文件、工具执行和完整运行历史默认留在客户端。SEP 当前不提供让客户端把本地任务交给云端执行的契约。SEP 中已有 `/api/task-plans` 和 `/api/tasks` 接口，主要服务 Web 工作安排和服务端执行链路，客户端第一阶段不要把它们当作本地任务同步 API。

## 2. 环境地址

### 2.1 共享联调环境（推荐）

```text
普通 API 根地址： https://sep-dev.longdaoSEP.cn/api
模型网关地址：   https://sep-dev.longdaoSEP.cn/api/gateway/v1
通知 WebSocket：  wss://sep-dev.longdaoSEP.cn/ws/notifications
员工状态 WS：     wss://sep-dev.longdaoSEP.cn/ws/employee-status
Swagger：         https://sep-dev.longdaoSEP.cn/api/docs
```

客户端进程配置：

```bash
SEP_BASE_URL=https://sep-dev.longdaoSEP.cn/api
SEP_GATEWAY_URL=https://sep-dev.longdaoSEP.cn/api/gateway/v1
```

注意：`SEP_BASE_URL` 已经包含 `/api`。请求时直接拼接 `/client/auth/login`，不要再拼一次 `/api`。例如：

```text
正确：https://sep-dev.longdaoSEP.cn/api/client/auth/login
错误：https://sep-dev.longdaoSEP.cn/client/auth/login
错误：https://sep-dev.longdaoSEP.cn/api/api/client/auth/login
```

### 2.2 本地后端环境

客户端开发者也可以在本机运行 SEP：

```bash
SEP_BASE_URL=http://localhost:3001/api
SEP_GATEWAY_URL=http://localhost:3001/api/gateway/v1
```

本地后端没有 HTTPS，WebSocket 使用 `ws://`；共享联调和生产必须使用 HTTPS/WSS。

### 2.3 生产环境

生产地址：

```text
https://longdaoSEP.cn/api
https://longdaoSEP.cn/api/gateway/v1
```

日常开发和功能联调不要连接生产。生产只用于候选版本验收。

## 3. 身份、ID 和令牌

### 3.1 ID 含义

| 字段 | 含义 | 客户端用途 |
|---|---|---|
| `enterpriseId` | 企业租户 ID | 本地数据隔离目录的一部分 |
| `memberId` | 用户在企业中的成员记录 ID | 诊断和本地作用域 |
| `employeeId` | 数字员工模板 ID | 员工包、技能接口 |
| `subscriptionId` | 企业对数字员工的订阅/雇佣关系 ID | 选择员工、换 employment token、知识库检索 |
| `capabilityId` | 员工绑定的能力 ID | 技能版本关联 |
| `skillVersionId` | 能力的技能版本 ID | 技能预览和本地安装 |
| `templateVersion` | 订阅锁定的员工模板版本 | 员工包完整性校验 |

### 3.2 三类令牌

| 令牌 | 来源 | 有效期 | 用途 | 存储 |
|---|---|---:|---|---|
| `accessToken` | `/client/auth/login`、`/client/auth/refresh` | 默认 1 小时 | 普通 JWT API，例如订阅、包、技能、知识库 | 仅 Electron main 内存 |
| `refreshToken` | `/client/auth/login` | 默认 30 天 | 刷新 access token、换 employment token | Electron `safeStorage` |
| `employmentToken` | `/client/auth/token` | 默认 15 分钟，可由平台设置 | 仅模型网关 | 仅 main 内存，按 `subscriptionId` 缓存 |

令牌禁止出现在 renderer、URL、任务正文、日志、错误上报和截图中。客户端不得保存或请求 `SUB2API_API_KEY`。

### 3.3 共享联调测试账号

以下账号用于客户端联调环境，当前可正常登录：

| 项目 | 值 |
|---|---|
| 登录邮箱 | `client-dev-1789113417@example.com` |
| 登录密码 | `ClientDev123!` |
| 账号角色 | `USER` / 客户端联调企业管理员 |
| 企业 | `客户端联调企业` |
| 设备指纹 | 客户端自行生成并保持稳定，例如 `macbook-client-dev` |

安全要求：该账号只允许访问 `sep-dev.longdaoSEP.cn`，不得用于生产；不要把登录密码、access token、refresh token 写入 Git、截图或公共日志。密码仅用于本次联调，联调结束后应轮换。

当前联调数据库状态：该企业目前尚未配置数字员工、订阅或 `EmployeeGrant`，因此登录成功后 `/client/subscriptions` 返回空数组是正常现象。需要验证员工包、知识库和模型网关时，由企业管理员先完成“创建/开通订阅 → 给成员授权”准备，拿到实际返回的 `subscriptionId` 后再继续。

## 4. 客户端职责边界

### 4.1 Electron main 必须负责

- 所有 SEP HTTP 和 WebSocket 请求。
- 令牌保存、刷新、吊销处理和并发刷新合并。
- 订阅列表缓存与授权变化处理。
- 员工包版本、SHA-256、npm/git 版本约束和 ZIP 安全校验。
- 技能预览和已审核技能同步。
- 本地任务、Pi session、工作区和工具审批。

### 4.2 renderer 只负责

- 通过 `contextBridge` 调用 IPC。
- 展示用户、企业、订阅、技能、任务和错误状态。
- 订阅组件卸载时解除 IPC/事件监听。

renderer 不得直接 `fetch` SEP，不得导入 `electron`，不得接触三个令牌中的任何一个。

## 5. 认证接口

所有以下路径都相对于 `SEP_BASE_URL`，因此实际请求会自动包含 `/api`。

### 5.1 客户端登录并注册设备

```http
POST /client/auth/login
Content-Type: application/json
```

请求体：

```json
{
  "email": "member@example.com",
  "password": "用户密码",
  "fingerprint": "稳定的设备指纹",
  "platform": "darwin",
  "clientVersion": "0.1.0"
}
```

字段约束：

| 字段 | 必填 | 约束 |
|---|---|---|
| `email` | 是 | 合法邮箱 |
| `password` | 是 | 非空 |
| `fingerprint` | 是 | 1-256 字符；同一设备保持稳定 |
| `platform` | 是 | 推荐 `darwin`、`win32`、`linux` |
| `clientVersion` | 否 | 客户端版本字符串 |

成功响应 `200`：

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<jwt>",
  "accessTokenExpiresIn": 3600,
  "refreshTokenExpiresIn": 2592000,
  "user": {
    "id": "user_id",
    "email": "member@example.com",
    "name": "成员",
    "role": "USER"
  },
  "enterprise": {
    "id": "enterprise_id",
    "name": "联调企业"
  },
  "devices": [
    {
      "id": "device_id",
      "fingerprint": "稳定的设备指纹",
      "platform": "darwin",
      "lastSeenAt": "2026-09-11T07:00:00.000Z"
    }
  ]
}
```

实现要求：

1. 保存 `refreshToken` 到 `safeStorage`，不要保存 access token。
2. `accessTokenExpiresIn` 缺失时兼容读取旧字段 `expiresIn`。
3. 同一个 `(userId, fingerprint)` 会更新同一台设备记录。
4. 设备被管理员吊销时，登录和后续换 token 都会失败。

### 5.2 刷新普通 access token

```http
POST /client/auth/refresh
Content-Type: application/json
```

```json
{
  "refreshToken": "<client-refresh-jwt>"
}
```

成功响应：

```json
{
  "accessToken": "<jwt>",
  "accessTokenExpiresIn": 3600,
  "user": { "id": "user_id", "email": "member@example.com", "name": "成员" },
  "enterprise": { "id": "enterprise_id", "name": "联调企业" }
}
```

并发刷新必须合并成一个请求。网络失败时保留 refresh token；只有明确收到 `401` 才清理凭据并通知 renderer 回登录页。

### 5.3 获取授权订阅列表

```http
GET /client/subscriptions
Authorization: Bearer <accessToken>
```

`GET /client/instances` 是迁移兼容别名，只有收到 `404` 时才允许尝试。当前成功响应是数组，不是 `{ data: [...] }`：

```json
[
  {
    "id": "subscription_id",
    "subscriptionId": "subscription_id",
    "employeeId": "employee_id",
    "name": "电商运营员工",
    "status": "ACTIVE",
    "templateVersion": "1.2.0",
    "template": {
      "id": "employee_id",
      "name": "电商运营员工",
      "avatar": null
    },
    "department": null,
    "allowedModels": ["gemini-3.5-flash-high"],
    "upgradeAvailable": false
  }
]
```

服务端已过滤：当前用户必须属于企业、拥有直接或部门 `EmployeeGrant`、授权未过期、订阅为 `ACTIVE` 且未到期。客户端仍要把网关和包接口的再次授权失败当作最终事实。

建议刷新时机：登录成功、应用回到前台、网关返回 `401/403/404`、包安装前。

### 5.4 换取雇佣 employment token

```http
POST /client/auth/token
Content-Type: application/json
```

```json
{
  "refreshToken": "<client-refresh-jwt>",
  "subscriptionId": "subscription_id"
}
```

成功响应：

```json
{
  "employmentToken": "<short-lived-jwt>",
  "expiresIn": 900,
  "employment": {
    "id": "subscription_id",
    "name": "电商运营员工",
    "templateId": "employee_id",
    "status": "ACTIVE"
  }
}
```

服务端会依次检查 refresh token 类型、设备是否吊销、订阅是否存在且 ACTIVE、企业成员关系和员工授权。客户端应在有效期剩余约三分之一时刷新，并合并同订阅的并发刷新请求。

旧字段 `instanceId` 不属于当前请求契约。不要发送：

```json
{ "refreshToken": "...", "instanceId": "..." }
```

## 6. 员工包和技能接口

### 6.1 查询订阅锁定的员工包

```http
GET /enterprise/subscriptions/:subscriptionId/package
Authorization: Bearer <accessToken>
```

成功响应示例：

```json
{
  "version": "1.2.0",
  "packageRef": { "type": "npm", "spec": "@sep/employee-commerce@1.2.0" },
  "zipAvailable": false,
  "sha256": null
}
```

客户端必须确认 `version === subscription.templateVersion`。`packageRef` 规则：

- npm 使用精确三段版本，禁止 `latest`、`^`、`~`、范围版本。
- git 使用完整 40 位 commit，禁止浮动 branch/tag。
- `packageRef` 不可用时才使用 ZIP 兜底。

### 6.4 预览技能正文

```http
GET /enterprise/skill-versions/:versionId/preview
Authorization: Bearer <accessToken>
```

响应包含 `content` Markdown 和版本元数据。客户端只展示或写入隔离运行时，不执行 Markdown 中的脚本或危险 HTML。

推荐本地目录：

```text
runtime/<enterpriseId>/<subscriptionId>/<packageVersion>/
```

安装过程采用 staging、校验、原子替换和失败回滚；manifest 至少记录订阅、员工、包版本、packageRef、SHA-256、技能版本和安装器版本。

## 7. 知识库接口

### 7.1 查询订阅被授权的知识库

```http
GET /knowledge-bases/grants/by-subscription/:subscriptionId
Authorization: Bearer <accessToken>
```

成功响应：

```json
{
  "grants": [
    {
      "id": "grant_id",
      "knowledgeBase": {
        "id": "knowledge_base_id",
        "name": "企业制度"
      }
    }
  ]
}
```

### 7.2 按订阅授权范围检索

```http
POST /knowledge-bases/search
Authorization: Bearer <accessToken>
Content-Type: application/json
```

请求体：

```json
{
  "query": "试用期退款规则",
  "subscriptionId": "subscription_id",
  "topK": 5,
  "scoreThreshold": 0.5,
  "strategy": "auto"
}
```

字段约束：

| 字段 | 约束 |
|---|---|
| `query` | 1-1000 字符 |
| `subscriptionId` | CUID，必须是当前用户有授权的订阅 |
| `topK` | 1-20，默认 5 |
| `scoreThreshold` | 0-1，默认 0.7 |
| `strategy` | `auto`、`lexical`、`vector`、`hybrid` |

响应：

```json
{
  "query": "试用期退款规则",
  "subscriptionId": "subscription_id",
  "strategy": "lexical",
  "durationMs": 120,
  "count": 1,
  "results": [
    {
      "chunkId": "chunk_id",
      "knowledgeBaseId": "knowledge_base_id",
      "source": "员工手册.md",
      "score": 0.82,
      "content": "相关制度正文"
    }
  ]
}
```

`strategy` 是服务端实际采用的策略。当前共享服务器 PostgreSQL 没有 pgvector 扩展，联调环境使用有界 BYTEA 兼容检索；Embedding 使用 Ollama `bge-m3:latest`，维度 1024。客户端不需要关心存储实现，只使用响应结果。

知识库调用建议：用户确认任务后，由 Electron main 检索最小必要片段，再注入 Pi 当前上下文；不要下载整个知识库，不要上传本地工作区文件。

## 8. 模型网关接口

### 8.1 请求

```http
POST /gateway/v1/chat/completions
Authorization: Bearer <employmentToken>
Content-Type: application/json
```

请求体遵循 OpenAI Chat Completions 的当前子集：

```json
{
  "model": "gemini-3.5-flash-high",
  "messages": [
    { "role": "system", "content": "员工系统提示和必要上下文" },
    { "role": "user", "content": "请完成这个任务" }
  ],
  "temperature": 0.2,
  "max_tokens": 2000,
  "stream": true,
  "tools": []
}
```

支持的 `role`：`system`、`user`、`assistant`、`tool`。`messages[].content` 当前要求字符串。`model` 必须来自当前订阅返回的 `allowedModels`，SEP 会再次检查平台启用状态、企业配置、订阅授权和余额。

### 8.2 流式响应

当 `stream: true` 时，响应为：

```text
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"id":"...","choices":[{"delta":{"role":"assistant","content":"你好"}}]}

data: {"id":"...","choices":[{"delta":{"content":"，我可以帮助你。"}}]}

data: {"id":"...","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}

data: [DONE]
```

客户端按 SSE 的空行分帧，处理每一条 `data:`：

1. JSON 增量追加到当前 assistant 输出。
2. 最后一块的 `usage` 用于本地诊断；SEP 会在后台记账。
3. `[DONE]` 表示正常完成。
4. 连接中断且未收到 `[DONE]` 时，不能将任务标记为完成。

### 8.3 非流式响应

`stream: false` 或省略时返回 OpenAI 兼容 JSON，并在响应中包含 `usage`（若上游提供）。

### 8.4 网关错误

| 状态 | 客户端处理 |
|---:|---|
| `400` | 请求字段、模型白名单或上游参数错误；修正请求，不盲目重试 |
| `401` | employment token 过期/类型错误；刷新一次 token 后原请求最多重试一次 |
| `403` | 授权、订阅、余额或企业状态不允许；刷新订阅目录，不自动循环重试 |
| `404` | 订阅/授权已失效或资源不存在；刷新目录并停止当前员工运行 |
| `429` | 若有 `Retry-After`，按其退避；最多额外重试两次 |
| `5xx` | 指数退避，最多额外重试两次；记录 requestId 和耗时 |
| 网络错误 | 保留本地任务为可恢复失败，不伪造完成状态 |

## 9. WebSocket 实时接口

WebSocket 不支持自定义 `Authorization` header。连接建立后 5 秒内必须发送第一条认证消息，令牌不放 URL。

### 9.1 通用连接流程

```ts
const ws = new WebSocket('wss://sep-dev.longdaoSEP.cn/ws/notifications');

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'auth', token: accessToken }));
};

setInterval(() => {
  ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
}, 30_000);
```

服务端会校验 Origin。联调客户端的 Origin 应为 `https://sep-dev.longdaoSEP.cn` 或由 Electron 请求库正确设置的受允许来源。

### 9.2 通知 WebSocket

地址：`wss://sep-dev.longdaoSEP.cn/ws/notifications`

服务端消息：

```json
{ "type": "connected", "data": { "unreadCount": 3 }, "timestamp": 0 }
{ "type": "notification", "data": { "id": "...", "category": "BILLING" }, "timestamp": 0 }
{ "type": "unread_count", "data": { "count": 4 }, "timestamp": 0 }
{ "type": "pong", "timestamp": 0 }
```

通知仍然以 HTTP 通知中心为最终数据源：

```http
GET /notifications?limit=50&offset=0&category=BILLING&unreadOnly=false
GET /notifications/unread-count
POST /notifications/:id/read
POST /notifications/read-all
DELETE /notifications/:id
DELETE /notifications/clear-read
Authorization: Bearer <accessToken>
```

实时消息丢失时，客户端重新拉取通知列表，不依赖 WebSocket 消息作为唯一存储。

### 9.3 员工状态 WebSocket

地址：`wss://sep-dev.longdaoSEP.cn/ws/employee-status`

连接认证后服务端立即推送，并约每 3 秒广播：

```json
{
  "type": "status_update",
  "data": [
    { "employeeId": "employee_id", "status": "WORKING" }
  ],
  "timestamp": 0
}
```

状态接口的 HTTP 兜底：

```http
GET /enterprise/employee-status
Authorization: Bearer <accessToken>
```

任务执行流使用 HTTP SSE，不使用尚未实现的 `/ws/tasks`：

```text
GET /api/tasks/:id/stream
```

## 10. 会话和任务边界

### 10.1 普通会话 API

这些接口属于 Web/云端会话链路，客户端只有在产品明确要求云端会话同步时才接入：

```http
POST /conversations
GET /conversations?source=CHAT|TASK
GET /conversations/:id
PATCH /conversations/:id
PATCH /conversations/:id/model
DELETE /conversations/:id
POST /conversations/:id/messages   # SSE
```

创建会话请求当前使用 `employeeId`，不是 `instanceId`：

```json
{
  "employeeId": "employee_id",
  "title": "可选标题",
  "source": "CHAT"
}
```

消息请求：

```json
{
  "content": "请帮我整理这份资料",
  "targetEmployeeId": "employee_id",
  "attachments": []
}
```

### 10.2 客户端本地任务

当前产品边界是：

- 任务计划可在客户端生成/展示/确认。
- Pi Agent 和工具在客户端执行。
- 工作区路径只在客户端保存，不传给 SEP。
- 工具审批由客户端 `ApprovalBroker` 完成。
- 客户端通过 employment token 调用模型网关。
- 本地任务状态、步骤输出和文件结果不自动写入 SEP。

因此客户端不要直接调用以下服务端任务接口来实现本地任务：

```text
POST /api/task-plans/preview
POST /api/tasks/:id/run
GET  /api/tasks/:id/stream
```

这些接口是 Web 工作安排/服务端执行链路。若未来需要企业查看客户端任务，必须新增明确的任务同步、隐私、保留期和幂等契约。

## 11. 文件上传和附件

聊天附件先上传，再把返回对象放入消息 `attachments`：

```http
POST /upload/file
POST /upload/files
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data
```

字段分别是 `file` 和 `files`。当前允许附件类型包括图片、文档、视频；单条消息最多 5 个附件。返回对象中的 `key` 是稳定标识，`url` 可能会过期。

历史 URL 过期时：

```http
POST /upload/refresh-url?key=<encoded-key>
Authorization: Bearer <accessToken>
```

客户端不应自行构造附件对象，也不要把本地绝对路径直接放入消息。

## 12. Electron IPC 建议契约

以下是 renderer 与 main 的建议边界，SEP HTTP 实现集中在 main：

| IPC | 用途 |
|---|---|
| `auth:login` | main 调 `/client/auth/login` |
| `auth:logout` | 清除内存 token，停止运行时 |
| `auth:required` | token 无法刷新时 main 推送 |
| `resources:list` | 返回订阅、模型、技能摘要 |
| `subscription:get-package` | 查询包信息 |
| `subscription:get-skills` | 查询员工技能 |
| `subscription:get-knowledge-base-grants` | 查询知识库授权 |
| `subscription:search-knowledge-bases` | 执行授权范围检索 |
| `task:create` | 创建本地任务 |
| `task:execute` | 启动本地 Pi 任务 |
| `task:pause` / `task:resume` / `task:cancel` | 本地任务控制 |
| `task:updated` | 向 renderer 推送本地任务变化 |

IPC 参数在 main 侧再次校验；事件监听必须返回取消函数，并在页面卸载时调用。

## 13. 可复制联调命令

### 13.1 健康检查

```bash
curl -fsS https://sep-dev.longdaoSEP.cn/api/health/ready
```

预期 `status` 和以下检查均为 `ok`：`postgres`、`redis`、`taskQueue`、`knowledgeQueue`、`sub2api`、`embedding`。

### 13.2 客户端登录

共享联调账号（仅限 `sep-dev.longdaoSEP.cn`）：

```text
邮箱：client-dev-1789113417@example.com
密码：ClientDev123!
```

不要把真实密码提交到脚本或日志：

```bash
export SEP_BASE_URL=https://sep-dev.longdaoSEP.cn/api
export SEP_EMAIL='client-dev-1789113417@example.com'
export SEP_PASSWORD='ClientDev123!'
export SEP_FINGERPRINT="$(hostname)-client-dev"

curl -fsS -X POST "$SEP_BASE_URL/client/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SEP_EMAIL\",\"password\":\"$SEP_PASSWORD\",\"fingerprint\":\"$SEP_FINGERPRINT\",\"platform\":\"darwin\",\"clientVersion\":\"0.1.0\"}"
```

该账号是共享联调账号，不得用于生产；如已多人使用，建议创建个人联调账号并轮换共享账号密码。

### 13.3 订阅列表

```bash
curl -fsS "$SEP_BASE_URL/client/subscriptions" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

### 13.4 换 employment token

```bash
curl -fsS -X POST "$SEP_BASE_URL/client/auth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\",\"subscriptionId\":\"$SUBSCRIPTION_ID\"}"
```

### 13.5 网关最小请求

```bash
curl -N -fsS -X POST "$SEP_BASE_URL/gateway/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $EMPLOYMENT_TOKEN" \
  -d '{
    "model": "<必须来自 allowedModels>",
    "messages": [{"role":"user","content":"你好，请回复联调成功"}],
    "stream": true
  }'
```

## 14. 联调验收顺序

### A. 认证和设备

- 登录成功，返回 access/refresh token 和用户企业信息。
- 重启客户端后能从 safeStorage 恢复 refresh token。
- access token 过期后只发起一次刷新请求。
- refresh token 无效或设备被吊销时回登录页。
- 令牌不出现在 renderer、日志、URL 和错误提示。

### B. 订阅和授权

- 企业管理员给成员直接授权后，订阅列表出现对应 `subscriptionId`。
- 部门授权后，部门成员能看到订阅，非成员看不到。
- 暂停、到期或撤销后，刷新列表不再出现。
- `instanceId` 不会出现在新请求体。

### C. 包和技能

- `package.version` 与 `templateVersion` 一致。
- npm/git 精确版本校验通过；ZIP SHA-256 校验通过。
- 安装目录按企业/订阅/版本隔离。
- 只有审核通过的 `currentVersion` 写入运行时。
- 安装失败能清理 staging 并恢复旧版本。

### D. 知识库

- 未授权知识库不会出现在 grants 或搜索结果。
- `topK`、阈值和 strategy 参数越界会被客户端拦截或由服务端返回 `400`。
- 搜索响应使用服务端实际 `strategy`，客户端不假设一定是 vector。
- 只把最小必要片段注入当前任务，不下载完整知识库。

### E. 网关和本地执行

- employment token 能调用 `/api/gateway/v1/chat/completions`。
- 模型不在 `allowedModels` 时请求被拒绝。
- 流式输出逐块显示，收到 `[DONE]` 才标记成功。
- 401 只刷新 token 并重试一次；403/404 不循环重试。
- 工具审批、文件读写和任务状态均在客户端可观察。

### F. 实时通道

- 通知 WebSocket 首条消息在 5 秒内发送 `{type:"auth",token}`。
- 员工状态 WS 收到初始 `status_update` 和后续广播。
- WebSocket 断线自动退避重连，重连后重新认证并补拉 HTTP 数据。
- 长任务使用 SSE 时能处理 `ping` 保活和连接中断。

## 15. 常见错误排查

| 现象 | 常见原因 | 排查 |
|---|---|---|
| 所有接口 404 | 少了 `/api` 前缀 | 检查 `SEP_BASE_URL` 是否已包含 `/api` |
| 换 token 返回 400 | 发了 `instanceId` | 改为 `subscriptionId` |
| 订阅返回空数组 | 用户没有 ACTIVE 订阅或没有 grant | 在 Web 企业端配置订阅和授权 |
| 网关 401 | 使用 access token 或 token 过期 | 只能用 employment token；刷新后重试一次 |
| 网关 400 模型不在白名单 | 模型不在 `allowedModels` | 只使用订阅列表返回的模型 |
| 知识库搜索 401/403 | access token 过期或无企业授权 | 刷新 access token，确认订阅授权 |
| WebSocket 1008 | 未及时发送 auth、token 无效或 Origin 不允许 | 检查首条 auth、令牌和 URL |
| readiness embedding failed | Ollama 首次加载模型或服务不可用 | 等待预热后重试；联系后端检查 Ollama |
| 流式响应只有半截 | 网络/代理中断 | 未收到 `[DONE]` 时标记可恢复失败 |

错误响应当前形状：

```json
{
  "statusCode": 401,
  "message": "Invalid or expired refresh token",
  "requestId": "request-id",
  "timestamp": "2026-09-11T07:00:00.000Z",
  "path": "/api/client/auth/token"
}
```

客户端必须保留 `statusCode`、`message` 和 `requestId`，但日志中不得记录认证头、令牌、密码、完整 prompt、完整响应或本地敏感路径。

## 16. 参考代码位置

SEP：

- `backend/src/modules/client/client.controller.ts`
- `backend/src/modules/client/client.service.ts`
- `backend/src/modules/client/client-employment.guard.ts`
- `backend/src/modules/gateway/gateway.controller.ts`
- `backend/src/modules/knowledge/search.controller.ts`
- `backend/src/modules/knowledge/knowledge.controller.ts`
- `backend/src/modules/enterprise/employee-status.gateway.ts`
- `backend/src/modules/notifications/notifications.gateway.ts`
- `backend/src/shared/index.ts`

sep-client：

- `electron/infrastructure/config.ts`
- `electron/auth/auth-api.ts`
- `electron/auth/employment-token-manager.ts`
- `electron/runtime/subscription-runtime.ts`
- `electron/pi/`
- `electron/tasks/`
- `src/shared/ipc.ts`

## 17. 版本变更约定

接口字段、令牌类型、状态机或责任边界发生变化时，必须同时更新：

1. SEP controller 和共享 Zod schema。
2. `sep-client` main API 适配器及测试。
3. 本文档的请求/响应示例和验收清单。
4. 联调环境的 smoke test。

未经双方确认，不得重新引入 `instanceId`、把模型密钥下发客户端，或把本地任务正文自动上传到 SEP。
