# SEP 客户端开发者对接指南 v1

> 状态：当前客户端实现基线
>
> 适用对象：`sep-client` Electron 主进程、preload、renderer 和 SEP 后端联调开发者
>
> 更新时间：2026-08-25

本文描述 SEP 平台与 `sep-client` 的当前对接契约。新代码以本文和平台规范为准；`instanceId`、`employeeInstanceId`、实例级 token 和云端任务执行属于历史语义，不应出现在新功能中。

## 1. 架构边界

```text
React renderer
    │ contextBridge / IPC
    ▼
Electron main
    ├─ safeStorage：refreshToken、账号元数据
    ├─ AuthSessionManager：accessToken 内存刷新
    ├─ SubscriptionRuntime：员工包、技能和隔离目录
    ├─ TaskManager：本地任务、运行记录、恢复
    ├─ ApprovalBroker：工具审批
    └─ Pi agent ── Bearer employmentToken ──► SEP Gateway
```

必须遵守：

- renderer 不直接 `fetch` SEP，不导入 Electron，不接触任何 token。
- 所有平台请求集中在 Electron main；preload 只暴露经过类型约束的 IPC 方法。
- `accessToken` 仅存在 main 内存；`refreshToken` 通过 Electron `safeStorage` 保存；`employmentToken` 按 `subscriptionId` 保存在 main 内存。
- SEP 负责认证、授权、员工包元数据、技能审核、模型网关、知识库和用量；客户端负责本地工作区、任务执行、文件和工具审批。
- 普通任务正文、本地文件、完整 prompt/response 默认不上传任务中心或日志。

## 2. 环境配置

| 变量 | 默认值 | 用途 |
|---|---|---|
| `SEP_BASE_URL` | `http://localhost:3001` | SEP 普通 API 根地址 |
| `SEP_GATEWAY_URL` | `${SEP_BASE_URL}/gateway/v1` | OpenAI-compatible 网关地址 |

生产环境必须使用 HTTPS。不要把后端地址硬编码到 renderer，也不要保存 `SUB2API_API_KEY` 或任何上游模型密钥。

## 3. ID 与认证

### 3.1 ID 规则

| 字段 | 含义 | 使用位置 |
|---|---|---|
| `enterpriseId` | 企业租户 | 本地目录和任务数据隔离 |
| `memberId` | 当前企业成员 | 账号和任务数据作用域 |
| `employeeId` | 数字员工模板 | 包和技能接口 |
| `subscriptionId` | 企业对员工的订阅/雇佣关系 | 客户端运行时、任务和网关令牌主键 |
| `employmentToken` | 短期网关 JWT | 仅发送给网关 |

新代码统一使用 `subscriptionId`。兼容旧磁盘数据时可以读取旧字段并转换，但新写入不得再生成旧字段。

### 3.2 登录

`POST /client/auth/login`

```json
{
  "email": "member@example.com",
  "password": "***",
  "fingerprint": "stable-device-fingerprint",
  "platform": "darwin",
  "clientVersion": "0.1.0"
}
```

成功响应至少包含：

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<jwt>",
  "accessTokenExpiresIn": 3600,
  "refreshTokenExpiresIn": 2592000,
  "user": { "id": "member_1", "email": "member@example.com", "name": "成员" },
  "enterprise": { "id": "enterprise_1", "name": "示例企业" }
}
```

客户端应优先使用 `accessTokenExpiresIn`；旧服务端可能只返回 `expiresIn`，仅保留兼容读取。

### 3.3 普通 access token 刷新

`POST /client/auth/refresh`

```json
{ "refreshToken": "<client-refresh-jwt>" }
```

成功响应：

```json
{
  "accessToken": "<jwt>",
  "accessTokenExpiresIn": 3600,
  "user": { "id": "member_1", "email": "member@example.com", "name": "成员" },
  "enterprise": { "id": "enterprise_1", "name": "示例企业" }
}
```

并发刷新必须合并为一个 HTTP 请求。刷新返回 401 时清理内存和 safeStorage 中的认证凭据并回到登录页；网络错误不能误删长期 refresh token，应允许用户重试。

### 3.4 订阅目录

首选：`GET /client/subscriptions`，请求头 `Authorization: Bearer <accessToken>`。

当前返回数组元素：

```json
{
  "subscriptionId": "sub_1",
  "employeeId": "employee_1",
  "name": "电商运营员工",
  "status": "ACTIVE",
  "templateVersion": "1.2.0",
  "template": { "id": "employee_1", "name": "电商运营员工", "avatar": null },
  "department": null,
  "allowedModels": ["gpt-4o-mini"],
  "upgradeAvailable": false
}
```

目录只展示当前成员有效授权且订阅为 `ACTIVE` 的记录。客户端仍不能把目录缓存当作最终授权；网关和包/技能接口会再次校验。只有在服务端尚未部署新接口时，收到 404 才允许兼容请求 `GET /client/instances`。

登录成功、窗口回到前台，以及网关返回 403/404 后都应刷新目录。当前订阅消失时禁止继续创建或执行任务。

## 4. Employment Token 与模型网关

### 4.1 换取 Employment Token

`POST /client/auth/token`

```json
{
  "refreshToken": "<client-refresh-jwt>",
  "subscriptionId": "sub_1"
}
```

成功响应：

```json
{
  "employmentToken": "<short-lived-jwt>",
  "expiresIn": 900,
  "employment": {
    "id": "sub_1",
    "name": "电商运营员工",
    "templateId": "employee_1",
    "status": "ACTIVE"
  }
}
```

令牌刷新提前量为有效期的三分之一且不少于 60 秒；同一订阅的并发刷新必须合并。令牌不得写入磁盘、renderer、任务正文或日志。

### 4.2 网关请求

`POST /gateway/v1/chat/completions`

```http
Authorization: Bearer <employmentToken>
Content-Type: application/json
```

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "员工技能和任务上下文" },
    { "role": "user", "content": "用户任务" }
  ],
  "temperature": 0.2,
  "max_tokens": 4000,
  "stream": true,
  "tools": []
}
```

`model` 必须来自该订阅的 `allowedModels`。SEP 会实时检查令牌、订阅状态、成员授权、企业余额和模型启用状态。

### 4.3 状态处理

| 状态 | 客户端行为 |
|---|---|
| 401 | 重新换 Employment Token 后只重试一次；再次 401 则任务失败并提示重新认证/重试 |
| 403 | 不重试；提示订阅、授权、余额或模型不可用；移除本地订阅缓存并刷新目录 |
| 404 | 按订阅授权失效处理并刷新目录 |
| 429 | 使用 `Retry-After` 退避，最多两次额外重试，等待上限 60 秒 |
| 5xx/网络错误 | 指数退避，最多两次额外重试 |
| 流式响应中断 | 任务标记为失败或可恢复，不能标记为完成 |

日志只记录 requestId、状态码、模型 ID、消息数量和耗时等元数据，不记录完整请求/响应内容或认证头。

## 5. 员工包与隔离运行时

### 5.1 查询包

`GET /enterprise/subscriptions/:subscriptionId/package`，使用普通 `accessToken`。

```json
{
  "version": "1.2.0",
  "packageRef": { "type": "npm", "spec": "@sep/employee-commerce@1.2.0" },
  "zipAvailable": false,
  "sha256": null
}
```

客户端必须确认 `package.version === subscription.templateVersion`。npm 只允许精确三段版本；git 必须带完整 40 位 commit；禁止 `latest`、范围版本、浮动 branch/tag。ZIP 仅是兼容兜底，并且必须有 SHA-256。

### 5.2 安装要求

运行时目录按企业、订阅和包版本隔离：

```text
runtime/<enterpriseId>/<subscriptionId>/<packageVersion>/
```

安装采用 staging -> 校验 -> 原子替换 -> 失败回滚流程。安装状态至少包括：`not_installed`、`installing`、`verifying`、`ready`、`failed`、`rollback`。

安装后记录订阅 ID、员工 ID、包版本、包引用、内容 SHA-256、安装时间和安装器版本。ZIP 解压前必须拒绝绝对路径、`..` 穿越、符号链接、特殊文件、超大条目和超大总解压体积。

## 6. 技能与 ResourceLoader

### 6.1 查询与预览

- `GET /enterprise/employees/:employeeId/skills`
- `GET /enterprise/skill-versions/:versionId/preview`

只同步 `currentVersion` 且状态为 `PLATFORM_APPROVED`、`APPROVED` 或 `PUBLISHED` 的版本。草稿、待审核版本不能进入生产运行时。

预览正文是 Markdown。客户端只展示正文和版本元数据，不执行脚本，不允许危险 HTML、外链或超大正文。

### 6.2 Pi 注入

技能写入订阅隔离目录后，通过 Pi SDK `DefaultResourceLoader` 的 `additionalSkillPaths`、`agentsFilesOverride` 和 `systemPrompt`/override 注入。不得依赖用户全局 `~/.pi` 作为员工技能来源。

技能选择发生变化时必须使运行时 manifest 失效并重新组装。包、技能、`AGENTS.md` 和 `SYSTEM.md` 必须来自当前订阅隔离目录。

## 7. 企业知识库

授权摘要：

`GET /knowledge-bases/grants/by-subscription/:subscriptionId`

检索：

`POST /knowledge-bases/search`

```json
{
  "query": "平台退货政策",
  "subscriptionId": "sub_1",
  "topK": 5,
  "scoreThreshold": 0.5,
  "strategy": "auto"
}
```

客户端应把 query 和 ID 去除首尾空白，限制 `topK` 为 1-20、`scoreThreshold` 为 0-1，未知策略降级为 `auto`。响应中的 `strategy` 是服务端实际采用的策略，可能从向量/混合检索降级为词法检索。

第一期推荐在用户确认任务后，由 main 调用 search，将最小必要片段注入当前 Pi 上下文；不下载整个知识库，不自动上传本地文件，不把完整任务正文回传任务中心。

## 8. 客户端 IPC 约定

renderer 只能调用 `window.electronAPI`。常用方法：

| IPC 方法 | 用途 |
|---|---|
| `getCurrentSession()` | 启动时恢复认证状态 |
| `getSubscriptions()` | 获取当前授权订阅 |
| `getPackageInfo(subscriptionId)` | 查询锁定包 |
| `getEmployeeSkills(employeeId)` | 查询技能 |
| `getSkillPreview(versionId)` | 预览 Markdown |
| `getKnowledgeBaseGrants(subscriptionId)` | 查询知识库授权 |
| `searchKnowledgeBases(request)` | 执行知识库检索 |
| `createTask(input)` | 创建本地任务 |
| `executeTask(input)` | 入队并执行任务 |
| `setTaskModel(taskId, modelId)` | 在任务未运行时切换模型 |
| `pauseTask/cancelTask/retryTask` | 控制本地任务 |

IPC 参数必须在 main 再次校验。所有 `on...` 监听器必须在 renderer 组件卸载时调用返回的取消函数。

### 工具审批

- `read`、`grep`、`find`、`ls` 等只读工具可直接执行。
- `bash`、`write`、`edit` 必须经 `ApprovalBroker` 请求用户确认。
- 未知工具默认拒绝。
- 审批超时 60 秒自动拒绝。

## 9. 错误与隐私

当前服务端错误至少按 HTTP 状态和 `message` 处理，不依赖未稳定的 `code` 字段。客户端错误消息可以展示脱敏后的 message，但不能把以下数据写入日志或 IPC 事件：

- access token、refresh token、employmentToken
- 上游 API key、密码、Cookie、Authorization 头
- 完整 prompt/response、任务正文、本地文件内容和敏感本地路径

本地任务和运行历史按 `enterpriseId/memberId` 隔离保存。应用重启时，运行中的记录必须恢复为 `interrupted`，不能伪造为 `completed`。

## 10. 联调验收清单

按顺序验证：

1. 登录、重启恢复、access refresh、设备吊销后的 401 清理。
2. 直接授权和部门授权下，目录只出现有效 ACTIVE 订阅。
3. `subscriptionId` 换 Employment Token，暂停/撤销后网关返回 401/403。
4. 包版本等于 `templateVersion`，安装 SHA、隔离目录、失败回滚通过。
5. 只有审核通过且当前生效技能进入 ResourceLoader。
6. 知识库 search 只返回当前订阅被授权知识库的结果。
7. 任务确认后只在客户端执行，工具审批拒绝可观察地暂停或失败。
8. 401、403、404、429、5xx、网络错误和流式中断均有确定状态和有限重试。
9. 双企业、双成员、直接授权和部门授权覆盖目录、包、技能、知识库、网关五条链路。

## 11. 相关文件

- 平台总规范：`/Users/yao/LLM/SEP/docs/对接/SEP与客户端对接开发规范-v1.md`
- 客户端 API 实现：`electron/auth/auth-api.ts`
- 会话和 token：`electron/auth/auth-session-manager.ts`、`electron/auth/employment-token-manager.ts`
- 网关适配器：`electron/pi/sdk/pi-coding-agent-adapter.ts`
- 员工包运行时：`electron/runtime/subscription-runtime.ts`
- IPC 类型：`src/shared/ipc.ts`
- 本地任务执行：`electron/tasks/`、`electron/pi/`

旧版 `docs/对接/SEP客户端API文档.md` 和 `docs/交接/客户端联调指南.md` 可用于历史背景，但其中的实例级字段和旧 token 命名不应复制到新代码。
