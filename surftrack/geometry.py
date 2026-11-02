"""Petits outils géométriques partagés (homographies, rotations, angles d'Euler AE)."""

import numpy as np

# Ordre des coins partout dans le projet : haut-gauche, haut-droit, bas-droit, bas-gauche
# (dans le repère de la surface elle-même, pas forcément à l'écran).
UNIT_SQUARE = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float64)


def warp_points(H, pts):
    """Applique une homographie 3x3 à des points (N,2)."""
    pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    p = np.hstack([pts, np.ones((len(pts), 1))]) @ np.asarray(H, dtype=np.float64).T
    return p[:, :2] / p[:, 2:3]


def rot_x(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


_ROT = {"x": rot_x, "y": rot_y, "z": rot_z}
_AXIS = {"x": 0, "y": 1, "z": 2}


def euler_to_matrix(angles_deg, order):
    """angles (ax, ay, az) en degrés ; order 'xyz' signifie R = Rx @ Ry @ Rz."""
    a = dict(zip("xyz", np.radians(angles_deg)))
    R = np.eye(3)
    for axis in order:
        R = R @ _ROT[axis](a[axis])
    return R


def matrix_to_euler(R, order):
    """Inverse de euler_to_matrix : renvoie (ax, ay, az) en degrés (Tait-Bryan)."""
    i, j, k = (_AXIS[c] for c in order)
    s = 1.0 if (i, j, k) in ((0, 1, 2), (1, 2, 0), (2, 0, 1)) else -1.0
    b = np.arcsin(np.clip(s * R[i, k], -1.0, 1.0))
    if abs(R[i, k]) < 1 - 1e-9:
        a = np.arctan2(-s * R[j, k], R[k, k])
        c = np.arctan2(-s * R[i, j], R[i, i])
    else:  # blocage de cardan : on met tout sur le premier axe
        a = np.arctan2(s * R[k, j], R[j, j])
        c = 0.0
    out = {}
    out[order[0]], out[order[1]], out[order[2]] = a, b, c
    return np.degrees([out["x"], out["y"], out["z"]])


def orthonormalize(R):
    U, _, Vt = np.linalg.svd(R)
    Rn = U @ Vt
    if np.linalg.det(Rn) < 0:
        U[:, -1] *= -1
        Rn = U @ Vt
    return Rn


def rotation_angle_deg(Ra, Rb):
    """Angle (degrés) de la rotation qui sépare Ra et Rb."""
    c = (np.trace(Ra.T @ Rb) - 1) / 2
    return float(np.degrees(np.arccos(np.clip(c, -1, 1))))
