"""3D Surface Tracker — commande principale (prototype).

Exemples :
  .venv/bin/python track.py ma_video.mp4 --pick                       # rectangle, cliqué
  .venv/bin/python track.py ma_video.mp4 --pick --surface disc        # disque, cliqué sur son bord
  .venv/bin/python track.py ma_video.mp4 --quad "812,400 1105,388 1120,602 800,610" --mode camera

Produit dans le dossier out/ :
  <nom>_AE.jsx       script à lancer dans After Effects
  <nom>_apercu.mp4   vidéo de contrôle (vert = zone trackée, cyan = surface 3D)
  <nom>_track.json   données brutes
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from surftrack.ae_export import build_ae_data, write_jsx
from surftrack.pipeline import run
from surftrack.preview import write_preview
from surftrack.surface import DiscSurface, RectSurface, fit_ellipse, ellipse_polygon
from surftrack.video import read_frame_bgr


def parse_points(text, n_min, n_max=None):
    pts = [tuple(float(v) for v in p.split(",")) for p in text.split()]
    if len(pts) < n_min or (n_max and len(pts) > n_max):
        raise SystemExit(f"Nombre de points incorrect : {len(pts)} (format \"x,y x,y …\")")
    return np.array(pts)


def pick_points(video, frame, kind):
    """Fenêtre de sélection. rect : 4 coins ; disc : au moins 5 points sur le bord."""
    import cv2

    img = read_frame_bgr(video, frame)
    s = min(1.0, 1500 / img.shape[1], 950 / img.shape[0])
    base = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    pts = []
    names = ["HAUT-GAUCHE", "HAUT-DROIT", "BAS-DROIT", "BAS-GAUCHE"]

    def on_mouse(ev, x, y, *_):
        if ev == cv2.EVENT_LBUTTONDOWN and (kind == "disc" or len(pts) < 4):
            pts.append((x / s, y / s))

    win = "3D Surface Tracker - Entree = valider, Retour arriere = annuler le dernier point, Echap = quitter"
    cv2.namedWindow(win)
    cv2.setMouseCallback(win, on_mouse)
    while True:
        view = base.copy()
        for p in pts:
            cv2.circle(view, (int(p[0] * s), int(p[1] * s)), 5, (0, 255, 0), -1)
        if kind == "rect":
            if len(pts) > 1:
                cv2.polylines(view, [np.int32(np.array(pts) * s)], len(pts) == 4, (0, 255, 0), 2)
            ready = len(pts) == 4
            hint = f"Cliquez le coin {names[len(pts)]}" if not ready else "Entree pour valider"
        else:
            ready = len(pts) >= 5
            if ready:
                c, ax, an = fit_ellipse(pts)
                cv2.polylines(view, [np.int32(ellipse_polygon(c, ax, an) * s)], True, (0, 255, 0), 2)
            hint = (f"Cliquez des points sur le BORD du disque ({len(pts)}/5 min., 8+ conseille)" if len(pts) < 8
                    else "Entree pour valider (ou ajoutez des points)")
        cv2.putText(view, hint, (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 5)
        cv2.putText(view, hint, (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 255), 2)
        cv2.imshow(win, view)
        key = cv2.waitKey(30) & 0xFF
        if key in (13, 10) and ready:
            break
        if key in (8, 127) and pts:
            pts.pop()
        if key == 27:
            cv2.destroyAllWindows()
            raise SystemExit("Annulé.")
    cv2.destroyAllWindows()
    cv2.waitKey(1)
    return np.array(pts)


def main():
    ap = argparse.ArgumentParser(description="Tracking 3D de surface plane -> After Effects")
    ap.add_argument("video")
    ap.add_argument("--surface", choices=["rect", "disc"], default="rect",
                    help="rect : rectangle (4 coins) ; disc : disque (points sur le bord)")
    ap.add_argument("--ref-frame", type=int, default=0, help="image où la surface est désignée (défaut 0)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--pick", action="store_true", help="désigner la surface dans une fenêtre")
    g.add_argument("--quad", help='rect : 4 coins "x,y x,y x,y x,y" (HG, HD, BD, BG)')
    g.add_argument("--rim", help='disc : au moins 5 points du bord "x,y x,y …"')
    ap.add_argument("--mode", choices=["auto", "object", "camera"], default="auto",
                    help="auto : détecté ; object : l'objet bouge (caméra fixe) ; camera : la caméra bouge")
    ap.add_argument("--focal", type=float, help="focale en pixels (sinon : métadonnées caméra, puis estimation)")
    ap.add_argument("--focal-mm", type=float, help="focale de l'objectif en mm, équivalent plein format")
    ap.add_argument("--sensor-mm", type=float, default=36.0, help="largeur du capteur en mm (défaut 36)")
    ap.add_argument("--aspect", type=float, help="rect : rapport largeur/hauteur réel si connu")
    ap.add_argument("--smooth", type=float, default=None,
                    help="stabilisation de l'inclinaison en images (0 = aucune ; défaut 2 rectangle, 4 disque)")
    ap.add_argument("--flip", action="store_true", help="disc : inverser l'inclinaison choisie automatiquement")
    ap.add_argument("--out", default="out", help="dossier de sortie")
    ap.add_argument("--no-preview", action="store_true")
    args = ap.parse_args()

    video = Path(args.video)
    if args.pick:
        pts = pick_points(video, args.ref_frame, args.surface)
    else:
        pts = parse_points(args.quad or args.rim, 4 if args.quad else 5, 4 if args.quad else None)
    surface = DiscSurface(pts) if args.surface == "disc" else RectSurface(pts)

    def progress(done, total, *_):
        print(f"\rTracking… {done}/{total}", end="" if done < total else "\n", flush=True)

    res = run(video, surface, args.ref_frame, focal_px=args.focal, focal_mm=args.focal_mm,
              sensor_mm=args.sensor_mm, aspect=args.aspect, smooth=args.smooth, flip=args.flip,
              progress=progress, mode=args.mode)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = video.stem
    jsx = out / f"{stem}_AE.jsx"
    write_jsx(jsx, build_ae_data(res, args.mode), name=f"ST {stem}")
    (out / f"{stem}_track.json").write_text(json.dumps({
        "video": str(video), "surface": args.surface, "points": pts.tolist(), "ref_frame": args.ref_frame,
        "focal": res.pose.focal.tolist(), "focal_source": res.focal_source, "size": res.pose.size,
        "corners": res.corners.tolist(), "confidence": res.track.confidence.tolist(),
        "R": res.pose.R.tolist(), "t": res.pose.t.tolist()}))
    print(f"Script After Effects : {jsx}")
    if res.alternative is not None:
        from dataclasses import replace
        alt = replace(res, pose=res.alternative[0], corners=res.alternative[1])
        jsx2 = out / f"{stem}_AE_inclinaison_inverse.jsx"
        write_jsx(jsx2, build_ae_data(alt, args.mode), name=f"ST {stem}")
        print(f"Variante (inclinaison inversée) : {jsx2}")
    if not args.no_preview:
        prev = out / f"{stem}_apercu.mp4"
        write_preview(video, prev, res)
        print(f"Aperçu : {prev}")


if __name__ == "__main__":
    sys.exit(main())
