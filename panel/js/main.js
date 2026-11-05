/* 3D Surface Tracker — panneau After Effects (CEP).
 *
 * Le panneau pilote une session du moteur Python (engine.py session, lignes JSON) via
 * Node.js et parle à After Effects via ExtendScript (jsx/host.jsx).
 *
 * La séquence suivie est celle de la compo : l'image k montre l'image src[k] du fichier
 * (précomps, remappages et étirements résolus par AE). Le panneau garde l'état complet
 * (forme, homographies image par image) : chaque action peut être annulée (⌘Z), et le
 * moteur ne sert qu'à décoder, suivre et calculer la 3D.
 *
 * Hors d'After Effects (navigateur), il passe en mode démo avec un moteur simulé.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const inCEP = !!window.__adobe_cep__;
  const nodeRequire = typeof require === 'function' ? require : (window.cep_node && window.cep_node.require);
  const fs = inCEP && nodeRequire && nodeRequire('fs');
  const path = inCEP && nodeRequire && nodeRequire('path');
  const cp = inCEP && nodeRequire && nodeRequire('child_process');
  const os = inCEP && nodeRequire && nodeRequire('os');
  const nodeProcess = inCEP && nodeRequire && nodeRequire('process');

  // ------------------------------------------------------------------ chemins
  function extensionDir() {
    let p = decodeURI(window.__adobe_cep__.getSystemPath('extension'));
    if (p.indexOf('file://') === 0) p = p.substring(7);
    return p;
  }
  const ROOT = inCEP ? path.dirname(fs.realpathSync(extensionDir())) : null; // dossier du projet
  const PY = ROOT && path.join(ROOT, '.venv', 'bin', 'python');
  const ENGINE = ROOT && path.join(ROOT, 'engine.py');
  const APPDIR = inCEP ? path.join(os.homedir(), 'Library', 'Application Support', '3D Surface Tracker') : null;
  const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  // ------------------------------------------------------------------ état
  const state = {
    shot: null,          // calque chargé (réponse de stGetLayer / stGetSelection)
    eng: null,           // session du moteur
    lensMm: null,        // focale des métadonnées (éq. 35 mm), si présente
    workDir: null,
    W: 0, H: 0, n: 0,    // dimensions de la vidéo, nombre d'images de la séquence
    thumbsDir: null,
    loaded: new Set(),   // images source dont la vignette est prête
    thumbs: new Map(),   // image source -> vignette décodée en mémoire (lecture fluide)
    k: 0,                // image affichée (indice de séquence)
    ref: 0,              // image de référence (celle où la forme est définie)
    // --- état annulable
    tool: 'rect',        // 'rect' | 'free'
    points: [],          // forme, en pixels de la vidéo, sur l'image de référence
    round: [0, 0, 0, 0], // arrondi des coins HG, HD, BD, BG, 0..100 (tous à 100 = disque)
    selCorner: -1,       // coin choisi pour l'arrondi (position HG=0…BG=3), -1 : tous
    flip: false,         // disque : autre inclinaison
    orientManual: false, // forme libre : orientation réglée au gizmo
    freeNormal: null,    // forme libre : normale choisie (repère caméra)
    Hs: {},              // k -> homographie référence -> image k trouvée par le suivi (9 nombres)
    keys: {},            // k -> homographie fixée à la main sur cette image (clé de correction)
    conf: {},            // k -> confiance du suivi
    // ---
    rev: 0,              // incrémenté à chaque modification (invalide la 3D)
    pose: null,          // dernière 3D calculée {rev, poses, size, kind, outline, jsx, ...}
    solving: false,
    full: new Map(),     // k -> image pleine résolution (quelques-unes en cache)
    cur: null,           // image affichée
    view: null,          // {s, ox, oy, fit} en pixels canvas
    drag: null,
    hover: -1,
    hoverRing: null,
    space: false,
    tracking: null,      // {dir, count, btn}
    playTimer: null,
    scrubbing: false,
    undo: [], redo: [],
    pendingStamp: 0,
  };

  // ------------------------------------------------------------------ utilitaires
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms || 7000);
  }
  $('toast').addEventListener('click', () => $('toast').classList.add('hidden'));

  function log(msg) {
    const el = $('log');
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  }

  function fileUrl(p) { return 'file://' + encodeURI(p).replace(/#/g, '%23'); }
  const pad5 = (i) => String(i).padStart(5, '0');

  function stamp() {
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function enable(id, on) { $(id).classList.toggle('disabled', !on); }

  function loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Impossible d'afficher l'image : " + src));
      img.src = src;
    });
  }

  // ------------------------------------------------------------------ After Effects
  function host(fn, ...args) {
    const call = `${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`;
    return new Promise((resolve) => {
      window.__adobe_cep__.evalScript(call, (r) => {
        try { resolve(JSON.parse(r)); } catch (e) { resolve({ ok: false, msg: "Réponse inattendue d'After Effects : " + r }); }
      });
    });
  }

  // ------------------------------------------------------------------ moteur Python
  function pythonEnv() {
    const env = Object.assign({}, nodeProcess.env, { PYTHONUNBUFFERED: '1' });
    // AE ne transmet pas le PATH du Terminal : on ajoute Homebrew pour ffmpeg (métadonnées caméra)
    env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', env.PATH || '/usr/bin:/bin'].join(':');
    return env;
  }

  /** Session du moteur : une ligne JSON par commande, réponses {type:'reply', id}. */
  function startEngine(args, onEvent) {
    if (!fs.existsSync(PY)) {
      throw new Error("Environnement Python introuvable :\n" + PY +
        "\n\nDans le Terminal, depuis le dossier du projet :\n/usr/bin/python3 -m venv .venv && .venv/bin/pip install -r requirements.txt");
    }
    const child = cp.spawn(PY, [ENGINE, 'session'].concat(args), { cwd: ROOT, env: pythonEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const eng = { child, nextId: 1, waiters: new Map(), dead: false, onEvent };
    let buf = '', stderr = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { log(line); continue; }
        if (ev.type === 'reply' && eng.waiters.has(ev.id)) {
          const w = eng.waiters.get(ev.id);
          eng.waiters.delete(ev.id);
          if (ev.error) { log(ev.trace || ev.error); w.reject(new Error(ev.error)); } else w.resolve(ev);
        } else if (ev.type === 'error') {
          log(ev.trace || ev.msg);
          toast(ev.msg);
        } else if (eng.onEvent) eng.onEvent(ev);
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => toast('Impossible de lancer Python : ' + e.message));
    child.on('close', (code) => {
      eng.dead = true;
      eng.waiters.forEach((w) => w.reject(new Error(`Le moteur s'est arrêté (code ${code}).\n` + stderr.slice(-600))));
      eng.waiters.clear();
      if (state.eng === eng && !eng.closing) {
        toast(`Le moteur s'est arrêté (code ${code}).\n` + stderr.slice(-600));
        state.eng = null;
        refresh();
      }
    });
    eng.send = (cmd, onEv) => new Promise((resolve, reject) => {
      if (eng.dead) { reject(new Error('Le moteur est arrêté : rechargez le calque.')); return; }
      const id = eng.nextId++;
      eng.waiters.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify(Object.assign({ id }, cmd)) + '\n');
    });
    eng.stop = () => { if (!eng.dead) child.stdin.write('{"cmd":"stop"}\n'); };
    eng.close = () => { eng.closing = true; try { child.stdin.end(); } catch (e) { /* déjà fermé */ } setTimeout(() => child.kill(), 1500); };
    return eng;
  }

  /** Moteur simulé (mode démo dans un navigateur) : suivi = léger glissement, pas de 3D. */
  function demoEngine(onEvent) {
    const eng = { dead: false, onEvent, stopFlag: false };
    eng.send = (cmd) => new Promise((resolve) => {
      if (cmd.cmd === 'track') {
        let i = cmd.k + cmd.dir, done = 0;
        eng.stopFlag = false;
        const tick = () => {
          if (i < 0 || i >= state.n || (cmd.count && done >= cmd.count) || eng.stopFlag) {
            resolve({ reason: eng.stopFlag ? 'stop' : 'end', last: i - cmd.dir, done });
            return;
          }
          const dx = 3 * (i - cmd.ref), a = 0.004 * (i - cmd.ref);
          onEvent({ type: 'tracked', k: i, H: [Math.cos(a), -Math.sin(a), dx, Math.sin(a), Math.cos(a), dx / 3, 0, 0, 1], conf: 0.9 });
          i += cmd.dir; done++;
          setTimeout(tick, 40);
        };
        tick();
      } else resolve({ poses: {}, size: [1, 1], kind: 'rect', focal_source: 'démo', error_mean: null, log: [] });
    });
    eng.stop = () => { eng.stopFlag = true; };
    eng.close = () => {};
    return eng;
  }

  function onEngineEvent(ev) {
    if (ev.type === 'log') log(ev.msg);
    else if (ev.type === 'loaded') {
      ev.got.forEach((s) => { state.loaded.add(s); cacheThumb(s); });
      drawTimeline();
    } else if (ev.type === 'load_error') {
      toast('Lecture des images interrompue : ' + ev.msg);
    } else if (ev.type === 'tracked' && state.tracking) {
      state.Hs[ev.k] = ev.H;
      state.conf[ev.k] = ev.conf;
      state.rev++;
      state.k = ev.k;
      showFrame(ev.k, { fast: true });
    }
  }

  // ------------------------------------------------------------------ calque à tracker
  /** Demandes du script « Tracker le calque » + signal de vie (le script ne rouvre pas un panneau ouvert). */
  function heartbeat() {
    try {
      fs.mkdirSync(APPDIR, { recursive: true });
      fs.writeFileSync(path.join(APPDIR, 'alive.txt'), String(Date.now()));
      const pending = path.join(APPDIR, 'pending.json');
      if (!fs.existsSync(pending) || state.tracking) return;
      const req = JSON.parse(fs.readFileSync(pending, 'utf8'));
      fs.unlinkSync(pending);
      if (req.stamp > state.pendingStamp && Date.now() - req.stamp < 60000) {
        state.pendingStamp = req.stamp;
        host('stGetLayer', req.compId, req.layerIndex, req.time).then(loadShot);
      }
    } catch (e) { /* demande illisible : ignorée */ }
  }

  function resetEdit() {
    stopPlay();
    Object.assign(state, {
      tool: 'rect', points: [], round: [0, 0, 0, 0], selCorner: -1, flip: false, orientManual: false, freeNormal: null,
      Hs: {}, keys: {}, conf: {}, pose: null, undo: [], redo: [], full: new Map(), cur: null,
      loaded: new Set(), thumbs: new Map(),
    });
    state.rev++;
    $('in-focal').value = '';
    syncControls();
  }

  /** Le pont After Effects (plug-in STBridge) répond-il ? */
  function bridgeAvailable() {
    return new Promise((resolve) => {
      const net = nodeRequire('net');
      const sock = net.createConnection(path.join(APPDIR, 'bridge.sock'));
      const done = (ok) => { try { sock.destroy(); } catch (e) { /* déjà fermé */ } resolve(ok); };
      sock.setTimeout(2000, () => done(false));
      sock.on('error', () => done(false));
      sock.on('connect', () => sock.write('PING\n'));
      sock.on('data', (d) => done(String(d).indexOf('OK') === 0));
    });
  }

  /** Calque sans l'effet : le panneau propose de l'ajouter (il porte le tracking dans le projet). */
  function showNeedEffect(sel) {
    if (state.eng) { state.eng.close(); state.eng = null; }
    resetEdit();
    state.shot = null;
    state.n = 0;
    enable('s-surface', true);
    enable('s-result', false);
    $('shot-empty').classList.add('hidden');
    $('shot-info').classList.remove('hidden');
    $('shot-info').innerHTML = `<div class="line"><b>${escapeHtml(sel.layerName)}</b> · « ${escapeHtml(sel.compName)} »</div>`;
    $('shot-warnings').innerHTML = '';
    $('need-text').textContent = "Ce calque n'a pas l'effet « 3D Surface Tracker ». C'est lui qui porte le tracking dans le projet : " +
      "ajoutez-le tout en bas de la pile d'effets, il verra l'image avec les effets placés au-dessus (stabilisation…)." +
      (sel.hasEffects ? '\n\nCe calque a déjà des effets : l\'effet tracker sera ajouté sous eux.' : '');
    $('need-effect').classList.remove('hidden');
    $('btn-add-effect').onclick = async () => {
      const r = await host('stAddTrackerEffect', sel.compId, sel.layerIndex);
      if (!r.ok) { toast(r.msg); return; }
      host('stGetLayer', sel.compId, sel.layerIndex, -1).then(loadShot);
    };
    refresh();
  }

  async function loadShot(sel) {
    if (!sel.ok) { toast(sel.msg, 12000); return; }
    if (sel.needEffect) { showNeedEffect(sel); return; }
    $('need-effect').classList.add('hidden');
    if (state.eng) { state.eng.close(); state.eng = null; }
    resetEdit();
    state.shot = sel;
    state.n = sel.frames.length;
    state.k = state.ref = sel.cur;
    const stem = String(sel.footageName || sel.layerName).replace(/\.[^.]+$/, '').replace(/[\/:]/g, '_');
    state.workDir = path.join(ROOT, 'out', 'panel', `${stem}_${stamp()}`);
    // vignettes d'un fichier vidéo : gardées d'une fois sur l'autre ; d'un précomp : il peut changer
    if (sel.mode === 'file') {
      const st = fs.statSync(sel.file);
      state.thumbsDir = path.join(ROOT, 'out', 'panel', 'cache', `${stem}_${st.size}_${Math.round(st.mtimeMs)}`);
    } else state.thumbsDir = path.join(state.workDir, 'thumbs');

    $('shot-empty').classList.add('hidden');
    $('shot-info').classList.remove('hidden');
    const what = sel.mode === 'file' ? path.basename(sel.file)
      : sel.mode === 'layer' ? `avant l'effet tracker (n° ${sel.effectIndex})` : `précomp « ${escapeHtml(sel.footageName)} »`;
    $('shot-info').innerHTML =
      `<div class="line"><b>${escapeHtml(sel.layerName)}</b> · ${sel.mode === 'file' ? escapeHtml(what) : what}</div>` +
      `<div class="line dim">Images ${sel.seqStart}–${sel.seqStart + state.n - 1} de « ${escapeHtml(sel.compName)} » ` +
      `(${state.n})</div>`;
    const w = $('shot-warnings');
    w.innerHTML = '';
    const note = (m, cls) => { const li = document.createElement('li'); li.textContent = m; if (cls) li.className = cls; w.appendChild(li); };
    sel.warnings.forEach((m) => note(m));
    if (sel.retimed) note('Remappage temporel ou étirement pris en compte : le suivi porte sur les images telles que la compo les montre.', 'note');
    $('summary').innerHTML = '';
    $('apply-msg').classList.add('hidden');
    $('log').textContent = '';

    $('btn-load').disabled = true;
    try {
      fs.mkdirSync(state.workDir, { recursive: true });
      const seq = path.join(state.workDir, 'seq.json');
      let video = sel.file, spec = { src: sel.frames, fps: sel.compFps, start: sel.seqStart, first: sel.cur };
      if (sel.mode === 'bridge' || sel.mode === 'layer') {
        const lens = { lens_src: sel.lensFile || null, lens_frames: sel.lensFrames || null, focal_scale: sel.focalScale || 1 };
        if (await bridgeAvailable()) {  // AE calcule les images, en mémoire
          video = 'bridge';
          const bridge = { item: sel.item, times: sel.times, width: sel.itemW, height: sel.itemH };
          if (sel.mode === 'layer') bridge.layer = { comp: sel.compId, layer: sel.layerIndex, effect: sel.effectIndex, time: 'L' };
          spec = Object.assign(spec, lens, { bridge });
        } else if (sel.mode === 'layer') {
          throw new Error('Pont After Effects absent : il faut le plug-in STBridge pour suivre un calque avec l\'effet « 3D Surface Tracker ». Voir le README.');
        } else {  // repli : rendu par la file d'attente
          note('Pont After Effects absent (plug-in STBridge non installé) : le précomp est rendu sur disque, c\'est plus lent. Voir le README pour l\'installer.');
          video = await renderLayer(sel);
          spec = Object.assign(spec, lens, { src: sel.frames.map((_, i) => i),
            lens_frames: sel.lensFrames ? sel.frames.map((i) => sel.lensFrames[i]) : null });
        }
      }
      fs.writeFileSync(seq, JSON.stringify(spec));
      const ready = new Promise((resolve) => {
        state.eng = startEngine([video, seq, state.thumbsDir], (ev) => {
          if (ev.type === 'ready') resolve(ev); else onEngineEvent(ev);
        });
      });
      const info = await ready;
      state.W = info.width;
      state.H = info.height;
      state.lensMm = info.lens ? info.lens.focal35_mm : null;
      $('focal-wrap').classList.toggle('hidden', !!state.lensMm);
      enable('s-surface', true);
      await loadFull(state.k);
      fitView();
    } catch (e) {
      toast(e.message);
    } finally {
      $('btn-load').disabled = false;
      refresh();
    }
  }

  /** Repli sans le pont : fait rendre le calque par AE ; renvoie le dossier d'images ou le fichier rendu. */
  async function renderLayer(sel) {
    const dir = path.join(state.workDir, 'render');
    const n = sel.frames.length;
    $('canvas-empty').textContent = 'Rendu du précomp par After Effects…';
    const poll = setInterval(() => {  // AE est occupé pendant le rendu : on suit les fichiers écrits
      let k = 0;
      try { k = fs.readdirSync(dir).filter((f) => f.indexOf('st_') === 0).length; } catch (e) { /* pas encore créé */ }
      $('canvas-empty').textContent = `Rendu du précomp par After Effects… ${k}/${n}`;
    }, 500);
    let r;
    try {
      r = await host('stRenderLayer', sel.compId, sel.layerIndex, sel.seqStart, n, dir);
    } finally {
      clearInterval(poll);
      $('canvas-empty').textContent = "L'image du calque s'affichera ici.";
    }
    if (!r.ok) throw new Error(r.msg);
    const files = fs.readdirSync(dir).filter((f) => f.indexOf('st_') === 0).sort();
    if (!files.length) throw new Error("Le rendu d'After Effects n'a produit aucun fichier dans :\n" + dir);
    if (files.length === 1 && /\.(mov|mp4|avi)$/i.test(files[0])) return path.join(dir, files[0]);
    if (files.length !== n) log(`⚠ Rendu : ${files.length} images pour ${n} attendues.`);
    return dir;
  }

  // ------------------------------------------------------------------ images
  /** Vignette d'une image source, décodée une fois et gardée en mémoire (lecture fluide). */
  function cacheThumb(s) {
    if (!inCEP || state.thumbs.has(s)) return;
    state.thumbs.set(s, null);  // en cours
    const dir = state.thumbsDir;
    loadImg(fileUrl(path.join(dir, pad5(s) + '.jpg'))).then((img) => {
      if (dir !== state.thumbsDir) return;  // un autre calque a été chargé entre-temps
      const keep = (bmp) => {
        state.thumbs.set(s, bmp);
        if (state.shot && state.shot.frames[state.k] === s && !state.full.has(state.k)) {
          state.cur = bmp;
          if (state.curThumbMissing) { state.curThumbMissing = false; refresh(); } else draw();
        }
      };
      if (window.createImageBitmap) createImageBitmap(img).then(keep).catch(() => keep(img)); else keep(img);
    }).catch(() => state.thumbs.delete(s));
  }

  /** Image pleine résolution de l'image k (cache de quelques images). */
  async function loadFull(k) {
    if (state.full.has(k)) return state.full.get(k);
    let img;
    if (!inCEP) img = await loadImg('demo.jpg');
    else {
      const out = path.join(state.workDir, 'frames', pad5(state.shot.frames[k]) + '.jpg');
      const r = await state.eng.send({ cmd: 'frame', k, out });
      img = await loadImg(fileUrl(r.path));
    }
    state.full.set(k, img);
    if (state.full.size > 8) state.full.delete(state.full.keys().next().value);
    if (state.k === k) { state.cur = img; state.curThumbMissing = false; draw(); }
    return img;
  }

  let fullTimer = null;
  /** Affiche l'image k : pleine résolution si en cache, sinon la vignette (puis la pleine résolution). */
  function showFrame(k, opts) {
    opts = opts || {};
    state.k = k;
    const f = state.full.get(k);
    if (f) { state.cur = f; state.curThumbMissing = false; }
    else if (inCEP) {
      const t = state.thumbs.get(state.shot.frames[k]);
      if (t) { state.cur = t; state.curThumbMissing = false; } else state.curThumbMissing = true;
      if (!opts.fast && !state.tracking) {
        clearTimeout(fullTimer);
        fullTimer = setTimeout(() => { if (state.k === k && state.eng) loadFull(k).catch(() => {}); }, 150);
      }
    }
    refresh();
  }

  // ------------------------------------------------------------------ géométrie
  function solve(A, b) { // élimination de Gauss avec pivot partiel
    const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }

  /** Homographie du carré unité vers les 4 coins (HG, HD, BD, BG), en 3x3. */
  function squareHomography(q) {
    const src = [[0, 0], [1, 0], [1, 1], [0, 1]], A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = q[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return h && [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  }

  function warp(H, x, y) {
    const w = H[2][0] * x + H[2][1] * y + H[2][2];
    return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
  }
  /** Homographie à plat (9 nombres) appliquée à un point. */
  function warp9(h, p) {
    const w = h[6] * p[0] + h[7] * p[1] + h[8];
    return [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w];
  }
  function inv9(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }

  /** Contour du rectangle arrondi dans le carré unité (même construction que le moteur) ;
   *  radii : arrondi de chaque coin HG, HD, BD, BG en 0..1. */
  function roundedUnit(radii, perArc) {
    const [rh, rd, rb, rg] = radii.map((r) => 0.5 * Math.max(0, Math.min(1, r))), pts = [], n = perArc || 12;
    [[rd, 1 - rd, rd, -90], [rb, 1 - rb, 1 - rb, 0], [rg, rg, 1 - rg, 90], [rh, rh, rh, 180]].forEach(([r, cx, cy, a0]) => {
      if (r <= 1e-6) { pts.push([cx, cy]); return; }
      for (let k = 0; k < n; k++) {
        const a = (a0 + 90 * k / (n - 1)) * Math.PI / 180;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    });
    return pts;
  }
  const radii = () => state.round.map((r) => r / 100);
  const anyRound = () => state.round.some((r) => r > 0);

  /** Contour du rectangle arrondi, vu en perspective (q : coins HG, HD, BD, BG). */
  function roundedOutline(q) {
    const H = squareHomography(q);
    if (!H || !anyRound()) return q;
    return roundedUnit(radii()).map(([u, v]) => warp(H, u, v));
  }

  const flat = (H) => [H[0][0], H[0][1], H[0][2], H[1][0], H[1][1], H[1][2], H[2][0], H[2][1], H[2][2]];
  function mul9(a, b) {
    const o = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o.push(a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]);
    return o.map((x) => x / o[8]);
  }
  /** Homographie qui envoie les points src sur dst (4 points : exacte ; plus : moindres carrés). */
  function fitH(src, dst) {
    if (src.length === 4) {
      const A = squareHomography(src), B = squareHomography(dst);
      return A && B ? mul9(flat(B), inv9(flat(A))) : null;
    }
    const N = Array.from({ length: 8 }, () => new Array(8).fill(0)), r = new Array(8).fill(0);
    src.forEach(([x, y], i) => {
      const [u, v] = dst[i];
      [[[x, y, 1, 0, 0, 0, -u * x, -u * y], u], [[0, 0, 0, x, y, 1, -v * x, -v * y], v]].forEach(([row, b]) => {
        for (let a = 0; a < 8; a++) { r[a] += row[a] * b; for (let c = 0; c < 8; c++) N[a][c] += row[a] * row[c]; }
      });
    });
    const h = solve(N, r);
    return h && h.concat([1]);
  }

  /** Indices des points dans l'ordre du contour (rectangle : HG, HD, BD, BG). */
  function orderIdx(pts) {
    if (state.tool !== 'rect' || pts.length !== 4) return pts.map((_, i) => i);
    const o = orderRect(pts);
    return o.map((p) => pts.indexOf(p));
  }

  /** Coins d'un rectangle dans l'ordre haut-gauche, haut-droit, bas-droit, bas-gauche. */
  function orderRect(pts) {
    if (pts.length !== 4) return pts;
    const cx = pts.reduce((a, p) => a + p[0], 0) / 4, cy = pts.reduce((a, p) => a + p[1], 0) / 4;
    const s = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let k = 0;
    s.forEach((p, i) => { if (p[0] + p[1] < s[k][0] + s[k][1]) k = i; });
    return s.slice(k).concat(s.slice(0, k));
  }

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const norm = (a) => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

  /** Focale en pixels : saisie > métadonnées > 50 mm (éq. 24x36, 36 mm = grand côté). */
  function focalPx() {
    const mm = parseFloat($('in-focal').value) || state.lensMm || 50;
    return mm / 36 * Math.max(state.W, state.H);
  }
  function ray(p) { // direction (repère caméra) du pixel p
    const f = focalPx();
    return norm([(p[0] - state.W / 2) / f, (p[1] - state.H / 2) / f, 1]);
  }
  function projectF(X, f) { return [state.W / 2 + f * X[0] / X[2], state.H / 2 + f * X[1] / X[2]]; }
  function project(X) { return projectF(X, focalPx()); }

  const isDisc = () => state.tool === 'rect' && state.round.every((r) => r >= 100);
  const hasTrack = () => Object.keys(state.Hs).some((k) => +k !== state.ref) || Object.keys(state.keys).length > 0;

  // ---- clés de correction : sur une image corrigée à la main, la forme est imposée ; entre
  // deux clés, l'écart entre le suivi et les clés est réparti progressivement (comme Mocha).
  const keyH = (k) => (k === state.ref ? I3 : state.keys[k]);
  const keyFrames = () => [state.ref].concat(Object.keys(state.keys).map(Number)).sort((a, b) => a - b);
  /** 4 points de la référence qui portent les corrections (rectangle : ses coins ; sinon le cadre de la forme). */
  function controlQuad() {
    if (state.tool === 'rect') return orderRect(state.points);
    const xs = state.points.map((p) => p[0]), ys = state.points.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
  let effCache = { rev: -1, map: new Map() };
  /** Homographie référence -> image k telle qu'utilisée : clé, ou suivi corrigé par les clés voisines. */
  function effH(k) {
    if (k === state.ref) return I3;
    if (state.keys[k]) return state.keys[k];
    const raw = state.Hs[k];
    if (!raw || !ready()) return raw || null;
    if (effCache.rev !== state.rev) effCache = { rev: state.rev, map: new Map() };
    if (effCache.map.has(k)) return effCache.map.get(k);
    let kp = null, kn = null;
    keyFrames().forEach((kk) => {
      if (!state.Hs[kk]) return;
      if (kk < k) kp = kk;
      else if (kk > k && kn === null) kn = kk;
    });
    let H = raw;
    if (kp !== null || kn !== null) {
      const Q = controlQuad();
      const delta = (kk) => Q.map((p) => { const a = warp9(keyH(kk), p), b = warp9(state.Hs[kk], p); return [a[0] - b[0], a[1] - b[1]]; });
      const dp = kp !== null ? delta(kp) : null, dn = kn !== null ? delta(kn) : null;
      const w = kp !== null && kn !== null ? (k - kp) / (kn - kp) : kp !== null ? 0 : 1;
      const c = Q.map((p, i) => {
        const q = warp9(raw, p);
        if (dp) { q[0] += (1 - w) * dp[i][0]; q[1] += (1 - w) * dp[i][1]; }
        if (dn) { q[0] += w * dn[i][0]; q[1] += w * dn[i][1]; }
        return q;
      });
      H = fitH(Q, c) || raw;
    }
    effCache.map.set(k, H);
    return H;
  }
  /** Prochaine clé après k dans le sens d (null s'il n'y en a pas). */
  function nextKey(k, d) {
    const ks = keyFrames().filter((kk) => (d > 0 ? kk > k : kk < k));
    return ks.length ? (d > 0 ? ks[0] : ks[ks.length - 1]) : null;
  }

  function rotate(v, axis, ang) { // rotation de Rodrigues autour d'un axe unitaire
    const c = Math.cos(ang), s = Math.sin(ang), k = dot(axis, v);
    return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, k * (1 - c)));
  }

  /** Modèle 3D du rectangle déduit des 4 coins : X(a, b) = C + a·eu + b·ev, a et b dans [-½, ½]. */
  function rectModel(points) {
    if (points.length !== 4) return null;
    const H = squareHomography(orderRect(points));
    if (!H) return null;
    const f = focalPx(), cx = state.W / 2, cy = state.H / 2;
    const col = (j) => [(H[0][j] - cx * H[2][j]) / f, (H[1][j] - cy * H[2][j]) / f, H[2][j]];
    const eu = col(0), ev = col(1);
    return { C: add(add(scale(eu, 0.5), scale(ev, 0.5)), col(2)), eu, ev };
  }

  function cornersOf(m) {
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => project(add(m.C, add(scale(m.eu, a / 2), scale(m.ev, b / 2)))));
  }

  /** Repère 3D de la surface sur l'image de référence, déduit de la forme :
   *  {C, x, y, n (vers l'arrière-plan), P(a, b) point de la surface, L taille des axes, auto}. */
  function gizmo() {
    if (!state.W || !ready()) return null;
    if (state.tool === 'rect') {
      const m = rectModel(state.points);
      if (!m) return null;
      let n = norm(cross(m.eu, m.ev));
      if (dot(n, m.C) < 0) n = scale(n, -1);
      if (isDisc() && state.flip) { const d = norm(m.C); n = norm(add(scale(d, 2 * dot(n, d)), scale(n, -1))); }
      const x = norm(add(m.eu, scale(n, -dot(m.eu, n)))), y = cross(n, x);
      return { C: m.C, x, y, n, model: m, P: (a, b) => add(m.C, add(scale(m.eu, a), scale(m.ev, b))),
        L: 0.5 * Math.min(Math.hypot(...m.eu), Math.hypot(...m.ev)) };
    }
    const pts = state.points;
    const center = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    const C = ray(center);
    const n = state.orientManual && state.freeNormal ? state.freeNormal : C;  // auto : face caméra en attendant le mouvement
    const x = norm(add([1, 0, 0], scale(n, -n[0]))), y = cross(n, x);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    pts.forEach((p) => { // étendue de la forme sur le plan
      const r = ray(p), D = add(scale(r, dot(n, C) / dot(n, r)), scale(C, -1));
      a0 = Math.min(a0, dot(D, x)); a1 = Math.max(a1, dot(D, x));
      b0 = Math.min(b0, dot(D, y)); b1 = Math.max(b1, dot(D, y));
    });
    const unit = pts.map((p) => { // contour de la forme en coordonnées 0..1 de la grille
      const r = ray(p), D = add(scale(r, dot(n, C) / dot(n, r)), scale(C, -1));
      return [(dot(D, x) - a0) / (a1 - a0), (dot(D, y) - b0) / (b1 - b0)];
    });
    return { C, x, y, n, auto: !state.orientManual, L: 0.5 * Math.min(a1 - a0, b1 - b0), unit,
      P: (a, b) => add(C, add(scale(x, a0 + (a + 0.5) * (a1 - a0)), scale(y, b0 + (b + 0.5) * (b1 - b0)))) };
  }

  /** Normale à transmettre au moteur (disque : tranche entre les 2 inclinaisons ; forme libre : réglage manuel). */
  function chosenNormal() {
    const g = gizmo();
    if (!g || !(isDisc() || (state.tool === 'free' && state.orientManual))) return null;
    return g.n;
  }

  /** Forme à l'image k : sur la référence telle quelle, ailleurs transportée par le suivi (null si non trackée). */
  function shapeAt(k) {
    if (k === state.ref || !hasTrack()) return state.points;
    const h = effH(k);
    return h ? state.points.map((p) => warp9(h, p)) : null;
  }
  const editable = () => !state.tracking && !!shapeAt(state.k);

  // ------------------------------------------------------------------ annuler / rétablir
  function snapshot() {
    return {
      tool: state.tool, points: state.points.map((p) => p.slice()), round: state.round.slice(), flip: state.flip,
      orientManual: state.orientManual, freeNormal: state.freeNormal, ref: state.ref,
      Hs: state.Hs, keys: state.keys, conf: state.conf, focal: $('in-focal').value, rev: state.rev,
    };
  }
  function sameSnap(a, b) {
    const light = (s) => JSON.stringify([s.tool, s.points, s.round, s.flip, s.orientManual, s.freeNormal, s.ref, s.focal, s.keys]);
    return a.Hs === b.Hs && light(a) === light(b);
  }
  let pendingSnap = null;
  /** Début d'une action annulable (l'état d'avant est mémorisé). */
  function beginAction() { if (!pendingSnap) pendingSnap = snapshot(); }
  /** Fin de l'action : elle entre dans l'historique si elle a changé quelque chose. */
  function endAction() {
    if (!pendingSnap) return;
    const before = pendingSnap;
    pendingSnap = null;
    if (sameSnap(before, snapshot())) {  // rien de changé : la 3D reste valable
      if (state.pose && state.pose.rev !== state.rev && state.pose.rev === before.rev) state.pose.rev = state.rev;
      return;
    }
    state.undo.push(before);
    if (state.undo.length > 200) state.undo.shift();
    state.redo = [];
    changed();
  }
  function act(fn) { beginAction(); fn(); endAction(); refresh(); }

  function restore(s) {
    const refMoved = s.ref !== state.ref;
    Object.assign(state, {
      tool: s.tool, points: s.points.map((p) => p.slice()), round: s.round.slice(), flip: s.flip,
      orientManual: s.orientManual, freeNormal: s.freeNormal, ref: s.ref, Hs: s.Hs, keys: s.keys, conf: s.conf,
    });
    $('in-focal').value = s.focal;
    syncControls();
    changed();
    if (refMoved || (!hasTrack() && state.k !== state.ref)) { showFrame(state.ref); syncAE(state.ref); } else refresh();
  }
  function undo() {
    if (state.tracking || !state.undo.length) return;
    pendingSnap = null;
    state.redo.push(snapshot());
    restore(state.undo.pop());
  }
  function redo() {
    if (state.tracking || !state.redo.length) return;
    pendingSnap = null;
    state.undo.push(snapshot());
    restore(state.redo.pop());
  }

  /** Une modification a eu lieu : la 3D est à recalculer. */
  function changed() {
    state.rev++;
    scheduleSolve();
  }

  function syncControls() {
    document.querySelectorAll('#toolbar [data-tool]').forEach((x) => x.classList.toggle('on', x.dataset.tool === state.tool));
    $('in-round').value = String(state.selCorner >= 0 ? state.round[state.selCorner] : Math.max(...state.round));
  }

  // ------------------------------------------------------------------ éditeur
  const canvas = $('view');
  const ctx = canvas.getContext('2d');
  const DPR = () => window.devicePixelRatio || 1;

  function fitView() {
    if (!state.W) return;
    resizeCanvas();
    const s = Math.min(canvas.width / state.W, canvas.height / state.H) * 0.98;
    state.view = { s, ox: (canvas.width - state.W * s) / 2, oy: (canvas.height - state.H * s) / 2, fit: s };
    draw();
  }

  function resizeCanvas() {
    const w = Math.round(canvas.clientWidth * DPR()), h = Math.round(canvas.clientHeight * DPR());
    if (canvas.width !== w || canvas.height !== h) {
      const v = state.view;
      if (v && canvas.width) { v.ox += (w - canvas.width) / 2; v.oy += (h - canvas.height) / 2; }
      canvas.width = w;
      canvas.height = h;
    }
  }

  const toScreen = (p) => [p[0] * state.view.s + state.view.ox, p[1] * state.view.s + state.view.oy];
  const toImage = (x, y) => [(x - state.view.ox) / state.view.s, (y - state.view.oy) / state.view.s];

  function canvasXY(ev) {
    const r = canvas.getBoundingClientRect();
    const k = canvas.width / r.width;
    return [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k];
  }

  function hitPoint(x, y) {
    const pts = editable() ? shapeAt(state.k) : null;
    if (!pts) return -1;
    const R = 10 * DPR();
    let best = -1, bd = R;
    pts.forEach((p, i) => {
      const [sx, sy] = toScreen(p);
      const d = Math.hypot(sx - x, sy - y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  function ready() {
    return state.tool === 'rect' ? state.points.length === 4 : state.points.length >= 3;
  }

  function polyPath(pts, close) {
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = toScreen(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    if (close) ctx.closePath();
  }

  let drawQueued = false;
  function draw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; drawNow(); });
  }

  function drawNow() {
    resizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = state.cur;
    $('canvas-empty').classList.toggle('hidden', !!img);
    drawTimeline();
    if (!img || !state.view) return;
    const v = state.view;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, v.ox, v.oy, state.W * v.s, state.H * v.s);  // vignettes : même cadre que la vidéo
    drawShape();
  }

  function drawShape() {
    const dpr = DPR(), k = state.k;
    const pts = shapeAt(k);
    if (!pts) return;
    const ok = ready(), canEdit = editable();
    const rectPts = state.tool === 'rect' && pts.length === 4 ? orderRect(pts) : null;
    const shape = rectPts && ok ? roundedOutline(rectPts) : pts;
    if (rectPts && ok && anyRound()) { // rectangle « pointu » en pointillés
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      polyPath(rectPts, true);
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = 'rgba(240, 192, 64, 0.7)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (shape.length > 1) {
      polyPath(shape, ok);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = ok ? '#3ce07a' : '#f0c040';
      ctx.stroke();
      if (ok) { ctx.fillStyle = 'rgba(60, 224, 122, 0.08)'; ctx.fill(); }
    }
    if (ok) drawSurface3D();
    if (!canEdit && state.tracking) return;
    const labels = ['HG', 'HD', 'BD', 'BG'];
    pts.forEach((p, i) => {
      const [x, y] = toScreen(p);
      if (rectPts && rectPts.indexOf(p) === state.selCorner) { // coin choisi pour l'arrondi
        ctx.beginPath();
        ctx.arc(x, y, 10 * dpr, 0, 2 * Math.PI);
        ctx.strokeStyle = '#f0c040';
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, (i === state.hover ? 6.5 : 5) * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = i === state.hover ? '#ffffff' : '#3ce07a';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
      if (rectPts) {
        ctx.font = `${11 * dpr}px -apple-system, sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.fillText(labels[rectPts.indexOf(p)], x + 8 * dpr, y - 8 * dpr);
      }
    });
    if (state.drag && state.drag.kind === 'point') drawLoupe(shapeAt(k)[state.drag.i]);
    if (state.hoverEdge && !state.drag) { // côté sous la souris : se déplace d'un bloc
      const [i, j] = state.hoverEdge;
      polyPath([pts[i], pts[j]]);
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.stroke();
    }
  }

  /** Pose calculée à l'image k, si elle est à jour. */
  function poseAt(k) {
    const p = state.pose;
    return p && p.rev === state.rev && p.poses && p.poses[k] ? p.poses[k] : null;
  }

  /** Grille 3D + axes : la pose calculée si elle est à jour, sinon (référence) celle déduite de la forme. */
  function drawSurface3D() {
    const k = state.k, ps = poseAt(k);
    let P, proj, C, axes, L, disc = isDisc(), outline = null, faint = false, clip = null;
    if (ps) {
      const R = ps.R, t = ps.t, [w, h] = state.pose.size;
      P = (a, b) => [R[0] * a * w + R[1] * b * h + t[0], R[3] * a * w + R[4] * b * h + t[1], R[6] * a * w + R[7] * b * h + t[2]];
      proj = (X) => projectF(X, ps.f);
      C = t;
      axes = [[R[0], R[3], R[6]], [R[1], R[4], R[7]], [-R[2], -R[5], -R[8]]];
      L = 0.5 * Math.min(w, h);
      disc = state.pose.kind === 'disc';
      outline = state.pose.outline;
      clip = outline;
    } else if (k === state.ref || !hasTrack()) {
      const g = gizmo();
      if (!g) return;
      P = g.P; proj = project; C = g.C; axes = [g.x, g.y, scale(g.n, -1)]; L = g.L; faint = !!g.auto;
      clip = g.unit || (state.tool === 'rect' && anyRound() && !disc ? roundedUnit(radii(), 8) : null);
      if (g.unit) outline = g.unit;
    } else return;
    if (disc) clip = Array.from({ length: 48 }, (_, i) => { const a = i / 48 * 2 * Math.PI; return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]; });
    const dpr = DPR();
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = faint ? 'rgba(0, 220, 255, 0.25)' : 'rgba(0, 220, 255, 0.7)';
    for (let i = 0; i <= 8; i++) { // grille 8 x 8, découpée à la forme
      const c = i / 8;
      clipLine(clip, true, c).forEach(([s0, s1]) => { polyPath([proj(P(c - 0.5, s0 - 0.5)), proj(P(c - 0.5, s1 - 0.5))]); ctx.stroke(); });
      clipLine(clip, false, c).forEach(([s0, s1]) => { polyPath([proj(P(s0 - 0.5, c - 0.5)), proj(P(s1 - 0.5, c - 0.5))]); ctx.stroke(); });
    }
    if (disc || outline) {
      const ring = disc ? Array.from({ length: 73 }, (_, i) => { const a = i / 72 * 2 * Math.PI; return proj(P(0.5 * Math.cos(a), 0.5 * Math.sin(a))); })
        : outline.map(([u, v]) => proj(P(u - 0.5, v - 0.5)));
      polyPath(ring, true);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = 'rgba(0, 220, 255, 0.9)';
      ctx.stroke();
    }
    const o = toScreen(proj(C));
    [[axes[0], '#ff4d4d'], [axes[1], '#3ce07a'], [axes[2], '#4aa3ff']].forEach(([axis, col]) => {
      const e = toScreen(proj(add(C, scale(axis, L))));
      ctx.lineWidth = 2.5 * dpr;
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(e[0], e[1]); ctx.stroke();
      const ang = Math.atan2(e[1] - o[1], e[0] - o[0]), hl = 9 * dpr;
      ctx.beginPath();
      ctx.moveTo(e[0], e[1]); ctx.lineTo(e[0] - hl * Math.cos(ang - 0.4), e[1] - hl * Math.sin(ang - 0.4));
      ctx.moveTo(e[0], e[1]); ctx.lineTo(e[0] - hl * Math.cos(ang + 0.4), e[1] - hl * Math.sin(ang + 0.4));
      ctx.stroke();
    });
    if (ringsShown()) drawRings();
  }

  /** Morceaux d'une ligne de la grille (u = c si vertical, sinon v = c) à l'intérieur du contour (0..1). */
  function clipLine(poly, vertical, c) {
    if (!poly || poly.length < 3) return [[0, 1]];
    const hits = [];
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length];
      const a0 = vertical ? p[0] : p[1], a1 = vertical ? q[0] : q[1], b0 = vertical ? p[1] : p[0], b1 = vertical ? q[1] : q[0];
      if ((a0 <= c && a1 > c) || (a1 <= c && a0 > c)) hits.push(b0 + (c - a0) / (a1 - a0) * (b1 - b0));
    });
    hits.sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]]);
    return out;
  }

  // ---- gizmo de rotation : un anneau par axe (X rouge, Y vert, Z bleu), comme dans AE
  const RING_COLORS = { x: '#ff4d4d', y: '#3ce07a', z: '#4aa3ff' };
  function ringsShown() { return !state.tracking && state.k === state.ref && ready() && !!gizmo(); }

  /** Anneaux en 3D autour du centre de la surface : axe de rotation + points projetés à l'écran. */
  function rings() {
    const g = gizmo();
    if (!g) return [];
    const r = 1.15 * g.L, out = [];
    const defs = [['x', g.x, g.y, g.n], ['y', g.y, g.x, g.n]];
    if (state.tool === 'rect') defs.push(['z', g.n, g.x, g.y]);  // forme libre : tourner dans le plan ne change rien
    defs.forEach(([id, axis, u, v]) => {
      const P3 = (a) => add(g.C, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a))));
      const pts = [];
      for (let i = 0; i <= 72; i++) pts.push(toScreen(project(P3(i / 72 * 2 * Math.PI))));
      out.push({ id, axis, P3, pts });
    });
    return out;
  }

  function drawRings() {
    const dpr = DPR(), active = state.drag && state.drag.kind === 'ring' ? state.drag.id : null;
    rings().forEach((rg) => {
      const hot = rg.id === active || (!active && rg.id === state.hoverRing);
      ctx.beginPath();
      rg.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.lineWidth = (hot ? 4 : 2) * dpr;
      ctx.strokeStyle = RING_COLORS[rg.id];
      ctx.globalAlpha = active && !hot ? 0.25 : hot ? 1 : 0.75;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  /** Anneau sous la souris : {ring, i} (i : indice du point le plus proche) ou null. */
  function hitRing(x, y) {
    if (!ringsShown()) return null;
    let best = null, bd = 7 * DPR();
    rings().forEach((rg) => {
      for (let i = 0; i < rg.pts.length - 1; i++) {
        const [ax, ay] = rg.pts[i], [bx, by] = rg.pts[i + 1];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        const d = Math.hypot(ax + u * dx - x, ay + u * dy - y);
        if (d < bd) { bd = d; best = { ring: rg, i }; }
      }
    });
    return best;
  }

  /** Loupe x4 autour du point déplacé, dans le coin opposé. */
  function drawLoupe(p) {
    const img = state.cur;
    if (!img || !p) return;
    const dpr = DPR(), size = 140 * dpr, zoom = 4, k = img.width / state.W;
    const [sx] = toScreen(p);
    const dx = sx < canvas.width / 2 ? canvas.width - size - 8 * dpr : 8 * dpr, dy = 8 * dpr;
    const src = size / (zoom * state.view.s);
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(dx - 1, dy - 1, size + 2, size + 2);
    ctx.drawImage(img, (p[0] - src / 2) * k, (p[1] - src / 2) * k, src * k, src * k, dx, dy, size, size);
    ctx.strokeStyle = '#3ce07a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dx + size / 2, dy); ctx.lineTo(dx + size / 2, dy + size);
    ctx.moveTo(dx, dy + size / 2); ctx.lineTo(dx + size, dy + size / 2);
    ctx.stroke();
    ctx.strokeRect(dx, dy, size, size);
    ctx.restore();
  }

  /** Sur la référence (ou avant tout suivi) on modifie la forme ; ailleurs, on pose une clé. */
  const onRef = () => state.k === state.ref || !hasTrack();

  /** Côté (deux points voisins) sous la souris : [i, j] ou null. */
  function hitEdge(x, y) {
    const pts = editable() ? shapeAt(state.k) : null;
    if (!pts || !ready()) return null;
    const o = orderIdx(pts);
    let best = null, bd = 7 * DPR();
    o.forEach((i, n) => {
      const j = o[(n + 1) % o.length];
      const [ax, ay] = toScreen(pts[i]), [bx, by] = toScreen(pts[j]);
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      const u = ((x - ax) * dx + (y - ay) * dy) / L2;
      if (u < 0.1 || u > 0.9) return;  // près d'un coin : c'est le coin qu'on attrape
      const d = Math.hypot(ax + u * dx - x, ay + u * dy - y);
      if (d < bd) { bd = d; best = [i, j]; }
    });
    return best;
  }

  /** Applique la forme affichée modifiée : sur la référence, la forme ; ailleurs, une clé. */
  function setShapeAt(shown) {
    if (onRef()) { state.points = shown.map((p) => p.slice()); return; }
    const H = fitH(state.points, shown);
    if (H) state.keys[state.k] = H;
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (ev) => {
    if (!state.cur || !state.view) return;
    stopPlay();
    const [x, y] = canvasXY(ev);
    const hit = ev.button === 0 || ev.button === 2 ? hitPoint(x, y) : -1;
    if (ev.button === 2 && hit >= 0) { // clic droit sur un point : supprimer
      act(() => { state.points.splice(hit, 1); });
      return;
    }
    if (ev.button === 1 || ev.button === 2 || state.space || !editable()) {
      state.drag = { kind: 'pan', x, y };
      canvas.classList.add('pan');
      return;
    }
    const edge = hit < 0 && ev.button === 0 ? hitEdge(x, y) : null;
    const ring = hit < 0 && !edge ? hitRing(x, y) : null;
    if (ring) { // tourner la surface autour d'un de ses axes
      const g = gizmo(), rg = ring.ring;
      const a = ring.i / 72 * 2 * Math.PI, eps = 0.01;
      const p0 = toScreen(project(rg.P3(a))), p1 = toScreen(project(rg.P3(a + eps)));
      let tx = (p1[0] - p0[0]) / eps, ty = (p1[1] - p0[1]) / eps;  // pixels par radian le long de l'anneau
      const tl = Math.hypot(tx, ty);
      if (tl < 30 * DPR()) { const s = 30 * DPR() / (tl || 1); tx *= s; ty *= s; }  // anneau vu par la tranche
      beginAction();
      if (isDisc() && state.flip) state.flip = false;  // la rotation à la main remplace l'inversion
      state.drag = { kind: 'ring', id: rg.id, axis: rg.axis, x0: x, y0: y, tx, ty, model: g.model, n0: g.n };
      draw();
      return;
    }
    beginAction();
    if (!onRef()) state.keys = Object.assign({}, state.keys);  // nouvel objet : l'historique garde l'ancien
    const base = (shapeAt(state.k) || []).map((p) => p.slice());
    if (hit >= 0) {
      state.drag = { kind: 'point', i: hit, base };
      if (state.tool === 'rect' && ready()) { state.selCorner = orderRect(base).indexOf(base[hit]); syncControls(); }
    } else if (edge) {
      state.drag = { kind: 'edge', edge, base, p0: toImage(x, y) };
    } else if (!onRef()) {
      pendingSnap = null;
      toast('Les points s\'ajoutent sur l\'image de référence. Ici, glissez un point ou un côté : ça pose une clé.', 3500);
      return;
    } else {
      if (state.tool === 'rect' && state.points.length >= 4) {
        pendingSnap = null;
        if (state.selCorner >= 0) { state.selCorner = -1; syncControls(); refresh(); }  // clic dans le vide : tous les coins
        return;
      }
      state.points.push(toImage(x, y));
      state.drag = { kind: 'point', i: state.points.length - 1 };
      state.rev++;
    }
    refresh();
  });

  window.addEventListener('mousemove', (ev) => {
    if (!state.view) return;
    const [x, y] = canvasXY(ev);
    const d = state.drag;
    if (d && d.kind === 'point') {
      const p = toImage(x, y);
      p[0] = Math.max(0, Math.min(state.W, p[0]));
      p[1] = Math.max(0, Math.min(state.H, p[1]));
      const shown = d.base.map((q) => q.slice());
      shown[d.i] = p;
      setShapeAt(shown);
      state.rev++;
      draw();
    } else if (d && d.kind === 'edge') {
      const p = toImage(x, y), dx = p[0] - d.p0[0], dy = p[1] - d.p0[1];
      const shown = d.base.map((q, i) => (d.edge.indexOf(i) >= 0 ? [q[0] + dx, q[1] + dy] : q.slice()));
      setShapeAt(shown);
      state.rev++;
      draw();
    } else if (d && d.kind === 'ring') {
      const ang = ((x - d.x0) * d.tx + (y - d.y0) * d.ty) / (d.tx * d.tx + d.ty * d.ty);
      if (d.model) { // rectangle / disque : les coins suivent la rotation
        state.points = cornersOf({ C: d.model.C, eu: rotate(d.model.eu, d.axis, ang), ev: rotate(d.model.ev, d.axis, ang) });
      } else {
        state.freeNormal = norm(rotate(d.n0, d.axis, ang));
        state.orientManual = true;
      }
      state.rev++;
      draw();
    } else if (d && d.kind === 'pan') {
      state.view.ox += x - d.x;
      state.view.oy += y - d.y;
      d.x = x;
      d.y = y;
      draw();
    } else if (ev.target === canvas) {
      const h = hitPoint(x, y);
      const e = h < 0 ? hitEdge(x, y) : null;
      const r = h < 0 && !e ? hitRing(x, y) : null;
      const rid = r ? r.ring.id : null;
      canvas.style.cursor = rid ? 'grab' : e ? 'move' : '';
      if (h !== state.hover || rid !== state.hoverRing || String(e) !== String(state.hoverEdge)) {
        state.hover = h; state.hoverRing = rid; state.hoverEdge = e; draw();
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (!state.drag) return;
    state.drag = null;
    canvas.classList.remove('pan');
    endAction();
    refresh();
  });

  canvas.addEventListener('wheel', (ev) => {
    if (!state.view) return;
    ev.preventDefault();
    const [x, y] = canvasXY(ev);
    const v = state.view;
    const s = Math.max(v.fit * 0.5, Math.min(v.fit * 24, v.s * Math.pow(1.0015, -ev.deltaY)));
    v.ox = x - (x - v.ox) * (s / v.s);
    v.oy = y - (y - v.oy) * (s / v.s);
    v.s = s;
    draw();
  }, { passive: false });

  canvas.addEventListener('dblclick', (ev) => {
    const [x, y] = canvasXY(ev);
    if (hitPoint(x, y) < 0) fitView();
  });

  // ------------------------------------------------------------------ clavier
  window.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && (ev.key === 'z' || ev.key === 'Z')) { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
    if (mod && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); redo(); return; }
    if (ev.target.tagName === 'INPUT' && ev.target.type !== 'range' && ev.target.type !== 'checkbox') return;
    if (ev.code === 'Space') { state.space = true; canvas.classList.add('pan'); ev.preventDefault(); }
    if ((ev.key === 'Backspace' || ev.key === 'Delete') && editable() && onRef() && state.points.length) {
      act(() => { state.points.pop(); });
      ev.preventDefault();
    }
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && state.n && !state.tracking) {
      const step = (ev.key === 'ArrowLeft' ? -1 : 1) * (ev.shiftKey ? 10 : 1);
      goTo(Math.max(0, Math.min(state.n - 1, state.k + step)), true);
      ev.preventDefault();
    }
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') { state.space = false; if (!state.drag) canvas.classList.remove('pan'); }
  });
  window.addEventListener('resize', draw);
  if (inCEP) {
    // ⌘Z / ⇧⌘Z / ←→ : pour le panneau plutôt que pour AE (codes de touches macOS)
    try {
      window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify([
        { keyCode: 6, metaKey: true }, { keyCode: 6, metaKey: true, shiftKey: true },
        { keyCode: 123 }, { keyCode: 124 }, { keyCode: 123, shiftKey: true }, { keyCode: 124, shiftKey: true },
        { keyCode: 51 }, { keyCode: 117 }, { keyCode: 49 },
      ]));
    } catch (e) { /* ancienne version de CEP */ }
  }

  // ------------------------------------------------------------------ outils
  document.querySelectorAll('#toolbar [data-tool]').forEach((b) => b.addEventListener('click', () => {
    if (state.tracking || b.dataset.tool === state.tool) return;
    act(() => {
      state.tool = b.dataset.tool;
      state.points = [];
      state.Hs = {};
      state.keys = {};
      state.conf = {};
      state.selCorner = -1;
    });
    syncControls();
  }));
  const round = $('in-round');
  round.addEventListener('pointerdown', beginAction);
  round.addEventListener('input', () => {
    beginAction();
    const r = state.round.slice();
    if (state.selCorner >= 0) r[state.selCorner] = +round.value; else r.fill(+round.value);
    state.round = r;
    state.rev++;
    refresh();
  });
  round.addEventListener('change', () => { endAction(); refresh(); });
  $('btn-flip').addEventListener('click', () => act(() => { state.flip = !state.flip; }));
  $('btn-orient-auto').addEventListener('click', () => act(() => { state.orientManual = false; state.freeNormal = null; }));
  const focalIn = $('in-focal');
  focalIn.addEventListener('focus', beginAction);
  focalIn.addEventListener('input', () => { beginAction(); state.rev++; refresh(); });
  focalIn.addEventListener('change', () => { endAction(); refresh(); });
  // effacer : un menu, pour ne pas confondre « le suivi seulement » et « tout »
  $('btn-clear').addEventListener('click', (e) => { e.stopPropagation(); if (!state.tracking) $('clear-menu').classList.toggle('hidden'); });
  window.addEventListener('click', () => $('clear-menu').classList.add('hidden'));
  $('btn-clear-track').addEventListener('click', () => act(() => { state.Hs = {}; state.keys = {}; state.conf = {}; }));
  $('btn-clear-all').addEventListener('click', () => act(() => {
    state.points = []; state.Hs = {}; state.keys = {}; state.conf = {}; state.selCorner = -1;
  }));
  // clé sur l'image courante : la poser (fige la forme affichée) ou la retirer
  $('btn-key').addEventListener('click', () => {
    const k = state.k;
    if (state.tracking || k === state.ref || !hasTrack()) return;
    act(() => {
      const keys = Object.assign({}, state.keys);
      if (keys[k]) delete keys[k];
      else if (effH(k)) keys[k] = effH(k).slice();
      state.keys = keys;
    });
  });
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);

  function refresh() {
    const n = state.points.length, k = state.k, tracked = hasTrack();
    let hint = '';
    if (state.tracking) hint = 'Suivi en cours : arrêtez (■) dès que la zone verte décroche, ce qui est déjà tracké est gardé.';
    else if (!state.cur) hint = '';
    else if (state.scrubbing && !tracked) hint = 'Relâchez sur une image nette où la surface est bien visible : elle devient la référence.';
    else if (k !== state.ref && tracked && !shapeAt(k)) hint = 'Image non trackée : trackez jusqu\'ici depuis une image trackée.';
    else if (k !== state.ref && tracked) hint = state.keys[k] ? 'Clé : la forme est imposée ici ; le suivi est corrigé progressivement jusqu\'aux clés voisines. Retracker depuis ici s\'arrête à la clé suivante.'
      : 'Glissez un point ou un côté pour corriger cette image : ça pose une clé (◆). Rotation : sur l\'image de référence (repère jaune).';
    else if (state.tool === 'rect') {
      hint = n < 4 ? `Cliquez les 4 coins (${n}/4). Arrondi à fond = disque.`
        : isDisc() ? 'Disque : ajustez les coins pour que le cercle épouse le bord.'
          : anyRound() ? 'Placez les coins là où les bords droits se rejoindraient (pointillés).'
            : 'Prêt à tracker.';
      if (n === 4) hint += ' Cliquez un coin pour l\'arrondir seul, glissez un côté pour le déplacer, les anneaux pour tourner la surface.';
    } else {
      hint = n < 3 ? `Cliquez le contour d'une zone plane (${n}/3 min.).`
        : state.orientManual ? 'Grille alignée à la main : elle sera utilisée telle quelle.'
          : 'Orientation déduite du mouvement. Pour l\'imposer, glissez les anneaux jusqu\'à aligner la grille sur la scène.';
    }
    $('hint').textContent = hint;
    const rv = state.selCorner >= 0 ? state.round[state.selCorner] : Math.max(...state.round);
    $('round-val').textContent = isDisc() ? 'disque' : (state.selCorner >= 0 ? ['HG', 'HD', 'BD', 'BG'][state.selCorner] + ' ' : '') + `${rv} %`;
    $('round-wrap').classList.toggle('hidden', state.tool !== 'rect');
    $('btn-flip').classList.toggle('hidden', !isDisc());
    $('btn-flip').classList.toggle('on', state.flip);
    $('orient-wrap').classList.toggle('hidden', !(state.tool === 'free' && state.orientManual));
    $('btn-undo').disabled = !state.undo.length || !!state.tracking;
    $('btn-redo').disabled = !state.redo.length || !!state.tracking;
    $('btn-clear-track').disabled = !tracked;
    $('btn-key').disabled = !!state.tracking || k === state.ref || !tracked || !effH(k);
    $('btn-key').classList.toggle('keyon', !!state.keys[k] || k === state.ref);
    $('btn-key').title = k === state.ref ? 'Image de référence (clé d\'origine)' : state.keys[k] ? 'Retirer la clé de cette image'
      : 'Poser une clé : fige la forme affichée sur cette image';
    $('toolbar').classList.toggle('disabled', !!state.tracking);

    // suivi : possible depuis la référence ou une image déjà trackée
    const canStart = ready() && !!state.eng && !state.tracking && !!effH(k);
    document.querySelectorAll('.trk').forEach((b) => {
      const running = state.tracking && state.tracking.btn === b;
      b.classList.toggle('running', !!running);
      b.disabled = state.tracking ? !running : !canStart;
      if (!b.dataset.icon) b.dataset.icon = b.innerHTML;
      const mode = running ? 'stop' : 'go';
      if (b.dataset.mode !== mode) {
        b.dataset.mode = mode;
        b.innerHTML = running ? '<svg class="solid" viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>' : b.dataset.icon;
        b.title = running ? 'Arrêter le suivi (les images déjà trackées sont gardées)' : b.dataset.title || b.title;
      }
      if (!b.dataset.title) b.dataset.title = b.title;
    });
    $('btn-play').disabled = !state.n || !!state.tracking;
    $('play-path').setAttribute('d', state.playTimer ? 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z' : 'M7 5l12 7-12 7z');
    if (state.shot) {
      $('frame-label').textContent = `${state.shot.seqStart + k}` + (k === state.ref ? ' · réf' : '');
    }
    const badge = state.tracking ? `Suivi… image ${state.shot.seqStart + k}`
      : state.curThumbMissing ? 'Vignettes en préparation…'
        : (tracked && !shapeAt(k)) ? 'Non trackée' : '';
    $('badge').textContent = badge;
    $('badge').classList.toggle('hidden', !badge);
    enable('s-result', !!state.pose && !!state.pose.ae && !state.tracking);
    $('btn-apply').disabled = !(state.pose && state.pose.ae && state.pose.rev === state.rev) || state.solving || !!state.tracking;
    draw();
  }

  // ------------------------------------------------------------------ timeline
  const tl = $('timeline');
  const tctx = tl.getContext('2d');
  const TL_PAD = 8;

  function tlX(k, w) { const p = TL_PAD * DPR(); return p + (state.n > 1 ? k / (state.n - 1) : 0.5) * (w - 2 * p); }

  function drawTimeline() {
    const dpr = DPR(), w = Math.round(tl.clientWidth * dpr), h = Math.round(tl.clientHeight * dpr);
    if (tl.width !== w || tl.height !== h) { tl.width = w; tl.height = h; }
    tctx.clearRect(0, 0, w, h);
    if (!state.n || !state.shot) return;
    const p = TL_PAD * dpr, cw = Math.max(1, (w - 2 * p) / Math.max(1, state.n - 1));
    tctx.fillStyle = '#1b1b1b';
    tctx.fillRect(0, 0, w, h);
    // vignettes prêtes (bande grise en bas)
    tctx.fillStyle = '#4a4a4a';
    const src = state.shot.frames;
    for (let k = 0; k < state.n; k++) if (state.loaded.has(src[k])) tctx.fillRect(tlX(k, w) - cw / 2, h - 4 * dpr, cw + 0.5, 3 * dpr);
    // images trackées (couleur selon la confiance)
    const y0 = 9 * dpr, y1 = h - 9 * dpr;
    new Set(Object.keys(state.Hs).concat(Object.keys(state.keys))).forEach((key) => {
      const k = +key, c = state.conf[k] === undefined ? 1 : state.conf[k];
      tctx.fillStyle = c >= 0.8 ? '#3ce07a' : c >= 0.6 ? '#e0a43a' : '#e0574f';
      tctx.fillRect(tlX(k, w) - cw / 2, y0, cw + 0.5, y1 - y0);
    });
    // référence (triangle) et clés (losanges)
    const xr = tlX(state.ref, w);
    tctx.fillStyle = '#f0c040';
    tctx.beginPath(); tctx.moveTo(xr - 5 * dpr, 0); tctx.lineTo(xr + 5 * dpr, 0); tctx.lineTo(xr, 7 * dpr); tctx.fill();
    Object.keys(state.keys).forEach((key) => {
      const xk = tlX(+key, w), yk = h / 2, r = 5 * dpr;
      tctx.beginPath(); tctx.moveTo(xk, yk - r); tctx.lineTo(xk + r, yk); tctx.lineTo(xk, yk + r); tctx.lineTo(xk - r, yk); tctx.closePath();
      tctx.fillStyle = '#f0c040'; tctx.fill();
      tctx.strokeStyle = '#000'; tctx.lineWidth = 1 * dpr; tctx.stroke();
    });
    // tête de lecture
    const xk = tlX(state.k, w);
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(xk - 1 * dpr, 0, 2 * dpr, h);
  }

  function tlFrame(ev) {
    const r = tl.getBoundingClientRect(), x = ev.clientX - r.left;
    const u = (x - TL_PAD) / Math.max(1, r.width - 2 * TL_PAD);
    return Math.max(0, Math.min(state.n - 1, Math.round(u * (state.n - 1))));
  }

  tl.addEventListener('mousedown', (ev) => {
    if (!state.n || state.tracking) return;
    stopPlay();
    state.scrubbing = true;
    showFrame(tlFrame(ev), { fast: true });
    const move = (e) => showFrame(tlFrame(e), { fast: true });
    const up = (e) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      state.scrubbing = false;
      goTo(tlFrame(e), true);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  /** Aller à l'image k. commit : avant tout suivi, elle devient la référence. */
  function goTo(k, commit) {
    if (commit && !hasTrack() && k !== state.ref) act(() => { state.ref = k; state.Hs = {}; state.conf = {}; });
    showFrame(k);
    if (commit) syncAE(k);
  }

  let syncTimer = null;
  function syncAE(k) { // l'instant d'AE suit le panneau (hors lecture)
    if (!inCEP || state.playTimer || !state.shot) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => host('stGoToFrame', state.shot.compId, state.shot.seqStart + k), 120);
  }

  function stopPlay() {
    if (!state.playTimer) return;
    clearInterval(state.playTimer);
    state.playTimer = null;
    refresh();
  }
  $('btn-play').addEventListener('click', () => {
    if (state.playTimer) { stopPlay(); goTo(state.k, true); return; }
    const fps = Math.min(30, (state.shot && state.shot.compFps) || 25);
    state.playTimer = setInterval(() => showFrame(state.k >= state.n - 1 ? 0 : state.k + 1, { fast: true }), 1000 / fps);
    refresh();
  });

  // ------------------------------------------------------------------ suivi
  /** Suivi depuis l'image affichée : une image, ou jusqu'à la clé suivante (ou au bout) ;
   *  « avant + arrière » : vers l'avant puis vers l'arrière depuis la même image. */
  async function trackRun(btn) {
    if (state.tracking) { state.tracking.cancel = true; state.eng.stop(); return; }  // le bouton en cours sert d'arrêt
    const dir = +btn.dataset.dir, one = btn.dataset.count === '1', k0 = state.k;
    const H0 = effH(k0);
    if (!ready() || !state.eng || !H0) return;
    stopPlay();
    beginAction();
    // nouveaux objets : l'historique garde les anciens ; l'image de départ est prise telle qu'affichée
    state.Hs = Object.assign({}, state.Hs, { [state.ref]: I3, [k0]: H0 });
    state.conf = Object.assign({}, state.conf, { [state.ref]: 1 });
    state.tracking = { btn, cancel: false };
    refresh();
    const pts = state.tool === 'rect' ? orderRect(state.points) : state.points;
    try {
      for (const d of dir === 0 ? [1, -1] : [dir]) {
        if (state.tracking.cancel) break;
        const kn = nextKey(k0, d);
        const count = one ? 1 : kn === null ? 0 : Math.abs(kn - k0);  // jusqu'à la clé suivante, incluse
        if (dir === 0 && state.k !== k0) showFrame(k0, { fast: true });
        const r = await state.eng.send({
          cmd: 'track', k: k0, dir: d, count, ref: state.ref, H: H0, Hprev: effH(k0 - d) || null,
          tool: state.tool, points: pts, roundness: radii(),
        });
        if (r.reason === 'lost') {
          toast(`Suivi perdu à l'image ${state.shot.seqStart + r.last + d} : corrigez la forme (clé) ou reprenez depuis une autre image.`, 5000);
          break;
        }
        if (r.reason === 'stop') break;
      }
    } catch (e) {
      toast(e.message);
    } finally {
      state.tracking = null;
      state.rev++;
      endAction();
      showFrame(state.k);
      syncAE(state.k);
    }
  }
  document.querySelectorAll('.trk').forEach((b) => b.addEventListener('click', () => trackRun(b)));

  // ------------------------------------------------------------------ 3D
  let solveTimer = null;
  function scheduleSolve() {
    clearTimeout(solveTimer);
    if (!hasTrack()) { state.pose = null; showSummary(); return; }
    solveTimer = setTimeout(runSolve, 350);
  }

  async function runSolve() {
    if (state.tracking || state.drag || !state.eng || !ready() || !hasTrack()) return;
    if (state.solving) { scheduleSolve(); return; }
    const rev = state.rev;
    const pts = state.tool === 'rect' ? orderRect(state.points) : state.points;
    const normal = chosenNormal();
    const focal = parseFloat($('in-focal').value);
    state.solving = true;
    refresh();
    try {
      const r = await state.eng.send({
        cmd: 'solve', Hs: usedHs(), conf: state.conf, ref: state.ref, tool: state.tool, points: pts,
        roundness: radii(), normal, focal_mm: focal > 0 ? focal : null,
        out: inCEP ? path.join(state.workDir, `apply_${rev}.jsx`) : '',
        name: state.shot.footageName.replace(/\.[^.]+$/, ''),
      });
      if (rev === state.rev) { state.pose = Object.assign(r, { rev }); showSummary(); }
    } catch (e) {
      toast(e.message);
    } finally {
      state.solving = false;
      if (rev !== state.rev) scheduleSolve();
      refresh();
    }
  }

  /** Homographies de toutes les images trackées, corrigées par les clés. */
  function usedHs() {
    const out = {};
    new Set(Object.keys(state.Hs).concat(Object.keys(state.keys))).forEach((key) => { const H = effH(+key); if (H) out[key] = H; });
    out[state.ref] = I3;
    return out;
  }

  function showSummary() {
    const ul = $('summary');
    ul.innerHTML = '';
    const r = state.pose;
    if (!r) return;
    const add = (cls, txt) => { const li = document.createElement('li'); li.className = cls; li.textContent = txt; ul.appendChild(li); };
    const keys = Object.keys(usedHs()).map(Number).sort((a, b) => a - b);
    const off = state.shot.seqStart, nk = Object.keys(state.keys).length;
    add('ok', `${keys.length}/${state.n} images trackées (${off + keys[0]}–${off + keys[keys.length - 1]})` +
      (nk ? `, ${nk} clé${nk > 1 ? 's' : ''} de correction` : ''));
    if (!/métadonnées|saisie/.test(r.focal_source)) add('warn', `Focale : ${r.focal_source}`);
    if (r.error_mean !== null && r.error_mean !== undefined) {
      add(r.error_mean < 1.5 ? 'ok' : 'warn', `Calage 3D sur la 2D : ${r.error_mean.toFixed(2)} px en moyenne (max ${r.error_max.toFixed(1)})`);
    }
  }

  // ------------------------------------------------------------------ appliquer dans l'effet
  $('btn-apply').addEventListener('click', async () => {
    const r = state.pose;
    if (!r || !r.ae || !inCEP) return;
    $('btn-apply').disabled = true;
    const out = await host('stApplyTracking', state.shot.compId, state.shot.layerIndex, r.ae);
    refresh();
    const box = $('apply-msg');
    box.classList.remove('hidden');
    box.style.color = out.ok ? '' : 'var(--err)';
    box.textContent = out.ok
      ? `Tracking appliqué à l'effet : ${out.frames} images clés. Sélectionnez l'effet pour voir la grille dans la compo ; ` +
        'ses boutons « Créer » ajoutent un null, un solide ou un texte posés sur la surface.'
      : out.msg;
  });

  $('btn-load').addEventListener('click', () => host('stGetSelection').then(loadShot));

  // ------------------------------------------------------------------ démarrage
  if (!inCEP) {
    // aperçu dans un navigateur : moteur simulé, toutes les images = demo.jpg
    $('shot-empty').textContent = 'Mode démo (hors After Effects) : suivi simulé.';
    $('btn-load').disabled = true;
    loadImg('demo.jpg').then((img) => {
      state.W = img.width; state.H = img.height; state.n = 60;
      state.shot = { seqStart: 0, compFps: 25, frames: Array.from({ length: 60 }, (_, i) => i), footageName: 'demo' };
      state.k = state.ref = 20;
      for (let i = 0; i < 60; i++) state.loaded.add(i);
      state.eng = demoEngine(onEngineEvent);
      state.full.set(20, img);
      state.cur = img;
      for (let i = 0; i < 60; i++) state.full.set(i, img);
      enable('s-surface', true);
      fitView();
      refresh();
    }).catch(() => refresh());
  } else {
    heartbeat();
    setInterval(heartbeat, 1000);
    window.addEventListener('beforeunload', () => { if (state.eng) state.eng.close(); });
    refresh();
  }
})();
