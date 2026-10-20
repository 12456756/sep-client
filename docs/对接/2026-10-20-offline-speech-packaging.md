# 离线语音模型打包交接

## 当前状态

语音输入已接入客户端，Windows x64 开发环境验证通过。当前安装包配置尚未内置模型；直接使用现有打包命令不能视为离线语音功能交付完成。

本次 Git 提交只包含源码、测试、模型清单和许可声明。`model.int8.onnx` 约 228 MiB，与 `tokens.txt`、测试 WAV 一起由 `.gitignore` 排除，不随 Git 推送。

## 打包机准备资源

在项目根目录执行：

```powershell
npm ci
powershell -NoProfile -File poc/sensevoice/prepare.ps1
```

准备脚本按 `resources/speech/sensevoice-int8/manifest.json` 中的固定版本下载并校验资源。此步骤只在开发机或打包机执行，不是终端用户下载流程。无法联网的打包机需提前导入同一版本文件并完成校验。

客户端实际使用的文件：

| 文件 | 用途 |
| --- | --- |
| `model.int8.onnx` | SenseVoice INT8 模型，239233841 字节 |
| `tokens.txt` | 与模型配套的词表，315894 字节 |
| `MODEL_LICENSE` | 模型许可声明 |
| `RUNTIME_LICENSE` | sherpa 运行时许可声明 |
| `manifest.json` | 来源、固定版本与校验信息 |

## 安装目录约定

平台方需在 `package.json` 的 `build` 配置中添加资源配置，再生成 beta/stable 的 builder 配置。`scripts/generate-builder-config.mjs` 会继承这份配置，不要只手改 `.release` 下的生成文件。

以下是待接入的 `extraResources` 配置示例，不代表当前已经修改了打包配置：

```json
{
  "extraResources": [
    {
      "from": "resources/speech/sensevoice-int8",
      "to": "speech/sensevoice-int8",
      "filter": [
        "model.int8.onnx",
        "tokens.txt",
        "MODEL_LICENSE",
        "RUNTIME_LICENSE",
        "manifest.json"
      ]
    }
  ]
}
```

最终必须能读取到：

```text
<安装目录>/resources/speech/sensevoice-int8/model.int8.onnx
<安装目录>/resources/speech/sensevoice-int8/tokens.txt
```

生产代码通过 `process.resourcesPath` 定位，不依赖项目目录、当前工作目录或用户选择的任务目录。模型放在 `app.asar` 外，测试 WAV 和临时下载文件不进入正式安装包。

模型及词表的大小和哈希在 `electron/data/speech-assets.ts` 中固定。换模型不能只覆盖文件，必须同步版本和校验信息并重新验证识别效果。缺失或损坏资源会拒绝识别，不会联网下载或回退云端。

## 原生运行库

- 保留锁文件中的 `sherpa-onnx-node@1.13.8` 及 `sherpa-onnx-win-x64@1.13.8`，不要忽略目标平台的 optional dependencies。
- 确认对应 `.node` 和 `.dll` 被收入安装包并解包到可加载目录；可以在现有 `asarUnpack` 数组中追加 `node_modules/sherpa-onnx-node/**/*` 与 `node_modules/sherpa-onnx-win-x64/**/*`，保留原有规则。
- Windows x64 原生包目前包括 `sherpa-onnx.node`、`onnxruntime.dll`、`onnxruntime_providers_shared.dll`、`sherpa-onnx-c-api.dll`、`sherpa-onnx-cxx-api.dll`，不要只复制 `.node` 文件。
- 保留独立构建产物 `out/main/speech-worker.js`。识别运行在 Electron utilityProcess 中，不需要安装 Python 或配置 GPU。
- 当前仅验证 Windows x64。macOS/Linux 或其他架构的包需单独验证原生依赖和系统权限，不能直接沿用 Windows 验收结论。

## 发布前检查

1. 打包前校验模型和词表完整性；资源不齐时应直接阻止发布，不能生成缺模型的正式包。
2. 检查安装产物中的模型、词表、许可文件、原生库与 worker；不能仅凭 `npm run build` 成功判断安装包可用。
3. 在未安装开发工具、没有项目目录和模型缓存的干净 Windows x64 机器上，安装后断网测试首次识别、重复识别、取消及授权设置。
4. 模型自身约增加 228 MiB 未压缩资源，还需计入词表和原生库；安装包压缩体积以实际产物为准。
5. 模型使用独立的 FunASR 模型许可，运行时使用 Apache-2.0。请平台方审核仓库内许可材料与模型商用分发要求，保留对应声明，不要将两者视为同一许可。

相关验证记录：`docs/testing/2026-10-20-offline-speech-input.md`。
