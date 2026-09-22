# MCP 工具接入说明

## 1. 接入范围

客户端通过 Pi Extension 把 MCP Server 的工具注册给模型，保留 Pi SDK 0.83.0：

```text
本机受信任配置 → MCP initialize / tools/list → pi.registerTool
模型工具调用 → 原有审批链路 → MCP tools/call → Pi 工具结果 → 下一轮模型上下文
```

本次不增加前端、IPC 或 SEP 接口，不更改现有任务调度。内置 `web_search` 已移除（直连搜索站点连续超时）；浏览网页使用 Playwright MCP，其他搜索服务可通过 MCP 配置接入。
未指定 MCP 配置时，客户端默认启用内置 Playwright 浏览器预设，可通过 SEP_PLAYWRIGHT_MCP=0 关闭。已有 SEP_MCP_CONFIG 显式配置继续优先，不自动合并新工具。Windows 桌面控制仍需另外接入。详见《Playwright浏览器工具接入说明》。

支持：

- `stdio`：启动本机 MCP Server 子进程，以标准输入/输出通信。
- `streamable-http`：连接远程 HTTPS 或本机回环 HTTP MCP endpoint。
- `tools/list` 分页发现、`tools/call` 执行，JSON Schema 参数传递。
- 文本结果和 `structuredContent`；业务错误、协议错误、超时返回错误工具结果。

暂不实现旧 HTTP+SSE 传输、OAuth 登录、MCP resources/prompts、热更新、图片/音频结果转发。
Streamable HTTP 协议内部的 SSE 响应由 SDK 处理，不等于支持旧版 SSE endpoint。
非文本内容会明确报告不支持，不会把图片数据当文本交给模型。

## 2. 配置入口

创建 UTF-8 JSON 文件，通过进程环境变量 `SEP_MCP_CONFIG` 指定其**绝对路径**。
不自动读取工作目录中的配置，避免打开不受信任项目时启动任意程序。

开发启动示例（PowerShell；路径仅为示例，请替换成实际文件）：

```powershell
$env:SEP_MCP_CONFIG = 'D:\sep-config\mcp.json'
npm run dev
```

安装版也需要在启动时继承这个环境变量。修改配置后请重启客户端，让已有的共享 Pi Session 重建。
不要把含凭据的配置文件提交到仓库。配置属于本机进程级，不按 SEP 公司/用户隔离；多用户机器应分别设置配置文件和文件访问权限。

### 本机 stdio 示例

```json
{
  "servers": [
    {
      "name": "localdocs",
      "transport": {
        "type": "stdio",
        "command": "C:\\Program Files\\nodejs\\node.exe",
        "args": ["D:\\mcp-servers\\docs\\server.mjs"]
      },
      "enabledTools": ["search"],
      "timeoutMs": 30000
    }
  ]
}
```

`command` 和脚本必须已安装；示例中的脚本并非本仓库自带服务。
可配置 `transport.env` 和绝对路径 `transport.cwd`；未设置 cwd 时使用当前任务工作目录。
stdio Server 以客户端用户权限运行，启动本身不弹工具审批框，因此只能配置可信程序。
不要使用需要交互安装确认的命令，也不要把日志写入 MCP 标准输出。

### 远程 Streamable HTTP 示例

```json
{
  "servers": [
    {
      "name": "search",
      "transport": {
        "type": "streamable-http",
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "Authorization": "Bearer REPLACE_WITH_MCP_SERVER_TOKEN"
        }
      },
      "enabledTools": ["search"],
      "autoApproveTools": ["search"],
      "timeoutMs": 30000
    }
  ]
}
```

URL、凭据和 `search` 都是占位示例，须替换为服务端实际 endpoint、令牌和工具原名。
远程 HTTP 明文连接被拒绝，只有 `localhost` / `127.0.0.1` / `[::1]` 允许 HTTP。
请求拒绝 HTTP 重定向，避免凭据随重定向泄露。不会自动附带 SEP 登录令牌。
配置值不做 `${ENV_VAR}` 字符串插值。

## 3. 工具命名与权限

- 工具对模型的名称：`mcp__<serverName>__<toolName>`，如 `mcp__search__search`。
- 原名过长或包含不兼容字符时会规范化并追加稳定摘要；实际调用仍使用原始名称。
- `enabledTools` 填 **MCP 工具原名**。省略或空数组表示不启用任何工具，也不连接该服务。
- 只有显式启用且 `tools/list` 确实返回的工具才注册；配置了不存在的工具会报初始化错误。
- 主机配置的 enabledTools 是 MCP 的独立白名单，加入本轮可见工具和有效审批策略；不要求修改前端内置工具权限档位。
- 默认每次执行都走现有审批。内置工具的 `auto-approve` 不会自动放行 MCP。
- `autoApproveTools` 必须是 enabledTools 的子集，只有明确列出的工具免审批。不要给浏览器点击、文件写入、命令执行等工具轻率配置免审批。
- Server 声称工具只读（`readOnlyHint`）不构成免审批授权，未注册的 `mcp__*` 名称仍拒绝。
- MCP 工具不自动继承本地文件工具的工作目录路径限制；浏览器/远端系统有自己的资源范围，应通过 Server 配置与审批约束。内置工具“只读”不代表配置的外部 MCP Server 也是只读。
- `disableTools` 或 planner 空工具策略不会连接/启动 MCP。

## 4. 错误、取消和生命周期

- MCP `isError`、调用异常、超时转成 Pi 错误工具结果，错误信息进入下一轮模型上下文；模型可以据此修正参数。
- 不在 MCP 桥中重试工具调用，不启用 HTTP 流重连重试；连接/发现失败会终止本次 Session 初始化并清理已建立连接。
- 保留原有模型请求重试和循环保护，不把工具失败改成自动重发相同调用。
- 取消信号传给 MCP SDK，调用结束清理共享信号监听器；超时不代表外部副作用一定已被撤销。
- Session dispose 时关闭连接：stdio 子进程由 transport 关闭；有 sessionId 的 HTTP 服务尝试 DELETE 终止会话，然后关闭 transport。
- MCP 调用统一保守记为可能有副作用，以便中断/崩溃恢复标记未知执行结果；这不代表前缀本身授予权限。
- 配置凭据会从工具结果/错误中脱敏；stdio stderr 被消费但不直接写入应用日志。

## 5. 实现位置与回归

- `electron/pi/sdk/pi-mcp-config.ts`：配置读取和校验。
- `electron/pi/sdk/pi-mcp-client.ts`：传输、发现、调用、结果转换和清理。
- `electron/pi/sdk/pi-coding-agent-adapter.ts`：Extension 注册、审批、会话生命周期。
- `pi-extension/guard.ts`：已注册扩展工具权限判定。
- `electron/common/constants.ts`：外部工具副作用恢复分类。

定向测试：

```powershell
npx tsx --test electron/pi/sdk/pi-mcp-client.test.ts electron/pi/sdk/pi-mcp-integration.test.ts electron/common/constants.test.ts pi-extension/guard.test.ts
```

集成测试使用真实 Pi SDK、本地假模型网关以及本地 MCP 服务，覆盖成功、业务失败、拒绝、免审批、禁用/planner、真实 TaskWorker 环境变量入口、stdio/HTTP、超时取消和清理；不调用 SEP 或真实第三方 MCP 服务。