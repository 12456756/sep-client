# SEP Client — 项目规则 (CLAUDE.md)

## 项目概览

**sep-client** 是基于 Electron + pi-coding-agent SDK 的企业 AI 员工桌面客户端，服务于 Silicon Employee Platform (SEP)。

- **主进程**: Electron (Node.js) + pi-coding-agent SDK (进程内，非 sidecar)
- **渲染进程**: React 18 + TypeScript
- **构建工具**: electron-vite
- **关键约束**: pi-coding-agent 版本**锁定 0.83.0**，不追最新

---

## 🔒 强制约束 (MANDATORY)

### 1. pi-coding-agent 版本锁定
```
@earendil-works/pi-coding-agent: "0.83.0"  ← 不可更改
@earendil-works/pi-ai: "0.83.0"           ← 不可更改
```
任何 PR **不得** 升级这两个包的版本，除非有专项讨论和测试通过。

### 2. 进程安全边界
- **主进程** (`electron/`): 可直接 import pi-coding-agent、访问 Node.js API、使用 safeStorage
- **渲染进程** (`src/`): **禁止** 直接 import Electron 模块，只能通过 `window.electronAPI` (contextBridge)
- **preload** (`electron/preload.ts`): 唯一可以同时访问 Electron 和 DOM 的位置

### 3. 不可变数据原则
- 所有 state 变更必须创建新对象，禁止 in-place mutation
- React state 使用 `setState(prev => ({ ...prev, ... }))` 模式
- 主进程事件数据视为只读

### 4. Extension 系统规范
`pi-extension/` 中的扩展工厂必须遵守：
```typescript
// ✅ 正确: ExtensionFactory 是函数
const factory: ExtensionFactory = (pi) => {
  pi.on('tool_call', async (event) => { ... });
};

// ❌ 错误: 不是对象的 create() 方法
const factory = { create: () => ({ handlers: {...} }) };
```

---

## 🏗️ 项目结构

```
sep-client/
├── poc/                    # PoC 验证脚本 (本周目标)
│   ├── fake-gateway.ts     # OpenAI-compatible mock gateway
│   ├── 01-sdk-import.ts   # PoC ①: SDK import
│   ├── 02-provider.ts     # PoC ②: 动态token注入
│   ├── 03-tool-call-async.ts  # PoC ③: async tool_call
│   └── 04-failure.ts      # PoC ④: 失败态冒泡
├── electron/               # Electron 主进程
│   ├── main.ts            # 入口、BrowserWindow、IPC处理
│   ├── preload.ts         # contextBridge API暴露
│   ├── pi-host.ts         # pi session生命周期
│   └── credentials.ts     # safeStorage封装
├── pi-extension/           # SEP 扩展 (pi-coding-agent extensions)
│   ├── index.ts           # 组合导出 buildSepExtensions()
│   ├── guard.ts           # tool_call 权限拦截
│   └── provider.ts        # before_provider_headers 动态token
├── src/                   # React 渲染进程
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx
│   └── shared/types.ts    # 主进程和渲染进程共享类型
└── scripts/               # 构建辅助脚本
```

---

## 🔑 核心 API 快速参考

### ExtensionFactory 模式
```typescript
import type { ExtensionFactory, ToolCallEvent, ToolCallEventResult,
  BeforeProviderHeadersEvent } from '@earendil-works/pi-coding-agent';

const myExtension: ExtensionFactory = (pi) => {
  // 动态 token 注入
  pi.on('before_provider_headers', async (event: BeforeProviderHeadersEvent) => {
    event.headers['authorization'] = await getToken(); // 返回值忽略，mutate in place
  });

  // 异步工具拦截
  pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
    const approved = await showDialog(event);
    return { block: !approved };
  });
};
```

### ModelRuntime 注册 provider
```typescript
const modelRuntime = await ModelRuntime.create({ modelsPath: null });

modelRuntime.registerProvider('sep-gateway', {
  name: 'SEP Gateway',
  baseUrl: process.env['SEP_GATEWAY_URL'],
  apiKey: 'placeholder',          // 被 before_provider_headers 覆盖
  api: 'openai-completions',
  models: [{
    id: 'sep-employee',
    name: 'SEP Employee',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  }],
});

const model = modelRuntime.getModel('sep-gateway', 'sep-employee');
// model 可能为 undefined，需检查
```

### Session 生命周期
```typescript
const session = await createAgentSession({
  modelRuntime,
  model,
  resourceLoader: new DefaultResourceLoader({
    extensionFactories: buildSepExtensions(config),
    noSkills: true,      // 禁用内置 skills
    noContextFiles: true, // 禁用 .pi 上下文文件
  }),
  sessionManager: SessionManager.inMemory(),
});

// 监听事件
session.on('agent_settled', () => { /* 本轮结束 */ });
session.on('agent_end', (e) => { /* 每次 LLM 调用结束 */ });

// 发送 prompt
session.prompt('user message');
```

### IPC 通信规范 (main ↔ renderer)
```typescript
// main.ts — 注册 handler
ipcMain.handle('pi:send-prompt', async (_event, text: string) => {
  piHost.sendPrompt(text);
  return { ok: true };
});

// preload.ts — 暴露给 renderer
contextBridge.exposeInMainWorld('electronAPI', {
  sendPrompt: (text: string) => ipcRenderer.invoke('pi:send-prompt', text),
});

// src/App.tsx — renderer 调用
await window.electronAPI.sendPrompt('hello');
```

---

## 📋 开发工作流

### 本周优先级：PoC 验证
```bash
npm run poc:01  # PoC ① SDK import
npm run poc:02  # PoC ② Provider + 动态token
npm run poc:03  # PoC ③ async tool_call
npm run poc:04  # PoC ④ 失败态冒泡
```
**全部通过后**再开始 UI 开发。任一失败需停下来重新讨论方案。

### 日常开发命令
```bash
npm run dev        # electron-vite 开发模式 (hot reload)
npm run build      # 构建生产版本
npm run typecheck  # TypeScript 类型检查 (主进程 + 渲染进程)
npm run lint       # ESLint 检查
```

### 调试 PoC
```bash
# 启动 fake gateway (可选，PoC 脚本自带内嵌服务器)
npm run poc:gw

# 手动测试 gateway 模式切换
curl -X POST http://localhost:9999/control -H "Content-Type: application/json" \
  -d '{"mode":"401"}'

# 查看捕获的 Authorization headers
curl http://localhost:9999/log
```

---

## 🔐 安全规范

### Credentials 管理
- Refresh token **必须** 通过 `electron.safeStorage` 加密存储
- **禁止** 在日志、console、事件数据中打印 token 的完整内容
- Token 仅在 `electron/credentials.ts` 和 `electron/pi-host.ts` 中处理
- 渲染进程**不可见**任何 token 值

### 工具审批
- 所有 `bash`、`write`、`edit` 工具调用**必须**经过用户确认
- 默认策略：未知工具 → block (在 `pi-extension/guard.ts` 中实现)
- 审批超时：60 秒未响应则自动拒绝

### IPC 安全
- `contextBridge.exposeInMainWorld` 只暴露必要的方法
- renderer 传入的所有参数在 main 进程中需验证类型
- **禁止** `nodeIntegration: true`

---

## ⚙️ TypeScript 规范

### tsconfig 分层
- `tsconfig.node.json` — 主进程 (electron/ + pi-extension/ + poc/ + scripts/)
- `tsconfig.web.json` — 渲染进程 (src/)
- `tsconfig.json` — 根，引用两者

### 类型导入规范
```typescript
// 从 pi-coding-agent 导入 (主进程 / pi-extension / poc)
import type { ExtensionFactory, ToolCallEvent, ToolCallEventResult,
  BeforeProviderHeadersEvent, ModelRuntime } from '@earendil-works/pi-coding-agent';

// 从 pi-ai 导入 (仅 poc 测试工具)
import { fauxProvider, fauxAssistantMessage, fauxToolCall }
  from '@earendil-works/pi-ai';

// 共享类型 (主进程和渲染进程均可用)
import type { PiClientEvent } from '@shared/types';
// tsconfig.node.json paths: "@shared/*" → "./src/shared/*"
// tsconfig.web.json  paths: "@/*"       → "./src/*"
```

### 文件大小限制
- 单文件 **≤ 400 行** (扩展至 600 行需注释说明原因)
- 函数体 **≤ 50 行**

---

## 🧪 测试策略

### PoC 脚本 (poc/)
- 每个 PoC 脚本是独立的 Node.js 程序，`process.exit(0)` 表示通过
- 使用内嵌 HTTP server（`node:http`）或 `fauxProvider`，不依赖外部服务
- 超时设置：单个 prompt 最多等待 30 秒

### 单元测试 (暂缓，PoC 阶段后实施)
- 目录：`__tests__/`
- 框架：vitest
- 覆盖率目标：80%

---

## 🚫 常见错误防止

| 错误 | 正确做法 |
|------|---------|
| `pi.on("tool_call", async handler)` 返回值被忽略 | handler 必须显式 `return { block: false/true }` |
| `event.headers.authorization = token` | 必须是 `event.headers['authorization']` (字符串键) |
| `modelRuntime.getModel(id)` 单参数 | 必须两参数: `getModel('providerId', 'modelId')` |
| renderer 直接 `import { ipcRenderer }` | 只能通过 `window.electronAPI.*` 调用 |
| `session.prompt()` 后不等待完成 | 监听 `agent_settled` 事件 |
| 升级 pi-coding-agent 版本 | 版本锁定 0.83.0，不得随意升级 |

---

## 📚 参考资料

- `docs/对接/SEP客户端-项目交接文档.md` — 架构设计、技术选型、4个PoC说明
- `docs/plans/项目升级开发顺序方案v3.md` — §8.5 开发顺序建议
- `README.md` — 快速开始指南
- pi-coding-agent 类型定义: `node_modules/@earendil-works/pi-coding-agent/dist/`
