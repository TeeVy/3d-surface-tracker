"""Génère un script After Effects (.jsx) qui crée caméra + surface 3D animées.

Correspondance des repères : une caméra AE à une position C = (L/2, H/2, -zoom),
sans orientation, voit exactement comme la caméra OpenCV (X droite, Y bas,
Z vers l'avant, zoom = focale en pixels). Un point P exprimé dans le repère
caméra OpenCV se trouve donc en P + C dans l'espace monde d'AE.
"""

import json

import numpy as np

from .geometry import matrix_to_euler

# Ordre de composition des rotations « Orientation » d'AE : R = Rx · Ry · Rz, sens
# trigonométrique standard (Z appliqué en premier, autour de l'axe propre du calque).
# Vérifié dans AE 2026 avec tools/ae_diagnostic.jsx.
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


JSX_TEMPLATE = r"""// 3D Surface Tracker — script généré automatiquement.
// Utilisation : ouvrez la composition contenant la vidéo trackée, sélectionnez
// le calque vidéo (facultatif, pour caler le temps), puis
// Fichier > Scripts > Exécuter le fichier de script...
(function () {
    var D = __DATA__;
    var NAME = __NAME__;

    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) {
        var noComp = "Ouvrez d'abord la composition qui contient la vidéo trackée.";
        if ($.global.ST_PANEL) { $.global.ST_RESULT = "ERREUR " + noComp; return; }
        alert("3D Surface Tracker\n\n" + noComp);
        return;
    }
    var k = comp.width / D.width;
    if (Math.abs(comp.height / D.height - k) > 0.01) {
        if (!confirm("Les proportions de la composition (" + comp.width + "x" + comp.height +
                     ") diffèrent de la vidéo trackée (" + D.width + "x" + D.height + ").\nContinuer quand même ?")) return;
    }
    var startTime = 0;  // temps compo de la 1re image de la vidéo
    if (typeof $.global.ST_TIME_OFFSET === "number") startTime = $.global.ST_TIME_OFFSET;  // panneau (précomps compris)
    else if (comp.selectedLayers.length > 0) startTime = comp.selectedLayers[0].startTime;

    __ROUNDED_SHAPE__
    function sc(v) { return [v[0] * k, v[1] * k, v[2] * k]; }
    function times() {
        var t = [];
        for (var i = 0; i < D.frames.length; i++) t.push(startTime + D.frames[i] / D.fps);
        return t;
    }
    function scaleAll(a) {
        var o = [];
        for (var i = 0; i < a.length; i++) o.push(sc(a[i]));
        return o;
    }
    function animate(prop, values) {
        if (values.length === 1) prop.setValue(values[0]);
        else prop.setValuesAtTimes(times(), values);
    }

    // calques à créer (choix du panneau) ; par défaut : null + solide
    var LY = $.global.ST_LAYERS || {nul: true, solid: true, text: false};
    var w = Math.max(4, Math.round(D.size[0] * k)), h = Math.max(4, Math.round(D.size[1] * k));

    app.beginUndoGroup("3D Surface Track");

    // --- Caméra (une seule cible, pas d'orientation automatique) ; réutilisée si déjà là
    var cam = null;
    for (var ci = 1; ci <= comp.numLayers; ci++) {
        if (comp.layer(ci) instanceof CameraLayer && comp.layer(ci).name === NAME + " Caméra") cam = comp.layer(ci);
    }
    var camNew = !cam;
    if (camNew) cam = comp.layers.addCamera(NAME + " Caméra", [comp.width / 2, comp.height / 2]);
    cam.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
    var zooms = [];
    for (var z = 0; z < D.zoom.length; z++) zooms.push(D.zoom[z] * k);
    animate(cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom"), zooms);
    var camT = cam.property("ADBE Transform Group");
    animate(camT.property("ADBE Position"), scaleAll(D.camPos));
    animate(camT.property("ADBE Orientation"), D.camOri);

    // Pose de la surface appliquée directement au calque : son point d'ancrage = centre de la surface.
    function pose(L) {
        L.threeDLayer = true;
        var T = L.property("ADBE Transform Group");
        animate(T.property("ADBE Position"), scaleAll(D.srfPos));
        animate(T.property("ADBE Orientation"), D.srfOri);
        return L;
    }
    function poseNull(name) {
        var n = comp.layers.addNull();
        n.name = name;
        n.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0, 0]);
        return pose(n);
    }
    var made = [];

    // --- Texte posé sur la surface
    if (LY.text) {
        var txt = comp.layers.addText("Texte");
        txt.name = NAME + " Texte";
        var tp = txt.property("ADBE Text Properties").property("ADBE Text Document");
        var td = tp.value;
        td.fontSize = Math.max(6, Math.round(0.22 * Math.min(w, h)));
        td.fillColor = [1, 1, 1];
        td.justification = ParagraphJustification.CENTER_JUSTIFY;
        tp.setValue(td);
        var r = txt.sourceRectAtTime(comp.time, false);
        txt.property("ADBE Transform Group").property("ADBE Anchor Point")
           .setValue([r.left + r.width / 2, r.top + r.height / 2, 0]);
        pose(txt);
        made.push("texte");
    }

    // --- Solide collé à la surface (à remplacer par votre contenu)
    if (LY.solid) {
        var sol = comp.layers.addSolid([0.15, 0.55, 1.0], NAME + " Contenu (remplacez-moi)", w, h, comp.pixelAspect);
        pose(sol);
        sol.property("ADBE Transform Group").property("ADBE Scale").setValue([100 * D.size[0] * k / w, 100 * D.size[1] * k / h, 100]);
        sol.property("ADBE Transform Group").property("ADBE Opacity").setValue(60);
        var sh = roundedShape(w, h, D.shape === "disc" ? [1, 1, 1, 1] : (D.round || [0, 0, 0, 0]));
        if (sh) sol.property("ADBE Mask Parade").addProperty("ADBE Mask Atom").property("ADBE Mask Shape").setValue(sh);
        made.push("solide");
    }

    // --- Null 3D au centre de la surface : parentez-y votre contenu (position 0,0,0)
    var nul = poseNull(NAME + " Surface");
    if (LY.nul) made.push("null");

    // --- Autocontrôle : reprojection des coins de la surface vs coins trackés
    var probe = comp.layers.addNull();
    probe.threeDLayer = true;
    var pp = probe.property("ADBE Transform Group").property("ADBE Position");
    var sw = D.size[0] * k, shh = D.size[1] * k;
    var corners = [[-sw / 2, -shh / 2], [sw / 2, -shh / 2], [sw / 2, shh / 2], [-sw / 2, shh / 2]];
    var errSum = 0, errMax = 0, nErr = 0;
    for (var c = 0; c < 4; c++) {
        pp.expression = "thisComp.layer(" + nul.index + ").toComp([" + corners[c][0] + "," + corners[c][1] + ",0])";
        for (var j = 0; j < D.check.length; j++) {
            var v = pp.valueAtTime(startTime + D.check[j].f / D.fps, false);
            var dx = v[0] - D.check[j].c[c][0] * k, dy = v[1] - D.check[j].c[c][1] * k;
            var e2 = Math.sqrt(dx * dx + dy * dy);
            errSum += e2; nErr++;
            if (e2 > errMax) errMax = e2;
        }
    }
    probe.remove();
    if (!LY.nul) nul.remove();

    app.endUndoGroup();

    var msg = "3D Surface Tracker — " + (D.mode === "object" ? "mode OBJET (caméra fixe)" : "mode CAMÉRA (surface fixe)") +
              "\n\n" + D.frames.length + " images clés · calques créés : " + (made.length ? made.join(", ") : "aucun") +
              (camNew ? " + caméra" : " (caméra existante mise à jour)") +
              "\nZoom caméra : " + (D.zoom.length === 1 ? (D.zoom[0] * k).toFixed(0) + " px"
                                    : "animé (" + D.zoom.length + " clés, zoom de l'objectif)") +
              "\nContrôle de reprojection : moyenne " + (errSum / nErr).toFixed(2) + " px, max " + errMax.toFixed(2) + " px";
    if (errMax > 3) msg += "\n\n⚠ Écart élevé : vérifiez que le calque vidéo sélectionné est bien celui tracké.";
    if (LY.nul) msg += "\n\nPour poser votre contenu : parentez-le à « " + nul.name + " » et mettez sa position à 0,0,0.";
    if ($.global.ST_TEST_MODE) { $.global.ST_TEST_RESULT = {mean: errSum / nErr, max: errMax}; return; }
    if ($.global.ST_PANEL) { $.global.ST_RESULT = msg; return; }
    alert(msg);
})();
"""


# Masque d'un rectangle w x h aux coins arrondis : r = arrondi des coins HG, HD, BD, BG (0..1, 1 =
# rayon d'une demi-largeur / demi-hauteur, comme le contour suivi). Tous à 1 : ellipse inscrite.
# null si aucun arrondi. Partagé avec l'effet (native/STEffect).
ROUNDED_SHAPE_JS = r"""function roundedShape(w, h, r) {
        var K = 0.5523, v = [], it = [], ot = [], any = false;
        // coin : position, sens vers le côté précédent (entrée) et vers le côté suivant (sortie)
        var C = [[0, 0, [0, 1], [1, 0]], [w, 0, [-1, 0], [0, 1]], [w, h, [0, -1], [-1, 0]], [0, h, [1, 0], [0, -1]]];
        for (var i = 0; i < 4; i++) {
            var rx = 0.5 * Math.max(0, Math.min(1, r[i])) * w, ry = 0.5 * Math.max(0, Math.min(1, r[i])) * h;
            var c = C[i], a = c[2], b = c[3];
            if (rx < 1e-3 || ry < 1e-3) { v.push([c[0], c[1]]); it.push([0, 0]); ot.push([0, 0]); continue; }
            any = true;
            var ra = a[0] ? rx : ry, rb = b[0] ? rx : ry;
            v.push([c[0] + a[0] * ra, c[1] + a[1] * ra]); it.push([0, 0]); ot.push([-a[0] * K * ra, -a[1] * K * ra]);
            v.push([c[0] + b[0] * rb, c[1] + b[1] * rb]); it.push([-b[0] * K * rb, -b[1] * K * rb]); ot.push([0, 0]);
        }
        if (!any) return null;
        var s = new Shape();
        s.vertices = v; s.inTangents = it; s.outTangents = ot; s.closed = true;
        return s;
    }"""


def write_jsx(path, data, name="ST"):
    js = JSX_TEMPLATE.replace("__DATA__", json.dumps(data, separators=(",", ":")))
    js = js.replace("__ROUNDED_SHAPE__", ROUNDED_SHAPE_JS)
    js = js.replace("__NAME__", json.dumps(name, ensure_ascii=False))
    with open(path, "w", encoding="utf-8-sig") as fh:  # BOM : AE lit alors l'UTF-8 correctement
        fh.write(js)
