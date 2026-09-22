# SEP 客户端工具调用联调修复与接入说明

> 文档版本：v1.0
> 更新时间：2026-09-20
> 适用对象：`sep-client` / Pi Agent 客户端开发者、联调测试人员
> 当前联调环境：`https://sep-dev.longdaoSEP.cn`
> 关联修复提交：`a1dace1`
> 关联部署记录：`82f547e`

本文用于指导客户端接入 SEP Gateway 的多轮工具调用，重点说明此前“首轮请求 200、执行工具后第二轮请求 400”的问题、客户端必须保留的上下文，以及联调验收方法。

## 1. 结论先看

SEP Gateway 的服务端修复已经完成并部署到共享联调环境。客户端不需要通过改字段名、重复执行工具或关闭流式请求来规避问题。

客户端需要确保：

1. **完整保留第一轮模型返回的 assistant 工具调用消息**；
2. **完整保留每一个 `tool_calls[].id`**；
3. 工具结果使用 `role: "tool"`，并通过 `tool_call_id` 精确关联对应的调用 ID；
4. 如果第一轮响应带有 `reasoning_content`，第二轮必须原样保留；
5. 流式响应中分片返回的工具调用参数必须按 index 合并后再执行工具；
6. 第二轮请求继续使用同一个 `model`，并携带完整的历史 `messages`。

正确的调用链为：

```text
请求 1：用户消息 + tools
    ↓
模型返回 assistant.tool_calls
    ↓
客户端按 tool_calls 执行本地工具
    ↓
请求 2：原历史消息 + assistant 工具调用 + tool 结果
    ↓
模型返回最终文本，或继续返回下一轮工具调用
```

## 2. 联调环境和接口地址

```text
普通 API 根地址： https://sep-dev.longdaoSEP.cn/api
模型网关地址：   https://sep-dev.longdaoSEP.cn/api/gateway/v1
```

客户端建议配置：

```bash
SEP_BASE_URL=https://sep-dev.longdaoSEP.cn/api
SEP_GATEWAY_URL=https://sep-dev.longdaoSEP.cn/api/gateway/v1
```

模型请求接口：

```http
POST /api/gateway/v1/chat/completions
Authorization: Bearer <employmentToken>
Content-Type: application/json
```

注意：

- `SEP_BASE_URL` 已经包含 `/api`，不要拼成 `/api/api/...`；
- Gateway 必须使用当前订阅换取的 `employmentToken`，不能使用普通 `accessToken`；
- `model` 必须来自当前订阅返回的 `allowedModels`；
- 本说明只针对联调环境，不要把联调账号、token 或内部配置写入客户端仓库、日志和截图。

## 3. 第二轮请求必须如何组装

### 3.1 首轮请求

```json
{
  "model": "deepseek-v4.1-flash",
  "messages": [
    {
      "role": "user",
      "content": "查看工作目录中有什么文件"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "ls",
        "description": "List files in a directory",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Optional directory path"
            }
          },
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": "auto",
  "stream": false
}
```

模型可能返回：

```json
{
  "choices": [
    {
      "index": 0,
      "finish_reason": "tool_calls",
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_test_ls_001",
            "type": "function",
            "function": {
              "name": "ls",
              "arguments": "{}"
            }
          }
        ]
      }
    }
  ]
}
```

客户端应将 `message` 作为历史消息保存，而不是只提取工具名称和参数。尤其不能丢弃：

```text
message.role
message.content
message.tool_calls[*].id
message.tool_calls[*].type
message.tool_calls[*].function.name
message.tool_calls[*].function.arguments
message.reasoning_content（如果存在）
```

### 3.2 工具结果消息

本地工具执行完成后，为每个工具调用生成一条 `role: "tool"` 消息：

```json
{
  "role": "tool",
  "tool_call_id": "call_test_ls_001",
  "content": "file-a.txt\nfile-b.txt"
}
```

约束：

- `tool_call_id` 必须与对应的 `assistant.tool_calls[].id` **完全一致**；
- 不要改成 `call_id`、`tool_id` 或其他自定义字段；
- `content` 必须是字符串；如果工具返回结构化数据，先序列化为 JSON 字符串；
- 多个工具调用要分别返回多条 `tool` 消息；
- 不要伪造模型没有返回的 `reasoning_content`；
- 不要把完整 token、授权头或不必要的本地敏感目录内容写入日志。

### 3.3 第二轮请求

第二轮请求应保留原来的历史消息，并追加真实的 assistant 工具调用和工具结果：

```json
{
  "model": "deepseek-v4.1-flash",
  "messages": [
    {
      "role": "user",
      "content": "查看工作目录中有什么文件"
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_test_ls_001",
          "type": "function",
          "function": {
            "name": "ls",
            "arguments": "{}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_test_ls_001",
      "content": "file-a.txt\nfile-b.txt"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "ls",
        "description": "List files in a directory",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Optional directory path"
            }
          },
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": "auto",
  "stream": false
}
```

实际客户端实现中，`assistant` 消息必须来自第一轮模型的真实响应；上面的 ID 和内容仅用于说明格式，不能硬编码到生产代码。

## 4. 推荐的客户端处理逻辑

伪代码如下：

```ts
const messages = [{ role: 'user', content: userInput }];

while (true) {
  const response = await gateway.chat.completions.create({
    model,
    messages,
    tools,
    tool_choice: 'auto',
    stream: useStream,
  });

  const assistantMessage = useStream
    ? assembleAssistantMessageFromSse(response)
    : response.choices[0].message;

  // 必须保存模型原始 assistant 消息，不能只保存文本。
  messages.push(assistantMessage);

  const toolCalls = assistantMessage.tool_calls ?? [];
  if (toolCalls.length === 0) {
    return assistantMessage.content ?? '';
  }

  for (const toolCall of toolCalls) {
    const result = await executeLocalTool(
      toolCall.function.name,
      JSON.parse(toolCall.function.arguments || '{}'),
    );

    messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: stringifyToolResult(result),
    });
  }
}
```

实现时还需要注意：

- `tool_calls` 可能包含多个调用，不能只处理数组第一个元素；
- 工具结果应使用模型返回的调用 ID，不要在客户端重新生成 ID；
- 如果一次 assistant 消息包含多个工具调用，追加所有对应的 `tool` 结果后再发下一次模型请求；
- 不要用“当前 `tool` 消息的上一条必须是 assistant”这种规则处理多工具结果；
- 应设置合理的最大工具调用轮数，避免模型和工具之间无限循环；
- 工具审批拒绝、工具执行异常也要返回可解释的字符串结果，或按客户端任务协议终止当前回合，不要发送缺字段的 `tool` 消息。

## 5. 流式工具调用处理

当 `stream: true` 时，工具调用的 ID、函数名和 `arguments` 可能分布在多个 SSE chunk 中。客户端不能把每个 chunk 当作一条完整工具调用。

处理原则：

1. 按 `tool_calls[].index` 聚合调用；
2. 首次出现时保存 `id`、`type`、函数名；
3. 持续拼接同一 index 的 `function.arguments` 字符串；
4. 收到工具调用完成信号或 `finish_reason: "tool_calls"` 后，再解析参数并执行工具；
5. 将组装后的完整 assistant 工具调用消息保存到下一轮 `messages`；
6. 工具结果回传后的下一轮可以继续使用 `stream: true`；
7. 只有收到 `data: [DONE]` 才能把普通流式文本请求标记为正常完成。

不能这样处理：

```text
收到第一个 arguments 分片 → 立即 JSON.parse → 执行工具
```

因为此时 JSON 可能尚未完整，容易导致参数解析失败或生成不完整的第二轮上下文。

## 6. 本次服务端修复内容

此前问题的服务端根因是 Gateway 请求 Schema 在转发前删除了工具调用上下文中的字段，尤其是：

- `assistant.tool_calls`；
- `tool.tool_call_id`；
- `reasoning_content`。

因此首轮请求可以成功，客户端执行工具后，第二轮缺少模型识别工具结果所需的关联信息，最终返回 400。

当前联调版本已完成：

- 保留并校验 `tool_calls`、`tool_call_id`、`reasoning_content`；
- 支持工具调用 assistant 消息的 `content: null`、空字符串或省略；
- 上游错误保留真实 HTTP 状态和 `error.message/code/param`；
- Gateway 400 错误返回 OpenAI SDK 可读取的错误结构；
- 连接上游失败返回 502，而不是伪装成无正文 400。

客户端不需要：

- 把 `tool_call_id` 改成其他字段名；
- 删除 `assistant.tool_calls`；
- 重复执行一次工具来“补救”请求；
- 为绕过校验而虚构 `reasoning_content`；
- 因为此前 400 而永久关闭流式请求。

## 7. 错误处理约定

Gateway 错误会尽量返回以下结构：

```json
{
  "error": {
    "message": "请求参数校验失败: messages.2.tool_call_id: 工具结果必须提供 tool_call_id",
    "type": "invalid_request_error",
    "code": "INVALID_PARAMETER",
    "param": "messages.2.tool_call_id",
    "requestId": "<gateway-request-id>"
  }
}
```

客户端应优先展示或记录：

```text
error.message
error.code
error.param
error.requestId
```

推荐处理策略：

| HTTP 状态 | 客户端处理 |
|---:|---|
| `400` | 修正请求结构或参数；不要对完全相同的请求无限重试 |
| `401` | 刷新 employment token 一次，原请求最多重试一次 |
| `403` | 检查订阅、模型授权、余额和企业状态，不循环重试 |
| `404` | 刷新订阅/授权信息，停止当前员工运行 |
| `429` | 按 `Retry-After` 或指数退避，限制重试次数 |
| `5xx` | 保留为可恢复失败，指数退避并记录 request ID |
| 网络错误 | 不伪造任务成功，保留本地任务为可恢复失败 |

如果客户端仍然收到 `400 status code (no body)`，请先确认是否使用了旧的 Gateway 地址或旧容器，然后收集下面的信息反馈平台：

- HTTP 状态码；
- `error.message`；
- `error.code`；
- `error.param`；
- `error.requestId` 或响应头 `x-request-id`；
- 脱敏后的 message role 序列；
- `assistant.tool_calls[].id` 与 `tool.tool_call_id` 是否一致；
- 是否为流式请求，以及是否收到完整的工具调用分片。

不要提交 access token、employment token、完整工作目录、完整工具参数或用户隐私数据。

## 8. 联调验收清单

客户端开发者完成修改后，请按以下顺序验证：

### 8.1 非流式两轮

- [ ] 首轮 `stream: false` 能返回 `assistant.tool_calls`；
- [ ] 客户端执行本地工具成功；
- [ ] 第二轮保留首轮 assistant 工具调用原文；
- [ ] 第二轮每条 `tool_call_id` 与对应 ID 完全一致；
- [ ] 第二轮 HTTP 200，并得到最终文本或下一轮工具调用；
- [ ] 最终响应 `finish_reason` 正确处理。

### 8.2 流式两轮

- [ ] 首轮 SSE 能正确合并分片的工具调用；
- [ ] 不会在 arguments 未完整时执行工具；
- [ ] 第二轮继续使用正确的历史上下文；
- [ ] 工具结果回传后的 SSE 能正常结束；
- [ ] 收到 `[DONE]` 后才标记任务成功。

### 8.3 异常输入

- [ ] 缺少 `tool_call_id` 时，能读取 400 的 `error.message/code/param/requestId`；
- [ ] 401 只刷新 employment token 并重试一次；
- [ ] 403、404 不进行无限重试；
- [ ] 工具执行失败不会生成缺少字段的伪造消息；
- [ ] 日志不包含 token 和本地敏感内容。

## 9. 相关文档

- [SEP 客户端共享联调完整对接文档](SEP-客户端共享联调完整对接文档-v1.md)：认证、订阅、employment token、网关基础接口和全链路验收。
- [SEP Gateway 工具调用后续请求 400 排查说明](SEP-Gateway-工具调用后续请求400排查说明-2026-09-20.md)：服务端根因、测试、部署和回滚记录。

## 10. 当前发布状态

截至 **2026-09-20**：

- 修复提交：`a1dace1`；
- 联调文档记录提交：`82f547e`；
- 联调容器：`sep-dev-backend:a1dace1-gateway`；
- 联调环境 readiness：PostgreSQL、Redis、任务队列、知识库队列、sub2api、embedding 均正常；
- 非流式和流式的首轮工具调用、工具结果回传均已通过真实模型验收；
- 客户端团队仍需使用实际 `sep-client/Pi SDK` 重试原始任务，确认客户端自己的 SSE 组装和消息保留逻辑。
