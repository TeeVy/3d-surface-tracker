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

// Noms des effets actifs d'un calque (ils peuvent déplacer les pixels : stabilisation…).
function stActiveEffects(L) {
    var out = [], fx = L.property("ADBE Effect Parade");
    if (!fx) return out;
    for (var i = 1; i <= fx.numProperties; i++) if (fx.property(i).active) out.push(fx.property(i).name);
    return out;
}

// Calque à tracker : SEUL le calque sélectionné compte. Un précomp est une boîte noire
// dont After Effects calcule l'image (pont STBridge) ; un métrage est lu directement.
// Les effets du calque lui-même ne seraient pas pris en compte : on demande de précomposer.
function stDescribe(comp, sel, time) {
    if (!(sel instanceof AVLayer) || !sel.source) return stFail("Le calque « " + sel.name + " » n'est ni une vidéo ni un précomp.");
    var src = sel.source, isComp = src instanceof CompItem;
    if (!isComp && !stIsVideoFootage(src)) return stFail("Le calque « " + sel.name + " » n'est ni une vidéo ni un précomp.");
    var fx = stActiveEffects(sel);
    if (fx.length) {
        return stFail("Le calque « " + sel.name + " » a des effets (" + fx.join(", ") + ") : le tracking ne les voit pas.\n\n" +
                      "Précomposez-le (Calque > Pré-composer, « Déplacer tous les attributs dans la nouvelle composition »), " +
                      "puis trackez le précomp.");
    }
    var warnings = [];
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
    var retimed = sel.timeRemapEnabled || !stNear(sel.stretch, 100, 0.01);

    // Image de la source montrée à chaque image de la compo où le calque est visible
    // (remappage et étirement du calque compris).
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
    var out = {
        ok: true, compId: comp.id, compName: comp.name, compW: comp.width, compH: comp.height,
        compFps: 1 / fd, layerIndex: sel.index, layerName: sel.name, seqStart: seqStart, cur: cur,
        retimed: retimed, warnings: warnings, chain: [sel.name]
    };
    if (!isComp) {  // métrage : lu directement dans le fichier
        out.mode = "file";
        out.file = src.file.fsName; out.footageName = src.name; out.fps = fps;
        out.frames = keys;
        return stJSON(out);
    }

    // Précomp : instants distincts (une image figée n'est calculée qu'une fois)
    var times = [], index = {}, frames = [];
    for (var u = 0; u < keys.length; u++) {
        var key = String(Math.round(keys[u] * 1e5));
        if (!index.hasOwnProperty(key)) { index[key] = times.length; times.push(keys[u]); }
        frames.push(index[key]);
    }
    out.mode = "bridge";
    out.item = src.id; out.itemW = src.width; out.itemH = src.height;
    out.footageName = src.name; out.frames = frames; out.times = times;

    // Focale : seulement lue dans le rush du précomp s'il y en a un (les pixels, eux, viennent d'AE)
    var lens = stLensInside(src, times);
    if (lens) { out.lensFile = lens.file; out.lensFrames = lens.frames; out.focalScale = lens.scale; out.file = lens.file; }
    return stJSON(out);
}

// Rush le plus bas d'un précomp (en descendant les précomps imbriqués) : fichier, image du
// fichier à chaque instant demandé, agrandissement dans le précomp. null si aucun.
function stLensInside(comp, times) {
    var chain = [], Ax = 1, L = null, c = comp, ignored = [];
    for (var depth = 0; depth < 12; depth++) {
        L = stPickInner(c, ignored);
        if (!L) return null;
        chain.push(L);
        Ax *= L.property("ADBE Transform Group").property("ADBE Scale").value[0] / 100;
        if (stIsVideoFootage(L.source)) break;
        if (!(L.source instanceof CompItem)) return null;
        c = L.source;
    }
    var src = L.source;
    if (!stIsVideoFootage(src)) return null;
    var fps = src.frameRate, n = Math.round(src.duration * fps), frames = [], last = 0;
    for (var i = 0; i < times.length; i++) {
        var f = stSourceFrame(chain, times[i], fps, n);
        if (f < 0) f = last;
        frames.push(f);
        last = f;
    }
    return {file: src.file.fsName, frames: frames, scale: Ax * src.width / comp.width};
}

// Rend le calque tel que la compo le montre (effets compris), images seqStart à seqStart+n-1
// de la compo, dans outDir. Le calque est mis en solo le temps du rendu ; les autres éléments
// de la file d'attente sont mis de côté puis rétablis.
function stRenderLayer(compId, layerIndex, seqStart, n, outDir) {
    var comp = stFindComp(compId);
    if (!comp) return stFail("Composition introuvable.");
    if (layerIndex < 1 || layerIndex > comp.numLayers) return stFail("Calque introuvable.");
    var sel = comp.layer(layerIndex);
    var rq = app.project.renderQueue, solos = [], queued = [], item = null, i;
    var folder = new Folder(outDir);
    if (!folder.exists) folder.create();
    try {
        for (i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (L instanceof AVLayer) { solos.push([L, L.solo]); L.solo = (i === layerIndex); }
        }
        for (i = 1; i <= rq.numItems; i++) {
            if (rq.item(i).status === RQItemStatus.QUEUED) { queued.push(rq.item(i)); rq.item(i).render = false; }
        }
        item = rq.items.add(comp);
        item.timeSpanStart = seqStart * comp.frameDuration;
        item.timeSpanDuration = n * comp.frameDuration;
        var om = item.outputModule(1);
        var fmt = "", names = ["JPEG Sequence", "Séquence JPEG", "PNG Sequence", "Séquence PNG", "TIFF Sequence", "Séquence TIFF"];
        for (i = 0; i < names.length && !fmt; i++) {
            try {
                om.setSettings({"Format": names[i]});
                var got = om.getSettings(GetSettingsFormat.STRING)["Format"];
                if (got && /JPEG|PNG|TIFF/i.test(got)) fmt = got;
            } catch (e) { /* format inconnu dans cette version */ }
        }
        if (!fmt) {  // repli : un modèle de sortie en séquence d'images s'il y en a un
            for (i = 0; i < om.templates.length && !fmt; i++) {
                if (/PNG|TIFF|JPEG/i.test(om.templates[i])) { om.applyTemplate(om.templates[i]); fmt = om.templates[i]; }
            }
        }
        var ext = /PNG/i.test(fmt) ? "png" : /TIFF/i.test(fmt) ? "tif" : /JPEG/i.test(fmt) ? "jpg" : "mov";
        om.file = new File(folder.fsName + "/st_[#####]." + ext);
        rq.render();
    } catch (e) {
        return stFail("Rendu impossible : " + e.toString());
    } finally {
        try { if (item) item.remove(); } catch (e2) {}
        for (i = 0; i < queued.length; i++) { try { queued[i].render = true; } catch (e3) {} }
        for (i = 0; i < solos.length; i++) { try { solos[i][0].solo = solos[i][1]; } catch (e4) {} }
    }
    return stJSON({ok: true, dir: folder.fsName, format: fmt});
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
