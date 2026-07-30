# SEP Client — PoC 验证阶段

基于 Electron + pi-coding-agent SDK 的企业 AI 员工桌面客户端。

## 📋 本周目标：4 个 PoC 验证（不写真实 UI）

根据 `项目升级开发顺序方案v3.md` §8.5 的建议，**第一周专注技术验证**，4 个 PoC 全部通过后再开始 UI 开发。

### ✅ PoC ① — SDK 导入验证
**目标**: Electron 主进程能 `import @earendil-works/pi-coding-agent` 且 `createAgentSession()` 不报 ESM/CJS 错误

**运行测试**:
```bash
npm run poc:01
```

**验证点**:
- ✓ import 成功（无模块加载错误）
- ✓ createAgentSession() 返回 AgentSession 对象
- ✓ session 具备 `.prompt()` 和 `.on()` 方法

---

### ✅ PoC ② — 自定义 Provider + 动态令牌注入
**目标**: 验证 `before_provider_headers` 事件能在每次 LLM 请求前动态注入不同的 access token

**运行测试**:
```bash
npm run poc:02
```

**验证点**:
- ✓ `ModelRuntime.registerProvider()` 注册指向 localhost 的 OpenAI-compatible provider
- ✓ `before_provider_headers` 在每次 HTTP 请求前触发
- ✓ 每次请求注入不同令牌，fake gateway 收到不同的 Authorization header

**原理**:
```typescript
pi.on('before_provider_headers', async (event) => {
  const token = await getAccessToken(); // 每次重新获取
  event.headers['authorization'] = token;
});
```

---

### ✅ PoC ③ — async tool_call 拦截验证
**目标**: 验证 `tool_call` handler 支持 `async` + `Promise`，主进程可以 await 用户确认后再返回 block/allow

**运行测试**:
```bash
npm run poc:03
```

**验证点**:
- ✓ `pi.on("tool_call", async handler)` 接收异步 handler
- ✓ handler 内部可以 `await` 用户确认 Promise（模拟 GUI 对话框）
- ✓ 返回 `{ block: true }` 能成功阻止工具执行

**架构**:
```typescript
pi.on('tool_call', async (event) => {
  const approved = await showApprovalDialog(event.toolName);
  return approved ? { block: false } : { block: true };
});
```

在 Electron 完整应用中，`showApprovalDialog` 通过 IPC 与 renderer 通信。

---

### ✅ PoC ④ — 失败态不静默降级
**目标**: 验证 gateway 返回 401/500 时，pi 层能捕获错误并冒泡到主进程（不是静默忽略）

**运行测试**:
```bash
npm run poc:04
```

**验证点**:
- ✓ gateway 返回 401 → pi 层报错
- ✓ 错误通过 `agent_end` 或 `auto_retry_end` 事件冒泡
- ✓ 未生成任何成功的 LLM 响应内容

---

## 🚀 快速开始

### 1. 安装依赖
```bash
npm install
```

关键依赖:
- `@earendil-works/pi-coding-agent@0.83.0` — 锁定版本，不追最新
- `@earendil-works/pi-ai@0.83.0` — 用于 PoC③ 的 fauxProvider
- `express` — PoC② 和 PoC④ 的 fake gateway
- `tsx` — 运行 TypeScript PoC 脚本

### 2. 运行 PoC 测试

**方案 A — 逐个运行 (推荐)**:
```bash
npm run poc:01   # SDK import
npm run poc:02   # Provider + dynamic token
npm run poc:03   # Async tool_call
npm run poc:04   # Failure handling
```

**方案 B — 使用 fake-gateway (可选)**:
如果需要手动测试 gateway 交互，可以先启动 fake gateway:
```bash
npm run poc:gw   # 启动 fake gateway on port 9999
```

然后在另一个终端测试 PoC②：
```bash
curl -X POST http://localhost:9999/control -H "Content-Type: application/json" -d '{"mode":"ok"}'
npm run poc:02
curl http://localhost:9999/log  # 查看捕获的 tokens
```

### 3. 运行 Electron 完整应用 (PoC 全通过后)

```bash
npm run dev      # 开发模式 (hot reload)
npm run build    # 构建生产版本
npm run package  # 打包成 .dmg / .exe
```

---

## 📁 项目结构

```
sep-client/
├── poc/                          # PoC 验证脚本 (Node.js standalone)
│   ├── fake-gateway.ts           # OpenAI-compatible fake gateway
│   ├── 01-sdk-import.ts          # PoC ①
│   ├── 02-provider.ts            # PoC ②
│   ├── 03-tool-call-async.ts     # PoC ③
│   └── 04-failure.ts             # PoC ④
├── electron/                     # Electron 主进程
│   ├── main.ts                   # 主进程入口
│   ├── preload.ts                # contextBridge IPC
│   ├── pi-host.ts                # pi session 生命周期管理
│   └── credentials.ts            # safeStorage 封装
├── pi-extension/                 # SEP 扩展 (guard + provider)
│   ├── index.ts                  # 组合导出
│   ├── guard.ts                  # 权限拦截 (tool_call handler)
│   └── provider.ts               # 动态令牌注入 (before_provider_headers)
├── src/                          # React 渲染进程
│   ├── index.html                # 入口 HTML
│   ├── main.tsx                  # React 入口
│   ├── App.tsx                   # PoC 验证面板 (简化 UI)
│   ├── shared/types.ts           # 共享类型定义
│   └── index.css                 # 全局样式
└── package.json
```

---

## 🔧 技术架构

### 核心决策 (来自交接文档 §8.4)

1. **pi-coding-agent 版本锁定**: `0.83.0` — 不追最新，避免破坏性变更
2. **进程内模式**: SDK 在 Electron 主进程内运行，**不是** sidecar 模式
3. **Extension 系统**: 通过 `ExtensionFactory` 注入自定义逻辑
   - `before_provider_headers` → 动态令牌注入
   - `tool_call` → 异步权限拦截

### 动态令牌注入流程 (PoC②)

```
[Renderer] user action
    ↓
[Main] ipcMain.handle('pi:send-prompt')
    ↓
[PiHost] session.prompt(text)
    ↓
[pi-coding-agent] agent loop starts
    ↓
[ModelRuntime] prepare HTTP request to SEP gateway
    ↓
[Extension] before_provider_headers fires
    ↓
[provider.ts] getAccessToken() → injects fresh token
    ↓
[HTTP] request sent with Authorization: Bearer <fresh-token>
```

### 工具审批流程 (PoC③)

```
[pi-agent] LLM returns bash tool_call
    ↓
[Extension] tool_call event fires
    ↓
[guard.ts] async handler starts
    ↓
[pi-host.ts] onToolApprovalRequest callback
    ↓
[main.ts] forwards to renderer via IPC
    ↓
[App.tsx] shows approval dialog
    ↓
[User] clicks "允许" or "拒绝"
    ↓
[App.tsx] sends response via IPC
    ↓
[main.ts] resolves pending Promise
    ↓
[guard.ts] returns { block: false } or { block: true }
    ↓
[pi-agent] executes or skips tool
```

---

## ⚠️ 已知限制 (PoC 阶段)

1. **无真实 SEP 后端**: PoC 使用 fake-gateway 模拟，返回固定响应
2. **无真实 OAuth**: refresh token 硬编码，未实现 /auth/refresh 调用
3. **无持久化**: credentials 仅内存存储，未写入磁盘
4. **简化 UI**: 仅状态面板 + 工具审批对话框，无完整聊天界面

这些都是**故意的**。根据 §8.5 开发顺序，本周只验证技术可行性，下周才开始 UI 和后端集成。

---

## 📚 参考文档

- `docs/对接/SEP客户端-项目交接文档.md` — 架构设计与技术选型
- `docs/plans/项目升级开发顺序方案v3.md` — 开发计划 (§8.5)
- [pi-coding-agent GitHub](https://github.com/earendil-works/pi-coding-agent) — SDK 官方文档

---

## 🎯 下一步 (PoC 全通过后)

1. **UI 层开发** — 真实聊天界面、消息流、工具执行状态
2. **后端集成** — 调用真实 SEP Gateway API (`/chat/completions`, `/auth/refresh`)
3. **凭证管理** — 持久化 refresh token 到 OS 加密存储
4. **错误处理** — 网络断线重连、token 过期刷新、失败重试
5. **打包发布** — 签名、公证、auto-update

---

## 💡 常见问题

**Q: PoC② 和 PoC④ 需要先启动 fake-gateway 吗？**  
A: 不需要。poc/02-provider.ts 和 poc/04-failure.ts 内嵌了 HTTP server，完全自包含。

**Q: PoC③ 需要真实的 LLM API key 吗？**  
A: 不需要。使用 `@earendil-works/pi-ai` 的 `fauxProvider` 预编程响应，无网络调用。

**Q: 为什么锁定 pi-coding-agent@0.83.0？**  
A: 根据交接文档 §8.4 要求，**不追最新版本**。0.83.0 是已知稳定版本，避免后续 API 变更影响开发进度。

**Q: 4 个 PoC 必须全部通过吗？**  
A: **是的**。引用文档原文："PoC 第一周就把这四件事跑通，它们是整个方案的技术前提。任一失败都需要回头重新讨论方案。"

---

**当前状态**: PoC 验证阶段 — 等待依赖安装完成后逐个运行测试
