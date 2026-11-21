// 3D Surface Tracker — fonctions ExtendScript appelées par le panneau.
// Chaque fonction renvoie une chaîne JSON.
//
// Le calque tracké porte l'effet « 3D Surface Tracker » : le panneau suit l'image telle
// qu'elle arrive à cet effet (calculée par After Effects, via le pont STBridge), écrit le
// résultat dans les paramètres de l'effet (« Appliquer le tracking ») et le relit en
// rouvrant le tracker : le tracking appartient à l'effet.

function stJSON(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") {
        return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
    }
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(stJSON(v[i]));
        return "[" + a.join(",") + "]";
    }
    var o = [];
    for (var k in v) if (v.hasOwnProperty(k)) o.push(stJSON(k) + ":" + stJSON(v[k]));
    return "{" + o.join(",") + "}";
}

function stFail(msg) { return stJSON({ok: false, msg: msg}); }

// Langue des messages (choisie dans le panneau) : T("english", "français").
var ST_LANG = "en";
function stSetLang(lang) { ST_LANG = lang === "fr" ? "fr" : "en"; return stJSON({ok: true}); }
function T(en, fr) { return ST_LANG === "fr" ? fr : en; }

function stNear(a, b, tol) { return Math.abs(a - b) <= tol; }

var ST_MATCH = "SurfTrack 3D Surface Tracker";

function stFindComp(compId) {
    var c = app.project.itemByID(compId);
    return (c instanceof CompItem) ? c : null;
}

function stIsVideoFootage(src) {
    return (src instanceof FootageItem) && src.file && !(src.mainSource instanceof SolidSource) &&
           !src.mainSource.isStill && src.hasVideo;
}

// Calque désigné par le bouton de l'effet (compo, indice, instant ; instant < 0 : celui de la compo).
function stGetLayer(compId, layerIndex, time) {
    var comp = stFindComp(compId);
    if (!comp) return stFail(T("The comp of the layer to track cannot be found.", "La composition du calque à tracker est introuvable."));
    if (layerIndex < 1 || layerIndex > comp.numLayers) return stFail(T("The layer to track cannot be found.", "Le calque à tracker est introuvable."));
    return stDescribe(comp, comp.layer(layerIndex), time < 0 ? comp.time : time);
}

// Indice (1..n) de l'effet « 3D Surface Tracker » actif sur le calque, ou 0.
function stTrackerEffect(L) {
    var par = L.property("ADBE Effect Parade");
    if (!par) return 0;
    for (var i = 1; i <= par.numProperties; i++) {
        if (par.property(i).matchName === ST_MATCH && par.property(i).active) return i;
    }
    return 0;
}

function stTrackerFx(comp, layerIndex) {
    if (!comp || layerIndex < 1 || layerIndex > comp.numLayers) return null;
    var i = stTrackerEffect(comp.layer(layerIndex));
    return i ? comp.layer(layerIndex).property("ADBE Effect Parade").property(i) : null;
}

// Temps dans la source d'un calque à l'instant t de sa compo (remappage et étirement
// compris), ou null s'il n'est pas visible à cet instant.
function stLayerTime(L, t) {
    if (t < L.inPoint - 1e-6 || t >= L.outPoint - 1e-6) return null;
    if (L.timeRemapEnabled) return L.property("ADBE Time Remapping").valueAtTime(t, false);
    return (t - L.startTime) * 100 / L.stretch;
}

// Description du calque pour le panneau : images de la compo où il est visible, effet
// tracker, rush pour la focale. Sans l'effet, le panneau propose de l'ajouter.
function stDescribe(comp, sel, time) {
    if (!(sel instanceof AVLayer) || !sel.source) return stFail(T("Layer \u201c" + sel.name + "\u201d is neither a video nor a precomp.", "Le calque « " + sel.name + " » n'est ni une vidéo ni un précomp."));
    var src = sel.source, isComp = src instanceof CompItem;
    if (!isComp && !stIsVideoFootage(src)) return stFail(T("Layer \u201c" + sel.name + "\u201d is neither a video nor a precomp.", "Le calque « " + sel.name + " » n'est ni une vidéo ni un précomp."));
    var stFx = stTrackerEffect(sel);
    if (!stFx) {
        var par0 = sel.property("ADBE Effect Parade");
        return stJSON({ok: true, needEffect: true, compId: comp.id, compName: comp.name, layerIndex: sel.index,
                       layerName: sel.name, hasEffects: par0.numProperties > 0});
    }
    var warnings = [];
    var below = [], par = sel.property("ADBE Effect Parade");
    for (var e = stFx + 1; e <= par.numProperties; e++) if (par.property(e).active) below.push(par.property(e).name);
    if (below.length) warnings.push(T("Effects below \u201c3D Surface Tracker\u201d (" + below.join(", ") + ") are not seen by the tracker. Move the tracker to the bottom of the stack.",
                         "Effets placés sous « 3D Surface Tracker » (" + below.join(", ") + ") : le tracking ne les voit pas. Mettez le tracker en bas de la pile."));
    // Images de la compo où le calque est visible ; pour la focale, l'instant correspondant
    // dans la source du calque (remappage et étirement compris).
    var fd = comp.frameDuration, fps = isComp ? 1 / src.frameDuration : src.frameRate;
    var srcFrames = isComp ? 0 : Math.round(src.duration * fps);
    var j0 = Math.max(0, Math.ceil(sel.inPoint / fd - 1e-4));
    var j1 = Math.min(Math.round(comp.duration / fd), Math.ceil(sel.outPoint / fd - 1e-4)) - 1;
    var keys = [];                          // métrage : image du fichier ; précomp : instant interne
    for (var j = j0; j <= j1; j++) {
        var t = stLayerTime(sel, j * fd);
        if (t === null || t < -1e-6 || t >= src.duration - 1e-6) { keys.push(null); continue; }
        if (isComp) keys.push(Math.max(0, t));
        else { var f = Math.floor(t * fps + 1e-4); keys.push(f < srcFrames ? f : null); }
    }
    var a = 0, b = keys.length - 1;
    while (a <= b && keys[a] === null) a++;
    while (b >= a && keys[b] === null) b--;
    if (a > b) return stFail(T("The layer is not visible on any frame of the comp.", "Le calque n'est visible sur aucune image de la composition."));
    keys = keys.slice(a, b + 1);
    var seqStart = j0 + a;
    for (var q = 1; q < keys.length; q++) if (keys[q] === null) keys[q] = keys[q - 1];  // trou : image voisine

    var cur = Math.floor(time / fd + 1e-4) - seqStart;
    if (cur < 0 || cur >= keys.length) {
        warnings.push(T("The current time is outside the visible part of the layer: the reference starts at its " +
                        (cur < 0 ? "first" : "last") + " frame. Pick it in the panel's timeline.",
                        "L'instant courant est hors de la partie visible du calque : la référence part de " +
                        (cur < 0 ? "sa première" : "sa dernière") + " image. Choisissez-la dans la timeline du panneau."));
        cur = Math.min(keys.length - 1, Math.max(0, cur));
    }
    var times = [];
    for (var c = 0; c < keys.length; c++) times.push((seqStart + c) * fd);
    var out = {
        ok: true, compId: comp.id, compName: comp.name, compFps: 1 / fd, layerIndex: sel.index, layerName: sel.name,
        effectIndex: stFx, width: src.width, height: src.height, sourceName: src.name,
        seqStart: seqStart, times: times, cur: cur, warnings: warnings,
        retimed: sel.timeRemapEnabled || !stNear(sel.stretch, 100, 0.01)
    };
    if (isComp) {
        var lens = stLensInside(src, keys);
        if (lens) { out.lensFile = lens.file; out.lensFrames = lens.frames; out.focalScale = lens.scale; }
    } else {
        out.lensFile = src.file.fsName; out.lensFrames = keys; out.focalScale = 1;
    }
    return stJSON(out);
}

// Rush le plus bas d'un précomp (en descendant les précomps imbriqués) : fichier, image du
// fichier à chaque instant demandé, agrandissement dans le précomp. null si aucun. Ne sert
// qu'à lire la focale dans les métadonnées : les pixels, eux, viennent d'After Effects.
function stLensInside(comp, times) {
    var chain = [], Ax = 1, L = null, c = comp;
    for (var depth = 0; depth < 12; depth++) {
        L = null;
        for (var i = c.numLayers; i >= 1 && !L; i--) {  // le plus bas des calques vidéo actifs
            var C = c.layer(i);
            if (C.enabled && C instanceof AVLayer && C.hasVideo && (stIsVideoFootage(C.source) || C.source instanceof CompItem)) L = C;
        }
        if (!L) return null;
        chain.push(L);
        Ax *= L.property("ADBE Transform Group").property("ADBE Scale").value[0] / 100;
        if (stIsVideoFootage(L.source)) break;
        c = L.source;
    }
    var src = L.source;
    if (!stIsVideoFootage(src)) return null;
    var fps = src.frameRate, n = Math.round(src.duration * fps), frames = [], last = 0;
    for (var k = 0; k < times.length; k++) {
        var t = times[k], ok = true;
        for (var m = 0; m < chain.length && ok; m++) {
            t = stLayerTime(chain[m], t);
            ok = t !== null && (m === chain.length - 1 || (t >= -1e-6 && t < chain[m].source.duration - 1e-6));
        }
        var f = ok ? Math.floor(t * fps + 1e-4) : -1;
        if (f < 0 || f >= n) f = last;
        frames.push(f);
        last = f;
    }
    return {file: src.file.fsName, frames: frames, scale: Ax * src.width / comp.width};
}

// Place l'instant courant de la compo sur une de ses images (aperçu synchronisé).
function stGoToFrame(compId, compFrame) {
    var comp = stFindComp(compId);
    if (!comp) return stFail(T("Comp not found.", "Composition introuvable."));
    comp.time = compFrame * comp.frameDuration;
    return stJSON({ok: true});
}

// Ajoute l'effet au calque, en bas de la pile.
function stAddTrackerEffect(compId, layerIndex) {
    var comp = stFindComp(compId);
    if (!comp || layerIndex < 1 || layerIndex > comp.numLayers) return stFail(T("Layer not found.", "Calque introuvable."));
    var par = comp.layer(layerIndex).property("ADBE Effect Parade");
    if (!par.canAddProperty(ST_MATCH)) {
        return stFail(T("The \u201c3D Surface Tracker\u201d effect is not installed (see the README), then restart After Effects.", "L'effet « 3D Surface Tracker » n'est pas installé (voir le README), puis redémarrez After Effects."));
    }
    app.beginUndoGroup("3D Surface Tracker: add effect");
    par.addProperty(ST_MATCH);
    app.endUndoGroup();
    return stJSON({ok: true});
}

// Écrit le tracking dans l'effet du calque : images clés de la pose (pixels de l'image du
// calque) ; d : données build_ae_data du moteur, plus mode2d et refFrame (n° d'image de la
// compo) et keyFrames (images des clés de correction) pour rouvrir le tracker. Les clés
// précédentes sont remplacées.
function stApplyTracking(compId, layerIndex, d) {
    var comp = stFindComp(compId);
    var fx = stTrackerFx(comp, layerIndex);
    if (!fx) return stFail(T("The layer has no \u201c3D Surface Tracker\u201d effect.", "L'effet « 3D Surface Tracker » est absent du calque."));
    var fd = comp.frameDuration, times = [], i;
    for (i = 0; i < d.frames.length; i++) times.push(d.frames[i] * fd);
    function clear(p) { while (p.numKeys > 0) p.removeKey(1); }
    function keys(name, vals) {
        var p = fx.property(name);
        clear(p);
        if (vals.length === 1 || times.length === 1) p.setValue(vals[0]);
        else p.setValuesAtTimes(times, vals);
    }
    function still(name, v) { var p = fx.property(name); clear(p); p.setValue(v); }
    function col(a, j) { var o = []; for (var q = 0; q < a.length; q++) o.push(a[q][j]); return o; }
    var r = d.round || [0, 0, 0, 0];
    app.beginUndoGroup("3D Surface Tracker: apply tracking");
    keys("Position X", col(d.srfPos, 0));
    keys("Position Y", col(d.srfPos, 1));
    keys("Position Z", col(d.srfPos, 2));
    keys("Orientation X", col(d.srfOri, 0));
    keys("Orientation Y", col(d.srfOri, 1));
    keys("Orientation Z", col(d.srfOri, 2));
    keys("Camera zoom", d.zoom);
    still("Width", d.size[0]);
    still("Height", d.size[1]);
    still("Camera distance", -d.camPos[0][2]);
    fx.property("Shape").setValue(d.shape === "disc" ? 2 : 1);
    still("Roundness TL", 100 * r[0]);
    still("Roundness TR", 100 * r[1]);
    still("Roundness BR", 100 * r[2]);
    still("Roundness BL", 100 * r[3]);
    fx.property("Mode").setValue(d.mode2d ? 2 : 1);
    still("Reference frame", d.refFrame);
    // clés de correction : à chaque clé, décalage des 4 coins par rapport au suivi brut (8 valeurs)
    var kt = [];
    for (i = 0; i < d.keyFrames.length; i++) kt.push(d.keyFrames[i] * fd);
    var CN = ["TL", "TR", "BR", "BL"];
    for (var c = 0; c < 8; c++) {
        var cp = fx.property("Correction " + CN[c >> 1] + (c % 2 ? " Y" : " X")), cv = [];
        clear(cp);
        for (i = 0; i < d.keyFrames.length; i++) cv.push(d.keyDeltas[i][c]);
        cp.setValuesAtTimes(kt, cv);
    }
    app.endUndoGroup();
    return stJSON({ok: true, frames: d.frames.length});
}

// Images (n° de la compo) des images clés d'une propriété.
function stKeyFrames(p, fd) {
    var out = [];
    for (var i = 1; i <= p.numKeys; i++) out.push(Math.round(p.keyTime(i) / fd));
    return out;
}

// Correction de chaque clé (8 valeurs : décalage des coins HG, HD, BD, BG), dans l'ordre des clés.
function stKeyDeltas(fx, keysProp) {
    var CN = ["TL", "TR", "BR", "BL"], out = [];
    for (var i = 1; i <= keysProp.numKeys; i++) {
        var t = keysProp.keyTime(i), row = [];
        for (var c = 0; c < 8; c++) row.push(fx.property("Correction " + CN[c >> 1] + (c % 2 ? " Y" : " X")).valueAtTime(t, false));
        out.push(row);
    }
    return out;
}

// Tracking déjà appliqué dans l'effet, pour rouvrir le tracker dessus : pose aux images
// clés (numéros d'image de la compo) et réglages fixes. null s'il n'y en a pas.
function stReadTracking(compId, layerIndex) {
    var comp = stFindComp(compId);
    var fx = stTrackerFx(comp, layerIndex);
    if (!fx) return stFail(T("The layer has no \u201c3D Surface Tracker\u201d effect.", "L'effet « 3D Surface Tracker » est absent du calque."));
    function v(name) { return fx.property(name).valueAtTime(0, false); }
    if (v("Width") <= 0) return stJSON({ok: true, data: null});
    var fd = comp.frameDuration, px = fx.property("Position X"), times = [], i;
    if (px.numKeys === 0) times.push(v("Reference frame") * fd);
    for (i = 1; i <= px.numKeys; i++) times.push(px.keyTime(i));
    var names = ["Position X", "Position Y", "Position Z", "Orientation X", "Orientation Y", "Orientation Z", "Camera zoom"];
    var props = [];
    for (i = 0; i < names.length; i++) props.push(fx.property(names[i]));
    var frames = [];
    for (i = 0; i < times.length; i++) {
        var row = [Math.round(times[i] / fd)];
        for (var j = 0; j < props.length; j++) row.push(props[j].valueAtTime(times[i], false));
        frames.push(row);  // [image, px, py, pz, ox, oy, oz, zoom]
    }
    return stJSON({ok: true, data: {
        frames: frames, size: [v("Width"), v("Height")], dist: v("Camera distance"),
        disc: fx.property("Shape").value === 2, mode2d: fx.property("Mode").value === 2,
        ref: Math.round(v("Reference frame")), keys: stKeyFrames(fx.property("Correction TL X"), fd),
        keyDeltas: stKeyDeltas(fx, fx.property("Correction TL X")),
        round: [v("Roundness TL"), v("Roundness TR"), v("Roundness BR"), v("Roundness BL")]
    }});
}
