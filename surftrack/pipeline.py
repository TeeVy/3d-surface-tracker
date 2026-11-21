"""Enchaînement complet : vidéo + surface -> tracking -> focale -> pose 3D."""

import os
from dataclasses import dataclass

import numpy as np

from .metadata import read_lens_info
from .ellipse_track import EllipseTracker, snap_ellipse
from .geometry import warp_points
from .pose import (as_focals, estimate_aspect, estimate_focal, project_corners, solve_disc_poses,
                   solve_poses, stabilize_poses)
from .scene import detect_motion_mode
from .tracker import PlanarTracker
from .video import frame_count, load_gray, video_size


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
    focal_source: dict
    surface: object
    alternative: object = None  # disque ambigu : (pose, coins) avec l'inclinaison inversée
    conics: object = None       # disque : ellipse du bord suivie dans chaque image
    frame_offset: int = 0       # indice dans le fichier de la 1re image traitée
    motion_mode: str = "object"  # 'object' (la surface bouge) ou 'camera' (la caméra bouge)
    motion_why: str = ""
    roundness: object = None    # arrondi des 4 coins (HG, HD, BD, BG), 0..1
    stopped: bool = False       # tracking arrêté à la demande


def run(video, surface, ref_frame=0, focal_px=None, focal_mm=None, sensor_mm=36.0, aspect=None,
        smooth=None, flip=False, track_scale=None, log=print, progress=None, frame_range=None,
        should_stop=None, live=None, mode="auto", normal_hint=None):
    """frame_range=(début, fin) : images du fichier à traiter (incluses) ; ref_frame est
    un indice du fichier. live(indice, image réduite, H réduite, polygone réduit) est
    appelé après chaque image trackée (aperçu en direct). normal_hint : orientation
    choisie dans le panneau (normale du plan, repère caméra de référence) ; elle
    tranche l'ambiguïté d'un disque et s'impose pour une forme libre."""
    W, H = video_size(video)
    if track_scale is None:  # 4K : on tracke en demi-résolution (2x plus rapide, 4x moins de mémoire)
        track_scale = 0.5 if max(W, H) > 2600 else 1.0
    total = frame_count(video)
    start, end = frame_range if frame_range else (0, total - 1)
    start, end = max(0, int(start)), min(total - 1, int(end)) if total > 0 else int(end)
    if not start <= ref_frame <= end:
        raise ValueError(f"L'image de référence ({ref_frame}) est hors de la plage trackée ({start}-{end}).")
    clip = load_gray(video, scale=track_scale, start=start, end=end)
    n = len(clip.frames)
    ref_file, ref_frame = ref_frame, ref_frame - start  # désormais : indices relatifs à la plage
    log(f"Vidéo : {W}x{H}, {clip.fps:.3f} img/s — images {start} à {start + n - 1} ({n} sur {total})"
        + (f", tracking en {int(100 * track_scale)} %" if track_scale != 1 else ""))

    poly = surface.track_polygon() * track_scale

    def on_step(done, count, i, Hs):
        if progress:
            progress(done, count)
        if live:
            live(i + start, clip.frames[i], Hs, poly)

    tracker = PlanarTracker(robust=surface.kind != "disc")  # disque : voir session.py
    track_small = tracker.track(clip.frames, ref_frame, poly, on_step, should_stop)
    track = track_small.scaled(1 / track_scale)
    if tracker.stopped:
        log("Tracking arrêté à la demande : seules les images déjà trackées sont utilisées.")

    lost = _detect_loss(track, surface.track_polygon(), ref_frame)
    lost_untracked = ~np.isfinite(track.homographies).all(axis=(1, 2))
    if (lost & ~lost_untracked).any():
        ranges = _ranges(np.flatnonzero(lost & ~lost_untracked) + start)
        log(f"⚠ Suivi perdu (flou de bougé, sortie de champ…) sur les images {ranges} : "
            "aucune image clé n'y sera créée.")
    if lost.any():
        track.homographies[lost] = np.nan
    weak = np.flatnonzero((track.confidence < 0.6) & ~lost)
    log(f"Confiance moyenne {track.confidence.mean():.3f}, recalage sur la référence "
        f"{100 * track.anchored.mean():.0f} % des images"
        + (f" ; {len(weak)} image(s) douteuse(s), ex. {weak[:10].tolist()}" if len(weak) else ""))

    focal, source = choose_focal(video, surface, track, W, H, focal_px, focal_mm, sensor_mm,
                                 np.arange(start, start + n), log)
    sol = solve(track, surface, W, H, focal, smooth=smooth, flip=flip, normal_hint=normal_hint,
                aspect=aspect, frames_small=clip.frames, track_scale=track_scale, log=log)
    pose = sol["pose"]

    if mode == "auto":
        mode, why = detect_motion_mode(clip.frames, track_scale, track.homographies, surface.track_polygon(),
                                       pose, W, H)
        log(f"Mouvement détecté : {'la caméra bouge' if mode == 'camera' else 'l’objet bouge'} ({why})")
    else:
        why = "choisi manuellement"
    return Result(W, H, clip.fps, n, track, sol["ref_corners"], sol["corners"], pose, source, surface,
                  sol["alternative"], sol["conics"], frame_offset=start, motion_mode=mode, motion_why=why,
                  stopped=tracker.stopped)


_LENS = {}


def _lens(video):
    """Métadonnées d'objectif (lues une fois par fichier : ffprobe est lent)."""
    if not video or not os.path.isfile(video):  # pas de rush identifié (précomp), ou rendu
        return None
    if video not in _LENS:
        _LENS[video] = read_lens_info(video)
    return _LENS[video]


def choose_focal(video, surface, track, W, H, focal_px=None, focal_mm=None, sensor_mm=36.0,
                 src_frames=None, log=print, scale=1.0):
    """Focale de chaque image : saisie > métadonnées caméra > estimation > 50 mm.
    scale : agrandissement du rush dans l'image suivie (rendu d'une compo où il est mis à l'échelle).
    src_frames[i] : image du fichier montrée à l'image i de la séquence (zoom image par image)."""
    n = len(track.homographies)
    src = np.arange(n) if src_frames is None else np.asarray(src_frames, int)
    ok = np.isfinite(track.homographies).all(axis=(1, 2))
    sub = np.flatnonzero(ok)[::max(1, ok.sum() // 80)]  # sous-échantillonnage pour l'estimation

    def seqs_for(f):
        if surface.kind == "disc":
            return [track.warp(c)[sub] for c in surface.candidates(f, W, H)]
        return [track.warp(surface.corners)[sub]]

    # source : d'où vient la focale (le panneau l'affiche dans sa langue)
    if focal_px:
        focal, source = focal_px, {"kind": "input", "px": float(focal_px)}
    elif focal_mm:
        focal, source = focal_mm / sensor_mm * max(W, H), {"kind": "input", "mm": float(focal_mm)}
    else:
        lens = _lens(video)
        if lens:
            focal = lens.focal_px_per_frame(W, H, int(src.max()) + 1)[src] * scale
            mm = (focal / scale / max(W, H) * 36.0)[ok] if ok.any() else focal / scale / max(W, H) * 36.0
            source = {"kind": "metadata", "camera": lens.camera, "lens": lens.lens, "mm": float(lens.focal35_mm)}
            if lens.varies and np.ptp(mm) > 0.05:
                source.update(mm_min=float(mm.min()), mm_max=float(mm.max()))
        elif len(sub) >= 3:
            fe = estimate_focal(seqs_for, W, H)
            if fe.reliable:
                focal, source = fe.focal, {"kind": "estimated", "uncertainty": float(fe.rel_uncertainty)}
            else:
                focal = 50 / 36 * max(W, H)
                source = {"kind": "default", "reason": "perspective"}
        else:
            focal = 50 / 36 * max(W, H)
            source = {"kind": "default"}
    focal = as_focals(focal, n)
    log(f"Focal length: {np.median(focal):.0f} px ({source['kind']})" if np.ptp(focal) < 1 else
        f"Focal length: {focal.min():.0f} to {focal.max():.0f} px ({source['kind']})")
    return focal, source


def solve(track, surface, W, H, focal, smooth=None, flip=False, normal_hint=None, aspect=None,
          frames_small=None, track_scale=1.0, log=print):
    """Pose 3D de la surface dans chaque image trackée (homographie finie).
    track : TrackResult pleine résolution ; frames_small : images (niveaux de gris, à
    l'échelle track_scale) nécessaires au suivi du bord d'un disque.
    Renvoie un dict : pose, corners, ref_corners, conics, alternative."""
    if smooth is None:  # disque : calage sur le bord, on peut lisser davantage l'inclinaison
        smooth = 4.0 if surface.kind == "disc" else 2.0
    n = len(track.homographies)
    ref_frame = track.ref_index
    focal = as_focals(focal, n)
    tracked = np.isfinite(track.homographies).all(axis=(1, 2))
    conics = alternative = None
    if surface.kind == "disc":  # suivi du bord, image par image
        S = np.diag([track_scale, track_scale, 1.0])
        Si = np.linalg.inv(S)
        C0 = snap_ellipse(frames_small[ref_frame], Si.T @ surface.conic @ Si)
        et = EllipseTracker(frames_small[ref_frame], C0)
        conics = np.full((n, 3, 3), np.nan)
        quality = np.zeros(n)
        for i in np.flatnonzero(tracked):
            if i == ref_frame:
                conics[i], quality[i] = C0, 1.0
            else:
                conics[i], quality[i] = et.refine(frames_small[i], S @ track.homographies[i] @ Si)
        conics = np.array([S.T @ C @ S for C in conics])  # retour en pleine résolution
        track.confidence = np.minimum(track.confidence, quality)
        log(f"Disc edge followed on {100 * (quality[tracked] > 0).mean():.0f}% of the tracked frames "
            f"(mean quality {quality[tracked].mean():.2f})")

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
            costs.append(float(np.median(np.linalg.norm(ctr[ok] - moved[ok], axis=1))) if ok.any() else 0.0)
        ambiguous = max(costs) < 1.5 * min(costs) + 1.0  # trop proches pour trancher (faible perspective)
        if normal_hint is not None:  # choix fait dans le panneau : la plus proche de l'orientation montrée
            hint = np.asarray(normal_hint, float) / np.linalg.norm(normal_hint)
            best = int(np.argmax([s[0].R[ref_frame][:, 2] @ hint for s in sols]))
            evidence = int(np.argmin(costs))
            if best != evidence and not ambiguous:
                log("⚠ The chosen tilt clearly contradicts the observed motion: check the preview.")
            ambiguous = False
        else:
            best = int(np.argmin(costs)) ^ int(bool(flip))
        pose, corners = sols[best]
        log(f"Disc tilt: interpretation {'B' if best else 'A'} "
            f"(center drift A {costs[0]:.2f} px / B {costs[1]:.2f} px)"
            + (" — chosen in the panel" if normal_hint is not None else "")
            + (" — flipped on request" if flip else ""))
        if ambiguous:
            alternative = sols[1 - best]
            log("⚠ Ambiguous tilt (little perspective): the flipped interpretation is also available.")
        ref_corners = corners[ref_frame]
    else:
        ref_corners = surface.corners
        corners = track.warp(ref_corners)
        if aspect is None:
            aspect = estimate_aspect(corners, focal, W, H, tracked & (track.confidence >= 0.6))
        log(f"Surface aspect ratio: {aspect:.3f}")
        pose = solve_poses(corners, focal, W, H, aspect, ref_frame, tracked)
    pose = stabilize_poses(pose, corners, W, H, smooth, conics)
    if surface.kind == "disc":  # coins virtuels du carré : ceux de la pose finale
        corners = project_corners(pose, W, H)
    if alternative is not None:
        alt_pose = stabilize_poses(alternative[0], alternative[1], W, H, smooth, conics)
        alternative = (alt_pose, project_corners(alt_pose, W, H))
    if pose.valid.any():
        log(f"3D vs 2D tracking error ({'disc edge' if surface.kind == 'disc' else 'corners'}): "
            f"mean {np.nanmean(pose.reproj_error[pose.valid]):.2f} px, "
            f"max {np.nanmax(pose.reproj_error[pose.valid]):.2f} px")
    return dict(pose=pose, corners=corners, ref_corners=ref_corners, conics=conics, alternative=alternative)


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
