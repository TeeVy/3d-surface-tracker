"""Session du panneau : un processus qui garde le plan en mémoire.

Les images sont celles du calque tracké telles qu'elles arrivent à l'effet
« 3D Surface Tracker » : After Effects les calcule et les envoie en mémoire par le
pont STBridge (voir bridge.py). Au démarrage, une passe charge toutes les images de
la séquence (niveaux de gris, à l'échelle du tracking) et écrit les vignettes de la
timeline, en commençant par l'image de référence.

Le panneau envoie ensuite des commandes JSON, une par ligne, sur l'entrée standard :

  {"id": 1, "cmd": "frame", "k": 12, "out": "/…/f.jpg"}         image pleine résolution
  {"id": 2, "cmd": "track", "k": 12, "dir": 1, "count": 0, …}     suivi (count 0 : jusqu'au bout)
  {"cmd": "stop"}                                                  arrête le suivi en cours
  {"id": 3, "cmd": "solve", "Hs": {"12": [9 nombres]}, …}         pose 3D (ou 2D) par image

L'image k de la séquence est l'image k du calque dans la compo (instant times[k]).
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

from .ae_export import build_ae_data
from .bridge import Bridge
from .geometry import warp_points
from .metadata import read_lens_info
from .pipeline import Result, choose_focal, solve
from .pose import solve_poses_2d
from .surface import DiscSurface, RectSurface
from .tracker import PlanarTracker, TrackResult

_lock = threading.Lock()


def emit(**kw):
    line = json.dumps(kw, ensure_ascii=False) + "\n"
    with _lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def _radii(c):
    return np.broadcast_to(np.asarray(c.get("roundness", 0), float), (4,))


def make_surface(c, for_pose=False):
    """Rectangle (4 coins HG, HD, BD, BG) aux coins éventuellement arrondis. Pour la pose 3D,
    les 4 coins arrondis à fond font un disque (son bord donne l'inclinaison)."""
    pts = np.asarray(c["points"], float).reshape(-1, 2)
    if len(pts) != 4:
        raise ValueError("The surface needs exactly 4 corners.")
    r = _radii(c)
    if for_pose and np.all(r >= 0.999):
        return DiscSurface.from_square(pts)
    return RectSurface(pts, r)


def _area(poly):
    x, y = poly[:, 0], poly[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))


def _mat(v):
    return np.asarray(v, float).reshape(3, 3)


class Session:
    def __init__(self, seq, thumbs_dir, thumb_side=720):
        self.times = [float(t) for t in seq["times"]]   # instant (compo) de chaque image
        self.n = len(self.times)
        self.layer = seq["layer"]                         # {comp, layer, effect} (numéros ExtendScript)
        self.comp_fps = float(seq["fps"])
        self.seq_start = int(seq["start"])                # n° d'image compo de l'image 0
        self.first = int(seq.get("first") or 0)           # image à charger en premier (la référence)
        # plage déjà trackée (tracking repris de l'effet) : chargée juste après la référence
        self.priority = seq.get("priority") or [self.first, self.first]
        self.W, self.H = int(seq["width"]), int(seq["height"])
        # focale : lue dans le rush du calque (ou le plus bas du précomp), image par image
        self.lens_video = seq.get("lens_src")
        self.lens_frames = np.asarray(seq.get("lens_frames") or range(self.n), int)
        self.focal_scale = float(seq.get("focal_scale") or 1.0)
        self.lens = read_lens_info(self.lens_video) if self.lens_video and Path(self.lens_video).is_file() else None
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

    # ------------------------------------------------------------------ images
    def _render(self, br, k, ds):
        L = self.layer
        return br.render_layer(L["comp"], L["layer"], L["effect"], self.times[k], ds, color=True)

    def load_all(self):
        """Une passe : images de tracking en mémoire + vignettes sur disque, la référence d'abord."""
        first = min(max(self.first, 0), self.n - 1)
        a, b = sorted(min(max(int(v), 0), self.n - 1) for v in self.priority)
        a, b = min(a, first), max(b, first)
        # référence, puis le reste de la plage trackée (avant, arrière), puis le reste du plan
        order = (list(range(first, b + 1)) + list(range(first - 1, a - 1, -1))
                 + list(range(b + 1, self.n)) + list(range(a - 1, -1, -1)))
        ds = int(round(1 / self.scale))
        tw, th_ = int(round(self.W * self.scale)), int(round(self.H * self.scale))
        done, last, got = 0, 0.0, []
        try:
            br = Bridge()
            try:
                for k in order:
                    img = self._render(br, k, ds)
                    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                    if g.shape[1] != tw or g.shape[0] != th_:
                        g = cv2.resize(g, (tw, th_), interpolation=cv2.INTER_AREA)
                    th = self.thumbs / f"{k:05d}.jpg"
                    f = min(1.0, self.thumb_side / max(img.shape[:2]))
                    small = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA) if f < 1 else img
                    tmp = th.with_suffix(".tmp.jpg")
                    cv2.imwrite(str(tmp), small, [cv2.IMWRITE_JPEG_QUALITY, 78])
                    tmp.replace(th)  # le panneau ne voit jamais une vignette à moitié écrite
                    with self.cond:
                        self.gray[k] = g
                        self.cond.notify_all()
                    done += 1
                    got.append(k)
                    if time.time() - last > 0.2 or done == self.n:
                        last = time.time()
                        emit(type="loaded", done=done, total=self.n, got=got)
                        got = []
            finally:
                br.close()
        except Exception as e:  # noqa: BLE001
            self.load_error = str(e)
        with self.cond:
            self.cond.notify_all()
        if self.load_error:
            emit(type="log", msg="⚠ Frame loading: " + self.load_error)
            emit(type="load_error", msg=self.load_error)

    def frame(self, k):
        """Image k (niveaux de gris, échelle de tracking) ; attend qu'elle soit chargée."""
        with self.cond:
            while k not in self.gray:
                if self.load_error:
                    raise IOError(f"Frame {k + self.seq_start} unreadable: {self.load_error}")
                self.cond.wait(0.5)
            return self.gray[k]

    # ------------------------------------------------------------------ commandes
    def cmd_frame(self, c):
        k = int(c["k"])
        out = Path(c["out"])
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            br = Bridge()
            try:
                img = self._render(br, k, 1)
            finally:
                br.close()
            cv2.imwrite(str(out), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        return {"path": str(out)}

    def cmd_track(self, c):
        """Suit la surface depuis l'image k (dont l'homographie est connue) dans le sens dir,
        sur count images (0 : jusqu'au bout). Chaque image trackée est envoyée aussitôt."""
        k, d, count = int(c["k"]), int(c["dir"]), int(c.get("count") or 0)
        ref = int(c["ref"])
        poly = make_surface(c).track_polygon() * self.scale
        # disque : uniforme, il se suit par son bord (déjà robuste aux occultations) ; masquer ses
        # reflets ôterait le peu de texture qui fixe sa rotation
        tracker = PlanarTracker(robust=not bool(np.all(_radii(c) >= 0.999)))
        tracker.prepare(self.frame(ref), poly, ref)
        # clés de correction : formes sûres, qui servent aussi de modèles de recalage (anti-dérive)
        for key, Hk in (c.get("anchors") or {}).items():
            tracker.add_anchor(int(key), self.frame(int(key)), self.S @ _mat(Hk) @ self.Si, poly)
        H_prev = self.S @ _mat(c["H"]) @ self.Si
        dH = (H_prev @ np.linalg.inv(self.S @ _mat(c["Hprev"]) @ self.Si)) if c.get("Hprev") else np.eye(3)
        prev, i, done = k, k + d, 0
        area_prev = _area(warp_points(H_prev, poly))
        reason = "end"
        self.stop.clear()
        while 0 <= i < self.n:
            if count and done >= count:
                reason = "count"
                break
            if self.stop.is_set():
                reason = "stop"
                break
            H, conf, _ = tracker.step(self.frame(prev), self.frame(i), H_prev, dH, poly, i)
            area = _area(warp_points(H, poly)) if np.all(np.isfinite(H)) else np.nan
            ratio = area / area_prev if area_prev > 0 else np.nan
            if not np.isfinite(ratio) or conf < 0.3 or not 1 / 1.5 < ratio < 1.5:
                reason = "lost"
                emit(type="log", msg=f"Track lost at frame {i + self.seq_start} (confidence {conf:.2f}): stopped.")
                break
            emit(type="tracked", k=i, H=np.round(self.Si @ H @ self.S, 9).ravel().tolist(), conf=round(float(conf), 3))
            dH = H @ np.linalg.inv(H_prev)
            H_prev, prev, area_prev = H, i, area
            i += d
            done += 1
        return {"reason": reason, "last": prev, "done": done}

    def cmd_solve(self, c):
        """Pose de la surface dans chaque image trackée. mode « 3d » : orientation complète ;
        « 2d » : surface face à la caméra (position, échelle, rotation dans l'image)."""
        n = self.n
        Hs = np.full((n, 3, 3), np.nan)
        conf = np.zeros(n)
        for key, v in c["Hs"].items():
            Hs[int(key)] = _mat(v)
        for key, v in (c.get("conf") or {}).items():
            conf[int(key)] = v
        ref = int(c["ref"])
        Hs[ref], conf[ref] = np.eye(3), 1.0
        track = TrackResult(Hs, conf, np.zeros(n, bool), ref)
        mode2d = c.get("mode") == "2d"
        surf = make_surface(c, for_pose=not mode2d)
        disc = bool(np.all(_radii(c) >= 0.999))
        logs = []

        def log(m):
            logs.append(m)
            emit(type="log", msg=m)

        focal, source = choose_focal(self.lens_video, surf, track, self.W, self.H, None, c.get("focal_mm"), 36.0,
                                     self.lens_frames, log, scale=self.focal_scale)
        if mode2d:
            corners = track.warp(surf.corners)
            pose = solve_poses_2d(corners, focal, self.W, self.H, ref)
            sol = dict(pose=pose, corners=corners, ref_corners=surf.corners, conics=None)
            log("2D mode: surface facing the camera (position, scale and rotation in the image).")
        else:
            sol = solve(track, surf, self.W, self.H, focal, normal_hint=c.get("normal"), frames_small=_Frames(self),
                        track_scale=self.scale, log=log)
        pose = sol["pose"]
        res = Result(self.W, self.H, self.comp_fps, n, track, sol["ref_corners"], sol["corners"], pose, source,
                     surf, None, sol["conics"], frame_offset=self.seq_start, motion_mode="object",
                     roundness=None if disc else _radii(c).tolist())
        out = {}
        if pose.valid.any():
            ae = build_ae_data(res, "object")
            ae["shape"] = "disc" if disc else "rect"
            out["ae"] = ae  # valeurs d'images clés pour l'effet (panneau : « Appliquer le tracking »)
        frames_out = {}
        for i in np.flatnonzero(pose.valid):
            frames_out[str(int(i))] = {"R": np.round(pose.R[i], 7).ravel().tolist(),
                                       "t": np.round(pose.t[i], 5).tolist(),
                                       "f": round(float(pose.focal[i]), 3),
                                       "e": round(float(pose.reproj_error[i]), 3)}
        err = pose.reproj_error[pose.valid]
        out.update(poses=frames_out, size=[float(pose.size[0]), float(pose.size[1])],
                   kind="disc" if disc else "rect", focal_source=source, focal=float(np.median(pose.focal)),
                   error_mean=float(np.nanmean(err)) if len(err) else None,
                   error_max=float(np.nanmax(err)) if len(err) else None, log=logs)
        return out


class _Frames:
    """Accès aux images de tracking par indice de séquence (pour le suivi du bord d'un disque)."""

    def __init__(self, session):
        self.s = session

    def __getitem__(self, k):
        return self.s.frame(int(k))


def run_session(seq_path, thumbs_dir):
    with open(seq_path, encoding="utf-8") as fh:
        seq = json.load(fh)
    ses = Session(seq, thumbs_dir)
    lens = ses.lens
    emit(type="ready", width=ses.W, height=ses.H, n=ses.n, scale=ses.scale, thumbs=str(ses.thumbs),
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
