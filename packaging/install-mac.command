#!/bin/bash
# 3D Surface Tracker — macOS installer.
# Double-click this file (first time: right-click > Open), or run it in Terminal:
#   bash install-mac.command
set -euo pipefail
cd "$(dirname "$0")"

PLUGINS="/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/3D Surface Tracker"
EXT="$HOME/Library/Application Support/Adobe/CEP/extensions/com.surftrack.panel"

echo "3D Surface Tracker — installation"
echo
echo "1/3  Effect and bridge plug-ins -> $PLUGINS"
echo "     (your administrator password is needed for this shared Adobe folder)"
sudo mkdir -p "$PLUGINS"
sudo rm -rf "$PLUGINS/STEffect.plugin" "$PLUGINS/STBridge.plugin"
sudo cp -R plugins/STEffect.plugin plugins/STBridge.plugin "$PLUGINS/"
sudo xattr -dr com.apple.quarantine "$PLUGINS" 2>/dev/null || true
# older copies placed directly in an After Effects Plug-ins folder would load twice
for d in "/Applications/Adobe After Effects "*/Plug-ins; do
  [ -d "$d" ] && sudo rm -rf "$d/STEffect.plugin" "$d/STBridge.plugin"
done

echo "2/3  Tracker panel -> $EXT"
rm -rf "$EXT"
mkdir -p "$(dirname "$EXT")"
cp -R extension "$EXT"
xattr -dr com.apple.quarantine "$EXT" 2>/dev/null || true

echo "3/3  Allowing the (unsigned) panel to load in After Effects"
for v in 9 10 11 12 13 14; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

echo
echo "Done. Restart After Effects, then:"
echo " - Settings > Scripting & Expressions: tick \"Allow Scripts to Write Files and Access Network\""
echo " - Effect > TeeVy > 3D Surface Tracker, then click \"Open tracker\""
echo
read -r -p "Press Return to close." _ || true
