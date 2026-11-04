"""Point d'entrée du moteur pour le panneau After Effects.

Toutes les sorties sur stdout sont des lignes JSON ({"type": ...}).

Sous-commandes :
  info    VIDEO                       dimensions, cadence, nombre d'images, focale des métadonnées
  frame   VIDEO INDEX OUT.jpg         extrait une image (pleine résolution)
  session VIDEO SEQ.json THUMBS_DIR   session du panneau : garde le plan en mémoire et répond
                                      aux commandes (voir surftrack/session.py)
"""

import argparse
import json
import sys
import traceback
from pathlib import Path

import cv2

from surftrack.metadata import read_lens_info
from surftrack.session import emit, run_session
from surftrack.video import read_frame_bgr


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


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("info")
    p.add_argument("video")
    p = sub.add_parser("frame")
    p.add_argument("video")
    p.add_argument("index", type=int)
    p.add_argument("out")
    p = sub.add_parser("session")
    p.add_argument("video")
    p.add_argument("seq", help="JSON {src: [image du fichier pour chaque image de la compo], fps, start}")
    p.add_argument("thumbs_dir")
    a = ap.parse_args()
    try:
        if a.cmd == "session":
            run_session(a.video, a.seq, a.thumbs_dir)
        else:
            {"info": cmd_info, "frame": cmd_frame}[a.cmd](a)
    except Exception as e:  # le panneau affiche le message
        emit(type="error", msg=str(e), trace=traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
