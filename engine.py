"""Point d'entrée du moteur pour le panneau After Effects.

Toutes les sorties sur stdout sont des lignes JSON :
  {"type": "log", "msg": "..."}
  {"type": "progress", "stage": "track", "done": 12, "total": 216}
  {"type": "result", ...}
  {"type": "error", "msg": "..."}

Sous-commandes :
  info  VIDEO                         dimensions, cadence, nombre d'images, focale des métadonnées
  frame VIDEO INDEX OUT.jpg           extrait une image (pleine résolution, orientation corrigée)
  track VIDEO --surface rect|disc|free --points "x,y x,y ..." --ref-frame N [--start A --end B]
        [--mode auto|object|camera] --out-dir DIR [--focal-mm F] [--smooth S] [--name NOM]
        Pendant le tracking : lignes {"type": "live", ...} (aperçu) ; écrire « stop » sur
        l'entrée standard arrête le tracking en gardant les images déjà trackées.
"""

import argparse
import base64
import json
import sys
import threading
import time
import traceback
from dataclasses import replace
from pathlib import Path

import cv2
import numpy as np

from surftrack.ae_export import build_ae_data, write_jsx
from surftrack.metadata import read_lens_info
from surftrack.pipeline import run
from surftrack.preview import write_preview_jpgs
from surftrack.surface import DiscSurface, FreeSurface, RectSurface
from surftrack.video import read_frame_bgr


def emit(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def cmd_info(a):
    cap = cv2.VideoCapture(a.video)
    if not cap.isOpened():
        raise IOError(f"Impossible d'ouvrir la vidéo : {a.video}")
    ok, img = cap.read()
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    lens = read_lens_info(a.video)
    emit(type="result", width=img.shape[1], height=img.shape[0], fps=fps, frames=n,
         lens=None if lens is None else {"camera": lens.camera, "lens": lens.lens,
                                          "focal35_mm": round(lens.focal35_mm, 2)})


def cmd_frame(a):
    img = read_frame_bgr(a.video, a.index)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(a.out, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    emit(type="result", path=a.out, width=img.shape[1], height=img.shape[0])


def cmd_track(a):
    pts = np.array([tuple(float(v) for v in p.split(",")) for p in a.points.split()])
    if a.surface == "rect" and len(pts) != 4:
        raise ValueError("Un rectangle se désigne par exactement 4 coins.")
    if a.surface == "disc" and len(pts) < 5:
        raise ValueError("Il faut au moins 5 points sur le bord du disque.")
    surface = {"rect": RectSurface, "disc": DiscSurface, "free": FreeSurface}[a.surface](pts)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    # arrêt à la demande : le panneau écrit « stop » sur l'entrée standard
    stop = threading.Event()

    def watch_stdin():
        for line in sys.stdin:
            if line.strip() == "stop":
                stop.set()
    threading.Thread(target=watch_stdin, daemon=True).start()

    def progress(done, total):
        if done % 2 == 0 or done == total:
            emit(type="progress", stage="track", done=done, total=total)

    last = [0.0]

    def live(frame, img, H, poly):
        """Aperçu en direct, ~12 images/s au plus : image réduite + zone suivie."""
        now = time.time()
        if now - last[0] < 0.08:
            return
        last[0] = now
        s = min(1.0, 480 / max(img.shape))
        small = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
        q = np.column_stack([poly, np.ones(len(poly))]) @ H.T
        emit(type="live", frame=frame, w=small.shape[1], h=small.shape[0],
             img="data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode(),
             poly=np.round(q[:, :2] / q[:, 2:3] * s, 1).tolist())

    frame_range = (a.start, a.end) if a.start is not None and a.end is not None else None
    res = run(a.video, surface, a.ref_frame, focal_mm=a.focal_mm, smooth=a.smooth, flip=False,
              log=lambda m: emit(type="log", msg=m), progress=progress, frame_range=frame_range,
              should_stop=stop.is_set, live=live, mode=a.mode)

    name = a.name or Path(a.video).stem
    jsx = out / "apply.jsx"
    write_jsx(jsx, build_ae_data(res, a.mode), name=f"ST {name}")
    emit(type="progress", stage="preview", done=0, total=1)
    write_preview_jpgs(a.video, out / "preview", res)
    alt_jsx = None
    if res.alternative is not None:
        alt = replace(res, pose=res.alternative[0], corners=res.alternative[1])
        alt_jsx = out / "apply_inverse.jsx"
        write_jsx(alt_jsx, build_ae_data(alt, a.mode), name=f"ST {name}")
        write_preview_jpgs(a.video, out / "preview_inverse", res, pose=alt.pose)
    emit(type="progress", stage="preview", done=1, total=1)

    off = res.frame_offset
    emit(type="result", jsx=str(jsx), alt_jsx=str(alt_jsx) if alt_jsx else None,
         preview_dir=str(out / "preview"),
         alt_preview_dir=str(out / "preview_inverse") if alt_jsx else None,
         start=off, end=off + res.n_frames - 1, frames=res.n_frames,
         lost=(np.flatnonzero(~res.pose.valid) + off).tolist(), stopped=res.stopped,
         motion=res.motion_mode if a.mode == "auto" else a.mode, motion_why=res.motion_why,
         focal=float(np.median(res.pose.focal)), focal_source=res.focal_source,
         error_mean=float(np.nanmean(res.pose.reproj_error)),
         error_max=float(np.nanmax(res.pose.reproj_error)))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("info")
    p.add_argument("video")
    p = sub.add_parser("frame")
    p.add_argument("video")
    p.add_argument("index", type=int)
    p.add_argument("out")
    p = sub.add_parser("track")
    p.add_argument("video")
    p.add_argument("--surface", choices=["rect", "disc", "free"], required=True)
    p.add_argument("--points", required=True)
    p.add_argument("--ref-frame", type=int, default=0)
    p.add_argument("--mode", choices=["auto", "object", "camera"], default="auto")
    p.add_argument("--start", type=int, help="première image du fichier à tracker")
    p.add_argument("--end", type=int, help="dernière image du fichier à tracker (incluse)")
    p.add_argument("--focal-mm", type=float)
    p.add_argument("--smooth", type=float)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--name")
    a = ap.parse_args()
    try:
        {"info": cmd_info, "frame": cmd_frame, "track": cmd_track}[a.cmd](a)
    except Exception as e:  # le panneau affiche le message
        emit(type="error", msg=str(e), trace=traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
