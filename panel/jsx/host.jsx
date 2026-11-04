// 3D Surface Tracker — fonctions ExtendScript appelées par le panneau.
// Chaque fonction renvoie une chaîne JSON.

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

function stIsVideoFootage(src) {
    return (src instanceof FootageItem) && src.file && !(src.mainSource instanceof SolidSource) &&
           !src.mainSource.isStill && src.hasVideo;
}

// Calque vidéo à utiliser dans un précomp : le plus bas des calques vidéo (ou précomps) actifs.
function stPickInner(comp, warnings) {
    var found = null, others = [];
    for (var i = comp.numLayers; i >= 1; i--) {
        var L = comp.layer(i);
        if (!L.enabled || !(L instanceof AVLayer) || !L.hasVideo) continue;
        var src = L.source;
        if (stIsVideoFootage(src) || (src instanceof CompItem)) {
            if (!found) found = L; else others.push(L.name);
        }
    }
    if (found && others.length) {
        warnings.push("Le précomp « " + comp.name + " » contient plusieurs vidéos : j'utilise « " + found.name +
                      " » (le calque vidéo le plus bas).");
    }
    return found;
}

// Calque vidéo sélectionné dans la composition active + image courante.
// Si c'est un précomp, on descend jusqu'au fichier vidéo en cumulant décalages
// temporels et transformations, pour vérifier que l'image du fichier se
// retrouve telle quelle (à l'échelle près) dans la compo.
function stGetSelection() {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) return stFail("Ouvrez la composition et sélectionnez le calque vidéo à tracker.");
    if (comp.selectedLayers.length === 0) return stFail("Sélectionnez le calque vidéo à tracker dans la composition.");
    return stDescribe(comp, comp.selectedLayers[0], comp.time);
}

// Calque désigné par le script « Tracker le calque » (compo, indice, instant au lancement).
function stGetLayer(compId, layerIndex, time) {
    var comp = stFindComp(compId);
    if (!comp) return stFail("La composition du calque à tracker est introuvable.");
    if (layerIndex < 1 || layerIndex > comp.numLayers) return stFail("Le calque à tracker est introuvable.");
    return stDescribe(comp, comp.layer(layerIndex), time);
}

function stDescribe(comp, sel, time) {
    var L = sel;
    var warnings = [], chain = [];
    var offset = 0;                         // temps compo = offset + temps dans le fichier
    var Ax = 1, Ay = 1, Bx = 0, By = 0;     // pixel compo = A * pixel du calque courant + B
    var timeOk = true;
    var lo = 0, hi = comp.duration;         // plage visible, dans le temps de la compo courante

    for (var depth = 0; depth < 12; depth++) {
        if (!(L instanceof AVLayer) || !L.source) return stFail("Le calque « " + L.name + " » n'est ni une vidéo ni un précomp.");
        chain.push(L.name);
        offset += L.startTime;
        lo = Math.max(lo, L.inPoint) - L.startTime;   // -> temps de la source du calque
        hi = Math.min(hi, L.outPoint) - L.startTime;
        if (L.source instanceof CompItem) { lo = Math.max(lo, 0); hi = Math.min(hi, L.source.duration); }
        if (L.timeRemapEnabled || !stNear(L.stretch, 100, 0.01)) timeOk = false;
        var tr = L.property("ADBE Transform Group");
        var pos = tr.property("ADBE Position").value, anc = tr.property("ADBE Anchor Point").value;
        var sc = tr.property("ADBE Scale").value, rot = tr.property("ADBE Rotate Z").value;
        if (L.threeDLayer || !stNear(rot, 0, 0.01) || L.parent) {
            warnings.push("« " + L.name + " » est en 3D, tourné ou parenté : la surface ne sera pas calée correctement.");
        }
        Bx = Ax * (pos[0] - sc[0] / 100 * anc[0]) + Bx;
        By = Ay * (pos[1] - sc[1] / 100 * anc[1]) + By;
        Ax *= sc[0] / 100;
        Ay *= sc[1] / 100;
        if (stIsVideoFootage(L.source)) break;
        if (!(L.source instanceof CompItem)) return stFail("Le calque « " + L.name + " » n'est pas une vidéo.");
        var inner = stPickInner(L.source, warnings);
        if (!inner) return stFail("Le précomp « " + L.source.name + " » ne contient aucun calque vidéo actif.");
        L = inner;
    }
    var src = L.source;
    if (!stIsVideoFootage(src)) return stFail("Aucune vidéo trouvée sous le calque sélectionné (trop de niveaux de précomp ?).");

    if (!timeOk) {
        warnings.push("Remappage temporel ou étirement du temps dans la chaîne de précomps : les images clés seront décalées dans le temps.");
    }
    var k = comp.width / src.width;
    if (!stNear(Ax, k, 0.002 * k) || !stNear(Ay, k, 0.002 * k) || !stNear(Bx, 0, 1) || !stNear(By, 0, 1)) {
        warnings.push("La vidéo est déplacée, recadrée ou mise à l'échelle entre le fichier et la compo : " +
                      "la surface 3D sera décalée. Le calque doit remplir la compo tel quel.");
    } else if (!stNear(k, 1, 0.0001)) {
        warnings.push("La vidéo (" + src.width + "x" + src.height + ") est mise à l'échelle de la compo (" +
                      comp.width + "x" + comp.height + ") : le résultat aussi.");
    }
    var fps = src.frameRate;
    var srcFrames = Math.round(src.duration * fps);
    var first = Math.max(0, Math.ceil(lo * fps - 1e-6));
    var last = Math.min(srcFrames - 1, Math.ceil(hi * fps - 1e-6) - 1);
    if (last < first) return stFail("Le calque n'est visible sur aucune image de la composition.");
    var frame = Math.round((time - offset) * fps);
    if (frame < first || frame > last) {
        warnings.push("L'instant courant est hors de la partie visible du calque : l'image de référence est ramenée à " +
                      (frame < first ? "sa première" : "sa dernière") + " image.");
        frame = Math.min(last, Math.max(first, frame));
    }
    return stJSON({
        ok: true, compId: comp.id, compName: comp.name, compW: comp.width, compH: comp.height,
        layerIndex: sel.index, layerName: sel.name,
        footageName: L.name, chain: chain, file: src.file.fsName, fps: fps, timeOffset: offset,
        frame: frame, rangeStart: first, rangeEnd: last, srcFrames: srcFrames,
        duration: src.duration, warnings: warnings
    });
}

function stFindComp(compId) {
    var c = app.project.itemByID(compId);
    return (c instanceof CompItem) ? c : null;
}

// Place l'instant courant de la compo sur une image de la vidéo (aperçu synchronisé).
function stGoToFrame(compId, timeOffset, fps, frame) {
    var comp = stFindComp(compId);
    if (!comp) return stFail("Composition introuvable.");
    comp.time = timeOffset + frame / fps;
    return stJSON({ok: true});
}

// Exécute le script généré par le moteur dans la compo. timeOffset : temps compo
// de la 1re image du fichier vidéo (précomps compris).
function stApply(compId, layerIndex, jsxPath, timeOffset) {
    var comp = stFindComp(compId);
    if (!comp) return stFail("Composition introuvable (supprimée ou renommée ?).");
    comp.openInViewer();
    for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
    if (layerIndex >= 1 && layerIndex <= comp.numLayers) comp.layer(layerIndex).selected = true;
    $.global.ST_PANEL = true;
    $.global.ST_RESULT = "";
    $.global.ST_TIME_OFFSET = timeOffset;
    try {
        $.evalFile(File(jsxPath));
    } catch (e) {
        $.global.ST_PANEL = false;
        $.global.ST_TIME_OFFSET = null;
        return stFail("Erreur dans le script : " + e.toString() + " (ligne " + e.line + ")");
    }
    $.global.ST_PANEL = false;
    $.global.ST_TIME_OFFSET = null;
    var r = String($.global.ST_RESULT);
    if (r.indexOf("ERREUR ") === 0) return stFail(r.substring(7));
    return stJSON({ok: true, msg: r});
}
