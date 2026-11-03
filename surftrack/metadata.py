"""Lecture de la focale dans les métadonnées caméra.

Sony (XAVC : A7S III, FX3, FX6…) enregistre une piste « rtmd » de métadonnées
temporelles au format SMPTE RDD-18 : ouverture, mise au point, focale… pour
chaque image. On y lit :
  0x8000  ouverture (F)
  0x8004  focale équivalent 35 mm (m)
  0x8005  focale réelle (m)
"""

import re
import shutil
import subprocess
from dataclasses import dataclass

import numpy as np


@dataclass
class LensInfo:
    focal35_mm: float      # focale équivalent plein format
    focal_mm: float        # focale réelle
    fnumber: float
    camera: str
    lens: str
    varies: bool           # zoom pendant le plan
    per_frame_mm: np.ndarray = None  # focale équivalent 35 mm de chaque image

    def focal_px(self, width, height):
        # 36 mm = largeur d'un capteur plein format = grand côté de l'image
        return self.focal35_mm / 36.0 * max(width, height)

    def focal_px_per_frame(self, width, height, n):
        """Focale en pixels pour chacune des n images (zoom compris)."""
        f = np.asarray(self.per_frame_mm if self.per_frame_mm is not None else [self.focal35_mm], float)
        f = f[:n] if len(f) >= n else np.concatenate([f, np.full(n - len(f), f[-1])])
        return f / 36.0 * max(width, height)


def _rdd18_distance(v):
    """Distance RDD-18 sur 16 bits : 4 bits d'exposant signé (base 10) + 12 bits de mantisse, en mètres."""
    e = v >> 12
    if e >= 8:
        e -= 16
    return (v & 0x0FFF) * 10.0 ** e


def _tag(packet, tag):
    i = packet.find(tag.to_bytes(2, "big") + b"\x00\x02")
    if i < 0:
        return None
    return int.from_bytes(packet[i + 4:i + 6], "big")


def read_lens_info(path):
    """Renvoie LensInfo, ou None si la vidéo ne contient pas ces métadonnées."""
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        return None
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=index,codec_type,codec_tag_string",
                            "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    idx = None
    for line in probe.stdout.splitlines():
        parts = line.split(",")
        if len(parts) >= 3 and parts[2].strip() == "rtmd":
            idx = parts[0]
    if idx is None:
        return None
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", f"0:{idx}", "-c", "copy", "-f", "data", "-"],
                         capture_output=True).stdout
    pkt = subprocess.run(["ffprobe", "-v", "error", "-select_streams", idx, "-show_entries", "packet=size",
                          "-of", "csv=p=0", "-read_intervals", "%+#1", str(path)], capture_output=True, text=True)
    try:
        size = int(pkt.stdout.split()[0])
    except (IndexError, ValueError):
        return None
    f35, freal, fnum = [], [], []
    for k in range(len(raw) // size):
        p = raw[k * size:(k + 1) * size]
        v4, v5, v0 = _tag(p, 0x8004), _tag(p, 0x8005), _tag(p, 0x8000)
        if v4 is not None:
            f35.append(_rdd18_distance(v4) * 1000)
        if v5 is not None:
            freal.append(_rdd18_distance(v5) * 1000)
        if v0 is not None:
            fnum.append(2 ** (8 * (1 - v0 / 65536)))
    if not f35 and not freal:
        return None
    f35 = f35 or freal

    head = b""
    with open(path, "rb") as fh:  # le XML Sony (modèle caméra/objectif) est en fin de fichier
        fh.seek(0, 2)
        n = fh.tell()
        fh.seek(max(0, n - 200_000))
        head = fh.read()
    cam = re.search(rb'<Device[^>]*modelName="([^"]*)"', head)
    lens = re.search(rb'<Lens modelName="([^"]*)"', head)
    return LensInfo(
        focal35_mm=float(np.median(f35)),
        focal_mm=float(np.median(freal)) if freal else float(np.median(f35)),
        fnumber=float(np.median(fnum)) if fnum else float("nan"),
        camera=cam.group(1).decode(errors="replace") if cam else "?",
        lens=lens.group(1).decode(errors="replace") if lens else "?",
        varies=(max(f35) - min(f35)) > 0.5,
        per_frame_mm=np.array(f35),
    )
