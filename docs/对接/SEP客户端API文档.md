# SEP 客户端 API 接入文档

**版本**: v1.0  
**日期**: 2026-07-30  
**适用范围**: sep-client 桌面客户端

---

## 概述

本文档面向 sep-client 桌面客户端开发者，描述如何通过 SEP 平台的 API 完成：
1. 用户登录与设备注册
2. 获取授权的 AI 员工实例列表
3. 获取实例级访问令牌
4. 调用 AI 模型网关

**基础 URL**: `https://your-sep-domain.com`（替换为实际部署域名）

**认证方式**: Bearer Token（JWT）

---

## 快速开始

### 典型调用流程

```
1. 登录
   POST /client/auth/login
   → accessToken + refreshToken

2. 获取实例列表
   GET /client/instances (用 accessToken)
   → 返回可用的 AI 员工列表

3. 选择实例，换取实例令牌
   POST /client/auth/token (用 refreshToken + instanceId)
   → 实例级 accessToken (15分钟有效)

4. 调用 AI
   POST /gateway/v1/chat/completions (用实例级 accessToken)
   → 流式返回 AI 回复 + 自动计费
```

---

## API 端点

### 1. 客户端登录

注册设备并获取访问令牌。

**端点**: `POST /client/auth/login`

**请求头**: 无需认证

**请求体**:
```json
{
  "email": "user@example.com",
  "password": "user_password",
  "fingerprint": "unique_device_id_generated_by_client",
  "platform": "darwin",
  "clientVersion": "1.0.0"
}
```

| 字段 | 类型 | 必填 | 说明 |
|-----|------|------|------|
| email | string | ✅ | 用户邮箱 |
| password | string | ✅ | 用户密码 |
| fingerprint | string | ✅ | 设备指纹（由客户端生成，建议用 OS+CPU+主板序列号的哈希，最长256字符）|
| platform | string | ✅ | 平台标识（`darwin` / `win32` / `linux`）|
| clientVersion | string | ❌ | 客户端版本号（可选）|

**响应** (200 OK):
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600,
  "user": {
    "id": "user_abc123",
    "email": "user@example.com",
    "name": "张三"
  },
  "enterprise": {
    "id": "ent_xyz789",
    "name": "示例科技有限公司"
  }
}
```

| 字段 | 说明 |
|-----|------|
| accessToken | 通用访问令牌（用于获取实例列表等），有效期 1 小时 |
| refreshToken | 刷新令牌（用于换取实例级令牌），有效期 30 天 |
| expiresIn | accessToken 过期时间（秒）|
| user | 用户基本信息 |
| enterprise | 用户所属企业（如果用户无企业归属则为 null）|

**错误响应**:

| HTTP 状态码 | 错误码 | 说明 |
|-----------|--------|------|
| 401 | Unauthorized | 邮箱或密码错误 |
| 403 | Forbidden | 设备已被吊销 |

**注意事项**:
- `fingerprint` 必须保持稳定（同一设备每次登录应使用相同指纹）
- 同一 `(userId, fingerprint)` 组合会复用同一条 `Device` 记录
- `refreshToken` 应安全存储（Electron 可用 `safeStorage`）

---

### 2. 获取实例列表

获取当前用户被授权使用的 AI 员工实例清单。

**端点**: `GET /client/instances`

**请求头**:
```
Authorization: Bearer <accessToken>
```

**响应** (200 OK):
```json
[
  {
    "instanceId": "inst_abc123",
    "displayName": "市场调研员·小智",
    "templateId": "tpl_xyz789",
    "lockedVersion": "1.2.0",
    "packageRef": {
      "type": "npm",
      "spec": "@sep/employee-market-research@1.2.0"
    },
    "config": {
      "allowedTools": ["web_search", "calculator"],
      "customPrompt": "你是一名专业的市场调研分析师..."
    },
    "allowedTools": ["web_search", "calculator"],
    "allowedModels": ["gpt-4", "gpt-3.5-turbo", "claude-3-opus"],
    "status": "ACTIVE"
  },
  {
    "instanceId": "inst_def456",
    "displayName": "客服助手·小美",
    "templateId": "tpl_uvw012",
    "lockedVersion": "2.0.1",
    "packageRef": null,
    "config": null,
    "allowedTools": null,
    "allowedModels": ["gpt-3.5-turbo"],
    "status": "ACTIVE"
  }
]
```

| 字段 | 类型 | 说明 |
|-----|------|------|
| instanceId | string | 实例唯一标识（换取令牌时使用）|
| displayName | string | 企业自定义的员工名称 |
| templateId | string | 来源模板 ID |
| lockedVersion | string | 锁定的模板版本号 |
| packageRef | object \| null | 员工包引用（npm/git），null 表示 ZIP 模式 |
| config | object \| null | 实例配置（企业侧定制）|
| allowedTools | string[] \| null | 允许的工具列表，null 表示使用默认 |
| allowedModels | string[] | 允许调用的模型 ID 列表 |
| status | string | 实例状态（ACTIVE / PAUSED / REVOKED）|

**packageRef 结构**:
```typescript
{
  type: 'npm' | 'git',
  spec: string  // npm: "@scope/pkg@version" | git: "https://github.com/..."
}
```

**错误响应**:

| HTTP 状态码 | 说明 |
|-----------|------|
| 401 | accessToken 无效或已过期 |
| 403 | 用户无企业归属 |

**注意事项**:
- 返回的实例已过滤：只包含当前用户有授权（直接授权或部门授权）且 `status=ACTIVE` 的实例
- `allowedModels` 是平台级启用的模型列表（从 `PlatformModel` 表读取）

---

### 3. 换取实例令牌

用 `refreshToken` + `instanceId` 换取该实例的短期访问令牌。

**端点**: `POST /client/auth/token`

**请求头**: 无需认证

**请求体**:
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "instanceId": "inst_abc123"
}
```

| 字段 | 类型 | 必填 | 说明 |
|-----|------|------|------|
| refreshToken | string | ✅ | 登录时获取的 refreshToken |
| instanceId | string | ✅ | 要使用的实例 ID（从实例列表中选择）|

**响应** (200 OK):
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 900,
  "instanceId": "inst_abc123"
}
```

| 字段 | 说明 |
|-----|------|
| accessToken | 实例级访问令牌（用于调用网关），默认有效期 15 分钟 |
| expiresIn | 过期时间（秒）|
| instanceId | 确认的实例 ID |

**令牌 Payload 结构**:
```json
{
  "sub": "user_abc123",
  "enterpriseId": "ent_xyz789",
  "instanceId": "inst_abc123",
  "memberId": "mem_def456",
  "type": "client-instance",
  "iat": 1722336000,
  "exp": 1722336900
}
```

**错误响应**:

| HTTP 状态码 | 错误信息 | 说明 |
|-----------|---------|------|
| 401 | refreshToken 无效或已过期 | refreshToken 验证失败 |
| 401 | Token type 错误 | 传入的不是 client-refresh 类型的令牌 |
| 403 | 设备已吊销，请重新登录 | 设备的 `revokedAt` 不为空 |
| 403 | 用户无企业归属 | 用户未加入任何企业 |
| 403 | 实例不存在、已停用或不属于该企业 | instanceId 无效或状态不是 ACTIVE |
| 403 | 无该实例的使用授权或授权已过期 | 该成员没有对应的 `EmployeeGrant` 记录 |

**注意事项**:
- 实例令牌有效期短（默认 15 分钟），过期后需重新调用此接口
- 有效期通过 `SystemSetting.CLIENT_TOKEN_TTL_MINUTES` 配置
- 一个 refreshToken 可以多次换取不同实例的令牌

---

### 4. 调用 AI 模型网关

通过 OpenAI 兼容接口调用 AI 模型。

**端点**: `POST /gateway/v1/chat/completions`

**请求头**:
```
Authorization: Bearer <实例级accessToken>
Content-Type: application/json
```

**请求体**:
```json
{
  "model": "gpt-4",
  "messages": [
    { "role": "system", "content": "你是一名专业的市场调研分析师。" },
    { "role": "user", "content": "帮我分析一下电商行业的竞品情况。" }
  ],
  "temperature": 0.7,
  "max_tokens": 2000,
  "stream": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|-----|------|------|------|
| model | string | ✅ | 模型 ID（必须在 `allowedModels` 白名单中）|
| messages | array | ✅ | 对话历史（OpenAI 格式）|
| temperature | number | ❌ | 温度参数（0-2），默认 1.0 |
| max_tokens | number | ❌ | 最大生成 token 数 |
| stream | boolean | ❌ | 是否流式返回，默认 false |
| tools | array | ❌ | 工具定义（OpenAI tools 格式）|

**messages 格式**:
```typescript
{
  role: 'system' | 'user' | 'assistant' | 'tool',
  content: string,
  name?: string
}
```

---

#### 4.1 非流式响应 (`stream: false`)

**响应** (200 OK):
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1722336000,
  "model": "gpt-4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "根据最新数据，电商行业主要竞品有：\n1. 淘宝...\n2. 京东..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 50,
    "completion_tokens": 200,
    "total_tokens": 250
  }
}
```

---

#### 4.2 流式响应 (`stream: true`)

**响应头**:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**响应体** (SSE 格式):
```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1722336000,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1722336000,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"根据"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1722336000,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"最新"},"finish_reason":null}]}

...

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1722336000,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":200,"total_tokens":250}}

data: [DONE]
```

**关键点**:
- 每行格式：`data: <JSON>\n\n`
- 最后一块带 `usage` 字段（用于计费）
- 结束标记：`data: [DONE]\n\n`

---

#### 4.3 错误响应

| HTTP 状态码 | 错误信息 | 说明 |
|-----------|---------|------|
| 401 | Missing token | 请求头缺少 Authorization |
| 401 | Invalid or expired token | 实例令牌无效或已过期 |
| 401 | Token type must be client-instance | 使用了错误类型的令牌（如 accessToken 而非实例令牌）|
| 403 | 实例不存在、已停用或不属于该企业 | 实例状态异常 |
| 403 | 无该实例的使用授权或授权已过期 | 授权被撤销或过期 |
| 403 | 企业算力余额不足，请联系管理员充值 | 企业账户余额 ≤ 0 |
| 400 | 模型 "xxx" 不在白名单中 | 请求的 model 不在该实例的 `allowedModels` 中 |
| 400 | sub2api API Key 未配置 | 平台侧配置缺失 |
| 400 | sub2api 错误(XXX): ... | 上游模型服务返回错误 |

**流式响应中途断连**:
- 如果 sub2api 连接中断，网关会直接断开客户端连接（不发送错误事件）
- 客户端应捕获连接断开，向用户提示"模型服务异常，请稍后重试"

---

#### 4.4 计费说明

**自动计费流程**:
1. 网关收到完整响应后，从 `usage` 中读取 token 用量
2. 根据模型单价计算成本（USD）× 汇率 → CNY
3. 写入 `ComputeTransaction` 表（记录 enterpriseId / instanceId / memberId）
4. 扣减 `Enterprise.computeBalance`

**费率示例** (网关内置，实际以平台配置为准):
| 模型 | 输入单价 (USD/1k tokens) | 输出单价 (USD/1k tokens) |
|-----|------------------------|------------------------|
| gpt-4 | $0.03 | $0.06 |
| gpt-3.5-turbo | $0.001 | $0.002 |
| claude-3-opus | $0.015 | $0.075 |

**汇率**: 从 `SystemSetting.USD_TO_CNY_RATE` 读取，默认 7.2

**重要**:
- 计费在**响应完成后**异步执行，不阻塞用户
- 计费失败只记录日志，不影响用户拿到 AI 回复
- 企业余额检查是**请求前**进行，可能出现小额透支（如余额 0.1 元，实际花了 0.5 元）

---

## 认证令牌总结

| 令牌类型 | 用途 | 有效期 | 获取方式 | type 字段 |
|---------|------|--------|---------|----------|
| **accessToken** (通用) | 获取实例列表等 | 1 小时 | `POST /client/auth/login` | `access` |
| **refreshToken** | 换取实例令牌 | 30 天 | `POST /client/auth/login` | `client-refresh` |
| **accessToken** (实例级) | 调用模型网关 | 15 分钟 | `POST /client/auth/token` | `client-instance` |

**令牌刷新策略建议**:
- 实例令牌快过期时（如剩余 < 5 分钟），后台调用 `POST /client/auth/token` 换新令牌
- refreshToken 快过期时（如剩余 < 7 天），提示用户重新登录

---

## 错误码汇总

| HTTP 状态码 | 场景 | 客户端处理建议 |
|-----------|------|--------------|
| 400 | 请求参数错误 | 显示错误信息，检查请求格式 |
| 401 | 令牌无效/过期 | 自动刷新令牌或提示重新登录 |
| 403 | 无权限/余额不足 | 显示明确提示，引导用户联系管理员 |
| 500 | 服务器内部错误 | 提示"服务异常，请稍后重试" |

**通用错误响应格式**:
```json
{
  "statusCode": 403,
  "message": "企业算力余额不足，请联系管理员充值",
  "error": "Forbidden"
}
```

---

## 安全建议

1. **令牌存储**:
   - `refreshToken` 存储在安全位置（Electron: `safeStorage.encryptString`）
   - 不要将令牌写入日志或明文配置文件

2. **设备指纹**:
   - 使用稳定的硬件标识生成（OS + CPU + 主板序列号 hash）
   - 不要用易变的信息（如 IP、进程 ID）

3. **HTTPS**:
   - 生产环境必须使用 HTTPS
   - 验证服务器证书

4. **错误处理**:
   - 敏感错误（如"密码错误"）不要暴露给日志采集服务
   - 网络错误重试时加入指数退避

5. **令牌泄露防护**:
   - 实例令牌短期有效（15 分钟），降低泄露风险
   - 如果检测到异常（如设备被吊销），立即清除本地令牌并提示重新登录

---

## 调试技巧

### 1. 查看令牌内容

所有令牌都是 JWT 格式，可以用 [jwt.io](https://jwt.io) 解码查看 payload（不要泄露到公网）。

**实例令牌示例 payload**:
```json
{
  "sub": "user_abc123",
  "enterpriseId": "ent_xyz789",
  "instanceId": "inst_abc123",
  "memberId": "mem_def456",
  "type": "client-instance",
  "iat": 1722336000,
  "exp": 1722336900
}
```

### 2. 测试网关接口

用 `curl` 测试网关:
```bash
curl -X POST https://your-sep-domain.com/gateway/v1/chat/completions \
  -H "Authorization: Bearer <实例令牌>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

### 3. 常见问题排查

| 问题 | 可能原因 | 解决方法 |
|-----|---------|---------|
| 401 Token type 错误 | 用了通用 accessToken 调网关 | 网关必须用实例令牌 |
| 403 无授权 | grant 被撤销或过期 | 重新获取实例列表，检查该实例是否还在 |
| 403 余额不足 | 企业欠费 | 联系企业管理员充值 |
| 400 模型不在白名单 | 请求了未启用的模型 | 从实例列表的 `allowedModels` 中选择 |
| 流式响应中断 | sub2api 连接断开 | 提示用户重试，如果频繁发生联系平台管理员 |

---

## 附录

### A. TypeScript 类型定义

```typescript
// 登录请求
interface ClientLoginRequest {
  email: string;
  password: string;
  fingerprint: string;
  platform: 'darwin' | 'win32' | 'linux' | string;
  clientVersion?: string;
}

// 登录响应
interface ClientLoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    name: string;
  };
  enterprise: {
    id: string;
    name: string;
  } | null;
}

// 实例清单
interface ClientInstance {
  instanceId: string;
  displayName: string;
  templateId: string;
  lockedVersion: string;
  packageRef: {
    type: 'npm' | 'git';
    spec: string;
  } | null;
  config: Record<string, unknown> | null;
  allowedTools: string[] | null;
  allowedModels: string[];
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
}

// 实例令牌请求
interface ClientTokenRequest {
  refreshToken: string;
  instanceId: string;
}

// 实例令牌响应
interface ClientTokenResponse {
  accessToken: string;
  expiresIn: number;
  instanceId: string;
}

// Chat Completion 请求
interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
}

// Chat Completion 响应（非流式）
interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

### B. 相关文档

- [SEP 客户端项目交接文档](./SEP客户端-项目交接文档.md) - 技术架构和 PoC 验证
- [硅基员工平台方向调整设计方案 v3](../architecture/v3/硅基员工平台-方向调整设计方案-v3.md) - 整体架构设计

---

**文档结束**  
如有疑问，请联系 SEP 后端开发团队。
