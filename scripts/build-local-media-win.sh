#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
test "${MSYSTEM:-}" = UCRT64
dest="$root/resources/local-media/win-x64"
mkdir -p "$dest"
version=$(node -p 'require("./resources/local-media/source.json").version')
url=$(node -p 'require("./resources/local-media/source.json").url')
sha256=$(node -p 'require("./resources/local-media/source.json").sha256')
source="ffmpeg-$version.tar.xz"
build=$(mktemp -d)
trap 'case "$build" in "${TMPDIR:-/tmp}"/*) rm -rf -- "$build";; esac' EXIT
cd "$build"
curl --fail --location --retry 3 --proto '=https' "$url" --output "$source"
printf '%s  %s\n' "$sha256" "$source" | sha256sum --check --strict
tar -xf "$source"
cd "ffmpeg-$version"
./configure --prefix=/usr --disable-autodetect --disable-network --disable-doc \
  --disable-ffplay --disable-debug --enable-mediafoundation --enable-d3d11va --extra-ldflags=-static
make -j"${FFMPEG_BUILD_JOBS:-4}" ffmpeg.exe ffprobe.exe
strip ffmpeg.exe ffprobe.exe
./ffmpeg.exe -hide_banner -v error -f lavfi -i 'testsrc2=s=320x180:r=24:d=1' \
  -pix_fmt nv12 -c:v h264_mf -an sample.mp4
./ffprobe.exe -hide_banner -v error -show_entries stream=codec_name -of csv=p=0 sample.mp4 | grep -Fx h264
cp ffmpeg.exe ffprobe.exe COPYING.LGPLv2.1 "../$source" "$root/scripts/build-local-media-win.sh" "$dest/"
./ffmpeg.exe -buildconf > "$dest/build-config.txt" 2>&1
cd "$dest"
sha256sum ffmpeg.exe ffprobe.exe > SHA256SUMS
