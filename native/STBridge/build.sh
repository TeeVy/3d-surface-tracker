#!/bin/bash
# Compile le pont AEGP (universel arm64 + x86_64) sans Xcode : clang + Rez des Command Line Tools.
# Usage : native/STBridge/build.sh [--install]
#   --install : copie le plug-in dans le dossier Plug-ins de chaque After Effects installé
#               (dossiers protégés : le mot de passe administrateur est demandé).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SDK="${AE_SDK:-$ROOT/AfterEffectsSDK/Examples}"
OUT="$ROOT/out/native/STBridge.plugin"
[ -d "$SDK/Headers" ] || { echo "SDK After Effects introuvable : $SDK" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
INC=(-I"$SDK/Headers" -I"$SDK/Headers/SP" -I"$SDK/Headers/adobesdk" -I"$SDK/Headers/adobesdk/config"
     -I"$SDK/Headers/adobesdk/drawbot" -I"$SDK/Util")
clang++ -std=c++17 -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 -bundle -fvisibility=hidden \
  -Wno-deprecated-declarations -Wno-multichar "${INC[@]}" \
  "$HERE/STBridge.cpp" "$SDK/Util/AEGP_SuiteHandler.cpp" "$SDK/Util/MissingSuiteError.cpp" \
  -framework CoreFoundation -o "$OUT/Contents/MacOS/STBridge"
Rez -o "$OUT/Contents/Resources/STBridge.rsrc" -useDF -d AE_OS_MAC -d __MACH__ \
  -I "$SDK/Headers" -I "$SDK/Resources" "$HERE/STBridge_PiPL.r"
cp "$HERE/Info.plist" "$OUT/Contents/Info.plist"
printf 'AEgxFXTC' > "$OUT/Contents/PkgInfo"
codesign --force --sign - "$OUT" >/dev/null 2>&1 || true   # signature locale (Apple Silicon)
echo "Compilé : $OUT"

if [ "${1:-}" = "--install" ]; then
  shopt -s nullglob
  for ae in "/Applications/Adobe After Effects "*/Plug-ins; do
    sudo rm -rf "$ae/STBridge.plugin"
    sudo cp -R "$OUT" "$ae/" && echo "Installé : $ae/STBridge.plugin"
  done
fi
