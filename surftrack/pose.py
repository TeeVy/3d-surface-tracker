"""Passage 2D -> 3D : focale, proportions de la surface et pose 3D par image.

On part de 4 « coins de référence » : l'image des coins d'un vrai rectangle posé
sur le plan (fournis par la surface, voir surface.py), propagés dans chaque
image par l'homographie trackée. Comme ce rectangle a des angles droits en 3D :
  - la focale peut être estimée quand la perspective varie assez ;
  - les proportions réelles du rectangle sont retrouvées ;
  - chaque image donne une pose 3D (rotation + position) de la surface.

Repère : celui d'OpenCV (X droite, Y bas, Z vers l'avant de la caméra), qui est
exactement celui d'une caméra After Effects non orientée.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import UNIT_SQUARE, orthonormalize, rotation_angle_deg


@dataclass
class FocalEstimate:
    focal: float
    reliable: bool
    rel_uncertainty: float  # incertitude relative approximative (0.05 = ±5 %)


@dataclass
class PoseResult:
    R: np.ndarray            # (N,3,3) rotation surface -> caméra
    t: np.ndarray            # (N,3) centre de la surface dans le repère caméra
    size: tuple              # (largeur, hauteur) de la surface, mêmes unités que t
    focal: np.ndarray        # (N,) focale en pixels de chaque image (zoom possible)
    reproj_error: np.ndarray  # (N,) erreur de reprojection des coins (px)
    valid: np.ndarray        # (N,) bool


def as_focals(focal, n):
    """Focale par image : un nombre (focale fixe) ou un tableau (zoom) -> tableau (n,)."""
    return np.broadcast_to(np.asarray(focal, dtype=np.float64), (n,)).copy()


def _K(f, width, height):
    return np.array([[f, 0, width / 2], [0, f, height / 2], [0, 0, 1]])


def _unit_square_homographies(corners, cx, cy):
    out = []
    for c in corners:
        out.append(cv2.getPerspectiveTransform(UNIT_SQUARE.astype(np.float32),
                                               (c - [cx, cy]).astype(np.float32)).astype(np.float64))
    return np.array(out)


def _frame_costs(Hn, f):
    """cos² de l'angle 3D entre les deux côtés du rectangle, par image (0 si focale parfaite)."""
    a = Hn[:, :, 0] / [f, f, 1]
    b = Hn[:, :, 1] / [f, f, 1]
    cos = np.sum(a * b, axis=1) / (np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1))
    return cos ** 2


def _robust_mean(costs):
    keep = max(1, int(0.9 * len(costs)))  # on écarte les 10 % d'images les plus incohérentes
    return float(np.sort(costs)[:keep].mean())


def orthogonality_cost(corner_seq, focal, width, height):
    corner_seq = corner_seq[np.isfinite(corner_seq).all(axis=(1, 2))]
    Hn = _unit_square_homographies(corner_seq, width / 2, height / 2)
    return _robust_mean(_frame_costs(Hn, focal))


def estimate_focal(corner_seqs_for, width, height):
    """Focale (px) qui rend le rectangle le plus « droit » en 3D sur toute la séquence.

    corner_seqs_for(f) -> liste de séquences de coins (N,4,2) candidates pour la
    focale f (un disque a 2 interprétations possibles, un rectangle une seule)."""
    def cost(f):
        return min(orthogonality_cost(seq, f, width, height) for seq in corner_seqs_for(f))

    fs = np.geomspace(0.25 * max(width, height), 8 * max(width, height), 240)
    costs = np.array([cost(f) for f in fs])
    k = int(np.argmin(costs))
    fine = np.linspace(fs[max(0, k - 1)], fs[min(len(fs) - 1, k + 1)], 40)
    fc = [cost(x) for x in fine]
    f = float(fine[int(np.argmin(fc))])

    # fiabilité : la courbe de coût doit avoir un creux étroit et marqué
    cmin, cmax = costs.min(), costs.max()
    band = fs[costs <= 3 * cmin + 1e-5]
    rel = float((band.max() - band.min()) / (2 * f))
    big = max(width, height)
    reliable = cmax > 30 * cmin and rel < 0.15 and 0.3 * big < f < 7 * big
    return FocalEstimate(f, bool(reliable), rel)


def estimate_aspect(corners, focal, width, height, valid=None):
    """Rapport largeur/hauteur réel du rectangle."""
    valid = np.ones(len(corners), bool) if valid is None else valid.copy()
    valid &= np.isfinite(corners).all(axis=(1, 2))  # images perdues exclues
    if not valid.any():
        raise RuntimeError("Aucune image trackée exploitable pour estimer les proportions.")
    Hn = _unit_square_homographies(corners[valid], width / 2, height / 2)
    F = as_focals(focal, len(corners))[valid]
    d = np.column_stack([F, F, np.ones_like(F)])
    a = np.linalg.norm(Hn[:, :, 0] / d, axis=1)
    b = np.linalg.norm(Hn[:, :, 1] / d, axis=1)
    return float(np.median(a / b))


def _object_points(w, h):
    return np.array([[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]])


def solve_poses(corners, focal, width, height, aspect, ref_index, valid=None):
    """Pose 3D par image. Échelle choisie pour que la surface soit à la distance
    focale de la caméra sur l'image de référence (≈ 1 unité = 1 pixel dans AE)."""
    n = len(corners)
    valid = np.ones(n, bool) if valid is None else valid.copy()
    focal = as_focals(focal, n)
    obj = _object_points(aspect, 1.0)

    R = np.full((n, 3, 3), np.nan)
    t = np.full((n, 3), np.nan)
    err = np.full(n, np.nan)

    def candidates(i):
        ok, rvecs, tvecs, errs = cv2.solvePnPGeneric(obj, corners[i].astype(np.float64), _K(focal[i], width, height), None,
                                                    flags=cv2.SOLVEPNP_IPPE)
        out = []
        for rv, tv, e in zip(rvecs, tvecs, np.ravel(errs)):
            if tv[2, 0] > 0:  # la surface doit être devant la caméra
                out.append((cv2.Rodrigues(rv)[0], tv.ravel(), float(e)))
        return out

    c = candidates(ref_index)
    if not c:
        raise RuntimeError("Impossible de calculer la pose sur l'image de référence.")
    R[ref_index], t[ref_index], err[ref_index] = min(c, key=lambda x: x[2])

    # continuité avec l'image voisine : lève l'ambiguïté des plans vus presque de face
    for step in (1, -1):
        last = ref_index
        i = ref_index + step
        while 0 <= i < n:
            if valid[i]:
                c = candidates(i)
                if c:
                    best_err = min(x[2] for x in c)
                    c = [x for x in c if x[2] <= best_err + 1.0]
                    R[i], t[i], err[i] = min(c, key=lambda x: rotation_angle_deg(x[0], R[last]))
                    last = i
                else:
                    valid[i] = False
            i += step

    scale = focal[ref_index] / t[ref_index][2]
    return PoseResult(R, t * scale, (aspect * scale, scale), focal, err, valid)


def _translation_for_rotation(R, obj, img, focal, cx, cy):
    """Meilleure position (moindres carrés linéaires) pour une rotation imposée."""
    A, b = [], []
    for P, (u, v) in zip(obj @ R.T, img):
        du, dv = u - cx, v - cy
        A.append([focal, 0, -du]); b.append(du * P[2] - focal * P[0])
        A.append([0, focal, -dv]); b.append(dv * P[2] - focal * P[1])
    return np.linalg.lstsq(np.array(A), np.array(b), rcond=None)[0]


def _rim_residuals(R, t, conic, focal, cx, cy, radius, ring):
    from .ellipse_track import conic_distance  # import local : évite un import circulaire

    X = (ring * radius) @ R.T + t
    q = focal * X[:, :2] / X[:, 2:3] + [cx, cy]
    return conic_distance(conic, q)


def _translation_on_rim(R, t0, conic, focal, cx, cy, radius, iters=8):
    """Position qui fait retomber le cercle 3D (rotation imposée) sur l'ellipse
    observée : moindres carrés de Gauss-Newton sur les 3 coordonnées."""
    a = np.linspace(0, 2 * np.pi, 48, endpoint=False)
    ring = np.column_stack([np.cos(a), np.sin(a), np.zeros_like(a)])
    t = t0.copy()
    for _ in range(iters):
        r = _rim_residuals(R, t, conic, focal, cx, cy, radius, ring)
        J = np.empty((len(r), 3))
        for k in range(3):
            d = np.zeros(3)
            d[k] = 1e-4 * max(1.0, abs(t[2]))
            J[:, k] = (_rim_residuals(R, t + d, conic, focal, cx, cy, radius, ring) - r) / d[k]
        step = np.linalg.lstsq(J, -r, rcond=None)[0]
        t = t + step
        if np.linalg.norm(step) < 1e-6 * abs(t[2]):
            break
    r = _rim_residuals(R, t, conic, focal, cx, cy, radius, ring)
    return t, float(np.sqrt(np.mean(r ** 2)))


def stabilize_poses(pose: PoseResult, corners, width, height, sigma_frames: float, conics=None):
    """Lisse la rotation dans le temps, puis recalcule la position pour que la
    surface retombe au mieux sur le tracking 2D : sur les coins pour un
    rectangle, sur l'ellipse du bord pour un disque (conics fourni).

    Quand la perspective est faible, l'inclinaison de la surface est mal définie
    et tremble d'une image à l'autre, alors qu'elle change à peine l'image : on
    peut donc la lisser fortement sans décaler la 2D. sigma=0 : aucun lissage."""
    if sigma_frames <= 0:
        return pose
    n = len(pose.t)
    radius = int(np.ceil(3 * sigma_frames))
    offsets = np.arange(-radius, radius + 1)
    kernel = np.exp(-0.5 * (offsets / sigma_frames) ** 2)
    obj = _object_points(*pose.size)
    R2, t2, err2 = pose.R.copy(), pose.t.copy(), pose.reproj_error.copy()
    for i in np.flatnonzero(pose.valid):
        idx = i + offsets
        ok = (idx >= 0) & (idx < n)
        ok[ok] &= pose.valid[idx[ok]]
        w = kernel[ok] / kernel[ok].sum()
        R2[i] = orthonormalize((pose.R[idx[ok]] * w[:, None, None]).sum(axis=0))
        f = pose.focal[i]
        t2[i] = _translation_for_rotation(R2[i], obj, corners[i], f, width / 2, height / 2)
        if conics is not None and np.all(np.isfinite(conics[i])):
            t2[i], err2[i] = _translation_on_rim(R2[i], t2[i], conics[i], f, width / 2, height / 2,
                                                 pose.size[0] / 2)
        else:
            X = obj @ R2[i].T + t2[i]
            proj = f * X[:, :2] / X[:, 2:3] + [width / 2, height / 2]
            err2[i] = float(np.sqrt(np.mean(np.sum((proj - corners[i]) ** 2, axis=1))))
    return PoseResult(R2, t2, pose.size, pose.focal, err2, pose.valid)


def project_corners(pose: PoseResult, width, height):
    """Reprojette les coins de la surface 3D (pour contrôle / aperçu)."""
    obj = _object_points(*pose.size)
    out = np.full((len(pose.t), 4, 2), np.nan)
    for i in np.flatnonzero(pose.valid):
        X = obj @ pose.R[i].T + pose.t[i]
        out[i] = pose.focal[i] * X[:, :2] / X[:, 2:3] + [width / 2, height / 2]
    return out


def solve_disc_poses(conics, homographies, focal, width, height, ref_index, flip=False, ref_order=None):
    """Pose 3D d'un disque par image, à partir de son ellipse (inclinaison, position)
    et de l'homographie trackée (rotation dans le plan uniquement).

    ref_order : ordre de préférence des 2 interprétations possibles sur l'image
    de référence ; flip=True prend l'autre (inclinaison inversée)."""
    from .surface import circle_poses_from_ellipse  # import local : évite un import circulaire

    n = len(conics)
    focal = as_focals(focal, n)
    R = np.full((n, 3, 3), np.nan)
    t = np.full((n, 3), np.nan)
    valid = np.zeros(n, bool)

    K = _K(focal[ref_index], width, height)
    cands = circle_poses_from_ellipse(conics[ref_index], K)
    order = list(ref_order) if ref_order is not None else list(range(len(cands)))
    pick = order[1] if (flip and len(cands) > 1) else order[0]
    c3, nrm, r = cands[pick]
    # repère d'orientation dans le plan : horizontale image projetée sur le disque
    u = np.array([1.0, 0, 0]) - nrm[0] * nrm
    u /= np.linalg.norm(u)
    a = np.array([c3, c3 + r * u]) @ K.T
    anchors = a[:, :2] / a[:, 2:3]  # 2 points image de référence qui portent la direction u

    def pose_from(c3, nrm, r, H, f):
        b = np.column_stack([warp_points_h(H, anchors), np.ones(2)]) @ np.linalg.inv(_K(f, width, height)).T
        X = b * ((nrm @ c3) / (b @ nrm))[:, None]  # rayons ∩ plan du disque
        u = X[1] - X[0]
        u -= (u @ nrm) * nrm
        u /= np.linalg.norm(u)
        return np.column_stack([u, np.cross(nrm, u), nrm]), c3 / r  # rayon unité

    R[ref_index], t[ref_index] = pose_from(c3, nrm, r, homographies[ref_index], focal[ref_index])
    valid[ref_index] = True
    for step in (1, -1):
        last_n = nrm
        i = ref_index + step
        while 0 <= i < n:
            if np.all(np.isfinite(conics[i])) and np.all(np.isfinite(homographies[i])):
                cs = circle_poses_from_ellipse(conics[i], _K(focal[i], width, height))
                c3i, ni, ri = max(cs, key=lambda x: x[1] @ last_n)  # continuité de la normale
                R[i], t[i] = pose_from(c3i, ni, ri, homographies[i], focal[i])
                valid[i] = True
                last_n = ni
            i += step

    scale = focal[ref_index] / t[ref_index][2]
    pose = PoseResult(R, t * scale, (2 * scale, 2 * scale), focal, np.zeros(n), valid)
    return pose, project_corners(pose, width, height)


def warp_points_h(H, pts):
    p = np.column_stack([pts, np.ones(len(pts))]) @ H.T
    return p[:, :2] / p[:, 2:3]
