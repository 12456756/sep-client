#!/usr/bin/env bash
# Sourced by both FFmpeg build recipes after creating their private build directory.
build_local_media_lame() {
  local manifest=$1 build=$2 jobs=$3 version url hash
  version=$(node -p 'require(process.argv[1]).lame.version' "$manifest")
  url=$(node -p 'require(process.argv[1]).lame.url' "$manifest")
  hash=$(node -p 'require(process.argv[1]).lame.sha256' "$manifest")
  lame_source="lame-$version.tar.gz"
  lame_prefix="$build/lame-prefix"
  (
    cd "$build"
    curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 --proto '=https' --proto-redir '=https' "$url" --output "$lame_source"
    printf '%s  %s\n' "$hash" "$lame_source" | if command -v sha256sum >/dev/null; then sha256sum -c -; else shasum -a 256 -c -; fi
    tar -xf "$lame_source"
    cd "lame-$version"
    # C17 permits LAME's legacy declarations on current clang/GCC; the CLI is not shipped.
    CFLAGS='-O2 -std=gnu17' ./configure --prefix="$lame_prefix" --disable-shared --enable-static --disable-frontend --disable-decoder
    make -j"$jobs"
    make install
  )
  lame_license="$build/lame-$version/COPYING"
}
