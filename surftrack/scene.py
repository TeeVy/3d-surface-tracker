"""Analyse de la scène autour de la surface.

1. Qui bouge ? Si le décor autour de la surface bouge de la même façon qu'elle,
   la surface est fixe dans la pièce et c'est la caméra qui bouge ; sinon c'est
   l'objet. Ça détermine ce qui sera animé dans After Effects (la caméra ou la
   surface), ce qui compte dès qu'on ajoute d'autres éléments 3D à la scène.

2. Orientation d'une surface de forme libre. Sans forme connue (rectangle,
   disque), l'inclinaison se lit dans le mouvement : la façon dont la
   perspective de la surface se déforme d'une image à l'autre dépend de son
   orientation (décomposition de l'homographie). Il faut pour cela que la caméra
   ou l'objet se déplace un peu (pas seulement tourner sur place).
"""

import cv2
import numpy as np

from .geometry import warp_points


def _skew(t):
    return np.array([[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]])


def detect_motion_mode(frames, track_scale, homographies, poly, pose, width, height, max_side=640):
    """Qui bouge : la surface ou la caméra ? Renvoie ('object' | 'camera', explication).

    On suit des points du décor (hors surface) et on compare deux hypothèses :
      - caméra fixe : le décor ne bouge pas à l'image ;
      - surface fixe : la caméra a fait le mouvement inverse de celui calculé
        pour la surface, donc chaque point du décor doit rester sur sa droite
        épipolaire, quelle que soit sa profondeur (la parallaxe est permise).
    L'hypothèse qui explique le mieux le décor l'emporte.
    frames : images réduites (track_scale) ; homographies, poly, pose : pleine résolution."""
    valid = np.flatnonzero(pose.valid & np.isfinite(homographies).all(axis=(1, 2)))
    if len(valid) < 3:
        return "object", "trop peu d'images pour analyser le décor"
    step = max(1, len(valid) // 40)
    h, w = frames[0].shape
    s = min(1.0, max_side / max(h, w))
    g = s * track_scale                       # pixels analysés = g × pixels pleine résolution
    size = np.ptp(poly, axis=0).max() * g
    c = np.array([width / 2, height / 2])
    static_err, epi_err = [], []
    for a, b in zip(valid[:-step:step], valid[step::step]):
        ia = cv2.resize(frames[a], None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        ib = cv2.resize(frames[b], None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        mask = np.full(ia.shape, 255, np.uint8)  # décor = tout sauf la surface (avec une marge)
        cv2.fillPoly(mask, [np.int32(np.round(warp_points(homographies[a], poly) * g))], 0)
        mask = cv2.erode(mask, np.ones((max(3, int(0.15 * size)),) * 2, np.uint8))
        p0 = cv2.goodFeaturesToTrack(ia, 300, 0.01, 8, mask=mask)
        if p0 is None or len(p0) < 20:
            continue
        p1, st, _ = cv2.calcOpticalFlowPyrLK(ia, ib, p0, None, winSize=(21, 21), maxLevel=4)
        good = st.ravel() == 1
        if good.sum() < 20:
            continue
        xa, xb = p0[good].reshape(-1, 2) / g, p1[good].reshape(-1, 2) / g   # pleine résolution
        static_err.append(np.median(np.linalg.norm(xb - xa, axis=1)))
        # mouvement de caméra impliqué par « surface fixe »
        Rab = pose.R[b] @ pose.R[a].T
        tab = pose.t[b] - Rab @ pose.t[a]
        if np.linalg.norm(tab) < 1e-9:
            epi_err.append(static_err[-1])
            continue
        E = _skew(tab / np.linalg.norm(tab)) @ Rab
        na = np.column_stack([(xa - c) / pose.focal[a], np.ones(len(xa))])
        nb = np.column_stack([(xb - c) / pose.focal[b], np.ones(len(xb))])
        Ea, Etb = na @ E.T, nb @ E
        num = np.sum(nb * Ea, axis=1) ** 2
        den = Ea[:, 0] ** 2 + Ea[:, 1] ** 2 + Etb[:, 0] ** 2 + Etb[:, 1] ** 2
        epi_err.append(np.median(np.sqrt(num / np.maximum(den, 1e-18))) * pose.focal[b])  # distance de Sampson (px)
    if not static_err:
        return "object", "pas assez de décor visible autour de la surface"
    st_e, ep_e = float(np.median(static_err)), float(np.median(epi_err))
    if st_e < 1.5:
        return "object", f"le décor est immobile ({st_e:.1f} px)"
    # seuil prudent : si la main ET la caméra bougent, aucune hypothèse n'est parfaite ;
    # on n'anime alors la caméra que si le décor la confirme nettement
    if ep_e < 0.35 * st_e:
        return "camera", f"le décor suit le mouvement de caméra déduit de la surface (écart {ep_e:.1f} px contre {st_e:.1f} px)"
    return "object", f"le décor ne suit pas un mouvement de caméra commun (écart {ep_e:.1f} px contre {st_e:.1f} px)"


def estimate_plane_normal(homographies, focals, width, height, ref_index, poly, max_frames=60):
    """Normale du plan (repère caméra de référence, orientée vers l'arrière-plan)
    déduite du mouvement. Renvoie (normale, fiable, explication)."""
    def K(f):
        return np.array([[f, 0, width / 2], [0, f, height / 2], [0, 0, 1]])

    Kr_inv = np.linalg.inv(K(focals[ref_index]))
    rays = np.column_stack([poly, np.ones(len(poly))]) @ Kr_inv.T
    valid = [i for i in np.flatnonzero(np.isfinite(homographies).all(axis=(1, 2))) if i != ref_index]
    if not valid:
        return np.array([0.0, 0, 1]), False, "aucune autre image trackée"
    idx = valid[::max(1, len(valid) // max_frames)]
    cands, weights = [], []
    for i in idx:
        Hn = np.linalg.inv(K(focals[i])) @ homographies[i] @ np.linalg.inv(Kr_inv)
        Hn /= np.linalg.svd(Hn, compute_uv=False)[1]
        n_sol, Rs, ts, ns = cv2.decomposeHomographyMat(Hn, np.eye(3))
        for t, n in zip(ts, ns):
            if np.linalg.norm(n) < 1e-9:
                continue
            n = n.ravel() / np.linalg.norm(n)
            if np.all(rays @ n > 0):  # plan devant la caméra
                cands.append(n)
                weights.append(float(np.linalg.norm(t)))  # déplacement / distance : force de la parallaxe
    if not cands:
        return np.array([0.0, 0, 1]), False, "aucune solution physique"
    cands, weights = np.array(cands), np.array(weights)
    close = (cands @ cands.T) > np.cos(np.radians(8))
    score = close @ weights
    best = int(np.argmax(score))
    members = close[best]
    n = (cands[members] * weights[members, None]).sum(axis=0)
    n /= np.linalg.norm(n)
    share = score[best] / weights.sum()          # la vraie normale revient à chaque image
    parallax = float(np.median(weights[members]))
    reliable = share > 0.35 and parallax > 0.02
    tilt = np.degrees(np.arccos(np.clip(n[2], -1, 1)))
    why = (f"inclinaison {tilt:.0f}° déduite du mouvement (cohérence {100 * share:.0f} %, "
           f"parallaxe {100 * parallax:.1f} %)")
    return n, bool(reliable), why
