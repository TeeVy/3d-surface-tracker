"""Faux pont After Effects pour tester le moteur sans AE : sert les images d'une vidéo
avec le protocole de native/STBridge (la compo, le calque et l'effet demandés sont ignorés ;
l'instant demandé est pris comme instant de la vidéo).

    .venv/bin/python tools/fake_bridge.py VIDEO INFO.json [--delay 0.02]
    ST_BRIDGE_INFO=INFO.json .venv/bin/python engine.py session SEQ.json THUMBS
"""
import argparse
import json
import secrets
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
ap.add_argument("info", help="fichier bridge.json à écrire (port et jeton)")
ap.add_argument("--delay", type=float, default=0.0, help="temps de rendu simulé par image")
a = ap.parse_args()
fps = cv2.VideoCapture(a.video).get(cv2.CAP_PROP_FPS) or 25.0
lock = threading.Lock()


TOKEN = secrets.token_hex(16)


def serve(c):
    buf = b""
    authed = False
    while True:
        while b"\n" not in buf:
            d = c.recv(4096)
            if not d:
                c.close()
                return
            buf += d
        line, buf = buf.split(b"\n", 1)
        parts = line.decode().split()
        if not authed:
            if parts != ["AUTH", TOKEN]:
                c.close()
                return
            authed = True
            continue
        if parts[0] == "PING":
            c.sendall(b"OK STBridge 4\n")
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


s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
s.listen(8)
with open(a.info, "w", encoding="utf-8") as f:
    json.dump({"port": s.getsockname()[1], "token": TOKEN}, f)
print("prêt", flush=True)
while True:
    conn, _ = s.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
