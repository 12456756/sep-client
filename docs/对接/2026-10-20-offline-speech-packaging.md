# 离线语音模型打包交接

## 当前状态

语音输入已接入客户端，Windows x64 开发环境验证通过。安装包已配置内置模型、词表与许可文件，原生运行库解包，打包前后都会校验资源。资源准备与实际安装包验收仍须按下文执行。

本次 Git 提交只包含源码、测试、模型清单和许可声明。`model.int8.onnx` 约 228 MiB，与 `tokens.txt`、测试 WAV 一起由 `.gitignore` 排除，不随 Git 推送。测试 WAV 仅在执行 `npm run speech:prepare -- --test-audio` 时下载。

## 打包机准备资源

在项目根目录执行：

```powershell
npm ci
npm run speech:prepare
npm run speech:verify
```

跨平台 Node 准备脚本（原 PowerShell 脚本仍可用）按 `resources/speech/sensevoice-int8/manifest.json` 中的固定版本下载并校验资源。此步骤只在开发机或打包机执行，不是终端用户下载流程。无法联网的打包机需提前导入同一版本文件并完成校验。

客户端实际使用的文件：

| 文件 | 用途 |
| --- | --- |
| `model.int8.onnx` | SenseVoice INT8 模型，239233841 字节 |
| `tokens.txt` | 与模型配套的词表，315894 字节 |
| `MODEL_LICENSE` | 模型许可声明 |
| `RUNTIME_LICENSE` | sherpa 运行时许可声明 |
| `manifest.json` | 来源、固定版本与校验信息 |

## 安装目录约定

`package.json` 的 `build` 配置已添加资源配置，并由 beta/stable 的 builder 配置继承。`scripts/generate-builder-config.mjs` 会继承这份配置，不要只手改 `.release` 下的生成文件。

当前 `extraResources` 配置：

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
- 确认对应 `.node` 和 `.dll` 被收入安装包并解包到可加载目录；现有 `asarUnpack` 已追加 `node_modules/sherpa-onnx-*/**/*` 并保留原有规则，覆盖包装器和对应平台原生依赖。
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

## 打包拦截与本地命令

- `beforePack` 校验模型、词表、清单、许可及目标平台 1.13.8 原生运行库；失败即停止打包。不会在打包 hook 中联网下载。
- `afterPack` 再次校验安装目录资源、原生库解包、语音 worker 与 macOS 麦克风用途声明，拒绝测试录音和临时文件。
- macOS 增加麦克风用途声明及签名所需 audio-input entitlement；正式签名发布仍遵循既有签名与公证流程。
- `npm run package:local:beta` 生成本地验证包；`npm run package:beta` 生成符合既有签名流程的发布包。版本仍为 0.1.2。
- 如需在 ARM Mac 上构建 x64 包，先确保锁文件对应的 `sherpa-onnx-darwin-x64@1.13.8` 已安装；缺少目标平台原生依赖会直接报错。
