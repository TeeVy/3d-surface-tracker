// 3D Surface Tracker — fonctions ExtendScript appelées par le panneau.
// Chaque fonction renvoie une chaîne JSON.
//
// Le calque tracké porte l'effet « 3D Surface Tracker » : le panneau suit l'image telle
// qu'elle arrive à cet effet (calculée par After Effects, via le pont STBridge), écrit le
// résultat dans les paramètres de l'effet, et enregistre son travail (forme, suivi, clés)
// dans les métadonnées XMP du projet pour le retrouver à la réouverture.

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
    if (!comp) return stFail("La composition du calque à tracker est introuvable.");
    if (layerIndex < 1 || layerIndex > comp.numLayers) return stFail("Le calque à tracker est introuvable.");
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
    if (!(sel instanceof AVLayer) || !sel.source) return stFail("Le calque « " + sel.name + " » n'est ni une vidéo ni un précomp.");
    var src = sel.source, isComp = src instanceof CompItem;
    if (!isComp && !stIsVideoFootage(src)) return stFail("Le calque « " + sel.name + " » n'est ni une vidéo ni un précomp.");
    var stFx = stTrackerEffect(sel);
    if (!stFx) {
        var par0 = sel.property("ADBE Effect Parade");
        return stJSON({ok: true, needEffect: true, compId: comp.id, compName: comp.name, layerIndex: sel.index,
                       layerName: sel.name, hasEffects: par0.numProperties > 0});
    }
    var warnings = [];
    var below = [], par = sel.property("ADBE Effect Parade");
    for (var e = stFx + 1; e <= par.numProperties; e++) if (par.property(e).active) below.push(par.property(e).name);
    if (below.length) warnings.push("Effets placés sous « 3D Surface Tracker » (" + below.join(", ") + ") : le tracking ne les voit pas. Mettez le tracker en bas de la pile.");
    var tr = sel.property("ADBE Transform Group");
    var pos = tr.property("ADBE Position").value, anc = tr.property("ADBE Anchor Point").value;
    var sc = tr.property("ADBE Scale").value, rot = tr.property("ADBE Rotate Z").value;
    if (sel.threeDLayer || !stNear(rot, 0, 0.01) || sel.parent) {
        warnings.push("« " + sel.name + " » est en 3D, tourné ou parenté : la surface ne sera pas calée correctement.");
    }
    var k = comp.width / src.width;
    var Ax = sc[0] / 100, Ay = sc[1] / 100, Bx = pos[0] - Ax * anc[0], By = pos[1] - Ay * anc[1];
    if (!stNear(Ax, k, 0.002 * k) || !stNear(Ay, k, 0.002 * k) || !stNear(Bx, 0, 1) || !stNear(By, 0, 1)) {
        warnings.push("Le calque est déplacé ou mis à l'échelle dans la compo : la surface 3D sera décalée. " +
                      "Il doit remplir la compo tel quel (précomposez-le si besoin).");
    }

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
    if (a > b) return stFail("Le calque n'est visible sur aucune image de la composition.");
    keys = keys.slice(a, b + 1);
    var seqStart = j0 + a;
    for (var q = 1; q < keys.length; q++) if (keys[q] === null) keys[q] = keys[q - 1];  // trou : image voisine

    var cur = Math.floor(time / fd + 1e-4) - seqStart;
    if (cur < 0 || cur >= keys.length) {
        warnings.push("L'instant courant est hors de la partie visible du calque : la référence part de " +
                      (cur < 0 ? "sa première" : "sa dernière") + " image. Choisissez-la dans la timeline du panneau.");
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
    if (!comp) return stFail("Composition introuvable.");
    comp.time = compFrame * comp.frameDuration;
    return stJSON({ok: true});
}

// Ajoute l'effet au calque, en bas de la pile.
function stAddTrackerEffect(compId, layerIndex) {
    var comp = stFindComp(compId);
    if (!comp || layerIndex < 1 || layerIndex > comp.numLayers) return stFail("Calque introuvable.");
    var par = comp.layer(layerIndex).property("ADBE Effect Parade");
    if (!par.canAddProperty(ST_MATCH)) {
        return stFail("L'effet « 3D Surface Tracker » n'est pas installé (native/build.sh --install, puis redémarrer AE).");
    }
    app.beginUndoGroup("3D Surface Tracker : ajouter l'effet");
    par.addProperty(ST_MATCH);
    app.endUndoGroup();
    return stJSON({ok: true});
}

// Écrit le tracking dans l'effet du calque : images clés de la pose (pixels de l'image du
// calque) ; d : données build_ae_data du moteur. Les clés précédentes sont remplacées.
function stApplyTracking(compId, layerIndex, d) {
    var comp = stFindComp(compId);
    var fx = stTrackerFx(comp, layerIndex);
    if (!fx) return stFail("L'effet « 3D Surface Tracker » est absent du calque.");
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
    app.beginUndoGroup("3D Surface Tracker : appliquer le tracking");
    keys("Position X", col(d.srfPos, 0));
    keys("Position Y", col(d.srfPos, 1));
    keys("Position Z", col(d.srfPos, 2));
    keys("Orientation X", col(d.srfOri, 0));
    keys("Orientation Y", col(d.srfOri, 1));
    keys("Orientation Z", col(d.srfOri, 2));
    keys("Zoom caméra", d.zoom);
    still("Largeur", d.size[0]);
    still("Hauteur", d.size[1]);
    still("Distance caméra", -d.camPos[0][2]);
    fx.property("Forme").setValue(d.shape === "disc" ? 2 : 1);
    still("Arrondi HG", 100 * r[0]);
    still("Arrondi HD", 100 * r[1]);
    still("Arrondi BD", 100 * r[2]);
    still("Arrondi BG", 100 * r[3]);
    app.endUndoGroup();
    return stJSON({ok: true, frames: d.frames.length});
}

// ------------------------------------------------------------------ travail du panneau
// Forme, suivi et clés sont enregistrés dans les métadonnées XMP du projet (une entrée
// par calque) : ils sont sauvegardés avec le projet et retrouvés à la réouverture.
var ST_NS = "http://ns.surftrack.local/1.0/";

function stXMP() {
    if (typeof XMPMeta === "undefined") {
        if (!ExternalObject.AdobeXMPScript) ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
    }
    XMPMeta.registerNamespace(ST_NS, "surftrack");
    return new XMPMeta(app.project.xmpPacket);
}

function stSessionKey(comp, L) {
    return "L" + comp.id + "_" + (typeof L.id === "number" ? L.id : "i" + L.index);
}

function stSaveSession(compId, layerIndex, json) {
    var comp = stFindComp(compId);
    if (!comp || layerIndex < 1 || layerIndex > comp.numLayers) return stFail("Calque introuvable.");
    try {
        var x = stXMP();
        x.setProperty(ST_NS, stSessionKey(comp, comp.layer(layerIndex)), json);
        app.project.xmpPacket = x.serialize();
    } catch (e) {
        return stFail("Enregistrement du tracking dans le projet impossible : " + e.toString());
    }
    return stJSON({ok: true});
}

function stLoadSession(compId, layerIndex) {
    var comp = stFindComp(compId);
    if (!comp || layerIndex < 1 || layerIndex > comp.numLayers) return stFail("Calque introuvable.");
    try {
        var p = stXMP().getProperty(ST_NS, stSessionKey(comp, comp.layer(layerIndex)));
        return stJSON({ok: true, data: p ? String(p.value) : null});
    } catch (e) {
        return stJSON({ok: true, data: null});
    }
}
