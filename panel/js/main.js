/* 3D Surface Tracker — panneau After Effects (CEP).
 *
 * Le calque tracké porte l'effet « 3D Surface Tracker ». Le panneau pilote une session du
 * moteur Python (engine.py session, lignes JSON) : les images sont celles du calque telles
 * qu'elles arrivent à l'effet, calculées par After Effects et envoyées par le pont STBridge.
 * Il parle à After Effects via ExtendScript (jsx/host.jsx).
 *
 * Le panneau garde l'état complet (forme, homographies image par image, clés de correction) :
 * chaque action peut être annulée (⌘Z). Le tracking n'est enregistré qu'en l'appliquant à
 * l'effet ; en rouvrant le tracker, il est reconstruit à partir des données de l'effet. Le
 * moteur ne sert qu'à charger les images, suivre et calculer la pose.
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
  const net = inCEP && nodeRequire && nodeRequire('net');
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
  const CORNERS = ['HG', 'HD', 'BD', 'BG'];

  // ------------------------------------------------------------------ état
  const state = {
    shot: null,          // calque chargé (réponse de stGetLayer)
    eng: null,           // session du moteur
    lensMm: null,        // focale des métadonnées (éq. 35 mm), si présente
    workDir: null,
    W: 0, H: 0, n: 0,    // dimensions de l'image du calque, nombre d'images
    thumbsDir: null,
    loaded: new Set(),   // images dont la vignette est prête
    thumbs: new Map(),   // image -> vignette décodée en mémoire (lecture fluide)
    k: 0,                // image affichée
    ref: 0,              // image de référence (celle où la forme est définie)
    // --- état annulable
    points: [],          // 4 coins, en pixels de l'image, sur l'image de référence
    round: [0, 0, 0, 0], // arrondi des coins HG, HD, BD, BG, 0..100 (tous à 100 = disque)
    flip: false,         // disque : autre inclinaison
    mode2d: false,       // 2D : surface face à la caméra
    Hs: {},              // k -> homographie référence -> image k trouvée par le suivi (9 nombres)
    keys: {},            // k -> homographie fixée à la main sur cette image (clé de correction)
    conf: {},            // k -> confiance du suivi
    // --- outils
    xform: 'move',       // gizmo : 'move' | 'rotate' | 'scale'
    space: 'local',      // axes du gizmo : 'local' (suit la surface) | 'world' (face à la caméra)
    // ---
    rev: 0,              // incrémenté à chaque modification (invalide la pose)
    pose: null,          // dernière pose calculée {rev, poses, size, kind, ae, ...}
    solving: false,
    full: new Map(),     // k -> image pleine résolution (quelques-unes en cache)
    cur: null,           // image affichée
    curThumbMissing: false,
    view: null,          // {s, ox, oy, fit} en pixels canvas
    drag: null,
    hover: null,         // élément sous la souris (point, poignée, côté…)
    spaceKey: false,
    tracking: null,      // {btn, cancel}
    playTimer: null,
    playDir: 1,          // sens de la lecture (aller-retour)
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

  function remember(key, value) { try { localStorage.setItem('st.' + key, value); } catch (e) { /* indisponible */ } }
  function recall(key, dflt) { try { const v = localStorage.getItem('st.' + key); return v === null ? dflt : v; } catch (e) { return dflt; } }

  // ------------------------------------------------------------------ After Effects
  function host(fn, ...args) {
    if (!inCEP) return Promise.resolve({ ok: false, msg: 'Hors d\'After Effects.' });
    // l'exception ExtendScript est renvoyée telle quelle (sinon CEP ne dit que « EvalScript error. »)
    const call = `try{${fn}(${args.map((a) => JSON.stringify(a)).join(',')})}catch(e){` +
      `stFail(e.toString()+" (${fn}, ligne "+e.line+")")}`;
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
  function startEngine(seqPath, thumbsDir, onEvent) {
    if (!fs.existsSync(PY)) {
      throw new Error("Environnement Python introuvable :\n" + PY +
        "\n\nDans le Terminal, depuis le dossier du projet :\n/usr/bin/python3 -m venv .venv && .venv/bin/pip install -r requirements.txt");
    }
    const child = cp.spawn(PY, [ENGINE, 'session', seqPath, thumbsDir], { cwd: ROOT, env: pythonEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
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
    eng.send = (cmd) => new Promise((resolve, reject) => {
      if (eng.dead) { reject(new Error('Le moteur est arrêté : rechargez le calque.')); return; }
      const id = eng.nextId++;
      eng.waiters.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify(Object.assign({ id }, cmd)) + '\n');
    });
    eng.stop = () => { if (!eng.dead) child.stdin.write('{"cmd":"stop"}\n'); };
    eng.close = () => { eng.closing = true; try { child.stdin.end(); } catch (e) { /* déjà fermé */ } setTimeout(() => child.kill(), 1500); };
    return eng;
  }

  /** Moteur simulé (mode démo dans un navigateur) : suivi = léger glissement, pas de pose. */
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
      ev.got.forEach((k) => { state.loaded.add(k); cacheThumb(k); });
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

  /** Le pont After Effects (plug-in STBridge) répond-il ? */
  function bridgeAvailable() {
    return new Promise((resolve) => {
      const sock = net.createConnection(path.join(APPDIR, 'bridge.sock'));
      const done = (ok) => { try { sock.destroy(); } catch (e) { /* déjà fermé */ } resolve(ok); };
      sock.setTimeout(2000, () => done(false));
      sock.on('error', () => done(false));
      sock.on('connect', () => sock.write('PING\n'));
      sock.on('data', (d) => done(String(d).indexOf('OK') === 0));
    });
  }

  // ------------------------------------------------------------------ calque à tracker
  /** Demandes du bouton « Ouvrir le tracker » de l'effet + signal de vie (il ne rouvre pas un panneau ouvert). */
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
      points: [], round: [0, 0, 0, 0], flip: false, mode2d: false, Hs: {}, keys: {}, conf: {}, pose: null,
      undo: [], redo: [], full: new Map(), cur: null, loaded: new Set(), thumbs: new Map(),
    });
    state.rev++;
    $('in-focal').value = '';
    syncControls();
  }

  /** Calque sans l'effet : le panneau propose de l'ajouter (il porte le tracking dans le projet). */
  function showNeedEffect(sel) {
    if (state.eng) { state.eng.close(); state.eng = null; }
    resetEdit();
    state.shot = null;
    state.n = 0;
    enable('s-surface', true);
    $('shot-empty').classList.add('hidden');
    $('shot-info').classList.remove('hidden');
    $('shot-info').innerHTML = `<div class="line"><b>${escapeHtml(sel.layerName)}</b></div>`;
    $('details-shot').textContent = `Compo « ${sel.compName} ».`;
    $('shot-warnings').innerHTML = '';
    $('btn-details').classList.remove('warn');
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
    state.n = sel.times.length;
    state.k = state.ref = sel.cur;
    const stem = String(sel.layerName).replace(/[\/:]/g, '_').slice(0, 40);
    state.workDir = path.join(ROOT, 'out', 'panel', `${stem}_${stamp()}`);
    state.thumbsDir = path.join(state.workDir, 'thumbs');

    $('shot-empty').classList.add('hidden');
    $('shot-info').classList.remove('hidden');
    $('shot-info').innerHTML =
      `<div class="line"><b>${escapeHtml(sel.layerName)}</b> <span class="dim">· images ${sel.seqStart}–${sel.seqStart + state.n - 1}</span></div>`;
    $('details-shot').textContent = `Compo « ${sel.compName} » · ${state.n} images (${sel.seqStart}–${sel.seqStart + state.n - 1}), ` +
      'telles qu\'elles arrivent à l\'effet (avec les effets placés au-dessus).';
    const w = $('shot-warnings');
    w.innerHTML = '';
    const note = (m, cls) => { const li = document.createElement('li'); li.textContent = m; if (cls) li.className = cls; w.appendChild(li); };
    sel.warnings.forEach((m) => note(m));
    if (sel.retimed) note('Remappage temporel ou étirement pris en compte : le suivi porte sur les images telles que la compo les montre.', 'note');
    $('btn-details').classList.toggle('warn', sel.warnings.length > 0);  // avertissement à lire dans « Détails »
    $('summary').innerHTML = '';
    $('log').textContent = '';

    try {
      if (!(await bridgeAvailable())) {
        throw new Error('Pont After Effects absent : installez les plug-ins (native/build.sh --install) puis redémarrez After Effects.');
      }
      // tracking déjà appliqué : ses images sont chargées en premier (référence, puis la plage trackée)
      const rt = await host('stReadTracking', sel.compId, sel.layerIndex);
      const saved = rt.ok ? rt.data : null;
      let first = sel.cur, priority = null;
      if (saved && saved.frames.length) {
        const ks = saved.frames.map((row) => row[0] - sel.seqStart).filter((k) => k >= 0 && k < state.n);
        if (ks.length) {
          priority = [Math.min(...ks), Math.max(...ks)];
          first = ks.indexOf(saved.ref - sel.seqStart) >= 0 ? saved.ref - sel.seqStart : ks[0];
          state.k = state.ref = first;
        }
      }
      fs.mkdirSync(state.workDir, { recursive: true });
      const seq = path.join(state.workDir, 'seq.json');
      fs.writeFileSync(seq, JSON.stringify({
        times: sel.times, fps: sel.compFps, start: sel.seqStart, first, priority, width: sel.width, height: sel.height,
        layer: { comp: sel.compId, layer: sel.layerIndex, effect: sel.effectIndex },
        lens_src: sel.lensFile || null, lens_frames: sel.lensFrames || null, focal_scale: sel.focalScale || 1,
      }));
      const ready = new Promise((resolve) => {
        state.eng = startEngine(seq, state.thumbsDir, (ev) => { if (ev.type === 'ready') resolve(ev); else onEngineEvent(ev); });
      });
      const info = await ready;
      state.W = info.width;
      state.H = info.height;
      state.lensMm = info.lens ? info.lens.focal35_mm : null;
      $('focal-wrap').classList.toggle('hidden', !!state.lensMm);
      enable('s-surface', true);
      if (saved) restoreFromEffect(saved);
      await loadFull(state.k);
      fitView();
    } catch (e) {
      toast(e.message, 12000);
    } finally {
      refresh();
    }
  }

  // ------------------------------------------------------------------ tracking déjà appliqué
  /** Rouvre le tracking enregistré dans l'effet : la pose de chaque image clé redonne les coins
   *  de la surface, donc son suivi (homographie depuis l'image de référence). */
  function restoreFromEffect(d) {
    const off = state.shot.seqStart, W = state.W, H = state.H, [w, h] = d.size;
    const corners = ([, px, py, pz, ox, oy, oz, zoom]) => {
      const R = eulerXYZ(ox, oy, oz), t = [px - W / 2, py - H / 2, pz + d.dist];
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
        const p = [a * w / 2, b * h / 2, 0];
        const X = [0, 1, 2].map((i) => R[3 * i] * p[0] + R[3 * i + 1] * p[1] + t[i]);
        return [W / 2 + zoom * X[0] / X[2], H / 2 + zoom * X[1] / X[2]];
      });
    };
    const rows = d.frames.filter((row) => row[0] - off >= 0 && row[0] - off < state.n);
    if (!rows.length) return;
    const refRow = rows.find((row) => row[0] === d.ref) || rows[0];
    // coins enregistrés (suivi corrigé par les clés) à chaque image
    const ref = refRow[0] - off, refC = corners(refRow), eff = {};
    rows.forEach((row) => { eff[row[0] - off] = corners(row); });
    // clés et leur correction (décalage des 4 coins) ; la référence n'a pas de correction
    const delta = { [ref]: [[0, 0], [0, 0], [0, 0], [0, 0]] };
    (d.keys || []).forEach((f, i) => {
      const k = f - off, c = (d.keyDeltas || [])[i];
      if (k !== ref && eff[k] && c) delta[k] = [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]];
    });
    const keyKs = Object.keys(delta).map(Number).sort((a, b) => a - b);
    // suivi brut = suivi corrigé moins la correction, répartie entre clés voisines comme dans effH
    const Hs = {}, conf = {}, keys = {};
    Object.keys(eff).map(Number).forEach((k) => {
      let kp = null, kn = null;
      keyKs.forEach((kk) => { if (kk <= k) kp = kk; else if (kn === null) kn = kk; });
      const w = kp !== null && kn !== null ? (k - kp) / (kn - kp) : kp !== null ? 0 : 1;
      const raw = eff[k].map((p, i) => {
        let dx = 0, dy = 0;
        if (kp !== null) { dx += (1 - w) * delta[kp][i][0]; dy += (1 - w) * delta[kp][i][1]; }
        if (kn !== null) { dx += w * delta[kn][i][0]; dy += w * delta[kn][i][1]; }
        return [p[0] - dx, p[1] - dy];
      });
      const Hk = fitH(refC, raw);
      if (Hk) { Hs[k] = Hk; conf[k] = 1; }
      if (k !== ref && delta[k]) keys[k] = fitH(refC, eff[k]);
    });
    Object.assign(state, {
      points: refC, round: d.disc ? [100, 100, 100, 100] : d.round.map((x) => Math.round(x)), flip: false,
      mode2d: d.mode2d, ref, Hs, conf, keys,
    });
    state.k = state.ref;
    if (!state.lensMm) $('in-focal').value = (refRow[7] / Math.max(W, H) * 36).toFixed(1);  // focale saisie à l'époque
    syncControls();
    changed();
    log(`Tracking de l'effet repris : ${rows.length} images.`);
  }

  /** Orientation AE (degrés, R = Rx · Ry · Rz) -> matrice 3x3 à plat. */
  function eulerXYZ(ax, ay, az) {
    const r = Math.PI / 180, [a, b, c] = [ax * r, ay * r, az * r];
    const Rx = [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
    const Ry = [Math.cos(b), 0, Math.sin(b), 0, 1, 0, -Math.sin(b), 0, Math.cos(b)];
    const Rz = [Math.cos(c), -Math.sin(c), 0, Math.sin(c), Math.cos(c), 0, 0, 0, 1];
    const mul = (A, B) => { const o = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o.push(A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]); return o; };
    return mul(mul(Rx, Ry), Rz);
  }

  // ------------------------------------------------------------------ images
  /** Vignette d'une image, décodée une fois et gardée en mémoire (lecture fluide). */
  function cacheThumb(k) {
    if (!inCEP || state.thumbs.has(k)) return;
    state.thumbs.set(k, null);  // en cours
    const dir = state.thumbsDir;
    loadImg(fileUrl(path.join(dir, pad5(k) + '.jpg'))).then((img) => {
      if (dir !== state.thumbsDir) return;  // un autre calque a été chargé entre-temps
      const keep = (bmp) => {
        state.thumbs.set(k, bmp);
        if (state.k === k && !state.full.has(k)) {
          state.cur = bmp;
          if (state.curThumbMissing) { state.curThumbMissing = false; refresh(); } else draw();
        }
      };
      if (window.createImageBitmap) createImageBitmap(img).then(keep).catch(() => keep(img)); else keep(img);
    }).catch(() => state.thumbs.delete(k));
  }

  /** Image pleine résolution de l'image k (cache de quelques images). */
  async function loadFull(k) {
    if (state.full.has(k)) return state.full.get(k);
    let img;
    if (!inCEP) img = await loadImg('demo.jpg');
    else {
      const r = await state.eng.send({ cmd: 'frame', k, out: path.join(state.workDir, 'frames', pad5(k) + '.jpg') });
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
      const t = state.thumbs.get(k);
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
  const flat = (H) => [H[0][0], H[0][1], H[0][2], H[1][0], H[1][1], H[1][2], H[2][0], H[2][1], H[2][2]];
  function mul9(a, b) {
    const o = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o.push(a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]);
    return o.map((x) => x / o[8]);
  }
  /** Homographie qui envoie les 4 points src sur les 4 points dst (même ordre). */
  function fitH(src, dst) {
    const A = squareHomography(src), B = squareHomography(dst);
    return A && B ? mul9(flat(B), inv9(flat(A))) : null;
  }

  /** Contour du rectangle arrondi dans le carré unité (même construction que le moteur et l'effet) ;
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
  const isDisc = () => state.round.every((r) => r >= 100);

  /** Coins d'un quadrilatère dans l'ordre haut-gauche, haut-droit, bas-droit, bas-gauche. */
  function orderRect(pts) {
    if (pts.length !== 4) return pts;
    const cx = pts.reduce((a, p) => a + p[0], 0) / 4, cy = pts.reduce((a, p) => a + p[1], 0) / 4;
    const s = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let k = 0;
    s.forEach((p, i) => { if (p[0] + p[1] < s[k][0] + s[k][1]) k = i; });
    return s.slice(k).concat(s.slice(0, k));
  }
  /** Indices des points dans l'ordre HG, HD, BD, BG. */
  function orderIdx(pts) {
    if (pts.length !== 4) return pts.map((_, i) => i);
    return orderRect(pts).map((p) => pts.indexOf(p));
  }

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => scale(a, 1 / len(a));

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

  function rotate(v, axis, ang) { // rotation de Rodrigues autour d'un axe unitaire
    const c = Math.cos(ang), s = Math.sin(ang), k = dot(axis, v);
    return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, k * (1 - c)));
  }

  // ---- modèle 3D de la surface déduit de ses 4 coins à l'image : X(a, b) = C + a·eu + b·ev, a, b dans [-½, ½]
  /** 3D : le rectangle dont le quadrilatère est l'image en perspective (angles droits en 3D). */
  function rectModel(c) {
    const H = squareHomography(c);
    if (!H) return null;
    const f = focalPx(), cx = state.W / 2, cy = state.H / 2;
    const col = (j) => [(H[0][j] - cx * H[2][j]) / f, (H[1][j] - cy * H[2][j]) / f, H[2][j]];
    const eu = col(0), ev = col(1);
    return { C: add(add(scale(eu, 0.5), scale(ev, 0.5)), col(2)), eu, ev };
  }
  /** 2D : rectangle face à la caméra ajusté au quadrilatère (centre, angle, largeur, hauteur). */
  function simModel(c) {
    const [hg, hd, bd, bg] = c, d2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const top = [hd[0] - hg[0], hd[1] - hg[1]], bot = [bd[0] - bg[0], bd[1] - bg[1]];
    const lt = Math.hypot(...top) || 1, lb = Math.hypot(...bot) || 1;
    const ang = Math.atan2(top[1] / lt + bot[1] / lb, top[0] / lt + bot[0] / lb);
    const w = (lt + lb) / 2, h = (d2(hg, bg) + d2(hd, bd)) / 2, f = focalPx();
    const cx = (hg[0] + hd[0] + bd[0] + bg[0]) / 4, cy = (hg[1] + hd[1] + bd[1] + bg[1]) / 4;
    const co = Math.cos(ang), si = Math.sin(ang);
    return { C: [cx - state.W / 2, cy - state.H / 2, f], eu: [w * co, w * si, 0], ev: [-h * si, h * co, 0] };
  }
  function modelOf(shown) {
    if (!shown || shown.length !== 4) return null;
    const c = orderRect(shown);
    return state.mode2d ? simModel(c) : rectModel(c);
  }
  /** Coins de l'image du modèle, HG, HD, BD, BG. */
  function cornersOf(m) {
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => project(add(m.C, add(scale(m.eu, a / 2), scale(m.ev, b / 2)))));
  }
  /** Repère de la surface : x le long de la largeur, n normale vers l'arrière-plan, y = n × x. */
  function axesOf(m) {
    const x = norm(m.eu);
    let n = norm(cross(m.eu, m.ev));
    if (dot(n, m.C) < 0) n = scale(n, -1);
    return { x, y: cross(n, x), n };
  }
  /** Normale transmise au moteur : tranche entre les 2 inclinaisons possibles d'un disque. */
  function chosenNormal() {
    if (state.mode2d || !isDisc() || !ready()) return null;
    const m = modelOf(state.points);
    if (!m) return null;
    let n = axesOf(m).n;
    if (state.flip) { const d = norm(m.C); n = norm(add(scale(d, 2 * dot(n, d)), scale(n, -1))); }
    return n;
  }

  const ready = () => state.points.length === 4;
  const hasTrack = () => Object.keys(state.Hs).some((k) => +k !== state.ref) || Object.keys(state.keys).length > 0;

  // ---- clés de correction : sur une image corrigée à la main, la forme est imposée ; entre
  // deux clés, l'écart entre le suivi et les clés est réparti progressivement (comme Mocha).
  const keyH = (k) => (k === state.ref ? I3 : state.keys[k]);
  const keyFrames = () => [state.ref].concat(Object.keys(state.keys).map(Number)).sort((a, b) => a - b);
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
      const Q = orderRect(state.points);
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
  /** Correction d'une clé : décalage de ses 4 coins (HG, HD, BD, BG) par rapport au suivi brut, à plat. */
  function keyDelta(k) {
    if (k === state.ref || !state.Hs[k]) return [0, 0, 0, 0, 0, 0, 0, 0];
    return [].concat(...orderRect(state.points).map((p) => {
      const a = warp9(keyH(k), p), b = warp9(state.Hs[k], p);
      return [a[0] - b[0], a[1] - b[1]];
    }));
  }
  /** Prochaine clé après k dans le sens d (null s'il n'y en a pas). */
  function nextKey(k, d) {
    const ks = keyFrames().filter((kk) => (d > 0 ? kk > k : kk < k));
    return ks.length ? (d > 0 ? ks[0] : ks[ks.length - 1]) : null;
  }

  /** Forme à l'image k : sur la référence telle quelle, ailleurs transportée par le suivi (null si non trackée). */
  function shapeAt(k) {
    if (k === state.ref || !hasTrack()) return state.points;
    const h = effH(k);
    return h ? state.points.map((p) => warp9(h, p)) : null;
  }
  const editable = () => !state.tracking && !!shapeAt(state.k);
  /** Sur la référence (ou avant tout suivi) on modifie la forme ; ailleurs, on pose une clé. */
  const onRef = () => state.k === state.ref || !hasTrack();
  /** Applique la forme affichée modifiée : sur la référence, la forme ; ailleurs, une clé. */
  function setShapeAt(shown) {
    if (onRef()) { state.points = shown.map((p) => p.slice()); return; }
    const H = fitH(state.points, shown);
    if (H) state.keys[state.k] = H;
  }
  /** Remplace la forme affichée par les coins d'un modèle (gizmo). */
  function applyModel(m, base) {
    const idx = orderIdx(base), c = cornersOf(m), shown = base.map((p) => p.slice());
    idx.forEach((i, j) => { shown[i] = c[j]; });
    setShapeAt(shown);
  }

  // ------------------------------------------------------------------ annuler / rétablir
  function snapshot() {
    return {
      points: state.points.map((p) => p.slice()), round: state.round.slice(), flip: state.flip, mode2d: state.mode2d,
      ref: state.ref, Hs: state.Hs, keys: state.keys, conf: state.conf, focal: $('in-focal').value, rev: state.rev,
    };
  }
  function sameSnap(a, b) {
    const light = (s) => JSON.stringify([s.points, s.round, s.flip, s.mode2d, s.ref, s.focal, s.keys]);
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
    if (sameSnap(before, snapshot())) {  // rien de changé : la pose reste valable
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
      points: s.points.map((p) => p.slice()), round: s.round.slice(), flip: s.flip, mode2d: s.mode2d,
      ref: s.ref, Hs: s.Hs, keys: s.keys, conf: s.conf,
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

  /** Une modification a eu lieu : la pose est à recalculer. */
  function changed() {
    state.rev++;
    scheduleSolve();
  }

  function syncControls() {
    document.querySelectorAll('[data-dim]').forEach((b) => b.classList.toggle('on', (b.dataset.dim === '2d') === state.mode2d));
    document.querySelectorAll('[data-xform]').forEach((b) => b.classList.toggle('on', b.dataset.xform === state.xform));
    document.querySelectorAll('[data-space]').forEach((b) => b.classList.toggle('on', b.dataset.space === state.space));
  }

  // ------------------------------------------------------------------ vue
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
  const S3 = (X) => toScreen(project(X));  // point 3D -> écran

  function canvasXY(ev) {
    const r = canvas.getBoundingClientRect();
    const k = canvas.width / r.width;
    return [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k];
  }

  function polyPath(pts, close) {
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = toScreen(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    if (close) ctx.closePath();
  }
  function screenPath(pts, close) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    if (close) ctx.closePath();
  }
  /** Distance d'un point à un segment, en pixels écran, et position le long du segment (0..1). */
  function segDist(x, y, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
    return [Math.hypot(a[0] + u * dx - x, a[1] + u * dy - y), u];
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
    ctx.drawImage(img, v.ox, v.oy, state.W * v.s, state.H * v.s);  // vignettes : même cadre que l'image
    drawShape();
  }

  // ------------------------------------------------------------------ forme
  /** Contour 0..1 qui découpe la grille (arrondis, disque), ou null pour le rectangle simple. */
  function unitOutline() {
    if (isDisc()) return Array.from({ length: 48 }, (_, i) => { const a = i / 48 * 2 * Math.PI; return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]; });
    return anyRound() ? roundedUnit(radii(), 8) : null;
  }

  function drawShape() {
    const dpr = DPR(), pts = shapeAt(state.k);
    if (!pts) return;
    const ok = ready(), rect = ok ? orderRect(pts) : null;
    if (ok) {
      const H = squareHomography(rect);
      const outline = H && anyRound() ? roundedUnit(radii()).map(([u, v]) => warp(H, u, v)) : rect;
      if (anyRound()) { // rectangle « pointu » en pointillés
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        polyPath(rect, true);
        ctx.lineWidth = 1 * dpr;
        ctx.strokeStyle = 'rgba(240, 192, 64, 0.6)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      polyPath(outline, true);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#3ce07a';
      ctx.stroke();
      ctx.fillStyle = 'rgba(60, 224, 122, 0.08)';
      ctx.fill();
      drawSurface3D(pts);
    } else if (pts.length > 1) {
      polyPath(pts, false);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#f0c040';
      ctx.stroke();
    }
    if (state.tracking) return;
    const hv = state.hover || {};
    if (hv.kind === 'edge' && !state.drag) { // côté sous la souris : se déplace d'un bloc
      polyPath([pts[hv.i], pts[hv.j]]);
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.stroke();
    }
    if (ok && editable()) { drawGizmo(); drawRoundHandles(pts); }
    pts.forEach((p, i) => {
      const [x, y] = toScreen(p), hot = hv.kind === 'point' && hv.i === i;
      ctx.beginPath();
      ctx.arc(x, y, (hot ? 6.5 : 5) * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = hot ? '#ffffff' : '#3ce07a';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
      if (rect) {
        ctx.font = `${11 * dpr}px -apple-system, sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.fillText(CORNERS[rect.indexOf(p)], x + 8 * dpr, y - 8 * dpr);
      }
    });
    if (state.drag && state.drag.kind === 'point') drawLoupe(pts[state.drag.i]);
  }

  /** Pose calculée à l'image k, si elle est à jour. */
  function poseAt(k) {
    const p = state.pose;
    return p && p.rev === state.rev && p.poses && p.poses[k] ? p.poses[k] : null;
  }

  /** Grille 3D : la pose calculée si elle est à jour, sinon celle déduite de la forme affichée. */
  function drawSurface3D(pts) {
    const ps = poseAt(state.k);
    let P, proj, C, axes, L;
    if (ps) {
      const R = ps.R, t = ps.t, [w, h] = state.pose.size;
      P = (a, b) => [R[0] * a * w + R[1] * b * h + t[0], R[3] * a * w + R[4] * b * h + t[1], R[6] * a * w + R[7] * b * h + t[2]];
      proj = (X) => projectF(X, ps.f);
      C = t;
      axes = [[R[0], R[3], R[6]], [R[1], R[4], R[7]], [-R[2], -R[5], -R[8]]];
      L = 0.5 * Math.min(w, h);
    } else {
      const m = modelOf(pts);
      if (!m) return;
      const ax = axesOf(m);
      P = (a, b) => add(m.C, add(scale(m.eu, a), scale(m.ev, b)));
      proj = project;
      C = m.C;
      axes = [ax.x, ax.y, scale(ax.n, -1)];
      L = 0.5 * Math.min(len(m.eu), len(m.ev));
    }
    const dpr = DPR(), clip = unitOutline();
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = 'rgba(0, 220, 255, 0.7)';
    for (let i = 0; i <= 8; i++) { // grille 8 x 8, découpée à la forme
      const c = i / 8;
      clipLine(clip, true, c).forEach(([s0, s1]) => { polyPath([proj(P(c - 0.5, s0 - 0.5)), proj(P(c - 0.5, s1 - 0.5))]); ctx.stroke(); });
      clipLine(clip, false, c).forEach(([s0, s1]) => { polyPath([proj(P(s0 - 0.5, c - 0.5)), proj(P(s1 - 0.5, c - 0.5))]); ctx.stroke(); });
    }
    if (clip) {
      polyPath(clip.map(([u, v]) => proj(P(u - 0.5, v - 0.5))), true);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = 'rgba(0, 220, 255, 0.9)';
      ctx.stroke();
    }
    if (editable()) return;  // le gizmo montre déjà les axes
    const o = toScreen(proj(C));
    [[axes[0], '#ff4d4d'], [axes[1], '#3ce07a'], [axes[2], '#4aa3ff']].forEach(([axis, col]) => {
      drawArrow(o, toScreen(proj(add(C, scale(axis, L)))), col, 2.5 * dpr);
    });
  }

  function drawArrow(o, e, col, width) {
    const dpr = DPR(), ang = Math.atan2(e[1] - o[1], e[0] - o[0]), hl = 9 * dpr;
    ctx.lineWidth = width;
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(e[0], e[1]); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(e[0], e[1]); ctx.lineTo(e[0] - hl * Math.cos(ang - 0.4), e[1] - hl * Math.sin(ang - 0.4));
    ctx.moveTo(e[0], e[1]); ctx.lineTo(e[0] - hl * Math.cos(ang + 0.4), e[1] - hl * Math.sin(ang + 0.4));
    ctx.stroke();
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

  // ---- arrondi des coins : une poignée par coin, sur sa diagonale (glisser vers l'intérieur)
  const UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]], INWARD = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  function roundHandles(pts) {
    const H = squareHomography(orderRect(pts));
    if (!H) return [];
    const S2 = (u, v) => toScreen(warp(H, u, v));
    return UNIT.map(([cu, cv], j) => {
      const [su, sv] = INWARD[j], p0 = S2(cu, cv), p1 = S2(cu + su * 0.1, cv + sv * 0.1);
      const minR = Math.min(0.25, 16 * DPR() / (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 0.1 || 1));
      const r = Math.max(0.5 * state.round[j] / 100, minR);
      return { j, at: S2(cu + su * r, cv + sv * r), H };
    });
  }
  function drawRoundHandles(pts) {
    const dpr = DPR(), hv = state.hover || {};
    roundHandles(pts).forEach(({ j, at }) => {
      const hot = (hv.kind === 'round' && hv.j === j) || (state.drag && state.drag.kind === 'round' && state.drag.j === j);
      ctx.beginPath();
      ctx.arc(at[0], at[1], (hot ? 5.5 : 4) * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = state.round[j] > 0 ? '#f0c040' : 'rgba(0, 0, 0, 0.6)';
      ctx.fill();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = hot ? '#ffffff' : '#f0c040';
      ctx.stroke();
    });
  }

  // ---- gizmo de transformation (Déplacer / Tourner / Mettre à l'échelle), axes locaux ou du monde
  const AXIS_COLORS = { x: '#ff4d4d', y: '#3ce07a', z: '#4aa3ff' };
  /** Géométrie du gizmo à l'image affichée : modèle, axes, poignées à l'écran. */
  function gizmo() {
    const shown = shapeAt(state.k);
    const m = modelOf(shown);
    if (!m) return null;
    const ax = axesOf(m), L = 0.5 * Math.min(len(m.eu), len(m.ev));
    const world = state.space === 'world';
    // z vers la caméra (comme les axes de la grille : la flèche bleue pointe vers l'avant de la surface)
    const A = world ? { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, -1] } : { x: ax.x, y: ax.y, z: scale(ax.n, -1) };
    const o = S3(m.C);
    const g = { m, ax, o, handles: [] };
    const dpr = DPR(), size = 60 * dpr;  // longueur des flèches à l'écran, quel que soit le zoom
    // pixels écran par unité 3D au centre de la surface (pour un vecteur parallèle à l'image)
    const ppuFront = state.view.s * focalPx() / Math.max(1e-6, m.C[2]);
    /** Direction à l'écran d'un axe 3D, ramenée à une longueur fixe. Seul un axe qui vise
     *  vraiment la caméra (presque réduit à un point) prend une diagonale de secours. */
    const screenDir = (a, length) => {
      const e = S3(add(m.C, scale(a, length))), v = [e[0] - o[0], e[1] - o[1]], l = Math.hypot(v[0], v[1]);
      if (l < 0.2 * ppuFront * length) return { v: [-0.7 * size, 0.7 * size], ppu: ppuFront };
      return { v: [v[0] / l * size, v[1] / l * size], ppu: l / length };
    };
    if (state.xform === 'move') {
      ['x', 'y', 'z'].forEach((id) => {
        if (id === 'z' && state.mode2d) return;
        const d = screenDir(A[id], L);
        g.handles.push({ kind: 'axis', id, a: A[id], from: [o[0] + 0.2 * d.v[0], o[1] + 0.2 * d.v[1]], to: [o[0] + d.v[0], o[1] + d.v[1]], dir: d });
      });
      g.handles.push({ kind: 'plane', id: 'p', at: o });
    } else if (state.xform === 'rotate') {
      const r = 1.15 * L, defs = state.mode2d ? [['z', A.z, A.x, A.y]] : [['x', A.x, A.y, A.z], ['y', A.y, A.x, A.z], ['z', A.z, A.x, A.y]];
      defs.forEach(([id, axis, u, v]) => {
        const P3 = (a) => add(m.C, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a))));
        const pts = [];
        for (let i = 0; i <= 72; i++) pts.push(S3(P3(i / 72 * 2 * Math.PI)));
        g.handles.push({ kind: 'ring', id, axis, P3, pts });
      });
    } else { // échelle : toujours le long de la largeur et de la hauteur de la surface
      [['x', ax.x], ['y', ax.y]].forEach(([id, a]) => {
        const d = screenDir(a, L);
        g.handles.push({ kind: 'scale', id, from: o, to: [o[0] + d.v[0], o[1] + d.v[1]], dir: d });
      });
      g.handles.push({ kind: 'uniform', id: 'u', at: o });
    }
    return g;
  }

  function drawGizmo() {
    const g = gizmo();
    if (!g) return;
    const dpr = DPR(), hv = state.hover || {}, d = state.drag;
    const same = (a, b) => a && b && a.kind === b.kind && a.id === b.id;
    g.handles.forEach((h) => {
      const hot = d ? d.kind === 'gizmo' && same(d.handle, h) : hv.kind === 'gizmo' && same(hv.h, h);
      if (h.kind === 'axis') {
        drawArrow(h.from, h.to, AXIS_COLORS[h.id], (hot ? 4 : 2.5) * dpr);
      } else if (h.kind === 'ring') {
        screenPath(h.pts);
        ctx.lineWidth = (hot ? 4 : 2) * dpr;
        ctx.strokeStyle = AXIS_COLORS[h.id];
        ctx.globalAlpha = d && !hot ? 0.25 : hot ? 1 : 0.8;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (h.kind === 'scale') {
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = AXIS_COLORS[h.id];
        screenPath([h.from, h.to]);
        ctx.stroke();
        const s = (hot ? 7 : 5) * dpr;
        ctx.fillStyle = AXIS_COLORS[h.id];
        ctx.fillRect(h.to[0] - s, h.to[1] - s, 2 * s, 2 * s);
      } else { // plan (déplacer) ou échelle uniforme : carré au centre
        const s = (hot ? 8 : 6) * dpr;
        ctx.fillStyle = hot ? '#ffffff' : 'rgba(255, 255, 255, 0.8)';
        ctx.fillRect(h.at[0] - s, h.at[1] - s, 2 * s, 2 * s);
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = '#000';
        ctx.strokeRect(h.at[0] - s, h.at[1] - s, 2 * s, 2 * s);
      }
    });
  }

  // ------------------------------------------------------------------ souris
  /** Élément sous la souris, par priorité : coin, poignée d'arrondi, gizmo, côté. */
  function hitTest(x, y) {
    if (!editable()) return null;
    const pts = shapeAt(state.k), R = 10 * DPR();
    for (let i = 0; i < pts.length; i++) {
      const [sx, sy] = toScreen(pts[i]);
      if (Math.hypot(sx - x, sy - y) < R) return { kind: 'point', i };
    }
    if (!ready()) return null;
    for (const h of roundHandles(pts)) if (Math.hypot(h.at[0] - x, h.at[1] - y) < 8 * DPR()) return { kind: 'round', j: h.j, H: h.H };
    const g = gizmo();
    if (g) {
      let best = null, bd = 8 * DPR();
      g.handles.forEach((h) => {
        let dist = Infinity;
        if (h.kind === 'axis') dist = segDist(x, y, h.from, h.to)[0];
        else if (h.kind === 'scale') dist = Math.max(Math.abs(h.to[0] - x), Math.abs(h.to[1] - y)) - 3 * DPR();
        else if (h.kind === 'ring') for (let i = 0; i < h.pts.length - 1; i++) dist = Math.min(dist, segDist(x, y, h.pts[i], h.pts[i + 1])[0]);
        else dist = Math.max(Math.abs(h.at[0] - x), Math.abs(h.at[1] - y)) - 2 * DPR();
        if (dist < bd) { bd = dist; best = h; }
      });
      if (best) return { kind: 'gizmo', h: best, g };
    }
    const o = orderIdx(pts);
    for (let n = 0; n < 4; n++) {
      const i = o[n], j = o[(n + 1) % 4];
      const [d, u] = segDist(x, y, toScreen(pts[i]), toScreen(pts[j]));
      if (d < 7 * DPR() && u > 0.12 && u < 0.88) return { kind: 'edge', i, j };
    }
    return null;
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (ev) => {
    if (!state.cur || !state.view) return;
    stopPlay();
    const [x, y] = canvasXY(ev);
    if (ev.button !== 0 || state.spaceKey || !editable()) {
      state.drag = { kind: 'pan', x, y };
      canvas.classList.add('pan');
      return;
    }
    const hit = hitTest(x, y);
    const base = (shapeAt(state.k) || []).map((p) => p.slice());
    if (!hit) {
      if (state.points.length < 4 && onRef()) { // poser les coins
        beginAction();
        state.points.push(toImage(x, y));
        state.drag = { kind: 'point', i: state.points.length - 1, base: state.points.map((p) => p.slice()) };
        state.rev++;
        refresh();
      } else {
        state.drag = { kind: 'pan', x, y };
        canvas.classList.add('pan');
      }
      return;
    }
    beginAction();
    if (!onRef()) state.keys = Object.assign({}, state.keys);  // nouvel objet : l'historique garde l'ancien
    if (hit.kind === 'point') state.drag = { kind: 'point', i: hit.i, base };
    else if (hit.kind === 'edge') state.drag = { kind: 'edge', i: hit.i, j: hit.j, base, p0: toImage(x, y) };
    else if (hit.kind === 'round') state.drag = { kind: 'round', j: hit.j, Hi: inv9(flat(hit.H)), round0: state.round.slice() };
    else {
      const h = hit.h, g = hit.g;
      const d = { kind: 'gizmo', handle: h, base, m0: g.m, x0: x, y0: y };
      if (h.kind === 'ring') { // pixels par radian le long de l'anneau, au point saisi
        let bi = 0, bd = Infinity;
        h.pts.forEach((p, i) => { const dd = Math.hypot(p[0] - x, p[1] - y); if (dd < bd) { bd = dd; bi = i; } });
        const a = bi / 72 * 2 * Math.PI, eps = 0.01, p0 = S3(h.P3(a)), p1 = S3(h.P3(a + eps));
        let tx = (p1[0] - p0[0]) / eps, ty = (p1[1] - p0[1]) / eps;
        const tl = Math.hypot(tx, ty);
        if (tl < 30 * DPR()) { const s = 30 * DPR() / (tl || 1); tx *= s; ty *= s; }  // anneau vu par la tranche
        d.tx = tx; d.ty = ty;
        if (isDisc() && state.flip) state.flip = false;  // la rotation à la main remplace l'inversion
      } else if (h.kind === 'plane') { // glisser dans le plan de la surface (local) ou parallèle à l'image (monde)
        d.nrm = state.space === 'world' || state.mode2d ? [0, 0, 1] : g.ax.n;
        d.P0 = planePoint(toImage(x, y), d.nrm, g.m.C);
      }
      state.drag = d;
    }
    draw();
  });

  /** Point 3D du plan (normale nrm, passant par C) vu au pixel p. */
  function planePoint(p, nrm, C) {
    const r = ray(p), den = dot(nrm, r);
    return Math.abs(den) < 1e-9 ? null : scale(r, dot(nrm, C) / den);
  }

  function dragGizmo(d, x, y) {
    const h = d.handle, m = d.m0, dx = x - d.x0, dy = y - d.y0;
    let m2 = null;
    if (h.kind === 'axis') {
      const v = h.dir.v, l = Math.hypot(v[0], v[1]);
      m2 = { C: add(m.C, scale(h.a, (dx * v[0] + dy * v[1]) / l / h.dir.ppu)), eu: m.eu, ev: m.ev };
    } else if (h.kind === 'plane') {
      const P = planePoint(toImage(x, y), d.nrm, m.C);
      if (P && d.P0) m2 = { C: add(m.C, sub(P, d.P0)), eu: m.eu, ev: m.ev };
    } else if (h.kind === 'ring') {
      const ang = (dx * d.tx + dy * d.ty) / (d.tx * d.tx + d.ty * d.ty);
      m2 = { C: m.C, eu: rotate(m.eu, h.axis, ang), ev: rotate(m.ev, h.axis, ang) };
    } else if (h.kind === 'scale') {
      const v = h.dir.v, f = Math.max(0.05, 1 + (dx * v[0] + dy * v[1]) / (v[0] * v[0] + v[1] * v[1]));
      m2 = { C: m.C, eu: h.id === 'x' ? scale(m.eu, f) : m.eu, ev: h.id === 'y' ? scale(m.ev, f) : m.ev };
    } else if (h.kind === 'uniform') {
      const f = Math.max(0.05, Math.exp((dx - dy) / (150 * DPR())));
      m2 = { C: m.C, eu: scale(m.eu, f), ev: scale(m.ev, f) };
    }
    if (m2) applyModel(m2, d.base);
  }

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
      if (shown.length === 4) setShapeAt(shown); else state.points = shown;
      state.rev++;
      draw();
    } else if (d && d.kind === 'edge') {
      const p = toImage(x, y), ex = p[0] - d.p0[0], ey = p[1] - d.p0[1];
      setShapeAt(d.base.map((q, i) => (i === d.i || i === d.j ? [q[0] + ex, q[1] + ey] : q.slice())));
      state.rev++;
      draw();
    } else if (d && d.kind === 'round') { // position de la souris projetée sur la diagonale du coin
      const [u, v] = warp9(d.Hi, toImage(x, y)), [cu, cv] = UNIT[d.j], [su, sv] = INWARD[d.j];
      const val = Math.round(200 * Math.max(0, Math.min(0.5, ((u - cu) * su + (v - cv) * sv) / 2)));
      state.round = ev.shiftKey ? [val, val, val, val] : d.round0.map((r, j) => (j === d.j ? val : r));
      state.rev++;
      refresh();
    } else if (d && d.kind === 'gizmo') {
      dragGizmo(d, x, y);
      state.rev++;
      draw();
    } else if (d && d.kind === 'pan') {
      state.view.ox += x - d.x;
      state.view.oy += y - d.y;
      d.x = x;
      d.y = y;
      draw();
    } else if (ev.target === canvas) {
      const h = hitTest(x, y);
      canvas.style.cursor = !h ? '' : h.kind === 'edge' || (h.kind === 'gizmo' && h.h.kind === 'plane') ? 'move'
        : h.kind === 'point' ? 'pointer' : 'grab';
      const key = (o) => (o ? [o.kind, o.i, o.j, o.h && o.h.kind, o.h && o.h.id].join() : '');
      if (key(h) !== key(state.hover)) { state.hover = h; draw(); }
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
    const h = hitTest(x, y);
    if (h && h.kind === 'round') { act(() => { state.round = state.round.map((r, j) => (j === h.j ? 0 : r)); }); return; }
    if (!h) fitView();
  });

  // ------------------------------------------------------------------ clavier
  window.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && (ev.key === 'z' || ev.key === 'Z')) { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
    if (mod && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); redo(); return; }
    if (ev.target.tagName === 'INPUT' && ev.target !== keysink && ev.target.type !== 'checkbox') return;
    if (ev.code === 'Space') { state.spaceKey = true; canvas.classList.add('pan'); ev.preventDefault(); }
    const k = ev.key.toLowerCase();
    if (!mod && (k === 'w' || k === 'e' || k === 'r')) { setXform({ w: 'move', e: 'rotate', r: 'scale' }[k]); ev.preventDefault(); }
    if (!mod && k === 'x') { setSpace(state.space === 'local' ? 'world' : 'local'); ev.preventDefault(); }
    if ((ev.key === 'Backspace' || ev.key === 'Delete') && state.keys[state.k] && !state.tracking) {
      removeKey(state.k);  // sur une clé : la supprimer
      ev.preventDefault();
    } else if ((ev.key === 'Backspace' || ev.key === 'Delete') && editable() && onRef() && state.points.length) {
      act(() => { state.points.pop(); });
      ev.preventDefault();
    }
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && state.n && !state.tracking) {
      const step = (ev.key === 'ArrowLeft' ? -1 : 1) * (ev.shiftKey ? 10 : 1);
      goTo(Math.max(0, Math.min(state.n - 1, state.k + step)), true);
      ev.preventDefault();
    }
  });
  // Le panneau garde le clavier : après chaque clic (hors champ de saisie), le focus revient au champ
  // invisible ; sinon After Effects reçoit les touches (⌘Z, W, E, R…) à la place du panneau.
  const keysink = $('keysink');
  const grabKeys = () => { if (document.activeElement !== keysink) keysink.focus({ preventScroll: true }); keysink.value = ''; };
  document.addEventListener('mousedown', (ev) => {
    const t = ev.target;
    if (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range') return;  // focale saisie
    setTimeout(grabKeys, 0);
  }, true);
  window.addEventListener('focus', () => { if (!document.activeElement || document.activeElement === document.body) grabKeys(); });
  keysink.addEventListener('input', () => { keysink.value = ''; });

  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') { state.spaceKey = false; if (!state.drag) canvas.classList.remove('pan'); }
  });
  window.addEventListener('resize', draw);
  if (inCEP) {
    // raccourcis pour le panneau plutôt que pour AE (codes de touches macOS) : ⌘Z, ⇧⌘Z, ←, →,
    // effacement, espace, W, E, R, X
    try {
      window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify([
        { keyCode: 6, metaKey: true }, { keyCode: 6, metaKey: true, shiftKey: true },
        { keyCode: 123 }, { keyCode: 124 }, { keyCode: 123, shiftKey: true }, { keyCode: 124, shiftKey: true },
        { keyCode: 51 }, { keyCode: 117 }, { keyCode: 49 }, { keyCode: 13 }, { keyCode: 14 }, { keyCode: 15 }, { keyCode: 7 },
      ]));
    } catch (e) { /* ancienne version de CEP */ }
  }

  // ------------------------------------------------------------------ barre d'outils
  function setXform(x) { state.xform = x; remember('xform', x); syncControls(); refresh(); }
  function setSpace(s) { state.space = s; remember('space', s); syncControls(); refresh(); }
  document.querySelectorAll('[data-xform]').forEach((b) => b.addEventListener('click', () => setXform(b.dataset.xform)));
  document.querySelectorAll('[data-space]').forEach((b) => b.addEventListener('click', () => setSpace(b.dataset.space)));
  document.querySelectorAll('[data-dim]').forEach((b) => b.addEventListener('click', () => {
    if (state.tracking || (b.dataset.dim === '2d') === state.mode2d) return;
    act(() => { state.mode2d = b.dataset.dim === '2d'; });
    syncControls();
  }));
  $('btn-flip').addEventListener('click', () => act(() => { state.flip = !state.flip; }));
  const focalIn = $('in-focal');
  focalIn.addEventListener('focus', beginAction);
  focalIn.addEventListener('input', () => { beginAction(); state.rev++; refresh(); });
  focalIn.addEventListener('change', () => { endAction(); refresh(); });
  // effacer : un menu, pour ne pas confondre « le suivi seulement » et « tout »
  $('btn-clear').addEventListener('click', (e) => { e.stopPropagation(); if (!state.tracking) $('clear-menu').classList.toggle('hidden'); });
  window.addEventListener('click', () => $('clear-menu').classList.add('hidden'));
  $('btn-clear-track').addEventListener('click', () => act(() => { state.Hs = {}; state.keys = {}; state.conf = {}; }));
  $('btn-clear-all').addEventListener('click', () => act(() => {
    state.points = []; state.round = [0, 0, 0, 0]; state.Hs = {}; state.keys = {}; state.conf = {};
  }));
  function removeKey(k) {
    act(() => { const keys = Object.assign({}, state.keys); delete keys[k]; state.keys = keys; });
  }
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
    $('btn-flip').classList.toggle('hidden', !isDisc() || state.mode2d);
    $('btn-flip').classList.toggle('on', state.flip);
    $('btn-undo').disabled = !state.undo.length || !!state.tracking;
    $('btn-redo').disabled = !state.redo.length || !!state.tracking;
    $('btn-clear-track').disabled = !tracked;
    $('btn-key').disabled = !!state.tracking || k === state.ref || !tracked || !effH(k);
    $('btn-key').classList.toggle('keyon', !!state.keys[k] || k === state.ref);
    $('btn-key').title = k === state.ref ? 'Image de référence (clé d\'origine)' : state.keys[k] ? 'Retirer la clé de cette image (Suppr)'
      : 'Poser une clé : fige la forme affichée sur cette image';
    $('toolbar').classList.toggle('disabled', !!state.tracking);

    // suivi : possible depuis la référence ou une image déjà trackée
    const canStart = ready() && !!state.eng && !state.tracking && !!effH(k);
    document.querySelectorAll('.trk').forEach((b) => {
      const running = state.tracking && state.tracking.btn === b;
      b.classList.toggle('running', !!running);
      b.disabled = state.tracking ? !running : !canStart;
      if (!b.dataset.icon) { b.dataset.icon = b.innerHTML; b.dataset.title = b.title; }
      const mode = running ? 'stop' : 'go';
      if (b.dataset.mode !== mode) {
        b.dataset.mode = mode;
        b.innerHTML = running ? '<svg class="solid" viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>' : b.dataset.icon;
        b.title = running ? 'Arrêter le suivi (les images déjà trackées sont gardées)' : b.dataset.title;
      }
    });
    const PAUSE = 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z';
    document.querySelectorAll('.play').forEach((b) => {
      b.disabled = !state.n || !!state.tracking;
      const path = b.querySelector('path');
      if (!b.dataset.d) b.dataset.d = path.getAttribute('d');
      const playing = !!state.playTimer && b.dataset.dir === String(state.playBtn);
      path.setAttribute('d', playing ? PAUSE : b.dataset.d);
    });
    ['btn-step-back', 'btn-step-fwd'].forEach((id) => { $(id).disabled = !state.n || !!state.tracking; });
    $('btn-key-prev').disabled = !state.n || !!state.tracking || nextKey(k, -1) === null;
    $('btn-key-next').disabled = !state.n || !!state.tracking || nextKey(k, 1) === null;
    if (state.shot) $('frame-label').textContent = `${state.shot.seqStart + k}` + (k === state.ref ? ' · réf' : '');
    // seules indications affichées en permanence (le reste est dans l'aide)
    const badge = state.tracking ? `Suivi… image ${state.shot.seqStart + k}`
      : state.curThumbMissing ? 'Images en préparation…'
        : !state.cur ? ''
          : (state.scrubbing && !tracked) ? 'Relâchez sur une image nette : elle devient la référence'
            : (tracked && !shapeAt(k)) ? 'Non trackée'
              : n < 4 ? `Cliquez les 4 coins de la surface (${n}/4)` : '';
    $('badge').textContent = badge;
    $('badge').classList.toggle('hidden', !badge);
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
    // images chargées (bande grise en bas)
    tctx.fillStyle = '#4a4a4a';
    state.loaded.forEach((k) => tctx.fillRect(tlX(k, w) - cw / 2, h - 4 * dpr, cw + 0.5, 3 * dpr));
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
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(tlX(state.k, w) - 1 * dpr, 0, 2 * dpr, h);
  }

  function tlFrame(ev) {
    const r = tl.getBoundingClientRect(), x = ev.clientX - r.left;
    const u = (x - TL_PAD) / Math.max(1, r.width - 2 * TL_PAD);
    return Math.max(0, Math.min(state.n - 1, Math.round(u * (state.n - 1))));
  }

  // clic droit sur un losange de la timeline : supprimer cette clé
  tl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (state.tracking || !state.n) return;
    const k = tlFrame(ev), tol = Math.max(1, Math.round(state.n * 6 / Math.max(1, tl.clientWidth)));
    const near = Object.keys(state.keys).map(Number).filter((kk) => Math.abs(kk - k) <= tol)
      .sort((a, b) => Math.abs(a - k) - Math.abs(b - k));
    if (near.length) removeKey(near[0]);
  });

  tl.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
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
  // lecture en aller-retour : arrivée au bout, elle repart dans l'autre sens
  document.querySelectorAll('.play').forEach((btn) => btn.addEventListener('click', () => {
    const dir = +btn.dataset.dir;
    if (state.playTimer) {
      const same = state.playBtn === dir;
      stopPlay();
      if (same) { goTo(state.k, true); return; }  // le bouton en cours sert de pause
    }
    state.playDir = state.playBtn = dir;  // playBtn : bouton lancé (il affiche la pause)
    const fps = Math.min(30, (state.shot && state.shot.compFps) || 25);
    state.playTimer = setInterval(() => {
      if (state.n < 2) return;
      let k = state.k + state.playDir;
      if (k < 0 || k >= state.n) { state.playDir = -state.playDir; k = state.k + state.playDir; }
      showFrame(k, { fast: true });
    }, 1000 / fps);
    refresh();
  }));
  const step = (d) => { if (state.n && !state.tracking) { stopPlay(); goTo(Math.max(0, Math.min(state.n - 1, state.k + d)), true); } };
  $('btn-step-back').addEventListener('click', () => step(-1));
  $('btn-step-fwd').addEventListener('click', () => step(1));
  /** Aller à la clé (ou à la référence) précédente / suivante. */
  const jumpKey = (d) => {
    if (!state.n || state.tracking) return;
    const kk = nextKey(state.k, d);
    if (kk !== null) { stopPlay(); goTo(kk, true); }
  };
  $('btn-key-prev').addEventListener('click', () => jumpKey(-1));
  $('btn-key-next').addEventListener('click', () => jumpKey(1));

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
    const pts = orderRect(state.points);
    try {
      for (const d of dir === 0 ? [1, -1] : [dir]) {
        if (state.tracking.cancel) break;
        const kn = nextKey(k0, d);
        const count = one ? 1 : kn === null ? 0 : Math.abs(kn - k0);  // jusqu'à la clé suivante, incluse
        if (dir === 0 && state.k !== k0) showFrame(k0, { fast: true });
        const r = await state.eng.send({
          cmd: 'track', k: k0, dir: d, count, ref: state.ref, H: H0, Hprev: effH(k0 - d) || null,
          points: pts, roundness: radii(),
          anchors: state.keys,  // les clés servent aussi de modèles de recalage (anti-dérive)
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

  // ------------------------------------------------------------------ pose
  let solveTimer = null;
  function scheduleSolve() {
    clearTimeout(solveTimer);
    if (!hasTrack()) { state.pose = null; showSummary(); return; }
    solveTimer = setTimeout(runSolve, 350);
  }

  /** Homographies de toutes les images trackées, corrigées par les clés. */
  function usedHs() {
    const out = {};
    new Set(Object.keys(state.Hs).concat(Object.keys(state.keys))).forEach((key) => { const H = effH(+key); if (H) out[key] = H; });
    out[state.ref] = I3;
    return out;
  }

  async function runSolve() {
    if (state.tracking || state.drag || !state.eng || !ready() || !hasTrack()) return;
    if (state.solving) { scheduleSolve(); return; }
    const rev = state.rev;
    const focal = parseFloat($('in-focal').value);
    state.solving = true;
    refresh();
    try {
      const r = await state.eng.send({
        cmd: 'solve', Hs: usedHs(), conf: state.conf, ref: state.ref, points: orderRect(state.points),
        roundness: radii(), normal: chosenNormal(), focal_mm: focal > 0 ? focal : null, mode: state.mode2d ? '2d' : '3d',
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

  function showSummary() {
    const ul = $('summary');
    ul.innerHTML = '';
    const r = state.pose;
    $('summary-empty').classList.toggle('hidden', !!r);
    if (!r) return;
    const add = (cls, txt) => { const li = document.createElement('li'); li.className = cls; li.textContent = txt; ul.appendChild(li); };
    const keys = Object.keys(usedHs()).map(Number).sort((a, b) => a - b);
    const off = state.shot.seqStart, nk = Object.keys(state.keys).length;
    add('ok', `${keys.length}/${state.n} images trackées (${off + keys[0]}–${off + keys[keys.length - 1]})` +
      (nk ? `, ${nk} clé${nk > 1 ? 's' : ''} de correction` : '') + (state.mode2d ? ' · 2D' : ''));
    if (!/métadonnées|saisie/.test(r.focal_source)) add('warn', `Focale : ${r.focal_source}`);
    if (r.error_mean !== null && r.error_mean !== undefined && !state.mode2d) {
      add(r.error_mean < 1.5 ? 'ok' : 'warn', `Calage 3D sur la 2D : ${r.error_mean.toFixed(2)} px en moyenne (max ${r.error_max.toFixed(1)})`);
    }
  }

  // ------------------------------------------------------------------ appliquer dans l'effet
  $('btn-apply').addEventListener('click', async () => {
    const r = state.pose;
    if (!r || !r.ae || !inCEP) return;
    $('btn-apply').disabled = true;
    const out = await host('stApplyTracking', state.shot.compId, state.shot.layerIndex,
      Object.assign({}, r.ae, {
        mode2d: state.mode2d, refFrame: state.shot.seqStart + state.ref,
        keyFrames: keyFrames().map((k) => state.shot.seqStart + k),
        keyDeltas: keyFrames().map(keyDelta),
      }));
    refresh();
    if (!out.ok) { toast(out.msg, 12000); log(out.msg); return; }
    // le tracking est dans l'effet : le panneau n'a plus rien à faire, il se ferme
    if (state.eng) { state.eng.close(); state.eng = null; }
    window.__adobe_cep__.closeExtension();
  });

  // ------------------------------------------------------------------ aide et détails
  const sheets = ['sheet-help', 'sheet-details'];
  function openSheet(id) {
    const was = !$(id).classList.contains('hidden');
    sheets.forEach((s) => $(s).classList.add('hidden'));
    if (!was) $(id).classList.remove('hidden');
  }
  $('btn-help').addEventListener('click', () => openSheet('sheet-help'));
  $('btn-details').addEventListener('click', () => openSheet('sheet-details'));
  sheets.forEach((id) => $(id).addEventListener('click', (ev) => {
    // clic sur le fond ou sur × : fermer
    if (ev.target === $(id) || ev.target.classList.contains('close')) $(id).classList.add('hidden');
  }));
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') sheets.forEach((s) => $(s).classList.add('hidden'));
  });

  // ------------------------------------------------------------------ démarrage
  state.xform = recall('xform', 'move');
  state.space = recall('space', 'local');
  syncControls();
  if (!inCEP) {
    // aperçu dans un navigateur : moteur simulé, toutes les images = demo.jpg
    $('shot-empty').textContent = 'Mode démo (hors After Effects) : suivi simulé.';
    loadImg('demo.jpg').then((img) => {
      state.W = img.width; state.H = img.height; state.n = 60;
      state.shot = { seqStart: 0, compFps: 25 };
      state.k = state.ref = 20;
      for (let i = 0; i < 60; i++) { state.loaded.add(i); state.full.set(i, img); }
      state.eng = demoEngine(onEngineEvent);
      state.cur = img;
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
