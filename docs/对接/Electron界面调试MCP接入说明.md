# Electron 界面调试 MCP 接入说明

验证日期：2026-10-23。工具为 `amafjarkasi/electron-mcp-server` 发布的
`electron-debug-mcp@1.10.0`，连接真实 sep-client 开发应用。

## 启动与连接

在仓库根目录运行：

```sh
npm run mcp:electron-debug:install
npm run dev:debug
```

`dev:debug` 使用原有 Electron main、preload 和 React App，开启页面调试端口 9333
与主进程 inspector 9334。两者只用于本机开发。
9222 在本机被 Chrome 占用，因此单独使用 9333。端口被占用时先确认进程归属。

项目 `.codex/config.toml` 已配置 `electron-debug` MCP。重新加载项目 MCP
或开启新的 Codex 会话后，调用 `attach`：

```json
{"debugPort":9333,"name":"sep-client"}
```

后续操作使用返回的 `id` 作为 `processId`，从返回的 `targets` 中选择实际
`http://localhost:5173/` 页面，将其 `id` 作为 `targetId`。Vite 端口可能自动递增，
应以实际目标为准。主进程重启后重新 `attach` 并获取目标 ID。
`stop_app` 对 attach 的应用只断开调试连接。

另用 `attach {"debugPort":9334}` 连接主进程，使用该连接的 `processId`
调用 `evaluate_main`。本项目主进程 inspector 中没有全局 `require`；可通过
`process.getBuiltinModule("module").createRequire(process.cwd()+"/package.json")("electron")`
取得 Electron API。验收脚本在截图前用它恢复、显示并聚焦实际窗口。

如需其他 MCP 客户端，设置工作目录为仓库根目录，启动：

```sh
node scripts/electron-debug-mcp.mjs
```

包装脚本固定工具版本，安装到已被 Git 忽略的
`output/electron-debug-mcp/tool/`，不修改根目录依赖和锁文件。
该版本 npm 包声明了未随包发布的 postinstall 脚本，因此直接 npx 安装在本机失败。
包装脚本使用 `--ignore-scripts --omit=optional`；attach 模式复用项目 Electron，
无需安装工具的可选 Electron。首次安装输出写入 stderr，保留 stdout 给 MCP JSON-RPC。

## 可重复验收

保持真实开发应用处于未登录页面、窗口可见且已激活，另开终端执行：

```sh
npm run test:electron-debug
```

自定义调试端口时，开发启动和验收需使用同一个端口：

```sh
npm run dev -- --remoteDebuggingPort 9335 --inspect 9336
SEP_ELECTRON_DEBUG_PORT=9335 SEP_ELECTRON_INSPECT_PORT=9336 npm run test:electron-debug
```

脚本通过同一个 MCP 包装入口执行以下操作：

| 项目 | 验证方式 |
| --- | --- |
| 真实应用 | 原 preload API、renderer 无 Node process、真实主进程 IPC 响应 |
| 截图 | 主进程恢复并聚焦真实窗口，确认 renderer 可见；MCP 返回 PNG image 内容，校验签名并保存 SHA-256 |
| 点击 | 实际 React「记住密码」复选框切换并恢复 |
| 页面弹层 | 有历史账号时打开实际账号列表，截图并用 Escape 关闭 |
| JS 对话框 | 注入无业务副作用的 confirm，通过 handle_dialog 取消 |
| CSS 热更新 | 临时添加无视觉影响的 CSS 自定义属性，检查 Vite 事件、计算样式及同一 document，再点击、截图 |
| 页面重载 | reload 后恢复真实 preload IPC 并截图 |
| 断开重连 | detach、重新 attach，确认同一目标仍可截图 |

每次结果保存在 `output/electron-debug-mcp/run-*/evidence.json`，
同目录有登录页、账号弹层、热更新后、重载后、重连后的 PNG。
2026-10-23 的完整通过记录：
`output/electron-debug-mcp/run-1792738840891/evidence.json`。

热更新探针会临时修改 `src/index.css`，结束或捕获错误时移除自己的标记；
不覆盖期间其他人的修改。验收期间避免同时修改该文件，以免恢复一致性检查失败。
未读取或显示明文密码，未登录或执行业务写操作；复选框状态会恢复。

## 已知范围与问题

- 实测 renderer 为 `hidden` 时，`Page.captureScreenshot` 多次超时，
  单独 `Page.bringToFront` 不能可靠恢复原生窗口。验收脚本改为通过主进程
  `restore/show/app.focus/window.focus` 后检查 renderer 可见，完整验收通过。
  手动调用 screenshot 时也需先激活窗口；没有主进程连接时用原生 UI 激活。
- `handle_dialog` 操作 JavaScript alert/confirm/prompt；系统文件选择器未在本轮验收。
  需要使用原生 UI 自动化补充，不能据此宣称全部系统弹窗可由 MCP 操作。
- 本轮验证 CSS HMR 和页面 reload。主进程被 electron-vite 重启会更换调试目标，
  需重新 attach，不保证旧 processId/targetId 自动恢复。
- 调试端口只用于本机开发；本次未修改生产主进程、preload、安全配置或构建依赖。
- 完整验收经过 MCP SDK 发起真实工具调用；当前 Codex 会话是否已重新加载新增 MCP
  配置，应以会话工具列表为准。
