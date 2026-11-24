#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
arch=${1:-$(node -p 'process.arch')}
case "$arch" in
  x64) native=x86_64 ;;
  arm64) native=arm64 ;;
  *) echo "Unsupported macOS FFmpeg target: $arch" >&2; exit 1 ;;
esac
test "$(uname -s)" = Darwin && test "$(uname -m)" = "$native" || {
  echo "Build FFmpeg on a native macOS $arch host." >&2
  exit 1
}
dest="$root/resources/local-media/mac-$arch"
version=$(node -p 'require("./resources/local-media/source.json").version')
url=$(node -p 'require("./resources/local-media/source.json").url')
sha256=$(node -p 'require("./resources/local-media/source.json").sha256')
source="ffmpeg-$version.tar.xz"
temp_root=$(cd "${TMPDIR:-/tmp}" && pwd -P)
build=$(mktemp -d "$temp_root/csep-ffmpeg.XXXXXXXX")
trap 'case "$build" in "$temp_root"/csep-ffmpeg.*) rm -rf -- "$build";; esac' EXIT
# Match Electron 33's minimum OS for both FFmpeg and LAME.
export MACOSX_DEPLOYMENT_TARGET=11.0 CC=/usr/bin/clang
manifest="$root/resources/local-media/source.json"
source "$root/scripts/build-local-media-lame.sh"
build_local_media_lame "$manifest" "$build" "${FFMPEG_BUILD_JOBS:-4}"
cd "$build"
curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' "$url" --output "$source"
printf '%s  %s\n' "$sha256" "$source" | shasum -a 256 -c -
tar -xf "$source"
cd "ffmpeg-$version"
./configure --prefix=/usr --cc=/usr/bin/clang --disable-autodetect --disable-network --disable-doc \
  --disable-ffplay --disable-debug --disable-x86asm --enable-videotoolbox --enable-libmp3lame \
  --extra-cflags="-I$lame_prefix/include" --extra-ldflags="-L$lame_prefix/lib"
make -j"${FFMPEG_BUILD_JOBS:-4}" ffmpeg ffprobe
for tool in ffmpeg ffprobe; do
  test "$(lipo -archs "$tool")" = "$native"
done
./ffmpeg -hide_banner -v error -f lavfi -i 'testsrc2=s=320x180:r=24:d=1' \
  -pix_fmt nv12 -c:v h264_videotoolbox -allow_sw 1 -bf 0 -an sample.mp4
./ffprobe -hide_banner -v error -show_entries stream=codec_name -of csv=p=0 sample.mp4 | grep -Fx h264
mkdir -p "$dest"
cp ffmpeg ffprobe COPYING.LGPLv2.1 "../$source" "$root/scripts/build-local-media-mac.sh" "$dest/"
cp "$build/$lame_source" "$manifest" "$root/scripts/build-local-media-lame.sh" "$dest/"
cp "$lame_license" "$dest/COPYING.LAME"
./ffmpeg -buildconf > "$dest/build-config.txt" 2>&1
cd "$dest"
shasum -a 256 ffmpeg ffprobe > SHA256SUMS
