#!/bin/bash
# 生成自适应图标（支持 macOS 深浅模式）

set -e

# 检查输入文件
LIGHT_ICON="$1"  # 白底版
DARK_ICON="$2"   # 黑底版

if [ -z "$LIGHT_ICON" ] || [ -z "$DARK_ICON" ]; then
  echo "使用方法: $0 <白底版.png> <黑底版.png>"
  echo "示例: $0 logo-light.png logo-dark.png"
  exit 1
fi

if [ ! -f "$LIGHT_ICON" ] || [ ! -f "$DARK_ICON" ]; then
  echo "错误: 找不到输入文件"
  exit 1
fi

# 输出目录
BUILD_DIR="build"
ICONSET_DIR="$BUILD_DIR/icon.iconset"
ICONSET_DARK_DIR="$BUILD_DIR/icon~dark.iconset"

mkdir -p "$BUILD_DIR"
rm -rf "$ICONSET_DIR" "$ICONSET_DARK_DIR"
mkdir -p "$ICONSET_DIR" "$ICONSET_DARK_DIR"

echo "📦 生成浅色模式图标..."
# 浅色模式（标准 iconset）
sips -z 16 16     "$LIGHT_ICON" --out "$ICONSET_DIR/icon_16x16.png"
sips -z 32 32     "$LIGHT_ICON" --out "$ICONSET_DIR/icon_16x16@2x.png"
sips -z 32 32     "$LIGHT_ICON" --out "$ICONSET_DIR/icon_32x32.png"
sips -z 64 64     "$LIGHT_ICON" --out "$ICONSET_DIR/icon_32x32@2x.png"
sips -z 128 128   "$LIGHT_ICON" --out "$ICONSET_DIR/icon_128x128.png"
sips -z 256 256   "$LIGHT_ICON" --out "$ICONSET_DIR/icon_128x128@2x.png"
sips -z 256 256   "$LIGHT_ICON" --out "$ICONSET_DIR/icon_256x256.png"
sips -z 512 512   "$LIGHT_ICON" --out "$ICONSET_DIR/icon_256x256@2x.png"
sips -z 512 512   "$LIGHT_ICON" --out "$ICONSET_DIR/icon_512x512.png"
sips -z 1024 1024 "$LIGHT_ICON" --out "$ICONSET_DIR/icon_512x512@2x.png"

echo "🌙 生成深色模式图标..."
# 深色模式（~dark iconset）
sips -z 16 16     "$DARK_ICON" --out "$ICONSET_DARK_DIR/icon_16x16.png"
sips -z 32 32     "$DARK_ICON" --out "$ICONSET_DARK_DIR/icon_16x16@2x.png"
sips -z 32 32     "$DARK_ICON" --out "$ICONSET_DARK_DIR/icon_32x32.png"
sips -z 64 64     "$DARK_ICON" --out "$ICONSET_DARK_DIR/icon_32x32@2x.png"
sips -z 128 128   "$DARK_ICON" --out "$ICONSET_DARK_DIR/icon_128x128.png"
sips -z 256 256   "$DARK_ICON" --out "$ICONSET_DARK_DIR/icon_128x128@2x.png"
sips -z 256 256   "$DARK_ICON" --out "$ICONSET_DARK_DIR/icon_256x256.png"
sips -z 512 512   "$DARK_ICON" --out "$ICONSET_DARK_DIR/icon_256x256@2x.png"
sips -z 512 512   "$DARK_ICON" --out "$ICONSET_DARK_DIR/icon_512x512.png"
sips -z 1024 1024 "$DARK_ICON" --out "$ICONSET_DARK_DIR/icon_512x512@2x.png"

echo "🔨 合并为自适应 .icns 文件..."
iconutil -c icns "$ICONSET_DIR" -o "$BUILD_DIR/icon.icns"
iconutil -c icns "$ICONSET_DARK_DIR" -o "$BUILD_DIR/icon~dark.icns"

# 合并为单个自适应 icns（macOS 11+）
echo "✅ 生成完成！"
echo "  - 浅色模式: $BUILD_DIR/icon.icns"
echo "  - 深色模式: $BUILD_DIR/icon~dark.icns"
echo ""
echo "📌 electron-builder 会自动识别这两个文件并打包"

# 清理临时文件
rm -rf "$ICONSET_DIR" "$ICONSET_DARK_DIR"
