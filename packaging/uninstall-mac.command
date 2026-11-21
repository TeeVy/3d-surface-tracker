#!/bin/bash
# 3D Surface Tracker — macOS uninstaller (projects keep their tracking data in the effect).
set -uo pipefail
echo "Removing 3D Surface Tracker (administrator password needed for the plug-ins)…"
sudo rm -rf "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/3D Surface Tracker"
for d in "/Applications/Adobe After Effects "*/Plug-ins; do
  [ -d "$d" ] && sudo rm -rf "$d/STEffect.plugin" "$d/STBridge.plugin"
done
rm -rf "$HOME/Library/Application Support/Adobe/CEP/extensions/com.surftrack.panel"
rm -rf "$HOME/Library/Application Support/3D Surface Tracker"
echo "Done. Restart After Effects."
read -r -p "Press Return to close." _ || true
