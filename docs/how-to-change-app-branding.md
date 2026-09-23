# 如何修改客户端 App 的 Logo 和名称

本文档说明如何自定义 SEP Client 的品牌标识，包括应用名称、图标和窗口标题。

## 一、修改应用名称

### 1. package.json 配置

编辑 `package.json` 中的以下字段：

```json
{
  "name": "your-app-name",           // npm 包名（小写，连字符）
  "description": "Your App Description",
  "build": {
    "appId": "com.yourcompany.yourapp",
    "productName": "Your App Name",   // 显示名称（用户可见）
    "copyright": "Copyright © 2026 Your Company",
    "artifactName": "YourApp-${version}-${os}-${arch}.${ext}"
  }
}
```

**关键字段说明**:
- `name`: npm 包标识符（内部使用）
- `productName`: **用户可见的应用名称**（菜单栏、任务管理器）
- `appId`: macOS/Windows 唯一标识符（反向域名格式）
- `artifactName`: 安装包文件名模板

### 2. 窗口标题（可选）

如果需要自定义窗口标题栏文字，编辑 `electron/bootstrap/main-window.ts`:

```typescript
const window = new BrowserWindow({
  title: 'Your App Name',  // 添加这一行
  // ... 其他配置
})
```

注意：当前配置使用 `titleBarStyle: 'hidden'`，标题栏被隐藏了。如果需要显示系统标题栏，可以移除或修改这个设置。

## 二、修改应用图标

### 1. 图标规格要求

| 平台 | 格式 | 推荐尺寸 | 路径 |
|------|------|----------|------|
| macOS | `.icns` | 512x512, 1024x1024 | `build/icon.icns` |
| Windows | `.ico` | 256x256 | `build/icon.ico` |
| Linux | `.png` | 512x512 | `build/icon.png` |

### 2. 创建图标目录和文件

```bash
# 1. 创建 build 目录
mkdir -p build

# 2. 放置图标文件
# macOS: build/icon.icns
# Windows: build/icon.ico
# Linux: build/icon.png
```

### 3. 生成多平台图标

**方式一：在线工具**
- https://www.icoconverter.com/ （PNG → ICO）
- https://cloudconvert.com/png-to-icns （PNG → ICNS）

**方式二：使用 electron-icon-builder**

```bash
# 安装工具
npm install --save-dev electron-icon-builder

# 从单个 PNG 生成所有平台图标（需要 1024x1024 PNG）
npx electron-icon-builder --input=./src/assets/logo.png --output=./build
```

**方式三：macOS 手动生成 .icns**

```bash
# 准备不同尺寸的图片
mkdir icon.iconset
sips -z 16 16     logo.png --out icon.iconset/icon_16x16.png
sips -z 32 32     logo.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     logo.png --out icon.iconset/icon_32x32.png
sips -z 64 64     logo.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   logo.png --out icon.iconset/icon_128x128.png
sips -z 256 256   logo.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   logo.png --out icon.iconset/icon_256x256.png
sips -z 512 512   logo.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   logo.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 logo.png --out icon.iconset/icon_512x512@2x.png

# 生成 .icns
iconutil -c icns icon.iconset -o build/icon.icns
```

### 4. electron-builder 配置（自动检测）

electron-builder 会自动从 `build/` 目录读取图标：

```json
{
  "build": {
    "mac": {
      "icon": "build/icon.icns"  // 可选，默认就是这个路径
    },
    "win": {
      "icon": "build/icon.ico"   // 可选，默认就是这个路径
    },
    "linux": {
      "icon": "build/icon.png"   // 可选，默认就是这个路径
    }
  }
}
```

如果图标文件在默认位置（`build/icon.*`），无需显式配置。

## 三、修改应用内 Logo（渲染进程）

### 当前 Logo 位置

- 文件: `src/assets/logo.png`
- 尺寸: 514 x 480 px
- 格式: PNG

### 替换步骤

1. **准备新 Logo**
   - 推荐尺寸: 512x512 px（正方形）或保持当前比例
   - 格式: PNG（支持透明背景）
   - 文件大小: < 200 KB

2. **替换文件**
   ```bash
   # 备份旧 logo
   cp src/assets/logo.png src/assets/logo.old.png
   
   # 替换为新 logo
   cp /path/to/your-new-logo.png src/assets/logo.png
   ```

3. **验证引用**（如果需要修改引用路径）
   ```bash
   grep -r "logo.png" src/ --include="*.tsx" --include="*.ts"
   ```

## 四、完整更换流程

### 快速检查清单

- [ ] 修改 `package.json` 的 `productName`、`appId`、`copyright`
- [ ] 准备图标文件并放入 `build/` 目录
  - [ ] `build/icon.icns` (macOS)
  - [ ] `build/icon.ico` (Windows)
  - [ ] `build/icon.png` (Linux)
- [ ] 替换 `src/assets/logo.png`（渲染进程内显示）
- [ ] 运行构建命令验证

### 验证命令

```bash
# 1. 开发模式预览
npm run dev

# 2. 生产构建（会使用新图标）
npm run build

# 3. 打包（生成安装包）
npm run package

# 4. 检查打包产物
ls -lh dist/
```

### 预期结果

开发模式（`npm run dev`）:
- 应用窗口标题显示新名称
- Dock/任务栏显示新图标（可能需要清缓存）

生产打包（`npm run package`）:
- `dist/` 目录包含新命名的安装包
- 安装后的应用显示新图标和名称

## 五、常见问题

### Q1: 图标不更新？

**macOS**:
```bash
# 清除图标缓存
sudo rm -rf /Library/Caches/com.apple.iconservices.store
killall Dock
```

**Windows**: 重启资源管理器或重启电脑

**开发模式**: 图标可能使用 Electron 默认图标，需要打包后才生效

### Q2: 打包后图标模糊？

- 检查源图标分辨率（至少 512x512）
- 确保 `.icns` 包含多个尺寸（16px 到 1024px）
- Windows `.ico` 至少包含 256x256

### Q3: 应用名称未更新？

- 确认修改了 `productName` 而非 `name`
- 重新运行 `npm run build`
- macOS: 删除旧应用再重新安装

### Q4: appId 冲突？

- 使用反向域名格式：`com.yourcompany.yourapp`
- 确保与其他应用不重复
- 修改后需要重新签名（macOS）

## 六、最佳实践

1. **图标设计**
   - 使用矢量图（SVG）作为源文件
   - 保持简洁，避免细节过多
   - 测试浅色和深色背景效果
   - 准备圆角和直角两个版本

2. **命名规范**
   - `productName`: 用户友好的名称（可以有空格）
   - `appId`: 反向域名，全小写，无特殊字符
   - `artifactName`: 清晰的版本和平台标识

3. **版本控制**
   - 不要提交 `build/` 目录到 Git（添加到 `.gitignore`）
   - 源 Logo 放在 `src/assets/` 并提交
   - 构建脚本自动生成平台图标

4. **自动化**
   ```json
   {
     "scripts": {
       "prebuild": "node scripts/generate-icons.js",
       "build": "electron-vite build"
     }
   }
   ```

## 参考资源

- electron-builder 图标指南: https://www.electron.build/icons
- macOS 图标设计: https://developer.apple.com/design/human-interface-guidelines/app-icons
- Windows 图标规范: https://learn.microsoft.com/en-us/windows/apps/design/style/iconography/app-icon-design
