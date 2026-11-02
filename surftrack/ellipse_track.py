"""Suivi du bord d'un disque (ellipse à l'image), image par image.

Le bord d'un disque est souvent l'élément le plus fiable d'une surface lisse
(reflets mobiles à l'intérieur, peu de texture). On le suit ainsi :
  - sur l'image de référence, on « aimante » l'ellipse cliquée sur le contour
    le plus net, puis on mémorise un profil d'intensité perpendiculaire au bord
    en N points ;
  - sur chaque image, l'homographie trackée prédit où sont ces N points ; on
    cherche le long de la normale le décalage qui fait le mieux correspondre le
    profil (corrélation normalisée : insensible à la luminosité) ;
  - on ajuste une ellipse robuste (rejet des points aberrants : main, cheveux…).
"""

import cv2
import numpy as np

from .geometry import warp_points


# ------------------------------------------------------------------ coniques
def conic_from_params(center, axes, angle_deg):
    t = np.radians(angle_deg)
    M = np.array([[np.cos(t), -np.sin(t), center[0]], [np.sin(t), np.cos(t), center[1]], [0, 0, 1]]) @ np.diag(
        [axes[0], axes[1], 1.0])
    Mi = np.linalg.inv(M)
    C = Mi.T @ np.diag([1.0, 1.0, -1.0]) @ Mi
    return C / np.abs(C).max()


def transform_conic(C, H):
    """Image de la conique C par l'homographie H."""
    Hi = np.linalg.inv(H)
    C2 = Hi.T @ C @ Hi
    return C2 / np.abs(C2).max()


def conic_normals(C, pts):
    """Normales unitaires (gradient de x^T C x) aux points donnés."""
    g = np.column_stack([pts, np.ones(len(pts))]) @ C.T
    n = g[:, :2]
    return n / np.linalg.norm(n, axis=1, keepdims=True)


def conic_distance(C, pts):
    """Distance géométrique approchée (1er ordre) des points à la conique."""
    P = np.column_stack([pts, np.ones(len(pts))])
    val = np.einsum("ij,jk,ik->i", P, C, P)
    grad = 2 * (P @ C.T)[:, :2]
    return np.abs(val) / np.maximum(np.linalg.norm(grad, axis=1), 1e-12)


def robust_fit(pts, iters=3, tol=1.5):
    """Ellipse robuste ; renvoie (conique, masque des points retenus) ou (None, None)."""
    keep = np.ones(len(pts), bool)
    C = None
    for _ in range(iters):
        if keep.sum() < 6:
            return None, None
        (cx, cy), (d1, d2), ang = cv2.fitEllipse(pts[keep].astype(np.float32))
        if min(d1, d2) < 4:
            return None, None
        C = conic_from_params((cx, cy), (d1 / 2, d2 / 2), ang)
        d = conic_distance(C, pts)
        mad = np.median(d[keep]) * 1.4826 + 1e-6
        keep = d < max(tol, 3 * mad)
    return C, keep


# ------------------------------------------------------------------ échantillonnage
def _sample(img, pts, normals, offsets):
    """Intensités le long des normales : tableau (N, len(offsets))."""
    X = (pts[:, None, 0] + normals[:, None, 0] * offsets[None, :]).astype(np.float32)
    Y = (pts[:, None, 1] + normals[:, None, 1] * offsets[None, :]).astype(np.float32)
    return cv2.remap(img, X, Y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)


def snap_ellipse(img, C, n=120, search=None):
    """Aimante une ellipse approximative sur le contour le plus net à proximité."""
    pts = _ellipse_points(C, n)
    span = np.ptp(pts, axis=0).max()
    search = search or max(4.0, 0.04 * span)
    normals = conic_normals(C, pts)
    offs = np.arange(-search, search + 0.5, 0.5)
    g = cv2.GaussianBlur(img.astype(np.float32), (0, 0), 1.0)
    prof = _sample(g, pts, normals, offs)
    grad = np.abs(np.gradient(prof, axis=1))
    k = np.argmax(grad, axis=1)
    found = pts + normals * offs[k][:, None]
    C2, _ = robust_fit(found)
    return C2 if C2 is not None else C


def _ellipse_points(C, n):
    """n points régulièrement répartis (en angle paramétrique) sur l'ellipse C."""
    A = C[:2, :2]
    center = -np.linalg.solve(A, C[:2, 2])
    k = -(C[2, 2] + C[:2, 2] @ center)
    w, V = np.linalg.eigh(A)
    axes = np.sqrt(np.abs(k / w))
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return center + np.column_stack([axes[0] * np.cos(t), axes[1] * np.sin(t)]) @ V.T


# ------------------------------------------------------------------ suivi
class EllipseTracker:
    def __init__(self, ref_img, C_ref, n=96, half=None, search=None):
        self.C_ref = C_ref
        self.pts_ref = _ellipse_points(C_ref, n)
        span = np.ptp(self.pts_ref, axis=0).max()
        self.half = half or max(4.0, 0.03 * span)      # demi-longueur du profil
        self.search = search or max(4.0, 0.04 * span)  # amplitude de recherche
        self.span_ref = span
        nrm = conic_normals(C_ref, self.pts_ref)
        g = cv2.GaussianBlur(ref_img.astype(np.float32), (0, 0), 1.0)
        self.offs = np.arange(-self.half, self.half + 0.5, 1.0)
        self.prof_ref = self._normalize(_sample(g, self.pts_ref, nrm, self.offs))

    @staticmethod
    def _normalize(p):
        p = p - p.mean(axis=1, keepdims=True)
        return p / (np.linalg.norm(p, axis=1, keepdims=True) + 1e-6)

    def refine(self, img, H):
        """Ellipse dans l'image courante ; renvoie (conique, qualité 0..1) ou (prédiction, 0)."""
        C_pred = transform_conic(self.C_ref, H)
        pts = warp_points(H, self.pts_ref)
        if not np.all(np.isfinite(pts)):
            return C_pred, 0.0
        nrm = conic_normals(C_pred, pts)
        k = np.ptp(pts, axis=0).max() / self.span_ref  # les profils suivent la taille apparente
        g = cv2.GaussianBlur(img.astype(np.float32), (0, 0), max(0.6, 1.0 * k))
        shifts = np.arange(-self.search, self.search + 0.25, 0.25) * k
        best = np.full(len(pts), -2.0)
        best_s = np.zeros(len(pts))
        for s in shifts:  # corrélation du profil pour chaque décalage
            prof = self._normalize(_sample(g, pts + nrm * s, nrm, self.offs * k))
            score = np.sum(prof * self.prof_ref, axis=1)
            better = score > best
            best[better], best_s[better] = score[better], s
        good = best > 0.6
        if good.sum() < 0.3 * len(pts):
            return C_pred, 0.0
        C, keep = robust_fit((pts + nrm * best_s[:, None])[good])
        if C is None:
            return C_pred, 0.0
        quality = float(np.mean(best[good][keep]) * keep.sum() / len(pts))
        return C, quality
