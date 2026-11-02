// 3D Surface Tracker — diagnostic des conventions d'After Effects.
// Mesure (1) la matrice de rotation produite par l'Orientation d'un calque 3D,
// (2) la projection d'un point par une caméra une-cible, (3) l'Orientation d'une caméra.
// Crée une compo temporaire puis la supprime. Le résultat s'affiche dans une fenêtre.
(function () {
    var comp = app.project.items.addComp("ST_diagnostic", 1920, 1080, 1, 1, 25);
    comp.openInViewer();
    var lines = [];
    function r(v) { var o = []; for (var i = 0; i < v.length; i++) o.push(Math.round(v[i] * 10000) / 10000); return o.join(","); }

    var probe = comp.layers.addNull();
    probe.threeDLayer = true;
    var pp = probe.property("ADBE Transform Group").property("ADBE Position");

    // (1) Orientation d'un calque -> axes monde
    var tgt = comp.layers.addNull();
    tgt.threeDLayer = true;
    var tests = [[30, 0, 0], [0, 30, 0], [0, 0, 30], [20, 30, 40]];
    for (var t = 0; t < tests.length; t++) {
        tgt.property("ADBE Transform Group").property("ADBE Orientation").setValue(tests[t]);
        var cols = [];
        var axes = ["[1,0,0]", "[0,1,0]", "[0,0,1]"];
        for (var a = 0; a < 3; a++) {
            pp.expression = "thisComp.layer(" + tgt.index + ").toWorldVec(" + axes[a] + ")";
            cols.push(r(pp.valueAtTime(0, false)));
        }
        lines.push("L" + tests[t].join("/") + " " + cols.join(" | "));
    }

    // (2) Projection caméra : caméra à (960,540,-1600), zoom 1600, point monde (1200,300,500)
    var cam = comp.layers.addCamera("diag cam", [960, 540]);
    cam.autoOrient = AutoOrientType.NO_AUTO_ORIENT;
    cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").setValue(1600);
    var camT = cam.property("ADBE Transform Group");
    camT.property("ADBE Position").setValue([960, 540, -1600]);
    camT.property("ADBE Orientation").setValue([0, 0, 0]);
    tgt.property("ADBE Transform Group").property("ADBE Orientation").setValue([0, 0, 0]);
    tgt.property("ADBE Transform Group").property("ADBE Position").setValue([1200, 300, 500]);
    var anc = "thisComp.layer(" + tgt.index + ").anchorPoint";
    pp.expression = "thisComp.layer(" + tgt.index + ").toComp(" + anc + ")";
    lines.push("P " + r(pp.valueAtTime(0, false)));

    // (3) Caméra orientée (20,30,40) : projection du même point
    camT.property("ADBE Orientation").setValue([20, 30, 40]);
    lines.push("C " + r(pp.valueAtTime(0, false)));

    var txt = lines.join("\n");
    comp.remove();
    alert("3D Surface Tracker - diagnostic\n(copiez tout ce texte)\n\n" + txt);
})();
