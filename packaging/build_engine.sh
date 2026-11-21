#!/bin/bash
# Moteur de tracking autonome (PyInstaller) : aucun Python à installer chez l'utilisateur.
#
# OpenCV est compilé ici avec les seuls modules dont le moteur se sert (core, imgproc, video,
# calib3d, imgcodecs) : les paquets OpenCV officiels pour macOS embarquent FFmpeg et des codecs
# vidéo sous GPL (x264, x265), inutiles ici, et pèsent ~4 fois plus lourd.
# Un environnement de construction par architecture (out/build-venv-<arch>) ; la première
# construction d'OpenCV prend une quinzaine de minutes.
#
# Usage : packaging/build_engine.sh [arm64|x86_64]   (défaut : l'architecture de ce Mac)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${1:-$(uname -m)}"
VENV="$ROOT/out/build-venv-$ARCH"
OUT="$ROOT/out/engine/$ARCH"
RUN=(arch "-$ARCH")
OPENCV_VERSION="4.14.0.94"

if [ ! -x "$VENV/bin/python" ]; then
  "${RUN[@]}" /usr/bin/python3 -m venv "$VENV"
  "${RUN[@]}" "$VENV/bin/pip" install -q --upgrade pip
  "${RUN[@]}" "$VENV/bin/pip" install -q "numpy>=1.24,<2.1" pyinstaller
fi
if ! "${RUN[@]}" "$VENV/bin/python" -c "import cv2" 2>/dev/null; then
  echo "Compilation d'OpenCV $OPENCV_VERSION ($ARCH, modules minimaux)…"
  export ENABLE_HEADLESS=1 MACOSX_DEPLOYMENT_TARGET=11.0 MAKEFLAGS="-j$(sysctl -n hw.ncpu)"
  export CMAKE_ARGS="-DBUILD_LIST=core,imgproc,video,calib3d,features2d,flann,imgcodecs,python3 \
    -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DWITH_OPENEXR=OFF -DWITH_TIFF=OFF -DWITH_WEBP=OFF \
    -DWITH_OPENJPEG=OFF -DWITH_JASPER=OFF -DWITH_AVIF=OFF -DWITH_JPEGXL=OFF -DWITH_IMGCODEC_HDR=OFF \
    -DWITH_IMGCODEC_SUNRASTER=OFF -DWITH_IMGCODEC_PXM=OFF -DWITH_IMGCODEC_PFM=OFF -DWITH_PROTOBUF=OFF \
    -DWITH_QUIRC=OFF -DWITH_ITT=OFF -DWITH_OPENCL=OFF -DWITH_ADE=OFF -DWITH_LAPACK=OFF -DWITH_EIGEN=OFF \
    -DBUILD_JPEG=ON -DBUILD_PNG=ON -DBUILD_ZLIB=ON"
  "${RUN[@]}" "$VENV/bin/pip" install --no-binary opencv-python-headless --no-deps \
    "opencv-python-headless==$OPENCV_VERSION"
fi

rm -rf "$OUT" "$ROOT/out/engine-work-$ARCH"
"${RUN[@]}" "$VENV/bin/pyinstaller" --noconfirm --clean --log-level WARN --name st-engine --onedir \
  --distpath "$OUT" --workpath "$ROOT/out/engine-work-$ARCH" --specpath "$ROOT/out/engine-work-$ARCH" \
  --exclude-module tkinter "$ROOT/engine.py"
codesign --force --deep --sign - "$OUT/st-engine" >/dev/null 2>&1 || true   # signature locale
echo "Moteur : $OUT/st-engine ($(du -sh "$OUT/st-engine" | cut -f1))"
