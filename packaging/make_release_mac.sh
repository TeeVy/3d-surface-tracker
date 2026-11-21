#!/bin/bash
# Paquet macOS prêt à distribuer : out/release/3D-Surface-Tracker-<version>-mac.zip
#   plugins/    STEffect.plugin, STBridge.plugin (universels)
#   extension/  panneau CEP + moteur autonome (engine/mac-arm64, engine/mac-x86_64 s'il est construit)
#   install-mac.command, uninstall-mac.command, README.txt
# Le moteur se construit d'abord : packaging/build_engine.sh arm64 [et x86_64].
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$ROOT/panel/CSXS/manifest.xml")"
NAME="3D-Surface-Tracker-$VERSION-mac"
DIR="$ROOT/out/release/$NAME"

"$ROOT/native/build.sh"
[ -x "$ROOT/out/engine/arm64/st-engine/st-engine" ] || { echo "Moteur arm64 absent : packaging/build_engine.sh arm64" >&2; exit 1; }

rm -rf "$DIR" "$DIR.zip"
mkdir -p "$DIR/plugins" "$DIR/extension/engine"
cp -R "$ROOT/out/native/STEffect.plugin" "$ROOT/out/native/STBridge.plugin" "$DIR/plugins/"
# panneau : sans l'image de démo ni le débogage à distance (.debug)
rsync -a --exclude ".debug" --exclude "demo.jpg" --exclude ".DS_Store" "$ROOT/panel/" "$DIR/extension/"
for arch in arm64 x86_64; do
  if [ -d "$ROOT/out/engine/$arch/st-engine" ]; then
    mkdir -p "$DIR/extension/engine/mac-$arch"
    cp -R "$ROOT/out/engine/$arch/st-engine" "$DIR/extension/engine/mac-$arch/"
  else
    echo "Note : pas de moteur $arch (Mac $arch non pris en charge par ce paquet)"
  fi
done
cp "$ROOT/packaging/install-mac.command" "$ROOT/packaging/uninstall-mac.command" "$DIR/"
chmod +x "$DIR/"*.command
cp "$ROOT/packaging/README-release.txt" "$DIR/README.txt"
cp "$ROOT/LICENSE" "$DIR/LICENSE.txt" 2>/dev/null || true
# ditto garde les liens symboliques du moteur (Python.framework)
(cd "$ROOT/out/release" && ditto -c -k --norsrc --noextattr --noqtn --keepParent "$NAME" "$NAME.zip")
echo "Paquet : $DIR.zip ($(du -h "$DIR.zip" | cut -f1))"
