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

// Temps dans la source d'un calque à l'instant t de sa compo (remappage et étirement
// compris), ou null s'il n'est pas visible à cet instant.
function stLayerTime(L, t) {
    if (t < L.inPoint - 1e-6 || t >= L.outPoint - 1e-6) return null;
    if (L.timeRemapEnabled) return L.property("ADBE Time Remapping").valueAtTime(t, false);
    return (t - L.startTime) * 100 / L.stretch;
}

// Image du fichier vidéo affichée à l'instant t de la compo du haut, en suivant la
// chaîne de calques (précomps, remappages, étirements) ; -1 si rien n'est visible.
function stSourceFrame(chain, t, fps, srcFrames) {
    for (var i = 0; i < chain.length; i++) {
        t = stLayerTime(chain[i], t);
        if (t === null) return -1;
        if (i < chain.length - 1 && (t < -1e-6 || t >= chain[i].source.duration - 1e-6)) return -1;
    }
    var f = Math.floor(t * fps + 1e-4);  // AE affiche l'image commencée au plus tard à cet instant
    return (f < 0 || f >= srcFrames) ? -1 : f;
}

function stDescribe(comp, sel, time) {
    var L = sel;
    var warnings = [], names = [], chain = [];
    var Ax = 1, Ay = 1, Bx = 0, By = 0;     // pixel compo = A * pixel du calque courant + B
    var retimed = false;

    for (var depth = 0; depth < 12; depth++) {
        if (!(L instanceof AVLayer) || !L.source) return stFail("Le calque « " + L.name + " » n'est ni une vidéo ni un précomp.");
        chain.push(L);
        names.push(L.name);
        if (L.timeRemapEnabled || !stNear(L.stretch, 100, 0.01)) retimed = true;
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

    var k = comp.width / src.width;
    if (!stNear(Ax, k, 0.002 * k) || !stNear(Ay, k, 0.002 * k) || !stNear(Bx, 0, 1) || !stNear(By, 0, 1)) {
        warnings.push("La vidéo est déplacée, recadrée ou mise à l'échelle entre le fichier et la compo : " +
                      "la surface 3D sera décalée. Le calque doit remplir la compo tel quel.");
    } else if (!stNear(k, 1, 0.0001)) {
        warnings.push("La vidéo (" + src.width + "x" + src.height + ") est mise à l'échelle de la compo (" +
                      comp.width + "x" + comp.height + ") : le résultat aussi.");
    }

    // Image du fichier montrée à chaque image de la compo où le calque est visible :
    // le suivi porte exactement sur ce qu'affiche la compo, remappages compris.
    var fps = src.frameRate, fd = comp.frameDuration;
    var srcFrames = Math.round(src.duration * fps);
    var j0 = Math.max(0, Math.ceil(sel.inPoint / fd - 1e-4));
    var j1 = Math.min(Math.round(comp.duration / fd), Math.ceil(sel.outPoint / fd - 1e-4)) - 1;
    var frames = [];
    for (var j = j0; j <= j1; j++) frames.push(stSourceFrame(chain, j * fd, fps, srcFrames));
    var a = 0, b = frames.length - 1;
    while (a <= b && frames[a] < 0) a++;
    while (b >= a && frames[b] < 0) b--;
    if (a > b) return stFail("Le calque n'est visible sur aucune image de la composition.");
    frames = frames.slice(a, b + 1);
    var seqStart = j0 + a;
    for (var q = 1; q < frames.length; q++) if (frames[q] < 0) frames[q] = frames[q - 1];  // trou : image voisine

    var cur = Math.floor(time / fd + 1e-4) - seqStart;
    if (cur < 0 || cur >= frames.length) {
        warnings.push("L'instant courant est hors de la partie visible du calque : la référence part de " +
                      (cur < 0 ? "sa première" : "sa dernière") + " image. Choisissez-la dans la timeline du panneau.");
        cur = Math.min(frames.length - 1, Math.max(0, cur));
    }
    return stJSON({
        ok: true, compId: comp.id, compName: comp.name, compW: comp.width, compH: comp.height,
        compFps: 1 / fd, layerIndex: sel.index, layerName: sel.name,
        footageName: L.name, chain: names, file: src.file.fsName, fps: fps, srcFrames: srcFrames,
        seqStart: seqStart, frames: frames, cur: cur, retimed: retimed, warnings: warnings
    });
}

function stFindComp(compId) {
    var c = app.project.itemByID(compId);
    return (c instanceof CompItem) ? c : null;
}

// Place l'instant courant de la compo sur une de ses images (aperçu synchronisé).
function stGoToFrame(compId, compFrame) {
    var comp = stFindComp(compId);
    if (!comp) return stFail("Composition introuvable.");
    comp.time = compFrame * comp.frameDuration;
    return stJSON({ok: true});
}

// Exécute le script généré par le moteur dans la compo. Les images clés sont datées
// en images de cette compo ; layers : calques à créer {nul, solid, text}.
function stApply(compId, layerIndex, jsxPath, layers) {
    var comp = stFindComp(compId);
    if (!comp) return stFail("Composition introuvable (supprimée ou renommée ?).");
    comp.openInViewer();
    for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
    if (layerIndex >= 1 && layerIndex <= comp.numLayers) comp.layer(layerIndex).selected = true;
    $.global.ST_PANEL = true;
    $.global.ST_RESULT = "";
    $.global.ST_TIME_OFFSET = 0;
    $.global.ST_LAYERS = layers;
    try {
        $.evalFile(File(jsxPath));
    } catch (e) {
        $.global.ST_PANEL = false;
        $.global.ST_TIME_OFFSET = null;
        $.global.ST_LAYERS = null;
        return stFail("Erreur dans le script : " + e.toString() + " (ligne " + e.line + ")");
    }
    $.global.ST_PANEL = false;
    $.global.ST_TIME_OFFSET = null;
    $.global.ST_LAYERS = null;
    var r = String($.global.ST_RESULT);
    if (r.indexOf("ERREUR ") === 0) return stFail(r.substring(7));
    return stJSON({ok: true, msg: r});
}
