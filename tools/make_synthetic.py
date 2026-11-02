"""Génère une vidéo de test avec une surface plane dont la pose 3D exacte est connue.

Scénarios :
  object : caméra fixe, la surface bouge et tourne (objet tenu en main)
  camera : surface fixe (posée devant un mur), la caméra se déplace
  weak   : surface fixe, téléobjectif, caméra qui bouge à peine (faible perspective)
Surfaces : rect (texturée) ou disc (disque peu texturé avec reflet mobile, type
tête de sèche-cheveux).

Sortie : <out>.mp4 + <out>_gt.json (vérité terrain : focale, poses, coins).
"""

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from surftrack.geometry import euler_to_matrix, warp_points  # noqa: E402

W, H = 1920, 1080
F = 1600.0
K = np.array([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]])


def set_focal(f):
    global F, K
    F = f
    K = np.array([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]])


def make_disc_texture(size):
    """Disque clair presque uni : dégradé doux, anneau chromé, petit logo."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    c = (size - 1) / 2
    r = np.hypot(xx - c, yy - c) / c
    img = 200 + 25 * (xx - c) / c - 10 * r
    img = np.where(r > 0.86, 120 + 120 * np.abs(np.sin((r - 0.86) * 40)), img)  # anneau
    img = np.dstack([img, img, img * 1.02]).clip(0, 255).astype(np.uint8)
    cv2.putText(img, "ST", (int(c - size * 0.08), int(c + size * 0.05)), cv2.FONT_HERSHEY_SIMPLEX,
                size / 400, (150, 150, 150), max(1, size // 120), cv2.LINE_AA)
    alpha = (r <= 1.0).astype(np.uint8) * 255
    return img, alpha


def make_texture(w, h, seed, label):
    rng = np.random.default_rng(seed)
    img = np.zeros((h, w, 3), np.float32)
    for scale in (4, 16, 64):
        n = rng.random((h // scale + 2, w // scale + 2, 3)).astype(np.float32)
        img += cv2.resize(n, (w, h), interpolation=cv2.INTER_CUBIC)[:h, :w] * (scale / 84)
    img = (img - img.min()) / (img.max() - img.min()) * 160 + 40
    img = img.astype(np.uint8)
    for _ in range(40):
        color = tuple(int(c) for c in rng.integers(0, 255, 3))
        x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
        r = int(rng.integers(8, max(9, min(w, h) // 8)))
        if rng.random() < 0.5:
            cv2.circle(img, (x, y), r, color, -1, cv2.LINE_AA)
        else:
            cv2.rectangle(img, (x, y), (x + r, y + int(r * 0.6)), color, -1)
    for i in range(6):
        cv2.putText(img, f"{label}{i}", (int(rng.integers(0, w - 200)), int(rng.integers(40, h))),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 3, cv2.LINE_AA)
    return img


def plane_homography(R, t, Wo, Ho, tex_w, tex_h):
    """Homographie texture(pixels) -> image pour un plan centré de taille Wo x Ho."""
    A = np.array([[Wo / tex_w, 0, -Wo / 2], [0, Ho / tex_h, -Ho / 2], [0, 0, 1]])
    return K @ np.column_stack([R[:, 0], R[:, 1], t]) @ A


def render_plane(frame, tex, Hm, gain=1.0, alpha=None, highlight=None):
    h, w = frame.shape[:2]
    if highlight is not None:  # reflet spéculaire qui glisse sur la surface
        hx, hy = highlight
        yy, xx = np.mgrid[0:tex.shape[0], 0:tex.shape[1]]
        spot = 90 * np.exp(-(((xx - hx) / (0.12 * tex.shape[1])) ** 2 + ((yy - hy) / (0.25 * tex.shape[0])) ** 2))
        tex = np.clip(tex.astype(np.float32) + spot[..., None], 0, 255).astype(np.uint8)
    warped = cv2.warpPerspective(tex, Hm, (w, h), flags=cv2.INTER_LINEAR)
    a = np.full(tex.shape[:2], 255, np.uint8) if alpha is None else alpha
    mask = cv2.warpPerspective(a, Hm, (w, h))
    m = (mask.astype(np.float32) / 255)[..., None]
    return (frame * (1 - m) + np.clip(warped * gain, 0, 255) * m).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=["object", "camera", "weak"], default="object")
    ap.add_argument("--surface", choices=["rect", "disc"], default="rect")
    ap.add_argument("--frames", type=int, default=120)
    ap.add_argument("--fps", type=float, default=25.0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.scenario == "weak":
        set_focal(5000.0)  # ~95 mm sur 1920 px
    Wo, Ho = (600.0, 400.0) if args.surface == "rect" else (500.0, 500.0)
    if args.surface == "rect":
        tex, alpha = make_texture(900, 600, 1, "SURF"), None
    else:
        tex, alpha = make_disc_texture(600)
    wall_tex = make_texture(1600, 1000, 2, "WALL")
    wall_w, wall_h = 6000.0, 3750.0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(out.with_suffix(".mp4")), cv2.VideoWriter_fourcc(*"mp4v"), args.fps, (W, H))
    rng = np.random.default_rng(0)
    gt = {"surface": args.surface, "focal": None, "width": W, "height": H, "fps": args.fps, "plane_size": [Wo, Ho],
          "scenario": args.scenario, "frames": []}

    for i in range(args.frames):
        s = i / max(1, args.frames - 1)
        if args.scenario == "object":
            # caméra = monde ; la surface tourne et se déplace
            Rc, tc = np.eye(3), np.zeros(3)
            Ro = euler_to_matrix([10 + 30 * np.sin(2 * np.pi * s), 35 * np.sin(np.pi * s * 1.5),
                                  12 * np.sin(2 * np.pi * s * 0.7)], "xyz")
            to = np.array([200 * np.sin(2 * np.pi * s), -80 * np.cos(np.pi * s), 1900 + 500 * np.sin(np.pi * s)])
        elif args.scenario == "weak":
            # surface fixe et lointaine, caméra quasi immobile (léger flottement à l'épaule)
            Ro = euler_to_matrix([-20, 25, 5], "xyz")
            to = np.array([0.0, 0.0, 6000.0])
            Rc = euler_to_matrix([1.0 * np.sin(2 * np.pi * s * 1.3), 1.5 * np.sin(2 * np.pi * s * 0.8),
                                  0.8 * np.sin(2 * np.pi * s * 2.1)], "xyz")
            tc = np.array([40 * np.sin(2 * np.pi * s), 20 * np.sin(2 * np.pi * s * 1.7), 60 * s])
        else:
            # surface fixe dans le monde ; la caméra orbite autour
            Ro = euler_to_matrix([-15, 20, 5], "xyz")
            to = np.array([0.0, 0.0, 2000.0])
            yaw = np.radians(-25 + 50 * s)
            pitch = np.radians(8 * np.sin(2 * np.pi * s))
            cam_pos = np.array([1200 * np.sin(yaw), -150 + 100 * s, 2000 - 1400 * np.cos(yaw)])
            # regarder vers la surface
            fwd = (to - cam_pos) / np.linalg.norm(to - cam_pos)
            right = np.cross([0, 1, 0], fwd)
            right /= np.linalg.norm(right)
            down = np.cross(fwd, right)
            Rcw = np.column_stack([right, down, fwd]) @ euler_to_matrix([np.degrees(pitch), 0, 3 * np.sin(4 * s)], "xyz")
            Rc = Rcw.T
            tc = -Rc @ cam_pos
        # surface et mur exprimés dans le repère caméra
        R_tc, t_tc = Rc @ Ro, Rc @ to + tc
        R_wc, t_wc = Rc, Rc @ np.array([0, 0, 4500.0 if args.scenario != "weak" else 14000.0]) + tc
        if args.scenario == "weak":
            wall_w, wall_h = 18000.0, 11250.0

        frame = np.full((H, W, 3), 30, np.float32)
        frame = render_plane(frame, wall_tex, plane_homography(R_wc, t_wc, wall_w, wall_h, *wall_tex.shape[1::-1]))
        Ht = plane_homography(R_tc, t_tc, Wo, Ho, *tex.shape[1::-1])
        gain = 0.85 + 0.3 * np.sin(2 * np.pi * s * 1.3) ** 2  # variation de lumière
        hl = None if args.surface == "rect" else (tex.shape[1] * (0.3 + 0.4 * s), tex.shape[0] * 0.35)
        frame = render_plane(frame, tex, Ht, gain, alpha, hl)
        frame += rng.normal(0, 3, frame.shape)
        frame = cv2.GaussianBlur(np.clip(frame, 0, 255).astype(np.uint8), (3, 3), 0.6)
        writer.write(frame)

        corners = warp_points(Ht, [[0, 0], [tex.shape[1], 0], [tex.shape[1], tex.shape[0]], [0, tex.shape[0]]])
        a = np.linspace(0, 2 * np.pi, 36, endpoint=False)
        rim = warp_points(Ht, np.column_stack([(1 + np.cos(a)) * tex.shape[1] / 2, (1 + np.sin(a)) * tex.shape[0] / 2]))
        gt["frames"].append({"R": R_tc.tolist(), "t": t_tc.tolist(), "corners": corners.tolist(), "rim": rim.tolist()})

    writer.release()
    gt["focal"] = F
    Path(str(out.with_suffix("")) + "_gt.json").write_text(json.dumps(gt))
    print(f"OK : {out.with_suffix('.mp4')} ({args.frames} images)")


if __name__ == "__main__":
    main()
