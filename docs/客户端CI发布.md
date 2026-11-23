# 客户端 CI 发布

`.github/workflows/client-release.yml` 只负责 SEP 客户端下载源，不部署 SEP 前端、后端或 Docker 镜像。

钉钉、飞书、企业微信采用独立组件分发。`scripts/connector-assets.mjs` 在 afterPack 中按锁定版本准备原生程序、许可证及钉钉资料包，输出到构建目录的 `connector-assets/`；安装包只包含 `connector-dependencies.json` 清单，不携带这三个 CLI。开发启动仍使用本地 npm 开发依赖。

Windows x64、macOS x64/arm64 构建的组件随平台产物合并，发布前由 `verify-connector-assets.mjs` 核对九个归档的大小及 SHA-256。上传脚本先将组件发布到 stable 下的 `connector-assets/`，校验后才发布客户端更新清单。组件文件名包含内容哈希，旧组件需要长期保留供旧客户端首次使用；不要随客户端版本目录一起清理。手动发布也必须带上完整 `connector-assets/` 和 upload-plan 中的组件清单。

客户端第一次连接时只下载对应连接器组件，验证归档及各文件后写入用户目录的 `connector-runtime/<id>/<归档哈希>/`。列表查询和任务工具发现不下载；已有授权但缓存缺失时，在首次调用资料、契约或命令前补齐。下载支持进度、取消及重试，失败不执行命令。下载由 Electron 网络栈使用系统网络配置，不携带平台登录凭据。腾讯会议和 QQ 邮箱继续使用内置实现。Mac 本地包组件采用 ad hoc 签名，正式签名包的组件另行 Developer ID 签名和公证；Windows 正式签名包组件使用现有打包签名器。各系统真实下载、执行及公证仍需在发布验收中验证。

触发方式：

- 推送与 `package.json` 版本一致的 `v<version>` 或 `client-v<version>` 标签：构建、校验并进入生产发布环境。推荐使用 `v<version>`，例如 `v0.5.1`。
- GitHub Actions 手动运行：`publish=false` 时只构建和汇总包；`publish=true` 时进入生产发布环境。
- `transfer` 默认选择 `server-pull`（服务器主动下载）；只有手动选择 `ssh` 才使用原来的 SSH/rsync 上传。推送版本标签时也默认使用 `server-pull`。

流水线在 macOS runner 构建 macOS ARM64/x64 DMG 与 ZIP，在 Windows runner 构建 Windows x64 NSIS EXE；Ubuntu runner 汇总并强制校验 10 个安装包及 blockmap。打包平台、缓存与完整性检查保持不变。

### 本地音视频组件

Windows x64、macOS Intel 与 Apple Silicon 安装包内置 FFmpeg 和 FFprobe，不要求用户安装 Python、Homebrew 或系统 FFmpeg。发布流程按 `resources/local-media/source.json` 固定源码和校验值，安装包随附对应源码、LGPL 许可证及构建脚本。macOS 使用系统 VideoToolbox 编码 H.264，在两个对应架构的 runner 上分别构建，并在签名后检查应用内可执行文件的架构、签名及媒体处理结果。

本地打包 macOS 时，先在对应架构的 Mac 上运行 `bash scripts/build-local-media-mac.sh x64` 或 `bash scripts/build-local-media-mac.sh arm64`，再运行打包命令。首次验收请使用 DMG 安装后从客户端运行一次带中文路径的本地剪辑，并检查外接盘作为临时目录时的空间提示和取消清理。

### Windows 随包 Bash

Windows x64 安装包在 `resources/bash-runtime/` 放置精简的 MSYS2 Bash 和常用文本、文件命令（含 `grep`、`sed`、`awk`、`find`，不含 Git、WSL 或包管理器）。客户端工具通过绝对路径优先使用这一份 Bash，仅为其子进程调整 `PATH`，不改系统配置或工具授权；开发环境没有随包目录时查找本机 Bash，但不使用 Windows 自带的 WSL 启动器。macOS/Linux 不打包该目录。

打包钩子按 `resources/bash-runtime/packages.json` 锁定版本及 SHA-256，从 MSYS2 下载并仅提取白名单。在 Windows 构建机上，随后用限制后的 `PATH` 运行各命令；跨平台构建 Windows 安装包时需要支持 Zstandard 的系统 `tar`，只检查资源与体积。离线构建可以用 `SEP_BASH_ARCHIVE_DIR` 指向已准备好的同版本 `.pkg.tar.zst` 文件目录，仍须通过哈希校验。LZMA 压缩负载上限为 15,000,000 字节；这个校验不代替首次发布前同配置 NSIS 有/无 Bash 的实际差值测量。

安装包内 `THIRD-PARTY-NOTICES.txt` 提供每个已锁定版本的 MSYS2 对应源码归档地址，许可证随运行时分发。Windows 发布作业会检查上游源码仍可获取；发布方应持续核对已发布版本所指向的对应源码，必要时为旧版提供可公开访问的镜像，不应只保留二进制。首次发布前，在未安装 Git 和 WSL 的 Windows x64 上从客户端对话触发并批准 Bash，核对基本管道、中文路径与失败退出码。

### 默认发布路径：服务器主动下载

1. Actions 合并三平台文件、合并 macOS 清单、校验安装包和九个连接器组件，并生成带版本说明的更新清单。
2. `server-pull-release.mjs --prepare` 将已验证的文件整理为单独的 GitHub Artifact，不再次压缩安装包；产物名称包含本次运行 ID 和重试次数。
3. 发布 job 以自身的临时 `github.token` 获取该产物的信息及临时下载地址，校验产物所属运行、提交、大小及 GitHub SHA256。只有该 job 增加 `actions: read`，无需新增长期 GitHub Token Secret。
4. SSH 只传递小型脚本及发布指令。服务器用 Python 3 标准库和 curl 下载产物，支持断点续传；单次最多下载 300 秒，最多四次，重试时重新获取临时地址。GitHub Token 不发送到服务器，临时地址只经 stdin 传递，不打印、不写入磁盘。
5. 服务器校验整个归档的 SHA256，限制 ZIP 路径、条目类型、文件数量和大小，再校验版本身份及每个文件的大小和 SHA256。只接受本次发布的文件，拒绝符号链接、越界路径和缺失组件。
6. 先发布版本目录和内容寻址的连接器组件，保留旧更新清单；文件完整后才原子替换单份 `latest.yml`、`latest-mac.yml`。两份清单不是一次文件系统操作，切换失败会恢复之前的两份清单。
7. 服务器通过匿名公开 HTTPS 实际下载五个安装包并核验大小和 SHA512，下载九个连接器组件并核验大小和 SHA256，同时核对公开清单内容；全部通过后才向 Actions 返回发布成功。失败或取消时恢复旧更新清单，已完整上传的版本文件保留供排查和重试。

额外的汇总下载产物只保留三天，减少重复占用 GitHub 存储；原始三平台产物仍按原配置保留十四天。临时下载地址过期会重新申请，但已被 GitHub 清理的产物无法继续下载。

服务器需要 Linux、Python 3.10+、curl 以及发布目录写入权限；预检会检查这些条件和剩余磁盘空间。当前下载服务器已具备这些条件，不需要依赖或重启业务 Docker 容器。

私有缓存默认保存在 `/www/sep/.sep-client-releases/<版本>-<运行ID>-<ArtifactID>/`，目录权限为 700。可通过 Environment Variable `SEP_RELEASE_WORK_ROOT` 调整到公开下载目录以外的专用路径；已有目录必须归 SSH 用户所有且权限为 700，脚本不会修改任意已有目录的权限。缓存包含续传数据、发布事务、旧清单备份及发布结果，不会清理历史客户端版本或历史连接器组件。已完成发布的私有下载归档需要按运维保留策略定期清理，清理前先确认没有运行中的发布及回退需要。

Actions 保持 SSH 连接并发送心跳，关闭连接或超过 45 秒没有心跳时服务器会在后续检查点取消操作；清单切换后取消会执行回退。强制杀进程、主机断电等不可恢复中断仍需根据私有事务和备份检查现场，不能将两份清单理解为跨文件原子事务。

### 手动备用：SSH 上传

在 Actions 中选择 Run workflow，设置 `publish=true`、`transfer=ssh`，即可使用原来的上传脚本。该方式不自动降级触发，避免默认下载失败后悄悄进入极慢的大文件上传。原有 Secrets、版本目录保护及更新清单最后发布规则保留。

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
