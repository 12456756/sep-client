# 客户端 CI 发布

`.github/workflows/client-release.yml` 只负责 SEP 客户端下载源，不部署 SEP 前端、后端或 Docker 镜像。

触发方式：

- 推送与 `package.json` 版本一致的 `v<version>` 或 `client-v<version>` 标签：构建、校验并进入生产发布环境。推荐使用 `v<version>`，例如 `v0.5.1`。
- GitHub Actions 手动运行：`publish=false` 时只构建和汇总包；`publish=true` 时进入生产发布环境。

流水线在 macOS runner 构建 macOS ARM64/x64 DMG 与 ZIP，在 Windows runner 构建 Windows x64 NSIS EXE；Ubuntu runner 汇总并强制校验 10 个安装包及 blockmap。发布阶段先上传版本目录，再远程校验 SHA256，最后更新 `latest.yml` 和 `latest-mac.yml`。

在 GitHub Environment `sep-download-production` 配置以下 Secrets：

- `SEP_UPLOAD_SSH_KEY_BASE64`：访问华为云下载服务器的私钥文件内容经 Base64 编码后的单行文本
- `SEP_UPLOAD_KNOWN_HOSTS`：服务器的固定 SSH host key，禁止关闭 host key 校验
- `SEP_UPLOAD_HOST`：默认 `121.37.128.126`
- `SEP_UPLOAD_USER`：默认 `root`
- `SEP_UPLOAD_ROOT`：默认 `/www/sep/downloads/sep-client/stable`
- `SEP_UPLOAD_PORT`：默认 `22`

将与服务器 `authorized_keys` 匹配的私钥文件做 Base64 编码后，完整保存为 `SEP_UPLOAD_SSH_KEY_BASE64`（macOS/Linux 可运行 `base64 < ~/.ssh/sep_deploy | tr -d '\n'`）。这样可以避免 GitHub Secret 对私钥多行换行的转换导致 OpenSSH 报 `error in libcrypto`。`SEP_UPLOAD_KNOWN_HOSTS` 必须包含 `SEP_UPLOAD_HOST` 对应的完整 host key 行。发布器会在一次运行中为 `ssh` 和 `rsync` 使用同一份临时 SSH 配置，强制使用该私钥并启用 host key 校验。

发布 job 使用 GitHub Environment 审批。版本目录已存在时会拒绝覆盖；更新清单发布失败时会恢复旧清单。工作流不会执行 SEP 容器重启、镜像拉取或前端部署。
