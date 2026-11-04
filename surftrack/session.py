"""Session du panneau : un processus qui garde le plan en mémoire.

Au démarrage, une seule passe de décodage charge les images de la séquence (en
niveaux de gris, à l'échelle du tracking) et écrit les vignettes de la timeline.
Le panneau envoie ensuite des commandes JSON, une par ligne, sur l'entrée standard :

  {"id": 1, "cmd": "frame", "k": 12, "out": "/…/f.jpg"}         image pleine résolution
  {"id": 2, "cmd": "track", "k": 12, "dir": 1, "count": 0, …}     suivi (count 0 : jusqu'au bout)
  {"cmd": "stop"}                                                  arrête le suivi en cours
  {"id": 3, "cmd": "solve", "Hs": {"12": [9 nombres]}, …}         pose 3D + script AE

La séquence est celle de la compo : l'image k de la séquence montre l'image src[k]
du fichier (remappages et précomps déjà résolus par After Effects).
Le panneau garde les homographies (référence -> image k) : il peut annuler, et le
moteur reste sans état autre que les images.
"""

import json
import queue
import sys
import threading
import time
import traceback
from pathlib import Path

import cv2
import numpy as np

from .ae_export import build_ae_data, write_jsx
from .geometry import warp_points
from .metadata import read_lens_info
from .pipeline import Result, choose_focal, solve
from .surface import DiscSurface, FreeSurface, RectSurface
from .tracker import PlanarTracker, TrackResult
from .video import iter_bgr, read_frame_bgr, video_size

_lock = threading.Lock()


def emit(**kw):
    line = json.dumps(kw, ensure_ascii=False) + "\n"
    with _lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def make_surface(c):
    pts = np.asarray(c["points"], float).reshape(-1, 2)
    if c["tool"] == "rect":
        if len(pts) != 4:
            raise ValueError("Un rectangle se désigne par exactement 4 coins.")
        r = float(c.get("roundness", 0))
        return DiscSurface.from_square(pts) if r >= 0.999 else RectSurface(pts, r)
    return FreeSurface(pts)


def _area(poly):
    x, y = poly[:, 0], poly[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))


def _mat(v):
    return np.asarray(v, float).reshape(3, 3)


class Session:
    def __init__(self, video, seq, thumbs_dir, thumb_side=720):
        self.video = video
        self.src = np.asarray(seq["src"], int)
        # rendu d'AE (effets, stabilisation…) : la focale vient du rush d'origine, image par image
        self.lens_video = seq.get("lens_src") or video
        self.lens_frames = np.asarray(seq.get("lens_frames") or seq["src"], int)
        self.focal_scale = float(seq.get("focal_scale") or 1.0)
        self.comp_fps = float(seq["fps"])
        self.seq_start = int(seq["start"])
        self.W, self.H = video_size(video)
        self.scale = 0.5 if max(self.W, self.H) > 2600 else 1.0  # 4K : tracking en demi-résolution
        self.S = np.diag([self.scale, self.scale, 1.0])
        self.Si = np.linalg.inv(self.S)
        self.thumbs = Path(thumbs_dir)
        self.thumbs.mkdir(parents=True, exist_ok=True)
        self.thumb_side = thumb_side
        self.gray = {}
        self.cond = threading.Condition()
        self.load_error = None
        self.stop = threading.Event()
        self.lens = read_lens_info(self.lens_video)

    # ------------------------------------------------------------------ images
    def load_all(self):
        """Une passe de décodage : images de tracking en mémoire + vignettes sur disque."""
        need = set(self.src.tolist())
        lo, hi = min(need), max(need)
        done, last = 0, 0.0
        try:
            for s, img in enumerate(iter_bgr(self.video, lo, hi), start=lo):
                if s not in need:
                    continue
                g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                if self.scale != 1:
                    g = cv2.resize(g, None, fx=self.scale, fy=self.scale, interpolation=cv2.INTER_AREA)
                th = self.thumbs / f"{s:05d}.jpg"
                if not th.exists():
                    k = min(1.0, self.thumb_side / max(img.shape[:2]))
                    small = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
                    tmp = th.with_suffix(".tmp.jpg")
                    cv2.imwrite(str(tmp), small, [cv2.IMWRITE_JPEG_QUALITY, 78])
                    tmp.replace(th)  # le panneau ne voit jamais une vignette à moitié écrite
                with self.cond:
                    self.gray[s] = g
                    self.cond.notify_all()
                done += 1
                if time.time() - last > 0.2 or done == len(need):
                    last = time.time()
                    emit(type="loaded", done=done, total=len(need), upto=s)
        except Exception as e:  # noqa: BLE001
            self.load_error = str(e)
        with self.cond:
            if len(self.gray) < len(need) and self.load_error is None:
                self.load_error = f"vidéo plus courte que prévu ({len(self.gray)}/{len(need)} images lues)"
            self.cond.notify_all()
        if self.load_error:
            emit(type="log", msg="⚠ Lecture de la vidéo : " + self.load_error)

    def frame(self, k):
        """Image k de la séquence (niveaux de gris, échelle de tracking) ; attend son décodage."""
        s = int(self.src[k])
        with self.cond:
            while s not in self.gray:
                if self.load_error:
                    raise IOError(f"Image {s} du fichier illisible : {self.load_error}")
                self.cond.wait(0.5)
            return self.gray[s]

    # ------------------------------------------------------------------ commandes
    def cmd_frame(self, c):
        s = int(self.src[c["k"]])
        out = Path(c["out"])
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(out), read_frame_bgr(self.video, s), [cv2.IMWRITE_JPEG_QUALITY, 92])
        return {"path": str(out), "src": s}

    def cmd_track(self, c):
        """Suit la surface depuis l'image k (dont l'homographie est connue) dans le sens dir,
        sur count images (0 : jusqu'au bout). Chaque image trackée est envoyée aussitôt."""
        n = len(self.src)
        k, d, count = int(c["k"]), int(c["dir"]), int(c.get("count") or 0)
        ref = int(c["ref"])
        surf = make_surface(c)
        poly = surf.track_polygon() * self.scale
        tracker = PlanarTracker()
        tracker.prepare(self.frame(ref), poly)
        H_prev = self.S @ _mat(c["H"]) @ self.Si
        dH = (H_prev @ np.linalg.inv(self.S @ _mat(c["Hprev"]) @ self.Si)) if c.get("Hprev") else np.eye(3)
        prev, i, done = k, k + d, 0
        area_prev = _area(warp_points(H_prev, poly))
        reason = "end"
        self.stop.clear()
        while 0 <= i < n:
            if count and done >= count:
                reason = "count"
                break
            if self.stop.is_set():
                reason = "stop"
                break
            if self.src[i] == self.src[prev]:  # même image du fichier (arrêt sur image, ralenti)
                H, conf = H_prev, 1.0
            else:
                H, conf, _ = tracker.step(self.frame(prev), self.frame(i), H_prev, dH, poly)
            area = _area(warp_points(H, poly)) if np.all(np.isfinite(H)) else np.nan
            ratio = area / area_prev if area_prev > 0 else np.nan
            if not np.isfinite(ratio) or conf < 0.3 or not 1 / 1.5 < ratio < 1.5:
                reason = "lost"
                emit(type="log", msg=f"Suivi perdu sur l'image {i + self.seq_start} (confiance {conf:.2f}) : arrêt.")
                break
            emit(type="tracked", k=i, H=np.round(self.Si @ H @ self.S, 9).ravel().tolist(), conf=round(float(conf), 3))
            dH = H @ np.linalg.inv(H_prev)
            H_prev, prev, area_prev = H, i, area
            i += d
            done += 1
        return {"reason": reason, "last": prev, "done": done}

    def cmd_solve(self, c):
        n = len(self.src)
        Hs = np.full((n, 3, 3), np.nan)
        conf = np.zeros(n)
        for key, v in c["Hs"].items():
            Hs[int(key)] = _mat(v)
        for key, v in (c.get("conf") or {}).items():
            conf[int(key)] = v
        ref = int(c["ref"])
        Hs[ref], conf[ref] = np.eye(3), 1.0
        track = TrackResult(Hs, conf, np.zeros(n, bool), ref)
        surf = make_surface(c)
        logs = []

        def log(m):
            logs.append(m)
            emit(type="log", msg=m)

        focal, source = choose_focal(self.lens_video, surf, track, self.W, self.H, None, c.get("focal_mm"), 36.0,
                                     self.lens_frames, log, scale=self.focal_scale)
        frames = _Frames(self)
        sol = solve(track, surf, self.W, self.H, focal, normal_hint=c.get("normal"), frames_small=frames,
                    track_scale=self.scale, log=log)
        pose = sol["pose"]
        res = Result(self.W, self.H, self.comp_fps, n, track, sol["ref_corners"], sol["corners"], pose, source,
                     surf, None, sol["conics"], frame_offset=self.seq_start, motion_mode="object",
                     outline=sol["outline"])
        out = {}
        if pose.valid.any():
            jsx = Path(c["out"])
            jsx.parent.mkdir(parents=True, exist_ok=True)
            write_jsx(jsx, build_ae_data(res, "object"), name=f"ST {c.get('name') or Path(self.video).stem}")
            out["jsx"] = str(jsx)
        frames_out = {}
        for i in np.flatnonzero(pose.valid):
            frames_out[str(int(i))] = {"R": np.round(pose.R[i], 7).ravel().tolist(),
                                       "t": np.round(pose.t[i], 5).tolist(),
                                       "f": round(float(pose.focal[i]), 3),
                                       "e": round(float(pose.reproj_error[i]), 3)}
        err = pose.reproj_error[pose.valid]
        out.update(poses=frames_out, size=[float(pose.size[0]), float(pose.size[1])], kind=surf.kind,
                   outline=None if sol["outline"] is None else np.round(sol["outline"], 5).tolist(),
                   focal_source=source, focal=float(np.median(pose.focal)),
                   error_mean=float(np.nanmean(err)) if len(err) else None,
                   error_max=float(np.nanmax(err)) if len(err) else None, log=logs)
        return out


class _Frames:
    """Accès aux images de tracking par indice de séquence (pour le suivi du bord d'un disque)."""

    def __init__(self, session):
        self.s = session

    def __getitem__(self, k):
        return self.s.frame(int(k))


def run_session(video, seq_path, thumbs_dir):
    with open(seq_path, encoding="utf-8") as fh:
        seq = json.load(fh)
    ses = Session(video, seq, thumbs_dir)
    lens = ses.lens
    emit(type="ready", width=ses.W, height=ses.H, n=len(ses.src), scale=ses.scale,
         thumbs=str(ses.thumbs),
         lens=None if lens is None else {"camera": lens.camera, "lens": lens.lens,
                                          "focal35_mm": round(lens.focal35_mm, 2)})
    threading.Thread(target=ses.load_all, daemon=True).start()

    jobs = queue.Queue()

    def worker():
        while True:
            c = jobs.get()
            try:
                fn = {"frame": ses.cmd_frame, "track": ses.cmd_track, "solve": ses.cmd_solve}[c["cmd"]]
                emit(type="reply", id=c.get("id"), **fn(c))
            except Exception as e:  # noqa: BLE001 — le panneau affiche le message
                emit(type="reply", id=c.get("id"), error=str(e), trace=traceback.format_exc())

    threading.Thread(target=worker, daemon=True).start()
    for line in sys.stdin:  # le panneau ferme l'entrée standard : fin de la session
        line = line.strip()
        if not line:
            continue
        try:
            c = json.loads(line)
        except ValueError:
            continue
        if c.get("cmd") == "stop":
            ses.stop.set()
        else:
            jobs.put(c)
