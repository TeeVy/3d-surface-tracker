"""Tracker planaire 2D.

La zone suivie est un polygone libre (quadrilatère, ellipse…) désigné sur
l'image de référence. Seuls ses pixels comptent : le fond est ignoré.

Pour chaque image, on estime l'homographie H (référence -> image courante) :

1. Suivi de points (KLT, contrôle aller-retour, RANSAC) depuis l'image
   précédente : bonne initialisation, même pour de grands mouvements.
2. Alignement dense (ECC) de toute la zone contre l'image PRÉCÉDENTE : utilise
   chaque pixel, y compris les bords et dégradés. Fonctionne sur les surfaces
   peu texturées, là où les points manquent.
3. Ancrage sur l'image de RÉFÉRENCE quand elle ressemble encore assez à
   l'image courante : supprime la dérive accumulée.

La confiance d'une image est la corrélation de l'alignement image à image.
L'ECC est insensible aux variations de luminosité (gain/offset).
"""

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import warp_points


@dataclass
class TrackResult:
    homographies: np.ndarray  # (N,3,3) référence -> image i
    confidence: np.ndarray    # (N,) 0..1
    anchored: np.ndarray      # (N,) bool : recalée sur la référence
    ref_index: int

    @staticmethod
    def warp_one(H, pts):
        return warp_points(H, pts)

    def warp(self, pts):
        """Position d'un ensemble de points de la référence dans chaque image : (N,len(pts),2)."""
        return np.array([warp_points(H, pts) for H in self.homographies])

    def scaled(self, s):
        """Homographies exprimées pour une image s fois plus grande."""
        S = np.diag([s, s, 1.0])
        Si = np.diag([1 / s, 1 / s, 1.0])
        return TrackResult(np.array([S @ H @ Si for H in self.homographies]), self.confidence,
                           self.anchored, self.ref_index)


class _Template:
    """Modèle pour l'ECC : découpe + masque + pyramide."""

    def __init__(self, img, polygon, erode=5):
        h_img, w_img = img.shape
        x0, y0 = np.floor(polygon.min(axis=0)).astype(int)
        x1, y1 = np.ceil(polygon.max(axis=0)).astype(int)
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w_img, x1), min(h_img, y1)
        self.ok = (x1 - x0 >= 16) and (y1 - y0 >= 16)
        if not self.ok:
            return
        self.offset = np.array([[1, 0, x0], [0, 1, y0], [0, 0, 1]], dtype=np.float64)
        crop = img[y0:y1, x0:x1].astype(np.float32)
        mask = np.zeros(crop.shape, np.uint8)
        cv2.fillPoly(mask, [np.int32(np.round(polygon - [x0, y0]))], 255)
        if erode:
            mask = cv2.erode(mask, np.ones((erode, erode), np.uint8))
        self.ok = cv2.countNonZero(mask) > 200
        w, h = x1 - x0, y1 - y0
        self.levels = []
        for s in (0.125, 0.25, 0.5, 1.0):  # grossier -> fin, jusqu'à ~600 px
            if min(w, h) * s < 40 and s < 1.0:
                continue
            tpl = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else crop
            m = cv2.resize(mask, (tpl.shape[1], tpl.shape[0]), interpolation=cv2.INTER_NEAREST)
            self.levels.append((s, tpl, m))
            if max(w, h) * s >= 600:
                break


class PlanarTracker:
    def __init__(self, max_features=500, anchor_min_cc=0.7, ecc_iterations=50, verbose=True, robust=True):
        self.robust = robust  # occultations : alignement refait sans les pixels aberrants
        self.anchor_sure_cc = 0.97  # ressemblance à une ancre qui l'impose quelle que soit la dérive
        self.max_features = max_features
        self.anchor_min_cc = anchor_min_cc
        self.ecc_criteria = (cv2.TERM_CRITERIA_COUNT | cv2.TERM_CRITERIA_EPS, ecc_iterations, 1e-6)
        self.verbose = verbose
        self._cache = {}

    # ------------------------------------------------------------------ public
    def track(self, frames, ref_index, polygon, progress=None, should_stop=None):
        """progress(fait, total, i, H) après chaque image ; should_stop() -> True pour
        arrêter : les images non encore trackées restent vides (NaN)."""
        poly = self.prepare(frames[ref_index], polygon)
        n = len(frames)

        Hs = np.full((n, 3, 3), np.nan)
        conf = np.zeros(n)
        anchored = np.zeros(n, bool)
        Hs[ref_index], conf[ref_index], anchored[ref_index] = np.eye(3), 1.0, True
        done = 1
        self.stopped = False
        for step in (1, -1):  # vers l'avant puis vers l'arrière depuis la référence
            H_prev, dH_prev, prev = np.eye(3), np.eye(3), ref_index
            i = ref_index + step
            while 0 <= i < n:
                if should_stop is not None and should_stop():
                    self.stopped = True
                    break
                self._cache = {}
                H, c, a = self._step(frames[prev], frames[i], H_prev, dH_prev, poly)
                Hs[i], conf[i], anchored[i] = H, c, a
                dH_prev = H @ np.linalg.inv(H_prev)
                H_prev, prev = H, i
                i += step
                done += 1
                if progress:
                    progress(done, n, i - step, H)
            if self.stopped:
                break
        return TrackResult(Hs, conf, anchored, ref_index)

    def prepare(self, ref_img, polygon, ref_index=0):
        """Modèle de la référence (anti-dérive). Renvoie le polygone en (k,2) float."""
        poly = np.asarray(polygon, dtype=np.float64).reshape(-1, 2)
        self.ref_tpl = _Template(ref_img, poly)
        if not self.ref_tpl.ok:
            raise ValueError("La zone à tracker est trop petite ou hors de l'image.")
        size = float(np.linalg.norm(poly.max(axis=0) - poly.min(axis=0)))
        self.max_anchor_jump = max(3.0, 0.02 * size)
        self.max_trusted_jump = 0.25 * size
        # ancres : (image, modèle, homographie référence -> cette image) ; la référence d'abord
        self.anchors = [(ref_index, self.ref_tpl, np.eye(3))]
        return poly

    def add_anchor(self, index, img, H, poly):
        """Image où la forme est sûre (clé de correction) : sert aussi de modèle de recalage."""
        tpl = _Template(img, warp_points(H, poly))
        if tpl.ok:
            self.anchors.append((index, tpl, np.asarray(H, float)))

    def step(self, prev, cur, H_prev, dH_prev, poly, index=None):
        """Une image : (H référence -> cur, confiance, recalée sur une ancre). index : n° de l'image,
        pour choisir l'ancre la plus proche dans le temps."""
        self._cache = {}
        return self._step(prev, cur, H_prev, dH_prev, poly, index)

    # ----------------------------------------------------------------- interne
    def _scaled(self, img, s):
        if s not in self._cache:
            self._cache[s] = (cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
                              if s < 1 else img).astype(np.float32)
        return self._cache[s]

    def _klt(self, prev, cur, poly_prev, dH_prev):
        """Mouvement image précédente -> courante par suivi de points (None si insuffisant)."""
        mask = np.zeros(prev.shape, np.uint8)
        cv2.fillPoly(mask, [np.int32(np.round(poly_prev))], 255)
        mask = cv2.erode(mask, np.ones((9, 9), np.uint8))
        p0 = cv2.goodFeaturesToTrack(prev, self.max_features, 0.005, 6, mask=mask, blockSize=7)
        if p0 is None or len(p0) < 8:
            return None
        lk = dict(winSize=(21, 21), maxLevel=4,
                  criteria=(cv2.TERM_CRITERIA_COUNT | cv2.TERM_CRITERIA_EPS, 30, 0.01),
                  flags=cv2.OPTFLOW_USE_INITIAL_FLOW)
        guess = cv2.perspectiveTransform(p0, dH_prev).astype(np.float32)
        p1, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, p0, guess.copy(), **lk)
        p0b, st2, _ = cv2.calcOpticalFlowPyrLK(cur, prev, p1, p0.copy(), **lk)
        fb = np.linalg.norm((p0 - p0b).reshape(-1, 2), axis=1)
        good = (st.ravel() == 1) & (st2.ravel() == 1) & (fb < 1.0)
        if good.sum() < 8:
            return None
        dH, inl = cv2.findHomography(p0[good], p1[good], cv2.USAC_MAGSAC, 1.5)
        if dH is None or inl.sum() < 8:
            return None
        return dH

    def _ecc_levels(self, levels, cur, W):
        """ECC multi-échelle sur des niveaux (échelle, modèle, masque) ; W en coords du modèle découpé."""
        cc = 0.0
        for s, img_t, m in levels:
            S = np.diag([s, s, 1.0])
            img = self._scaled(cur, s)
            Ws = (S @ W @ np.linalg.inv(S)).astype(np.float32)
            Ws /= Ws[2, 2]
            try:
                cc, Ws = cv2.findTransformECCWithMask(img_t, img, m, np.full(img.shape, 255, np.uint8),
                                                      Ws, cv2.MOTION_HOMOGRAPHY, self.ecc_criteria, 3)
            except cv2.error:
                return None, 0.0
            W = np.linalg.inv(S) @ Ws.astype(np.float64) @ S
        return W, float(cc)

    def _outliers(self, tpl, cur, W):
        """Pixels du modèle qui ne ressemblent pas à l'image courante une fois alignés (main,
        objet qui passe devant, reflet) : masque au niveau le plus fin, ou None s'il n'y en a pas."""
        s, img_t, m = tpl.levels[-1]
        S = np.diag([s, s, 1.0])
        Ws = S @ W @ np.linalg.inv(S)
        warped = cv2.warpPerspective(self._scaled(cur, s), Ws, (img_t.shape[1], img_t.shape[0]),
                                     flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
        inside = m > 0
        a, b = img_t[inside], warped[inside]
        if a.std() < 1e-3 or b.std() < 1e-3:
            return None
        # écart après normalisation gain / décalage (comme l'ECC), seuil robuste (médiane)
        r = np.zeros(img_t.shape, np.float32)
        r[inside] = np.abs((a - a.mean()) / a.std() - (b - b.mean()) / b.std())
        thr = max(0.6, 3.5 * 1.4826 * float(np.median(r[inside])))
        bad = ((r > thr) & inside).astype(np.uint8)
        k = max(3, int(round(min(img_t.shape) / 60)) | 1)
        bad = cv2.morphologyEx(bad, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))   # ignorer le bruit isolé
        bad = cv2.dilate(bad, np.ones((2 * k + 1, 2 * k + 1), np.uint8))           # et les bords de l'objet
        frac = bad[inside].mean()
        return bad if 0.08 < frac < 0.6 else None  # reflet, bruit : sous 8 %, rien n'est exclu

    def _ecc(self, tpl, cur, W_init):
        """Homographie (coords modèle découpé -> image courante) par ECC multi-échelle, robuste aux
        occultations : si une partie du modèle ne correspond pas (objet passé devant), on refait
        l'alignement sans elle. Renvoie (H image du modèle -> image courante, corrélation)."""
        W0 = W_init @ tpl.offset
        W, cc = self._ecc_levels(tpl.levels, cur, W0)
        if W is None:
            return None, 0.0
        if self.robust:
            # occultations repérées après l'alignement, et aussi à la position prévue (si un gros
            # objet a déjà faussé l'alignement) : on garde la meilleure ressemblance sur le reste
            best = (W, cc)
            for start in (W, W0):
                bad = self._outliers(tpl, cur, start)
                if bad is None:
                    continue
                levels = []
                for s_, img_t, m in tpl.levels:
                    b_ = cv2.resize(bad, (m.shape[1], m.shape[0]), interpolation=cv2.INTER_NEAREST)
                    levels.append((s_, img_t, np.where(b_ > 0, 0, m).astype(np.uint8)))
                if not all(cv2.countNonZero(m) > 200 for _, _, m in levels):
                    continue
                W2, cc2 = self._ecc_levels(levels if start is W0 else levels[-2:], cur, start)
                if W2 is not None and cc2 > best[1]:
                    best = (W2, cc2)
            W, cc = best
        W = W @ np.linalg.inv(tpl.offset)
        return W / W[2, 2], float(cc)

    def _anchor(self, cur, H, index, poly):
        """Recalage sur l'ancre la plus proche dans le temps (la référence, ou une clé), puis sur la
        référence si ça échoue : (H, corrélation) ou (None, 0)."""
        order = sorted(self.anchors, key=lambda a: abs(a[0] - index)) if index is not None else self.anchors
        tried = set()
        for k, tpl, Ha in order[:1] + [self.anchors[0]]:
            if k in tried:
                continue
            tried.add(k)
            W, cc = self._ecc(tpl, cur, H @ np.linalg.inv(Ha))  # image de l'ancre -> image courante
            if W is None or cc < self.anchor_min_cc:
                continue
            Hn = W @ Ha
            jump = np.abs(warp_points(Hn, poly) - warp_points(H, poly)).max()
            # près de l'estimation : accepté ; plus loin, seulement si la ressemblance est excellente
            # (l'ancre est sûre, et les occultations sont exclues de la comparaison)
            # (l'ancre est sûre, et les occultations sont exclues de la comparaison). Une ressemblance
            # quasi parfaite rattrape même une forte dérive (après une occultation, par exemple).
            if (jump < self.max_anchor_jump or (cc >= 0.9 and jump < self.max_trusted_jump)
                    or cc >= self.anchor_sure_cc):
                return Hn, cc
        return None, 0.0

    def _step(self, prev, cur, H_prev, dH_prev, poly, index=None):
        poly_prev = warp_points(H_prev, poly)
        # 1. initialisation : points suivis, et vitesse constante. Les points peuvent suivre un objet
        # qui passe devant (main) : si les deux désaccordent, on aligne depuis chacun.
        dH_klt = self._klt(prev, cur, poly_prev, dH_prev)
        inits = [dH_prev] if dH_klt is None else [dH_klt]
        if dH_klt is not None:
            gap = np.abs(warp_points(dH_klt, poly_prev) - warp_points(dH_prev, poly_prev)).max()
            if gap > self.max_anchor_jump:
                inits.append(dH_prev)
        # 2. alignement dense image précédente -> courante : la meilleure ressemblance l'emporte
        dH, cc_inc = inits[0], 0.0
        tpl_prev = _Template(prev, poly_prev)
        if tpl_prev.ok:
            for init in inits:
                dH_ecc, cc = self._ecc(tpl_prev, cur, init)
                if dH_ecc is not None and cc > cc_inc:
                    dH, cc_inc = dH_ecc, cc
        H = dH @ H_prev
        # 3. recalage sur une ancre (anti-dérive)
        H_a, cc_a = self._anchor(cur, H, index, poly)
        if H_a is not None:
            return H_a, max(cc_inc, cc_a), True
        return H, cc_inc, False
