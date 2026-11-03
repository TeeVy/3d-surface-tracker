"""Mesure la précision du moteur sur une vidéo synthétique (avec vérité terrain).

Simule un utilisateur qui désigne la surface sur l'image de référence (avec un
peu d'imprécision), lance le pipeline complet, puis compare :
  - calage 2D : centre de la surface reprojeté vs réel (px) ;
  - inclinaison : angle entre la normale estimée et la vraie (degrés) ;
  - tremblement : variation de cette erreur d'une image à l'autre (degrés) ;
  - position 3D : à l'échelle près (inconnaissable depuis une image).
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from surftrack.pipeline import run  # noqa: E402
from surftrack.surface import DiscSurface, RectSurface  # noqa: E402


def evaluate(video, ref_frame=0, click_noise=1.0, smooth=None, known_focal=False, quiet=False):
    gt = json.loads(Path(video).with_name(Path(video).stem + "_gt.json").read_text())
    rng = np.random.default_rng(42)
    fr = gt["frames"][ref_frame]
    if gt.get("surface", "rect") == "disc":
        rim = np.array(fr["rim"])[::3]  # 12 points cliqués sur le bord
        surface = DiscSurface(rim + rng.normal(0, click_noise, rim.shape))
    else:
        surface = RectSurface(np.array(fr["corners"]) + rng.normal(0, click_noise, (4, 2)))
    log = (lambda *_: None) if quiet else (lambda m: print("  " + m))
    t0 = time.time()
    res = run(video, surface, ref_frame, focal_px=gt["focal"] if known_focal else None, smooth=smooth, log=log)
    dt = time.time() - t0

    R_gt = np.array([f["R"] for f in gt["frames"]])
    t_gt = np.array([f["t"] for f in gt["frames"]])
    n_est, n_gt = res.pose.R[:, :, 2], R_gt[:, :, 2]
    tilt = np.degrees(np.arccos(np.clip(np.sum(n_est * n_gt, axis=1), -1, 1)))
    jitter = np.abs(np.diff(tilt))
    F = gt["focal"]
    c_gt = F * t_gt[:, :2] / t_gt[:, 2:3]
    c_est = res.pose.focal[:, None] * res.pose.t[:, :2] / res.pose.t[:, 2:3]
    err2d = np.linalg.norm(c_est - c_gt, axis=1)
    s = t_gt[ref_frame][2] / res.pose.t[ref_frame][2]
    pos = np.linalg.norm(res.pose.t * s - t_gt, axis=1) / np.linalg.norm(t_gt, axis=1)
    return {
        "img/s": len(t_gt) / dt, "focale %": 100 * (np.median(res.pose.focal) / F - 1),
        "centre 2D moy px": err2d.mean(), "centre 2D max px": err2d.max(),
        "inclinaison moy °": tilt.mean(), "inclinaison max °": tilt.max(),
        "tremblement moy °": jitter.mean(), "position moy %": 100 * pos.mean(),
        "écart 3D/2D moy px": float(np.nanmean(res.pose.reproj_error)),
        "confiance min": float(res.track.confidence.min()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("videos", nargs="+")
    ap.add_argument("--ref-frame", type=int, default=0)
    ap.add_argument("--click-noise", type=float, default=1.0, help="imprécision des clics (px)")
    ap.add_argument("--smooth", type=float, default=None)
    ap.add_argument("--known-focal", action="store_true", help="donner la vraie focale (comme avec les métadonnées)")
    args = ap.parse_args()
    for v in args.videos:
        print(f"=== {v}")
        r = evaluate(v, args.ref_frame, args.click_noise, args.smooth, args.known_focal)
        print("  " + " | ".join(f"{k} {v:.2f}" for k, v in r.items()))


if __name__ == "__main__":
    main()
