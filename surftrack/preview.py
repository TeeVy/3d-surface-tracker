"""Aperçu : zone trackée (vert) + surface 3D reprojetée (cyan), pour juger le résultat d'un coup d'œil."""

from pathlib import Path

import cv2
import numpy as np

from .video import iter_bgr


def _project(pose, i, pts3, width, height):
    X = pts3 @ pose.R[i].T + pose.t[i]
    return pose.focal[i] * X[:, :2] / X[:, 2:3] + [width / 2, height / 2]


def annotated_frames(video_path, res, pose=None, max_side=1600, label=True):
    """Générateur (index, image annotée réduite à max_side)."""
    W, H = res.width, res.height
    pose = pose or res.pose
    s = min(1.0, max_side / max(W, H))
    size = (int(W * s), int(H * s))
    w, h = pose.size
    lines = []
    for a in np.linspace(-0.5, 0.5, 9):
        lines.append(([a * w, -h / 2, 0], [a * w, h / 2, 0]))
        lines.append(([-w / 2, a * h, 0], [w / 2, a * h, 0]))
    disc = None
    if res.surface.kind == "disc":
        t = np.linspace(0, 2 * np.pi, 72)
        disc = np.column_stack([w / 2 * np.cos(t), h / 2 * np.sin(t), np.zeros_like(t)])
    zone = res.surface.track_polygon()
    axis_len = 0.5 * min(w, h)

    for i, img in enumerate(iter_bgr(video_path)):
        if i >= res.n_frames:
            break
        img = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
        S = np.diag([s, s, 1.0])
        if pose.valid[i]:
            def proj(p):
                return _project(pose, i, p, W, H) * s
            for p, q in lines:
                a, b = proj(np.array([p, q], float))
                cv2.line(img, tuple(np.int32(a)), tuple(np.int32(b)), (255, 220, 0), 1, cv2.LINE_AA)
            if disc is not None:
                cv2.polylines(img, [np.int32(proj(disc))], True, (255, 220, 0), 2, cv2.LINE_AA)
            Hs = S @ res.track.homographies[i]
            poly = np.column_stack([zone, np.ones(len(zone))]) @ Hs.T
            cv2.polylines(img, [np.int32(poly[:, :2] / poly[:, 2:3])], True, (0, 255, 0), 1, cv2.LINE_AA)
            o, x, y, z = proj(np.array([[0, 0, 0], [axis_len, 0, 0], [0, axis_len, 0], [0, 0, -axis_len]], float))
            for end, col in ((x, (0, 0, 255)), (y, (0, 255, 0)), (z, (255, 0, 0))):
                cv2.arrowedLine(img, tuple(np.int32(o)), tuple(np.int32(end)), col, 2, cv2.LINE_AA, tipLength=0.15)
        if label:
            conf = res.track.confidence[i]
            color = (0, 200, 0) if conf >= 0.8 else (0, 200, 255) if conf >= 0.6 else (0, 0, 255)
            text = f"image {i}  confiance {conf:.2f}" + ("" if pose.valid[i] else "  PERDU")
            fs = max(0.4, size[0] / 1400)
            cv2.putText(img, text, (10, int(30 * fs / 0.6)), cv2.FONT_HERSHEY_SIMPLEX, fs, (0, 0, 0), 4, cv2.LINE_AA)
            cv2.putText(img, text, (10, int(30 * fs / 0.6)), cv2.FONT_HERSHEY_SIMPLEX, fs, color, 1, cv2.LINE_AA)
        yield i, img


def write_preview(video_path, out_path, res, max_side=1600):
    writer = None
    for _, img in annotated_frames(video_path, res, max_side=max_side):
        if writer is None:
            writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), res.fps,
                                     (img.shape[1], img.shape[0]))
        writer.write(img)
    if writer is not None:
        writer.release()


def write_preview_jpgs(video_path, out_dir, res, pose=None, max_side=720, quality=80):
    """Une image JPEG annotée par image vidéo (pour l'aperçu du panneau)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, img in annotated_frames(video_path, res, pose=pose, max_side=max_side, label=False):
        cv2.imwrite(str(out_dir / f"{i:05d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, quality])
