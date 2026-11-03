"""Enchaînement complet : vidéo + surface -> tracking -> focale -> pose 3D."""

from dataclasses import dataclass

import numpy as np

from .metadata import read_lens_info
from .ellipse_track import EllipseTracker, snap_ellipse
from .geometry import warp_points
from .pose import (as_focals, estimate_aspect, estimate_focal, project_corners, solve_disc_poses,
                   solve_poses, stabilize_poses)
from .tracker import PlanarTracker
from .video import load_gray, video_size


@dataclass
class Result:
    width: int
    height: int
    fps: float
    n_frames: int
    track: object          # TrackResult en pleine résolution
    ref_corners: np.ndarray  # (4,2) coins de référence de la surface
    corners: np.ndarray    # (N,4,2) coins dans chaque image
    pose: object           # PoseResult
    focal_source: str
    surface: object
    alternative: object = None  # disque ambigu : (pose, coins) avec l'inclinaison inversée
    conics: object = None       # disque : ellipse du bord suivie dans chaque image


def run(video, surface, ref_frame=0, focal_px=None, focal_mm=None, sensor_mm=36.0, aspect=None,
        smooth=None, flip=False, track_scale=None, log=print, progress=None):
    if smooth is None:  # disque : calage sur le bord, on peut lisser davantage l'inclinaison
        smooth = 4.0 if surface.kind == "disc" else 2.0
    W, H = video_size(video)
    if track_scale is None:  # 4K : on tracke en demi-résolution (2x plus rapide, 4x moins de mémoire)
        track_scale = 0.5 if max(W, H) > 2600 else 1.0
    clip = load_gray(video, scale=track_scale)
    n = len(clip.frames)
    log(f"Vidéo : {W}x{H}, {n} images, {clip.fps:.3f} img/s"
        + (f" (tracking en {int(100 * track_scale)} %)" if track_scale != 1 else ""))
    if not 0 <= ref_frame < n:
        raise ValueError("Image de référence hors de la vidéo.")

    poly = surface.track_polygon() * track_scale
    track_small = PlanarTracker().track(clip.frames, ref_frame, poly, progress)
    track = track_small.scaled(1 / track_scale)

    conics = None
    alternative = None
    if surface.kind == "disc":  # suivi du bord, image par image
        S = np.diag([track_scale, track_scale, 1.0])
        Si = np.linalg.inv(S)
        C0 = snap_ellipse(clip.frames[ref_frame], Si.T @ surface.conic @ Si)
        et = EllipseTracker(clip.frames[ref_frame], C0)
        conics = np.full((n, 3, 3), np.nan)
        quality = np.zeros(n)
        for i in range(n):
            if i == ref_frame:
                conics[i], quality[i] = C0, 1.0
            elif np.all(np.isfinite(track_small.homographies[i])):
                conics[i], quality[i] = et.refine(clip.frames[i], track_small.homographies[i])
        conics = np.array([S.T @ C @ S for C in conics])  # retour en pleine résolution
        track.confidence = np.minimum(track.confidence, quality)
        log(f"Bord du disque suivi sur {100 * (quality > 0).mean():.0f} % des images "
            f"(qualité moyenne {quality.mean():.2f})")
    lost = _detect_loss(track, surface.track_polygon(), ref_frame)
    if lost.any():
        track.homographies[lost] = np.nan
        if conics is not None:
            conics[lost] = np.nan
        ranges = _ranges(np.flatnonzero(lost))
        log(f"⚠ Suivi perdu (flou de bougé, sortie de champ…) sur les images {ranges} : "
            "aucune image clé n'y sera créée.")
    weak = np.flatnonzero((track.confidence < 0.6) & ~lost)
    log(f"Confiance moyenne {track.confidence.mean():.3f}, recalage sur la référence "
        f"{100 * track.anchored.mean():.0f} % des images"
        + (f" ; {len(weak)} image(s) douteuse(s), ex. {weak[:10].tolist()}" if len(weak) else ""))

    # ---- focale : saisie > métadonnées caméra > estimation > défaut
    sub = slice(None, None, max(1, n // 80))  # sous-échantillonnage pour l'estimation

    def seqs_for(f):
        if surface.kind == "disc":
            return [track.warp(c)[sub] for c in surface.candidates(f, W, H)]
        return [track.warp(surface.corners)[sub]]

    if focal_px:
        focal, source = focal_px, "saisie (px)"
    elif focal_mm:
        focal, source = focal_mm / sensor_mm * max(W, H), f"saisie ({focal_mm:g} mm)"
    else:
        lens = read_lens_info(video)
        if lens:
            focal = lens.focal_px_per_frame(W, H, n)
            mm = lens.per_frame_mm[:n]
            if lens.varies:
                source = (f"métadonnées {lens.camera} / {lens.lens} : zoom de {mm.min():.1f} à "
                          f"{mm.max():.1f} mm éq. 35 mm, image par image")
            else:
                source = f"métadonnées {lens.camera} / {lens.lens} : {lens.focal35_mm:.1f} mm éq. 35 mm"
        else:
            fe = estimate_focal(seqs_for, W, H)
            if fe.reliable:
                focal, source = fe.focal, f"estimée (±{100 * fe.rel_uncertainty:.0f} %)"
            else:
                focal = 50 / 36 * max(W, H)
                source = "défaut 50 mm (pas assez de perspective pour l'estimer : utilisez --focal-mm)"
    focal = as_focals(focal, n)
    log(f"Focale : {np.median(focal):.0f} px — {source}" if np.ptp(focal) < 1 else
        f"Focale : {focal.min():.0f} à {focal.max():.0f} px — {source}")

    if surface.kind == "disc":
        # 2 inclinaisons possibles. Le centre réel du disque n'est pas au centre de
        # l'ellipse, et ce décalage diffère entre les deux : on garde celle dont le
        # centre suit le mieux le mouvement tracké.
        sols, costs = [], []
        for k in (0, 1):
            p, c = solve_disc_poses(conics, track.homographies, focal, W, H, ref_frame, ref_order=(k, 1 - k))
            ctr = focal[:, None] * p.t[:, :2] / p.t[:, 2:3] + [W / 2, H / 2]
            moved = np.array([warp_points(Hh, ctr[ref_frame][None])[0] for Hh in track.homographies])
            ok = p.valid & np.isfinite(moved).all(axis=1)
            sols.append((p, c))
            costs.append(float(np.median(np.linalg.norm(ctr[ok] - moved[ok], axis=1))))
        best = int(np.argmin(costs)) ^ int(bool(flip))
        pose, corners = sols[best]
        log(f"Inclinaison du disque : interprétation {'B' if best else 'A'} "
            f"(écart des centres A {costs[0]:.2f} px / B {costs[1]:.2f} px)"
            + (" — inversée à la demande" if flip else ""))
        if max(costs) < 1.5 * min(costs) + 1.0:  # trop proches pour trancher (faible perspective)
            alternative = sols[1 - best]
            log("⚠ Inclinaison ambiguë (peu de perspective) : un second script avec l'inclinaison "
                "inversée est aussi exporté.")
        ref_corners = corners[ref_frame]
    else:
        ref_corners = surface.corners
        corners = track.warp(ref_corners)
        if aspect is None:
            aspect = estimate_aspect(corners, focal, W, H, track.confidence >= 0.6)
        log(f"Proportions de la surface : {aspect:.3f}")
        tracked = np.isfinite(corners).all(axis=(1, 2))
        pose = solve_poses(corners, focal, W, H, aspect, ref_frame, tracked)
    pose = stabilize_poses(pose, corners, W, H, smooth, conics)
    if surface.kind == "disc":  # coins virtuels du carré : ceux de la pose finale
        corners = project_corners(pose, W, H)
    if alternative is not None:
        alt_pose = stabilize_poses(alternative[0], alternative[1], W, H, smooth, conics)
        alternative = (alt_pose, project_corners(alt_pose, W, H))
    log(f"Écart 3D / tracking 2D ({'bord du disque' if surface.kind == 'disc' else 'coins'}) : moyenne {np.nanmean(pose.reproj_error):.2f} px, "
        f"max {np.nanmax(pose.reproj_error):.2f} px")
    return Result(W, H, clip.fps, n, track, ref_corners, corners, pose, source, surface, alternative, conics)


def _detect_loss(track, poly, ref_frame, min_conf=0.3, max_area_ratio=1.5):
    """Images où le suivi a décroché. Depuis la référence, dans chaque sens, le
    suivi est perdu à la première image dont la confiance s'effondre ou dont la
    zone change brutalement de taille ; tout ce qui suit est perdu aussi (la
    chaîne de mouvements est rompue)."""
    n = len(track.homographies)
    lost = np.zeros(n, bool)

    def area(H):
        q = track.warp_one(H, poly)
        x, y = q[:, 0], q[:, 1]
        return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))

    for step in (1, -1):
        prev_area = area(track.homographies[ref_frame])
        i = ref_frame + step
        broken = False
        while 0 <= i < n:
            H = track.homographies[i]
            if not broken:
                a = area(H) if np.all(np.isfinite(H)) else np.nan
                ratio = a / prev_area if prev_area > 0 else np.nan
                if (not np.isfinite(ratio) or track.confidence[i] < min_conf
                        or not 1 / max_area_ratio < ratio < max_area_ratio):
                    broken = True
                else:
                    prev_area = a
            lost[i] = broken
            i += step
    return lost


def _ranges(idx):
    out, start = [], idx[0]
    for a, b in zip(idx, list(idx[1:]) + [None]):
        if b != a + 1:
            out.append(f"{start}-{a}" if a > start else f"{a}")
            if b is not None:
                start = b
    return ", ".join(out)
