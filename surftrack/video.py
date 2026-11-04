"""Lecture vidéo."""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Clip:
    frames: list  # images en niveaux de gris (uint8), éventuellement réduites
    fps: float
    width: int    # dimensions d'origine (pleine résolution)
    height: int
    scale: float = 1.0  # facteur de réduction des images stockées
    start: int = 0      # indice (dans le fichier) de la 1re image chargée


_IMG_EXT = (".jpg", ".jpeg", ".png", ".tif", ".tiff")


def _image_files(path):
    """Séquence d'images (rendu d'After Effects) : un dossier, images triées par nom. None sinon."""
    p = Path(path)
    if not p.is_dir():
        return None
    files = sorted(f for f in p.iterdir() if f.suffix.lower() in _IMG_EXT and not f.name.startswith("."))
    if not files:
        raise IOError(f"Aucune image dans le dossier : {path}")
    return files


class _SeqCapture:
    """Lecture d'une séquence d'images avec la même interface que cv2.VideoCapture."""

    def __init__(self, files, fps=25.0):
        self.files, self.i, self.fps = files, 0, fps

    def isOpened(self):
        return True

    def set(self, prop, value):
        if prop == cv2.CAP_PROP_POS_FRAMES:
            self.i = int(value)

    def get(self, prop):
        return {cv2.CAP_PROP_FRAME_COUNT: len(self.files), cv2.CAP_PROP_FPS: self.fps}.get(prop, 0)

    def read(self):
        if self.i >= len(self.files):
            return False, None
        img = cv2.imread(str(self.files[self.i]), cv2.IMREAD_COLOR)
        self.i += 1
        return img is not None, img

    def release(self):
        pass


def capture(path):
    files = _image_files(path)
    return _SeqCapture(files) if files is not None else cv2.VideoCapture(str(path))


def _open_at(path, start):
    """Ouvre la vidéo positionnée sur l'image `start` (saut exact vérifié sur les fichiers XAVC)."""
    cap = capture(path)
    if not cap.isOpened():
        raise IOError(f"Impossible d'ouvrir la vidéo : {path}")
    if start > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start)
    return cap


def frame_count(path):
    cap = capture(path)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    return n


def load_gray(path, max_frames=None, scale=1.0, start=0, end=None):
    """Images start..end (incluses) en niveaux de gris."""
    cap = _open_at(path, start)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    if end is not None:
        n_max = end - start + 1
        max_frames = n_max if max_frames is None else min(max_frames, n_max)
    frames = []
    while max_frames is None or len(frames) < max_frames:
        ok, img = cap.read()
        if not ok:
            break
        if not frames:
            h, w = img.shape[:2]
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        if scale != 1.0:
            g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        frames.append(g)
    cap.release()
    if not frames:
        raise IOError(f"Aucune image lisible dans : {path}")
    return Clip(frames, float(fps), w, h, scale, start)


def video_size(path):
    cap = capture(path)
    ok, img = cap.read()
    cap.release()
    if not ok:
        raise IOError(f"Impossible de lire : {path}")
    return img.shape[1], img.shape[0]


def read_frame_bgr(path, index):
    cap = _open_at(path, index)
    ok, img = cap.read()
    cap.release()
    if not ok:
        raise IOError(f"Impossible de lire l'image {index} de {path}")
    return img


def iter_bgr(path, start=0, end=None):
    cap = _open_at(path, start)
    i = start
    while end is None or i <= end:
        ok, img = cap.read()
        if not ok:
            break
        yield img
        i += 1
    cap.release()


def to_uint8_points(pts):
    return np.int32(np.round(np.asarray(pts).reshape(-1, 2)))
