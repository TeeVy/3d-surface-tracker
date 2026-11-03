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
        "outline": None if res.outline is None else np.round(res.outline, 5).tolist(),
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

    app.beginUndoGroup("3D Surface Track");

    // --- Caméra (une seule cible, pas d'orientation automatique)
    var cam = comp.layers.addCamera(NAME + " Caméra", [comp.width / 2, comp.height / 2]);
    cam.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
    var zooms = [];
    for (var z = 0; z < D.zoom.length; z++) zooms.push(D.zoom[z] * k);
    animate(cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom"), zooms);
    var camT = cam.property("ADBE Transform Group");
    animate(camT.property("ADBE Position"), scaleAll(D.camPos));
    animate(camT.property("ADBE Orientation"), D.camOri);

    // --- Null 3D qui porte la pose de la surface
    var nul = comp.layers.addNull();
    nul.name = NAME + " Surface (pose)";
    nul.threeDLayer = true;
    var nulT = nul.property("ADBE Transform Group");
    animate(nulT.property("ADBE Position"), scaleAll(D.srfPos));
    animate(nulT.property("ADBE Orientation"), D.srfOri);

    // --- Solide de démonstration collé à la surface (à remplacer par votre contenu)
    var w = Math.max(4, Math.round(D.size[0] * k)), h = Math.max(4, Math.round(D.size[1] * k));
    var sol = comp.layers.addSolid([0.15, 0.55, 1.0], NAME + " Contenu (remplacez-moi)", w, h, comp.pixelAspect);
    sol.threeDLayer = true;
    sol.setParentWithJump(nul);  // « parent = » compenserait la transformation : on veut l'identité
    var solT = sol.property("ADBE Transform Group");
    solT.property("ADBE Position").setValue(nulT.property("ADBE Anchor Point").value);
    solT.property("ADBE Orientation").setValue([0, 0, 0]);
    solT.property("ADBE Rotate X").setValue(0);
    solT.property("ADBE Rotate Y").setValue(0);
    solT.property("ADBE Rotate Z").setValue(0);
    solT.property("ADBE Scale").setValue([100 * D.size[0] * k / w, 100 * D.size[1] * k / h, 100]);
    solT.property("ADBE Opacity").setValue(60);
    if (D.shape === "disc") {  // masque circulaire inscrit dans le carré
        var mk = sol.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        var e = 0.5523, sh = new Shape();
        sh.vertices = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
        sh.inTangents = [[-e * w / 2, 0], [0, -e * h / 2], [e * w / 2, 0], [0, e * h / 2]];
        sh.outTangents = [[e * w / 2, 0], [0, e * h / 2], [-e * w / 2, 0], [0, -e * h / 2]];
        sh.closed = true;
        mk.property("ADBE Mask Shape").setValue(sh);
    }
    if (D.shape === "free" && D.outline) {  // masque reprenant la forme libre
        var mf = sol.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        var sf = new Shape(), vs = [];
        for (var q = 0; q < D.outline.length; q++) vs.push([D.outline[q][0] * w, D.outline[q][1] * h]);
        sf.vertices = vs;
        sf.closed = true;
        mf.property("ADBE Mask Shape").setValue(sf);
    }
    sol.moveBefore(nul);

    // --- Autocontrôle : reprojection des coins du solide vs coins trackés
    var probe = comp.layers.addNull();
    probe.threeDLayer = true;
    var pp = probe.property("ADBE Transform Group").property("ADBE Position");
    var corners = [[0, 0], [w, 0], [w, h], [0, h]];
    var errSum = 0, errMax = 0, nErr = 0;
    for (var c = 0; c < 4; c++) {
        pp.expression = "thisComp.layer(" + sol.index + ").toComp([" + corners[c][0] + "," + corners[c][1] + ",0])";
        for (var j = 0; j < D.check.length; j++) {
            var v = pp.valueAtTime(startTime + D.check[j].f / D.fps, false);
            var dx = v[0] - D.check[j].c[c][0] * k, dy = v[1] - D.check[j].c[c][1] * k;
            var e = Math.sqrt(dx * dx + dy * dy);
            errSum += e; nErr++;
            if (e > errMax) errMax = e;
        }
    }
    probe.remove();

    app.endUndoGroup();

    var msg = "3D Surface Tracker — " + (D.mode === "object" ? "mode OBJET (caméra fixe)" : "mode CAMÉRA (surface fixe)") +
              "\n\n" + D.frames.length + " images clés créées." +
              "\nZoom caméra : " + (D.zoom.length === 1 ? (D.zoom[0] * k).toFixed(0) + " px"
                                    : "animé (" + D.zoom.length + " clés, zoom de l'objectif)") +
              "\nContrôle de reprojection : moyenne " + (errSum / nErr).toFixed(2) + " px, max " + errMax.toFixed(2) + " px";
    if (errMax > 3) msg += "\n\n⚠ Écart élevé : vérifiez que le calque vidéo sélectionné est bien celui tracké.";
    msg += "\n\nPlacez votre contenu comme enfant de « " + nul.name + " » (ou remplacez le solide).";
    if ($.global.ST_TEST_MODE) { $.global.ST_TEST_RESULT = {mean: errSum / nErr, max: errMax}; return; }
    if ($.global.ST_PANEL) { $.global.ST_RESULT = msg; return; }
    alert(msg);
})();
"""


def write_jsx(path, data, name="ST"):
    js = JSX_TEMPLATE.replace("__DATA__", json.dumps(data, separators=(",", ":")))
    js = js.replace("__NAME__", json.dumps(name, ensure_ascii=False))
    with open(path, "w", encoding="utf-8-sig") as fh:  # BOM : AE lit alors l'UTF-8 correctement
        fh.write(js)
