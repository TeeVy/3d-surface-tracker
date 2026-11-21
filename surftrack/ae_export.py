"""Valeurs d'images clés pour l'effet « 3D Surface Tracker » (caméra + surface 3D).

Correspondance des repères : une caméra AE à une position C = (L/2, H/2, -zoom),
sans orientation, voit exactement comme la caméra OpenCV (X droite, Y bas,
Z vers l'avant, zoom = focale en pixels). Un point P exprimé dans le repère
caméra OpenCV se trouve donc en P + C dans l'espace monde d'AE.
"""

import numpy as np

from .geometry import matrix_to_euler

# Ordre de composition des rotations « Orientation » d'AE : R = Rx · Ry · Rz, sens
# trigonométrique standard (Z appliqué en premier, autour de l'axe propre du calque).
# Vérifié dans AE 2026.
AE_EULER_ORDER = "xyz"


def _ae_orientation(R):
    o = matrix_to_euler(R, AE_EULER_ORDER)
    return [round(float(v), 5) for v in o]


def build_ae_data(res, mode="auto"):
    """Prépare les valeurs d'images clés (unités = pixels de la vidéo source) depuis pipeline.Result.
    mode : 'object', 'camera' ou 'auto' (celui détecté par le pipeline)."""
    if mode == "auto":
        mode = res.motion_mode
    pose, ref, off = res.pose, res.track.ref_index, res.frame_offset
    # caméra fixe à la distance de la focale de référence ; le zoom, lui, peut être animé
    C = np.array([res.width / 2, res.height / 2, -pose.focal[ref]])
    frames, cam_pos, cam_ori, srf_pos, srf_ori = [], [], [], [], []
    R_ref, T_ref = pose.R[ref], pose.t[ref] + C
    for i in np.flatnonzero(pose.valid):
        frames.append(int(i) + off)  # indice dans le fichier vidéo
        if mode == "object":
            srf_pos.append((pose.t[i] + C).round(4).tolist())
            srf_ori.append(_ae_orientation(pose.R[i]))
        else:  # caméra mobile : la surface reste fixe à sa pose de référence
            R_cam = R_ref @ pose.R[i].T
            cam_pos.append((T_ref - R_cam @ pose.t[i]).round(4).tolist())
            cam_ori.append(_ae_orientation(R_cam))
    if mode == "object":
        cam_pos, cam_ori = [C.round(4).tolist()], [[0, 0, 0]]
    else:
        srf_pos, srf_ori = [T_ref.round(4).tolist()], [_ae_orientation(R_ref)]
    check = [int(i) for i in np.linspace(0, len(frames) - 1, min(12, len(frames))).astype(int)]
    return {
        "width": res.width, "height": res.height, "fps": res.fps, "mode": mode, "shape": res.surface.kind,
        "zoom": [round(float(pose.focal[i]), 3) for i in np.flatnonzero(pose.valid)]
                if np.ptp(pose.focal[pose.valid]) > 0.5 else [round(float(pose.focal[ref]), 3)],
        "size": [round(float(pose.size[0]), 4), round(float(pose.size[1]), 4)],
        "frames": frames,
        "camPos": cam_pos, "camOri": cam_ori, "srfPos": srf_pos, "srfOri": srf_ori,
        # coins trackés (pour l'autocontrôle dans AE) sur quelques images
        "check": [{"f": frames[k], "c": res.corners[frames[k] - off].round(3).tolist()} for k in check],
        "round": None if res.roundness is None else [round(float(r), 4) for r in res.roundness],
    }
