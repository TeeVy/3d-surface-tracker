"""Vidéo d'aperçu : zone trackée (vert) + surface 3D reprojetée (cyan), pour juger le résultat d'un coup d'œil."""

import cv2
import numpy as np

from .surface import ellipse_polygon
from .video import iter_bgr


def _project(pose, i, pts3, width, height):
    X = pts3 @ pose.R[i].T + pose.t[i]
    return pose.focal * X[:, :2] / X[:, 2:3] + [width / 2, height / 2]


def write_preview(video_path, out_path, res, max_side=1600):
    W, H, pose = res.width, res.height, res.pose
    s = min(1.0, max_side / max(W, H))
    size = (int(W * s), int(H * s))
    writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), res.fps, size)
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
    thick = max(1, int(round(2 / s)))

    for i, img in enumerate(iter_bgr(video_path)):
        if i >= res.n_frames:
            break
        if pose.valid[i]:
            for p, q in lines:
                a, b = _project(pose, i, np.array([p, q], float), W, H)
                cv2.line(img, tuple(np.int32(a)), tuple(np.int32(b)), (255, 220, 0), thick, cv2.LINE_AA)
            if disc is not None:
                cv2.polylines(img, [np.int32(_project(pose, i, disc, W, H))], True, (255, 220, 0), 2 * thick, cv2.LINE_AA)
            poly = np.array([res.track.homographies[i] @ np.r_[p, 1] for p in zone])
            cv2.polylines(img, [np.int32(poly[:, :2] / poly[:, 2:3])], True, (0, 255, 0), thick, cv2.LINE_AA)
            o, x, y, z = _project(pose, i, np.array([[0, 0, 0], [axis_len, 0, 0], [0, axis_len, 0],
                                                    [0, 0, -axis_len]], float), W, H)
            for end, col in ((x, (0, 0, 255)), (y, (0, 255, 0)), (z, (255, 0, 0))):
                cv2.arrowedLine(img, tuple(np.int32(o)), tuple(np.int32(end)), col, 2 * thick, cv2.LINE_AA, tipLength=0.15)
        conf = res.track.confidence[i]
        color = (0, 200, 0) if conf >= 0.8 else (0, 200, 255) if conf >= 0.6 else (0, 0, 255)
        label = f"image {i}  confiance {conf:.2f}" + ("  ancre" if res.track.anchored[i] else "")
        fs = 1.4 / s * 0.6
        cv2.putText(img, label, (int(20 / s), int(50 / s)), cv2.FONT_HERSHEY_SIMPLEX, fs, (0, 0, 0), 4 * thick, cv2.LINE_AA)
        cv2.putText(img, label, (int(20 / s), int(50 / s)), cv2.FONT_HERSHEY_SIMPLEX, fs, color, thick, cv2.LINE_AA)
        writer.write(cv2.resize(img, size, interpolation=cv2.INTER_AREA))
    writer.release()
