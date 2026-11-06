"""Faux pont After Effects pour tester le moteur sans AE : sert les images d'une vidéo
avec le protocole de native/STBridge (la compo, le calque et l'effet demandés sont ignorés ;
l'instant demandé est pris comme instant de la vidéo).

    .venv/bin/python tools/fake_bridge.py VIDEO SOCKET [--delay 0.02]
    ST_BRIDGE_SOCK=SOCKET .venv/bin/python engine.py session SEQ.json THUMBS
"""
import argparse
import os
import socket
import sys
import threading
import time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from surftrack.video import read_frame_bgr  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("video")
ap.add_argument("sock", help="chemin court (les sockets Unix sont limitées à ~104 caractères)")
ap.add_argument("--delay", type=float, default=0.0, help="temps de rendu simulé par image")
a = ap.parse_args()
fps = cv2.VideoCapture(a.video).get(cv2.CAP_PROP_FPS) or 25.0
lock = threading.Lock()


def serve(c):
    buf = b""
    while True:
        while b"\n" not in buf:
            d = c.recv(4096)
            if not d:
                c.close()
                return
            buf += d
        line, buf = buf.split(b"\n", 1)
        parts = line.decode().split()
        if parts[0] == "PING":
            c.sendall(b"OK STBridge 3\n")
            continue
        _, comp, layer, eff, tv, ts, ds, mode = parts[:8]
        with lock:
            img = read_frame_bgr(a.video, int(int(tv) / int(ts) * fps + 1e-4))
        time.sleep(a.delay)
        ds = int(ds)
        if ds > 1:
            img = cv2.resize(img, (img.shape[1] // ds, img.shape[0] // ds), interpolation=cv2.INTER_AREA)
        if mode == "G":
            img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        ch = 1 if img.ndim == 2 else 3
        c.sendall(f"OK {img.shape[1]} {img.shape[0]} {ch}\n".encode() + img.tobytes())


if os.path.exists(a.sock):
    os.unlink(a.sock)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(a.sock)
s.listen(8)
print("prêt", flush=True)
while True:
    conn, _ = s.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
