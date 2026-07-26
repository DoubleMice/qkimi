#!/usr/bin/env bash
set -euo pipefail

mode="${1:-package}"
case "$mode" in
  package|make|run) ;;
  *) echo "usage: native/build.sh [package|make|run]" >&2; exit 2 ;;
esac

project_root="$(cd "$(dirname "$0")/.." && pwd)"
native_root="$project_root/native"
out_root="$project_root/out"
target_root="$out_root/Kimi 2007-darwin-arm64"
app_root="$target_root/Kimi 2007.app"
binary_source="$native_root/.build/arm64-apple-macosx/release/Kimi2007"

swift build --package-path "$native_root" -c release --arch arm64

case "$target_root" in
  "$project_root"/out/*) ;;
  *) echo "refusing unsafe output path: $target_root" >&2; exit 3 ;;
esac

rm -rf "$target_root"
mkdir -p "$app_root/Contents/MacOS" "$app_root/Contents/Resources"
install -m 755 "$binary_source" "$app_root/Contents/MacOS/Kimi 2007"
strip -x "$app_root/Contents/MacOS/Kimi 2007"
install -m 644 "$native_root/Info.plist" "$app_root/Contents/Info.plist"
install -m 644 "$project_root/assets/icon.icns" "$app_root/Contents/Resources/AppIcon.icns"
# Web 资源按目录整体复制；LoopbackServer 仍只通过 static-manifest.json 暴露白名单路由。
ditto "$project_root/web" "$app_root/Contents/Resources/Web"
codesign --force --deep --sign - --identifier com.qkimi.desktop "$app_root" >/dev/null

if [[ "$mode" == "run" ]]; then
  open "$app_root"
  exit 0
fi

if [[ "$mode" == "make" ]]; then
  make_root="$out_root/make"
  zip_root="$make_root/zip/darwin/arm64"
  dmg_path="$make_root/Kimi 2007-0.1.0-arm64.dmg"
  zip_path="$zip_root/Kimi 2007-darwin-arm64-0.1.0.zip"
  stage="$(mktemp -d "${TMPDIR:-/tmp}/qkimi-native.XXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  mkdir -p "$make_root" "$zip_root"
  rm -f "$dmg_path" "$zip_path"
  ditto "$app_root" "$stage/Kimi 2007.app"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname "Kimi 2007" -srcfolder "$stage" -ov -format UDZO "$dmg_path" >/dev/null
  ditto -c -k --sequesterRsrc --keepParent "$app_root" "$zip_path"
  echo "Artifacts:"
  echo "  $app_root"
  echo "  $dmg_path"
  echo "  $zip_path"
else
  echo "Artifact: $app_root"
fi
