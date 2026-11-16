# 客户端 CI 发布

`.github/workflows/client-release.yml` 只负责 SEP 客户端下载源，不部署 SEP 前端、后端或 Docker 镜像。

钉钉、飞书、企业微信采用独立组件分发。`scripts/connector-assets.mjs` 在 afterPack 中按锁定版本准备原生程序、许可证及钉钉资料包，输出到构建目录的 `connector-assets/`；安装包只包含 `connector-dependencies.json` 清单，不携带这三个 CLI。开发启动仍使用本地 npm 开发依赖。

Windows x64、macOS x64/arm64 构建的组件随平台产物合并，发布前由 `verify-connector-assets.mjs` 核对九个归档的大小及 SHA-256。上传脚本先将组件发布到 stable 下的 `connector-assets/`，校验后才发布客户端更新清单。组件文件名包含内容哈希，旧组件需要长期保留供旧客户端首次使用；不要随客户端版本目录一起清理。手动发布也必须带上完整 `connector-assets/` 和 upload-plan 中的组件清单。

客户端第一次连接时只下载对应连接器组件，验证归档及各文件后写入用户目录的 `connector-runtime/<id>/<归档哈希>/`。列表查询和任务工具发现不下载；已有授权但缓存缺失时，在首次调用资料、契约或命令前补齐。下载支持进度、取消及重试，失败不执行命令。下载由 Electron 网络栈使用系统网络配置，不携带平台登录凭据。腾讯会议和 QQ 邮箱继续使用内置实现。Mac 本地包组件采用 ad hoc 签名，正式签名包的组件另行 Developer ID 签名和公证；Windows 正式签名包组件使用现有打包签名器。各系统真实下载、执行及公证仍需在发布验收中验证。

触发方式：

- 推送与 `package.json` 版本一致的 `v<version>` 或 `client-v<version>` 标签：构建、校验并进入生产发布环境。推荐使用 `v<version>`，例如 `v0.5.1`。
- GitHub Actions 手动运行：`publish=false` 时只构建和汇总包；`publish=true` 时进入生产发布环境。

流水线在 macOS runner 构建 macOS ARM64/x64 DMG 与 ZIP，在 Windows runner 构建 Windows x64 NSIS EXE；Ubuntu runner 汇总并强制校验 10 个安装包及 blockmap。发布阶段先上传版本目录，再远程校验 SHA256，最后更新 `latest.yml` 和 `latest-mac.yml`。

Windows 的 `npm ci` 使用 CMD，并在安装进程中清除继承的 `PSModulePath`。钉钉 CLI 的安装脚本会经 Node/CMD 启动 `powershell.exe`；清除后由 Windows PowerShell 构造系统模块路径，避免误加载 PowerShell 7 的 Archive 模块导致 `Expand-Archive` 失败。依赖安装脚本仍正常执行。

语音模型在验证、Windows 和 macOS 构建任务中使用 GitHub Actions 缓存；OfficeCLI 在 Windows 和 macOS 构建任务中缓存对应平台的程序，macOS 同时包含 ARM64 和 x64。缓存键由操作系统和对应 `manifest.json` 的哈希组成，不随客户端版本变化，也不回退匹配旧版本缓存。各平台始终按同一提交中的清单固定组件版本，缓存不包含清单、源码配置或签名凭据。

恢复缓存后仍执行 `speech:prepare` 和 `office:prepare`，核验大小与哈希；OfficeCLI 还会恢复所需执行权限。首次运行、缓存未命中或文件校验失败时才从固定版本的来源下载；打包前后仍保留原有完整性校验。缓存位于 GitHub，不会写入生产下载服务器，缓存被清理后可以重新下载。

在 GitHub Environment `sep-download-production` 配置以下 Secrets：

- `SEP_UPLOAD_SSH_KEY_BASE64`：访问华为云下载服务器的私钥文件内容经 Base64 编码后的单行文本
- `SEP_UPLOAD_KNOWN_HOSTS`：服务器的固定 SSH host key，禁止关闭 host key 校验
- `SEP_UPLOAD_HOST`：默认 `121.37.128.126`
- `SEP_UPLOAD_USER`：默认 `root`
- `SEP_UPLOAD_ROOT`：默认 `/www/sep/downloads/sep-client/stable`
- `SEP_UPLOAD_PORT`：默认 `22`

将与服务器 `authorized_keys` 匹配的私钥文件做 Base64 编码后，完整保存为 `SEP_UPLOAD_SSH_KEY_BASE64`（macOS/Linux 可运行 `base64 < ~/.ssh/sep_deploy | tr -d '\n'`）。这样可以避免 GitHub Secret 对私钥多行换行的转换导致 OpenSSH 报 `error in libcrypto`。`SEP_UPLOAD_KNOWN_HOSTS` 必须包含 `SEP_UPLOAD_HOST` 对应的完整 host key 行。发布器会在一次运行中为 `ssh` 和 `rsync` 使用同一份临时 SSH 配置，强制使用该私钥并启用 host key 校验。

发布 job 使用 GitHub Environment 审批。版本目录已存在时会拒绝覆盖；更新清单发布失败时会恢复旧清单。工作流不会执行 SEP 容器重启、镜像拉取或前端部署。
