#!/bin/bash
# Compile les plug-ins natifs (universels arm64 + x86_64) sans Xcode : clang + Rez des Command Line Tools.
#   STBridge : pont qui envoie au moteur les images calculées par After Effects
#   STEffect : effet « 3D Surface Tracker » (marque le calque, ouvre le panneau)
# Usage : native/build.sh [--install]
#   --install : copie les plug-ins dans le dossier Plug-ins de chaque After Effects installé
#               (dossiers protégés : le mot de passe administrateur est demandé).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SDK="${AE_SDK:-$ROOT/AfterEffectsSDK/Examples}"
[ -d "$SDK/Headers" ] || { echo "SDK After Effects introuvable : $SDK" >&2; exit 1; }
INC=(-I"$SDK/Headers" -I"$SDK/Headers/SP" -I"$SDK/Headers/adobesdk" -I"$SDK/Headers/adobesdk/config"
     -I"$SDK/Headers/adobesdk/drawbot" -I"$SDK/Util")

build() {  # nom
  local name="$1" src="$HERE/$1" out="$ROOT/out/native/$1.plugin"
  rm -rf "$out"
  mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
  clang++ -std=c++17 -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 -bundle -fvisibility=hidden \
    -Wno-deprecated-declarations -Wno-multichar "${INC[@]}" \
    "$src/$name.cpp" "$SDK/Util/AEGP_SuiteHandler.cpp" "$SDK/Util/MissingSuiteError.cpp" \
    -framework CoreFoundation -o "$out/Contents/MacOS/$name"
  Rez -o "$out/Contents/Resources/$name.rsrc" -useDF -d AE_OS_MAC -d __MACH__ \
    -I "$SDK/Headers" -I "$SDK/Resources" "$src/${name}_PiPL.r"
  cp "$src/Info.plist" "$out/Contents/Info.plist"
  printf '%s' "$(/usr/libexec/PlistBuddy -c 'Print :CFBundlePackageType' "$src/Info.plist")FXTC" > "$out/Contents/PkgInfo"
  codesign --force --sign - "$out" >/dev/null 2>&1 || true   # signature locale (Apple Silicon)
  echo "Compilé : $out"
}

build STBridge
build STEffect

if [ "${1:-}" = "--install" ]; then
  shopt -s nullglob
  for ae in "/Applications/Adobe After Effects "*/Plug-ins; do
    for p in STBridge STEffect; do
      sudo rm -rf "$ae/$p.plugin"
      sudo cp -R "$ROOT/out/native/$p.plugin" "$ae/" && echo "Installé : $ae/$p.plugin"
    done
  done
fi
