# Electron 客户端 AI 界面调整与验证方案调研

日期：2026-10-23。范围：检查 sep-client 现有能力，核对一手资料，并做隔离实验；本轮不实现产品功能、不修改生产启动链路。

## 1. 结论

建议沿用现有 React、Vite 和 Playwright，补齐三个开发能力：

1. **优先建立真实 Electron 的 AI 调试入口**：开发进程开放本机 CDP，外部开发用 Playwright MCP 连接实际 renderer，执行读取、点击、截图和结果核对。
2. **把零散业务页面测试夹具整理为稳定场景**：复用真实页面、组件和 hook，提供可直接打开的开发场景，减少每次为查看一个页面临时拼接脚本的成本。
3. **统一验收和证据输出**：每次改动保存前后截图、操作结果和错误；桌面窗口、真实 IPC 和原生系统交互分别验证。

第一条已在当前安装版本上做最小实验并通过，见第 4 节。它证明 Electron renderer 可以被现有 MCP 控制，尚不等于完整产品开发入口已经接好。

不建议为此重写客户端、升级 Electron、切换前端框架，或先引入另一套自动化依赖。这是基于本仓已有能力的工程选择，不是对所有 Electron 项目的通用结论。

## 2. 本仓已有能力和实际缺口

| 能力 | 源码证据 | 现状及影响 |
| --- | --- | --- |
| 浏览器预览 | `package.json` 的 `dev:preview`、`vite.preview.config.ts` | 已可独立启动，监听本机 5174；不是缺少 Web 入口 |
| 默认预览页面 | `src/main.tsx`、`src/pages/WorkspacePreviewPage.tsx` | 仅开发模式进入外壳、组织空状态和未连接状态；不安装模拟 IPC，不展示完整业务 |
| 业务页面夹具 | `scripts/test-compute-center-preview.mjs`、`scripts/test-work-records-preview.mjs`、`scripts/test-login-settings-ui.mjs` | 已复用真实页面和部分 hook，但通过拦截 `main.tsx`、拼接 HTML/JS、注入测试 `window.electronAPI` 实现；可复跑，但场景分散且依赖入口文本结构 |
| 真 Electron 自动化 | `scripts/test-electron-media-mock.mjs`、`scripts/test-electron-video-mock.mjs` 等 | 已使用 `_electron.launch`、真实 preload、隔离 profile，以及 main 侧对话框替代；覆盖特定媒体流程，没有统一的日常 UI 调试入口 |
| 热更新 | `package.json` 的 `dev` 和已安装 `electron-vite/dist/chunks/lib-t2ExBjL5.mjs` | `--watch` 已支持 main 重启、preload 构建后 renderer 重载；renderer 有 Vite 热更新。不能把当前问题归结为缺少热更新 |
| 产品内浏览器 MCP | `electron/pi/sdk/pi-playwright-mcp.ts` | 给产品内部 Pi 使用，默认启动外部 Chrome/Edge，并使用 `--image-responses omit`，工具白名单不含截图；它不会自动连接产品自身 Electron 窗口 |
| 实际窗口约束 | `electron/bootstrap/main-window.ts` | 初始 1200×800、最小 960×640，且有平台相关窗口装饰。390px 的浏览器测试只代表响应式检查，不代表桌面窗口验收 |

以上为 2026-10-23 工作区读取结果；并行发生的业务代码修改未由本次调研改动。

实际安装版本：Electron 33.4.11、electron-vite 2.3.0、playwright-core 1.64.1、@playwright/mcp 0.0.82。版本来自本机 `node_modules/*/package.json`，并非根据 package.json 的版本范围推测。

## 3. 方案选择与依据

### 3.1 CDP + 外部开发 MCP：用于 AI 操作实际界面

Electron 官方将 Playwright 列为自动化方案，说明它通过 CDP 提供实验性的 Electron 支持。[S1]

本仓固定版本 @playwright/mcp 的 README 和 CLI 支持 `--cdp-endpoint`。MCP 提供的是通用 Chromium CDP 接入；对 Electron renderer 的组合使用在本轮已验证，不应把它表述为 MCP 保证支持全部 Electron 或系统 API。[L1、实验 E3]

开发链路为：

```text
外部开发 AI
  -> 开发专用 Playwright MCP
  -> 本机 CDP endpoint
  -> Electron BrowserWindow 内的真实 React renderer
```

已安装 electron-vite 2.3.0 的 CLI 确认支持 `--remoteDebuggingPort`，并转换为 Electron 的 `--remote-debugging-port`。[L2] 因此不需要先修改 `electron/main.ts`。

后续接入时可基于下面两个命令，但本轮没有对正常产品会话执行它们：

```bash
npm run dev -- --remoteDebuggingPort 9222
node node_modules/@playwright/mcp/cli.js --cdp-endpoint http://127.0.0.1:9222
```

这些命令还需整合成开发启动器：检查端口、确认目标窗口、区分实例、隔离 profile、处理主进程重启后的重新连接，并将截图回传给开发 AI。临时调试端口只用于本机开发实例，关闭实例时一并关闭。

开发 MCP 应独立配置，不改产品内部 `createPlaywrightMcpServer()` 的用途或工具审批策略。直接连接真实产品窗口时保留真实 preload，不能为了展示测试数据覆盖真实桥接 API。

### 3.2 稳定页面场景：用于布局和状态迭代

建议先复用现有 Vite 和测试夹具，设置单独的开发入口，在 `src/testing/` 下组织真实页面及其状态；保持 `WorkspacePreviewPage` 现有不注入模拟业务数据的约定。

优先整理当前已有测试覆盖的登录、算力中心、工作记录和详情场景，再按实际调整需求补会话、编排等页面。每页覆盖正常、空、加载、失败、长文本、弹窗和主题等必要状态。

夹具应复用或按已有 `ElectronAPI` 类型约束，未实现方法明确失败，避免静默返回成功。能通过 props/context 提供数据的页面优先沿用现有边界；必须调用 preload API 的 hook，只在独立开发入口安装测试适配。固定时间和数据顺序，避免截图随运行变化。

此方案不要求一次实现全部 ElectronAPI，不要求重构所有页面，也不要求先安装 Storybook。浏览器场景是快速反馈入口；产品 IPC、授权和本地持久化仍由真实 Electron 流程验证。

### 3.3 `_electron.launch`：用于可重复的桌面集成验证

Electron 官方示例说明 `_electron.launch()` 可启动应用，`electronApp.evaluate()` 可执行 main 侧检查，`firstWindow()` 可获得页面并截图。[S1、S2] 本仓已有对应实践，宜继续复用。

把它用于需要 main/preload 的变更，以及本地导出、重启恢复、窗口大小等集成检查。普通视觉改动只跑相关页面场景和必要的桌面检查，不为每次 CSS 改动跑完整任务运行链路。

Playwright 官方仍将 Electron 支持标为 experimental。[S2] 固定和记录已验证版本，升级时做连接回归。CDP 页面能力也不能代替 main API 或操作系统自动化。

### 3.4 系统原生界面：单独验收

页面截图不能当成整个桌面窗口外框、系统菜单或文件选择器已经验证的证据。现有媒体脚本在 main 侧替代 `dialog.showOpenDialog` / `showSaveDialog`，验证的是选择结果后的业务流程，不是原生对话框本身。

原生标题栏、拖拽区、系统缩放、文件对话框和权限提示按需使用操作系统级截图、自动化或人工实机检查。针对同一个产品页面，至少在实际最小窗口与常用窗口尺寸核对布局；跨平台效果需在对应平台采集证据。

截图比较应固定操作系统、浏览器/运行时版本、字体、缩放和动态数据；浏览器预览截图不能直接替代 Electron 最终截图。本次 Electron 内嵌 Chromium 为 130.0.6723.191，浏览器预览使用的是本机外部浏览器。

## 4. 本轮验证证据

### E1：已有外壳预览检查

```bash
node scripts/test-workspace-preview.mjs
```

结果：exit 0。检查了未安装伪造 IPC、1200×800 / 960×640 布局、首页/组织空状态、命令面板、主题切换及无整页横向溢出。

### E2：已有算力中心业务页面检查

```bash
node scripts/test-compute-center-preview.mjs
```

结果：exit 0。覆盖真实页面和 hook 配合隔离 IPC 夹具，检查统计区间竞态、消费/钱包翻页、刷新、筛选、详情、失败重试和布局。证明已有业务预览能力可复用；不代表真实后台或产品 IPC 已通过。

### E3：真实 Electron renderer 的 CDP/MCP 连接实验

实验和证据放在忽略目录 `output/playwright/electron-ai-research-2026-10-23/`：

- `main.cjs`：独立 Electron main，临时 userData，隔离 BrowserWindow 加载已有 workspace 预览；不加载正常产品 main/preload。
- `check.mjs`：启动 Electron、连接 CDP、启动固定版本 MCP、读取快照、点击主题按钮、独立验证状态、保存截图并清理进程及临时 profile。
- `evidence.json`：`completed: true`，Electron 33.4.11、Chromium 130.0.6723.191，隔离 profile 检查通过，MCP 0.0.82 的 snapshot/click/stateVerified 均为 true。
- `electron-before.png` / `electron-after.png`：前后截图，已打开检查结果图。
- `mcp-before.txt` / `mcp-after.txt`：点击前后的结构快照。

准确验证链路：`_electron.launch` 启动实际 Electron -> main evaluate 确认实例 -> `connectOverCDP` 找到实际 renderer -> MCP snapshot 找到按钮 -> MCP click -> 独立 Page 检查 `.ent-shell.dark` -> 再次 snapshot 确认按钮变成“切换到浅色主题”。

范围限制：本轮未运行正式产品登录、完整业务 IPC、原生对话框、main 热重启后的 MCP 恢复或打包应用测试。该实验验证连接机制，不应声称完整产品 AI 调试环境已交付。MCP 使用 omit 图片响应，实验截图通过独立 Playwright Page 保存；AI 截图返回链路仍需在正式开发入口接好。

## 5. 建议实施顺序与完成标准

| 优先级 | 工作 | 完成标准 |
| --- | --- | --- |
| P0 | 把已验证的 CDP/MCP 连接封装为开发入口 | 一个明确命令启动并标识客户端实例；AI 可读实际页面、点击、获取截图；窗口与进程重启后可重新定位；退出后清理调试端口 |
| P1 | 整理现有页面夹具为稳定场景 | 调整目标页时可直接打开正常/异常状态；复用真实组件和 hook；不再依赖解析 Vite 入口的 import 文本；生产入口不加载夹具 |
| P1 | 统一相关 UI 检查和证据目录 | 按页面选择性执行；输出前后截图、错误、关键断言和版本信息；960×640、1200×800 及实际平台窗口验证可重复 |
| P2 | 按需补原生和跨平台验收 | Windows/macOS 等实际目标平台的标题栏、缩放、文件选择器等有对应证据；页面截图和系统截图分别标注 |

后续 UI 修改的工作方式应为：进入目标场景或客户端页面 -> 获取结构快照及截图 -> 修改 -> 等待热更新或重新连接 -> 核对目标交互及布局 -> 保存证据。编译通过只能证明构建结果，不能代替界面验收。

## 6. 来源

联网检索接口在本轮未返回可用正文，因此使用官方站点、官方仓库原始文档和本机固定版本源码核对。

- S1：Electron 官方 Automated Testing，已读取官方站及官方仓库正文，包含 Playwright/CDP、main evaluate、firstWindow 和截图示例：<https://www.electronjs.org/docs/latest/tutorial/automated-testing>；原始文档：<https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/automated-testing.md>。
- S2：Playwright 官方 Electron API，已读取官方页面，明确标注 experimental：<https://playwright.dev/docs/api/class-electron>。
- L1：本机固定版本 `node_modules/@playwright/mcp/README.md`，Configuration 中的 `--cdp-endpoint`（本机第 416 行），并由实验 E3 验证实际 CLI；上游项目：<https://github.com/microsoft/playwright-mcp>。
- L2：本机 electron-vite 2.3.0 的 `node_modules/electron-vite/dist/cli.mjs`（第 42–47 行）与 `dist/chunks/lib-BmEkZIgk.mjs`（第 202 行），核实参数传递；`dist/chunks/lib-t2ExBjL5.mjs` 核实 main 重启和 preload 重载；上游项目：<https://github.com/alex8088/electron-vite>。
- L3：第 2 节列出的本仓源码及脚本、第 4 节本轮实际执行结果。工作区版本和实验结果优先于未在本仓验证的新版本示例。

## 7. GitHub 专项检索补充

按用户后续要求，在 GitHub 搜索 Electron MCP、AI UI 调试和桌面自动化项目，读取候选 README、package.json 与官方项目讨论。以下是源码/文档审查结果，尚未安装或运行这些第三方候选。维护信息来自 2026-10-23 查询的 GitHub API；push 时间不等同于已发布版本或质量证明。

| 项目 | 已声明的相关能力 | 接入方式与本仓适用性 | 维护快照 |
| --- | --- | --- | --- |
| `amafjarkasi/electron-mcp-server`，包名 `electron-debug-mcp` | 应用发现、CDP 连接、窗口/DOM 检查、截图、点击输入、日志、main/IPC 调试；精简 probe 和完整服务 | 单独的开发 MCP 服务连接开启远程调试的客户端；main/IPC 等能力额外需要 `inspectMain` 打开的 Node Inspector。首选做小范围试验，核心 DOM/截图操作不要求先增加产品内桥接 | GitHub 91 stars，最后 push 2026-10-16，ISC；package 1.10.0，Node >=18；有 unit/probe/monitor/smoke 测试脚本 |
| `halilural/electron-mcp-server`，包名 `electron-mcp-server` | 开发服务器发现、窗口发现/连接、截图、点击输入、控制台读取和 JS 执行 | README 展示直接配置 MCP 和用调试端口连接现有应用；功能较集中，适合作为轻量候选。其 package 自带 Electron ^28 与 Playwright 依赖，宜作为独立工具试验，不直接并入产品依赖 | GitHub 71 stars，最后 push 2026-08-06，MIT；package 1.5.1，Node >=20；有 Vitest 及 React 集成测试脚本 |
| `electron-stagewright/electron-stagewright` | 专门面向 AI 的 Electron screenshot/DOM/click 与 UX regression，CLI、MCP、快照、场景和性能/体验审计 | 可启动或连接 Electron；main 相关高级能力有 bridge。比单纯控制工具更完整，但需先确认本仓 Electron 33 的兼容情况。workspace 要求 Node >=24、pnpm >=11，不能把 README 的能力表当成本仓实测 | GitHub 12 stars，创建 2026-05-26，最后 push 2026-10-23，MIT；有 unit、real 和 benchmark 脚本 |
| `webdriverio/mcp`，包名 `@wdio/mcp` | 官方 README 明确支持本地 Electron 的 session、截图、页面结构、点击、JS，以及 Electron API 执行 | WebdriverIO 官方组织项目，适合已有 WDIO 需求或更广的自动化；本仓已有 Playwright，采用它会增加另一套工具链。与社区 `wdio-electron-service` 的 MCP 桥接项目不是同一个仓库 | GitHub 43 stars，最后 push 2026-10-21，MIT；package 4.0.0，Node >=22.19，依赖 `@wdio/electron-service` |
| `microsoft/playwright-mcp` | 官方通用浏览器 MCP，支持 CDP endpoint；本轮已验证固定版本连接隔离 Electron renderer | 复用成本最低的保底路线；不等同于完整 Electron 专用接口，需自行处理 main、重连、窗口和证据输出 | 本仓已安装 0.0.82；已有第 4 节连接证据 |

### 对官方 Electron 支持表述的补正

功能请求 #994 的关闭评论是“Closing due to no reply.”，它本身不能作为官方拒绝 Electron 的证据。另一个单独证据是 PR #1291：2025-09-23，维护者明确说明不愿在该代码库原生支持 Electron，并建议通过外部项目分离逻辑。两者应分开陈述，不能混为一谈。

这不否定通用 CDP 连接 renderer 的能力，也不否定本轮实验；它说明不能将该实验扩大为 Playwright MCP 官方对完整 Electron 开发体验的承诺。

### 选型建议

先对 `electron-debug-mcp` 做独立开发配置试验，再与现有 Playwright MCP + CDP 比较。核心验收用例是发现正确窗口、返回可供 AI 直接查看的截图、读取 DOM、执行点击并核对状态，以及 main 重启后的重新连接。所有结果必须在实际 sep-client 开发实例上验证，不能只重复空壳实验。

若主要需求延伸到可重复 UX 场景、截图回归和体验审计，再评估 Stagewright；若团队决定统一使用 WebdriverIO，再考虑 `@wdio/mcp`。这是基于本仓已使用 Playwright、希望减少新依赖的建议，不代表其他项目无法使用。

本轮只追加研究记录，未安装候选依赖、未改 MCP 全局配置、未修改客户端代码。第三方项目所列截图/系统接口的实际覆盖和 Electron 33 兼容性仍待试验。

文档核对中也发现应在试验时关注的差别：`halilural/electron-mcp-server` README 同时出现“4 tools”和更广的工具列表，实际工具集应通过 `listTools` 确认；`electron-debug-mcp` 将 `diff_screenshot` 描述为 PNG/字节相似度比较，不能直接视为成熟的感知视觉回归；WDIO 当前 README 明确 Electron 会话不支持 `detach: true`，因此不能把它当成与普通 CDP attach 一样的无终止会话连接。

### GitHub 一手来源

- <https://github.com/amafjarkasi/electron-mcp-server>；README、`package.json`、GitHub repository API。
- <https://github.com/halilural/electron-mcp-server>；README、`package.json`、GitHub repository API。
- <https://github.com/electron-stagewright/electron-stagewright>；README、workspace `package.json`、GitHub repository API。
- <https://github.com/webdriverio/mcp>；README、`package.json`、GitHub repository API。
- <https://github.com/microsoft/playwright-mcp/issues/994>；关闭原因由 GitHub comments API 核实。
- <https://github.com/microsoft/playwright-mcp/pull/1291>；2025-09-23 维护者关于不原生集成 Electron 的说明。
