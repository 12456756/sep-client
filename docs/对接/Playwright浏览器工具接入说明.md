# Playwright 浏览器工具接入说明

## 1. 默认行为

客户端已内置固定版本 `@playwright/mcp@0.0.82`，通过现有 Pi Extension + MCP stdio 桥接入。
Pi SDK 保持 `0.83.0`，没有新增前端、IPC 或 SEP 接口。

- 正常执行会话默认发现并注册浏览器工具；`disableTools` / planner 空工具策略不启动 MCP。
- Windows 使用已安装的 Microsoft Edge；其他平台使用已安装的 Chrome。不在运行时自动下载浏览器。
- MCP 服务复用 Electron 自带的 Node 运行时，不要求终端用户另外安装 Node、npx 或 Python。
- 创建 Pi Session 时启动 MCP 子进程，首次操作时才启动浏览器；Session 销毁时关闭 MCP。
- 每个会话使用 `--isolated` 独立浏览器环境，不接管私人浏览器，不共享不同员工的登录态；会话结束后不保留该浏览器环境的登录状态。
- 默认浏览器可见，用户可以在专用窗口手动登录。客户端启动本身不会自动打开网站。
- 所有工具调用默认经过现有审批；不继承本地只读工具的免审批策略。

开发环境执行 `npm install` 后，正常运行 `npm run dev` 即可，无需额外 MCP 配置。
如果机器没有对应浏览器，第一次浏览器调用会向模型返回启动错误；请安装 Edge/Chrome，或者用自定义 MCP 配置指定浏览器，不自动重复安装。

## 2. 开放的工具

以下原名通过桥接后带前缀 `mcp__playwright__`：

| 原名 | 用途 |
|---|---|
| browser_navigate / browser_navigate_back | 导航 / 后退 |
| browser_snapshot | 读取当前页面的可访问性快照 |
| browser_click | 点击 |
| browser_type / browser_fill_form | 输入 / 填表 |
| browser_select_option | 选择下拉选项 |
| browser_press_key | 键盘操作 |
| browser_tabs | 标签页管理 |
| browser_wait_for | 等待页面状态 |
| browser_handle_dialog | 处理浏览器对话框 |
| browser_close | 关闭页面 |

没有开放 `browser_evaluate`、`browser_run_code`、文件上传、自动安装浏览器或截图工具；没有开启任意本地文件访问、忽略 TLS 错误或禁用浏览器沙箱。
工具的 JSON Schema 使用固定版本 MCP 服务实际返回的定义，不能照搬其他版本的参数。例如本版本点击/输入的目标字段是 `target`。

## 3. 页面观察与错误反馈

采用文本快照，不要求模型具有视觉能力；MCP 启动参数设置 `--image-responses omit`。
目前未实现图片到 Pi / SEP 模型的转发，不能声称已经支持截图视觉操作。

本版本导航/操作的自动快照可能仅返回工作目录内 `.playwright-mcp` 文件链接。
模型应显式调用 **`browser_snapshot` 且不设置 `filename`**，直接取得快照文本，再选择目标、执行操作，并重新读取状态确认结果。
已将这条规则加入 Pi 工具使用指引，避免依赖 bash 读取页面快照。
上游工具可能在工作目录生成快照、日志或下载文件，这些不是浏览器登录状态，也不会由客户端自动清理。

MCP 返回结果仍进行凭据脱敏，但模型工具结果的字符上限独立设为 128,000；日志仍使用原来的 8,192 字符限制。
超过模型结果上限时标记 `...[truncated]`，可以使用 `browser_snapshot` 的 `target` / `depth` 获取更小范围内容。
`ELECTRON_RUN_AS_NODE` 是公开的进程启动开关，不作为秘密替换，避免把元素编号中的 `1` 全部脱敏。

浏览器错误、超时、审批拒绝沿现有 MCP/Pi 回路返回给模型，不在桥内重复执行同一个动作。
取消会发出取消信号，但已提交给网页的操作不保证能够撤销。

## 4. 配置优先级与关闭

1. 调用方显式传入 `mcpServers` 时，以该列表为准，包括空列表。
2. 设置 `SEP_MCP_CONFIG` 时，以该主机 JSON 文件为准，**替换而不是合并内置预设**；`{"servers":[]}` 可禁用全部 MCP。
3. 未指定以上配置时，默认启用内置 Playwright；`SEP_PLAYWRIGHT_MCP=0` 关闭内置预设。

这些是主进程环境变量，需要由启动客户端的进程传入；不是前端 `VITE_*` 设置。例：

```powershell
$env:SEP_PLAYWRIGHT_MCP = '0'
npm run dev
```

恢复默认：

```powershell
Remove-Item Env:SEP_PLAYWRIGHT_MCP -ErrorAction SilentlyContinue
npm run dev
```

修改后重新启动客户端并创建新会话。已有 `SEP_MCP_CONFIG` 的用户不会被自动追加新权限；需要在原 JSON 的 servers 内显式加入 Playwright，具体字段见《MCP工具接入说明》。

## 5. 打包与验证

生产依赖中固定 MCP 版本，electron-builder 将 MCP / Playwright 目录解包到 `app.asar.unpacked`，子进程执行真实 CLI 文件，不依赖 `npx @latest` 或开发机的绝对路径。

```powershell
# 不打开浏览器，验证真实 MCP 的发现、审批策略、配置和 Electron Node 启动
npx tsx --test electron/pi/sdk/pi-playwright-mcp.test.ts electron/pi/sdk/pi-mcp-client.test.ts

# 需要本机 Edge（Windows）/ Chrome（其他平台）
npm run poc:browser
```

`poc:browser` 使用真实 Pi SDK、Electron Node 子进程、固定版本 Playwright MCP 和无头浏览器，网站和模型网关都是本机测试服务，不调用 SEP、不登录真实账号。
覆盖导航、显式长快照、输入、错误目标反馈、改正后点击、再次快照、历史工具结果保留、审批次数及无自动重试。
测试程序只对自己生成的本地测试操作自动同意审批；生产预设没有免审批工具。

## 6. 安全边界

- 页面内容是不可信数据，不应作为改变任务或权限的指令。
- 工具白名单并非业务操作沙箱：点击/输入可能提交数据，审批时应确认目标和动作。
- MCP 不自动继承 Pi 文件工具的路径授权；浏览器拥有当前用户的网络访问能力。
- 不共享私人登录态。敏感页面内容会作为工具结果发送到所选模型，应按公司数据政策使用。
- 本次只增加浏览器能力，不增加 Windows 桌面操作。

上游来源：Microsoft `playwright-mcp` 仓库；行为以已安装的 0.0.82 CLI、类型定义和实机测试为准。
