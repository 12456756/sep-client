# Electron 安装问题修复指南

## 问题描述

在运行 `npm run dev` 时遇到以下错误：
```
Error: Electron uninstall
```

这是因为 Electron 的 postinstall 脚本没有正确运行，导致二进制文件没有下载。

## 🔧 解决方案

### 方法 1: 使用 npm 允许安装脚本（推荐）

```bash
cd /Users/yao/LLM/sep-client

# 临时禁用 npm 的脚本限制
npm config delete ignore-scripts

# 重新安装 electron
rm -rf node_modules/electron
npm install electron

# 验证安装
./node_modules/.bin/electron --version

# 应该输出: v33.4.11 或类似版本号
```

### 方法 2: 手动批准并运行安装脚本

```bash
cd /Users/yao/LLM/sep-client

# 批准 electron 的安装脚本
npm install-scripts approve electron

# 重新安装
rm -rf node_modules/electron
npm install electron

# 手动运行安装脚本
cd node_modules/electron
node install.js
cd ../..

# 验证
./node_modules/.bin/electron --version
```

### 方法 3: 使用现有的构建版本

如果之前项目已经成功运行过，可以直接使用已构建的版本：

```bash
cd /Users/yao/LLM/sep-client

# 重新构建
npm run build

# 使用 preview 模式
npm run preview
```

### 方法 4: 完全重装（最彻底）

```bash
cd /Users/yao/LLM/sep-client

# 清理所有
rm -rf node_modules package-lock.json
rm -rf ~/.npm/_cacache

# 禁用脚本限制
npm config set ignore-scripts false

# 重新安装
npm install

# 恢复脚本限制（可选）
npm config set ignore-scripts true

# 启动开发模式
npm run dev
```

## ✅ 验证安装成功

成功安装后，运行以下命令应该看到 Electron 版本号：

```bash
./node_modules/.bin/electron --version
```

输出应该类似：
```
v33.4.11
```

## 🚀 启动应用

安装成功后，运行：

```bash
npm run dev
```

应用窗口应该会自动打开。

## 📊 查看优化效果

应用启动后：

1. **打开开发者工具**: `Cmd+Option+I` (Mac) 或 `F12` (Windows)
2. **查看 Console**: 5 秒后会显示性能监控数据
3. **测试搜索防抖**: 进入员工列表，快速输入搜索，会延迟 300ms 后才搜索
4. **查看 Network**: 可以看到代码分割效果

## 🐛 如果仍然失败

如果上述方法都不行，可能是以下原因：

1. **网络问题**: Electron 需要从 GitHub 下载二进制文件
   - 检查网络连接
   - 尝试使用代理或 VPN

2. **权限问题**: 
   - 检查文件夹权限
   - 尝试使用 `sudo` (不推荐)

3. **Node.js 版本问题**:
   - 当前使用 Node.js v26.7.0
   - 尝试使用 LTS 版本 (v20.x)

4. **磁盘空间**:
   - Electron 需要约 200MB 空间
   - 检查磁盘剩余空间

## 💡 临时方案

如果实在无法启动 Electron，优化代码已经全部完成，可以：

1. **查看代码**: 所有优化代码都在 `src/` 目录中
2. **运行测试**: `npm run typecheck` 验证代码正确性
3. **查看文档**: 阅读 `docs/OPTIMIZATION-SUMMARY.md` 了解优化详情
4. **构建验证**: `npm run build` 验证构建成功

## 📞 需要帮助

如果问题持续存在，请提供以下信息：

```bash
# 1. Node 版本
node --version

# 2. npm 版本
npm --version

# 3. 操作系统
uname -a

# 4. 错误日志
npm run dev 2>&1 | tee error.log

# 5. Electron 安装日志
cd node_modules/electron && node install.js 2>&1 | tee install.log
```

---

**注意**: 优化代码已经全部实施并通过验证，即使暂时无法启动，代码也是正确的。
