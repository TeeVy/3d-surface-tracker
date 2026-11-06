"""Définition de la surface trackée, sur l'image de référence.

Deux types :
  rect : 4 coins d'un rectangle réel (écran, étiquette, boîte…)
  disc : un disque (tête de sèche-cheveux, couvercle, cadran…), désigné par
         des points cliqués sur son bord -> ellipse

Dans les deux cas, la surface fournit :
  - un polygone de suivi (la zone dont les pixels servent au tracking) ;
  - 4 « coins de référence » : l'image de 4 coins d'un vrai rectangle posé sur
    le plan (pour un disque : le carré circonscrit). Ces coins, propagés par
    l'homographie trackée, donnent la pose 3D de chaque image.
"""

import cv2
import numpy as np

from .geometry import warp_points


# --------------------------------------------------------------------- ellipse
def fit_ellipse(points):
    """Ajuste une ellipse ; renvoie (centre, demi-axes, angle_deg) au format OpenCV."""
    pts = np.asarray(points, np.float32).reshape(-1, 2)
    if len(pts) < 5:
        raise ValueError("Il faut au moins 5 points sur le bord du disque.")
    (cx, cy), (d1, d2), ang = cv2.fitEllipse(pts)
    return np.array([cx, cy]), np.array([d1 / 2, d2 / 2]), ang


def ellipse_conic(center, axes, angle_deg):
    """Matrice 3x3 C de la conique (x^T C x = 0)."""
    t = np.radians(angle_deg)
    M = np.array([[np.cos(t), -np.sin(t), center[0]], [np.sin(t), np.cos(t), center[1]], [0, 0, 1]]) @ np.diag(
        [axes[0], axes[1], 1.0])
    Mi = np.linalg.inv(M)
    return Mi.T @ np.diag([1.0, 1.0, -1.0]) @ Mi


def ellipse_polygon(center, axes, angle_deg, n=72, scale=1.0):
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    a = np.radians(angle_deg)
    x, y = axes[0] * scale * np.cos(t), axes[1] * scale * np.sin(t)
    return np.column_stack([center[0] + x * np.cos(a) - y * np.sin(a), center[1] + x * np.sin(a) + y * np.cos(a)])


def circle_poses_from_ellipse(conic, K):
    """Les 2 poses possibles d'un cercle 3D dont l'image est la conique donnée.

    Renvoie une liste de (centre_3d, normale, rayon) avec une échelle arbitraire
    (plan à distance ~1), normale orientée vers l'arrière-plan (z > 0)."""
    Q = K.T @ conic @ K
    Q = (Q + Q.T) / 2
    w, V = np.linalg.eigh(Q)
    if (w > 0).sum() == 1:
        w, V = -w, V
    order = np.argsort(-w)          # l1 >= l2 > 0 > l3
    l1, l2, l3 = w[order]
    e1, _, e3 = V[:, order[0]], V[:, order[1]], V[:, order[2]]
    a = np.sqrt(max(0.0, (l1 - l2) / (l1 - l3)))
    b = np.sqrt(max(0.0, (l2 - l3) / (l1 - l3)))
    out = []
    for s in (1.0, -1.0) if a > 1e-9 else (1.0,):
        n = s * a * e1 + b * e3
        n /= np.linalg.norm(n)
        if n[2] < 0:
            n = -n
        c3, r = _circle_on_plane(conic, K, n)
        out.append((c3, n, r))
    return out


def _circle_on_plane(conic, K, n):
    """Rétro-projette l'ellipse sur le plan n·X = 1 et ajuste un cercle (centre 3D, rayon)."""
    # points de l'ellipse
    w, V = np.linalg.eigh(conic[:2, :2])
    center = -np.linalg.solve(conic[:2, :2], conic[:2, 2])
    k = -(conic[2, 2] + conic[:2, 2] @ center)
    axes = np.sqrt(np.abs(k / w))
    t = np.linspace(0, 2 * np.pi, 90, endpoint=False)
    pts = center + (np.column_stack([axes[0] * np.cos(t), axes[1] * np.sin(t)]) @ V.T)
    rays = np.column_stack([pts, np.ones(len(pts))]) @ np.linalg.inv(K).T
    X = rays / (rays @ n)[:, None]
    u = np.cross(n, [0.0, 1.0, 0.0])
    u /= np.linalg.norm(u)
    v = np.cross(n, u)
    p2 = np.column_stack([X @ u, X @ v])
    A = np.column_stack([2 * p2, np.ones(len(p2))])
    sol, *_ = np.linalg.lstsq(A, (p2 ** 2).sum(axis=1), rcond=None)
    c2 = sol[:2]
    r = np.sqrt(sol[2] + c2 @ c2)
    c3 = c2[0] * u + c2[1] * v + n / (n @ n)  # point du plan n·X=1
    c3 = c3 - (c3 @ n - 1) * n               # projection exacte sur le plan
    return c3, float(r)


def square_corners_on_plane(c3, n, r, K):
    """Image des coins du carré circonscrit au cercle (aligné sur l'horizontale image)."""
    u = np.array([1.0, 0, 0]) - n[0] * n
    u /= np.linalg.norm(u)
    v = np.cross(n, u)  # n x u : vers le bas pour un plan de face
    P = np.array([c3 + r * (-u - v), c3 + r * (u - v), c3 + r * (u + v), c3 + r * (-u + v)])
    p = P @ K.T
    return p[:, :2] / p[:, 2:3]


# --------------------------------------------------------------------- surfaces
def unit_square_homography(corners):
    """Homographie du carré unité [0,1]² vers les 4 coins (HG, HD, BD, BG)."""
    src = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]])
    return cv2.getPerspectiveTransform(src, np.float32(corners)).astype(np.float64)


def _radii(roundness):
    """Rayons des 4 coins (HG, HD, BD, BG) en fraction de la demi-largeur, 0..0.5 dans le carré unité."""
    r = np.broadcast_to(np.asarray(roundness, float), (4,))
    return 0.5 * np.clip(r, 0, 1)


def rounded_unit(roundness, per_arc=12):
    """Contour du rectangle arrondi dans le carré unité [0,1]² (un arrondi par coin, ou un seul
    pour les 4). Un coin sans arrondi reste un point."""
    rh, rd, rb, rg = _radii(roundness)[[0, 1, 2, 3]]
    pts = []
    for r, cx, cy, a0 in ((rd, 1 - rd, rd, -90), (rb, 1 - rb, 1 - rb, 0), (rg, rg, 1 - rg, 90), (rh, rh, rh, 180)):
        if r <= 1e-6:
            pts.append((cx, cy))
            continue
        for a in np.radians(np.linspace(a0, a0 + 90, per_arc)):
            pts.append((cx + r * np.cos(a), cy + r * np.sin(a)))
    return np.array(pts)


def rounded_outline(corners, roundness, per_arc=12):
    """Contour d'un rectangle aux coins arrondis, vu en perspective.

    roundness 0..1 (un nombre, ou un par coin HG, HD, BD, BG) : rayon des arrondis en fraction
    de la demi-largeur (même construction que dans le panneau : arcs dans le carré unité, puis
    homographie)."""
    if np.all(_radii(roundness) <= 1e-6):
        return np.asarray(corners, np.float64)
    return warp_points(unit_square_homography(corners), rounded_unit(roundness, per_arc))


def inscribed_conic(corners):
    """Image du cercle inscrit dans le carré dont les coins sont donnés."""
    H = unit_square_homography(corners)
    C0 = ellipse_conic((0.5, 0.5), (0.5, 0.5), 0.0)
    Hi = np.linalg.inv(H)
    return Hi.T @ C0 @ Hi


class RectSurface:
    """Rectangle, éventuellement aux coins arrondis. Les 4 coins sont ceux du
    rectangle « pointu » (là où les bords droits se rejoindraient)."""
    kind = "rect"

    def __init__(self, corners, roundness=0.0):
        self.corners = np.asarray(corners, np.float64).reshape(4, 2)
        self.roundness = np.broadcast_to(np.asarray(roundness, float), (4,)).copy()

    def track_polygon(self):
        return rounded_outline(self.corners, self.roundness)

    def reference_corners(self, focal, width, height, homographies=None):
        """4 coins d'un vrai rectangle sur l'image de référence (+ proportions inconnues : None)."""
        return self.corners, None


class DiscSurface:
    kind = "disc"

    def __init__(self, rim_points=None, conic=None):
        if conic is None:
            self.rim_points = np.asarray(rim_points, np.float64).reshape(-1, 2)
            self.center, self.axes, self.angle = fit_ellipse(self.rim_points)
            self.conic = ellipse_conic(self.center, self.axes, self.angle)
        else:  # ellipse déjà connue (ex. rectangle arrondi à fond)
            from .ellipse_track import _ellipse_points
            self.conic = np.asarray(conic, np.float64)
            self.center, self.axes, self.angle = fit_ellipse(_ellipse_points(self.conic, 72))

    @classmethod
    def from_square(cls, corners):
        """Disque inscrit dans le carré (vu en perspective) dont on donne les 4 coins."""
        return cls(conic=inscribed_conic(corners))

    def track_polygon(self):
        return ellipse_polygon(self.center, self.axes, self.angle, scale=1.0)

    def candidates(self, focal, width, height):
        K = np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1]])
        return [square_corners_on_plane(c3, n, r, K) for c3, n, r in circle_poses_from_ellipse(self.conic, K)]

    def reference_corners(self, focal, width, height, homographies=None):
        """Carré circonscrit au disque ; parmi les 2 inclinaisons possibles, garde
        celle qui reste la plus « carrée en 3D » sur toute la séquence."""
        from .pose import orthogonality_cost

        cands = self.candidates(focal, width, height)
        if len(cands) == 1 or homographies is None:
            return cands[0], 1.0
        costs = []
        for c in cands:
            seq = np.array([warp_points(H, c) for H in homographies if np.all(np.isfinite(H))])
            costs.append(orthogonality_cost(seq, focal, width, height))
        return cands[int(np.argmin(costs))], 1.0
