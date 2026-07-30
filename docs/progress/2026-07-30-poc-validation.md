# 2026-07-30 — PoC 验证完成

## 今日完成

### 1. 项目初始化 ✅

- 初始化 git 仓库，关联 `https://github.com/yaoruiquan/sep-client`
- 创建项目骨架：`electron/`, `pi-extension/`, `src/`, `poc/`
- 配置 TypeScript（主进程 + 渲染进程分离）
- 添加 `"type": "module"` 启用 ESM

### 2. 4 个 PoC 全部通过 ✅

| PoC | 验证目标 | 状态 | 关键发现 |
|-----|---------|------|---------|
| ① | SDK import + createAgentSession | ✅ PASS | 返回值需解构 `{ session }` |
| ② | before_provider_headers 动态 token | ✅ PASS | 需调用 `resourceLoader.reload()` |
| ③ | async tool_call 拦截 | ✅ PASS | handler 能正常 await 200ms |
| ④ | 401 错误冒泡 | ✅ PASS | agent_end 事件正确触发 |

**关键 API 修正**（原文档有误，已更新到 CLAUDE.md）：

1. `createAgentSession` 返回 `{ session, extensionsResult }` — 需解构
2. `DefaultResourceLoader` 必须传 `cwd`/`agentDir`，且必须 `await reload()`
3. `session.on()` 不存在 → 用 `session.subscribe(listener)`

### 3. 文档编写 ✅

- 重写 `CLAUDE.md`（对齐 SEP 项目风格，去掉 emoji，表格驱动，包含 API 修正）
- 创建 `docs/对接/开发交接文档.md`（当前状态、PoC 结果、下一步计划）
- 创建 `docs/README.md`（文档目录索引）
- 按 SEP 项目结构组织 docs 目录：`architecture/`, `plans/`, `progress/`, `research/`, `status/`, `对接/`

### 4. 代码结构

```
sep-client/
├── electron/         主进程（BrowserWindow, IPC, pi-host, credentials）
├── pi-extension/     SEP 扩展（guard, provider）
├── src/              React 渲染进程
├── poc/              验证脚本（已全部通过，保留作回归测试）
└── docs/
    ├── 对接/         开发交接文档.md
    ├── progress/     本文件
    └── README.md
```

## 遇到的问题

### 1. tsx + pi-coding-agent ESM 兼容

**问题**: 初次运行 `npm run poc:01` 报错 `ERR_PACKAGE_PATH_NOT_EXPORTED`

**原因**: 
- `pi-coding-agent` package.json 有 `"type": "module"`
- 项目 package.json 缺少 `"type": "module"`
- tsconfig.node.json 用了 `moduleResolution: "bundler"`（tsx 不支持）

**解决**:
- 项目 package.json 添加 `"type": "module"`
- tsconfig.node.json 改用 `"moduleResolution": "node"`

### 2. DefaultResourceLoader 构造参数

**问题**: `TypeError: Cannot read properties of undefined (reading 'startsWith')`

**原因**: 构造函数没传 `cwd` 参数，内部 `normalizePath` 崩溃

**解决**: 必须传 `cwd: process.cwd()` 和 `agentDir: '.pi'`

### 3. Extension 不生效

**问题**: PoC ② 中 `before_provider_headers` 事件没有触发，token 没有被替换

**原因**: `resourceLoader` 构造后没有调用 `reload()`，extensions 不会被加载

**解决**: 在 `createAgentSession` 之前显式调用 `await resourceLoader.reload()`

## 下一步计划

### Phase 1 — 核心 UI（本周）

1. **登录流程** — OAuth 集成、refresh token 持久化（safeStorage）
2. **会话界面** — 启动 pi session、发送 prompt、流式显示输出
3. **工具审批** — 拦截 tool_call、渲染审批弹窗、返回用户决策

### Phase 2 — 完善体验

4. 多轮对话历史
5. 401 自动刷新 token
6. 设置页（Gateway URL、连接状态）

### Phase 3 — 发版

7. electron-builder 打包
8. 自动更新

## Commits

```
3e687ac chore: initial project skeleton with 4 PoC scripts
30ffed0 docs: rewrite CLAUDE.md; add 开发交接文档
<pending> docs: restructure docs/ to match SEP project layout
```
