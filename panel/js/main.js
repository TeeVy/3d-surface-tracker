/* 3D Surface Tracker — panneau After Effects (CEP).
 *
 * Le panneau pilote le moteur Python (engine.py, lignes JSON sur stdout) via Node.js
 * et parle à After Effects via ExtendScript (jsx/host.jsx).
 * Le calque à tracker arrive par le script « Tracker le calque » (ae_scripts/), qui
 * dépose une demande dans ~/Library/Application Support/3D Surface Tracker/.
 * Hors d'After Effects (navigateur), il passe en mode démo : éditeur seul.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const inCEP = !!window.__adobe_cep__;
  const nodeRequire = typeof require === 'function' ? require : (window.cep_node && window.cep_node.require);
  const fs = nodeRequire && nodeRequire('fs');
  const path = nodeRequire && nodeRequire('path');
  const cp = nodeRequire && nodeRequire('child_process');
  const os = nodeRequire && nodeRequire('os');
  const nodeProcess = nodeRequire && nodeRequire('process');

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

  // ------------------------------------------------------------------ état
  const state = {
    shot: null,          // calque chargé (réponse de stGetLayer / stGetSelection)
    lensMm: null,        // focale des métadonnées (éq. 35 mm), si présente
    workDir: null,
    tool: 'rect',        // 'rect' | 'free'
    points: [],          // en pixels de la vidéo
    flip: false,         // disque : autre inclinaison
    orientManual: false, // forme libre : orientation réglée à la main (gizmo)
    freeNormal: null,    // forme libre : normale choisie au gizmo (repère caméra)
    thumbsDir: null,     // vignettes de la plage, pour choisir l'image de référence
    img: null,           // image de référence
    view: null,          // {s, ox, oy, fit} en pixels canvas
    show: 'edit',        // 'edit' | 'browse' (timeline avant tracking) | 'live' | 'result'
    live: null,          // aperçu en direct : {img, poly, frame}
    drag: null,          // {kind:'point', i} | {kind:'pan', x, y} | {kind:'rotate', ...}
    browseImg: null,     // vignette affichée pendant le choix de la référence
    hover: -1,
    space: false,
    result: null,
    previewImg: null,
    child: null,
    runCount: 0,
    playTimer: null,
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

  function fileUrl(p) {
    return 'file://' + encodeURI(p).replace(/#/g, '%23') + '?t=' + Date.now();
  }

  function stamp() {
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function enable(id, on) { $(id).classList.toggle('disabled', !on); }

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
  function runEngine(args, onEvent, trackable = !!onEvent) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(PY)) {
        reject(new Error("Environnement Python introuvable :\n" + PY +
          "\n\nDans le Terminal, depuis le dossier du projet :\n/usr/bin/python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"));
        return;
      }
      const env = Object.assign({}, nodeProcess.env, { PYTHONUNBUFFERED: '1' });
      // AE ne transmet pas le PATH du Terminal : on ajoute Homebrew pour ffmpeg (métadonnées caméra)
      env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', env.PATH || '/usr/bin:/bin'].join(':');
      const child = cp.spawn(PY, [ENGINE].concat(args), { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
      if (trackable) state.child = child;  // seul le tracking est « en cours » (arrêtable)
      let buf = '', stderr = '', result = null, error = null;
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch (e) { if (onEvent) onEvent({ type: 'log', msg: line }); continue; }
          if (ev.type === 'result') result = ev;
          else if (ev.type === 'error') error = ev;
          else if (onEvent) onEvent(ev);
        }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => reject(new Error('Impossible de lancer Python : ' + e.message)));
      child.on('close', (code, signal) => {
        if (state.child === child) state.child = null;
        if (result) resolve(result);
        else if (error) reject(new Error(error.msg));
        else if (signal) reject(new Error('Annulé.'));
        else reject(new Error(`Le moteur s'est arrêté (code ${code}).\n` + stderr.slice(-800)));
      });
    });
  }

  // ------------------------------------------------------------------ calque à tracker
  /** Demandes du script « Tracker le calque » + signal de vie (le script ne rouvre pas un panneau ouvert). */
  function heartbeat() {
    try {
      fs.mkdirSync(APPDIR, { recursive: true });
      fs.writeFileSync(path.join(APPDIR, 'alive.txt'), String(Date.now()));
      const pending = path.join(APPDIR, 'pending.json');
      if (!fs.existsSync(pending) || state.child) return;
      const req = JSON.parse(fs.readFileSync(pending, 'utf8'));
      fs.unlinkSync(pending);
      if (req.stamp > state.pendingStamp && Date.now() - req.stamp < 60000) {
        state.pendingStamp = req.stamp;
        host('stGetLayer', req.compId, req.layerIndex, req.time).then(loadShot);
      }
    } catch (e) { /* demande illisible : ignorée */ }
  }

  async function loadShot(sel) {
    if (!sel.ok) { toast(sel.msg); return; }
    stopPlay();
    state.shot = sel;
    state.points = [];
    state.flip = false;
    state.orientManual = false;
    state.freeNormal = null;
    state.result = null;
    state.show = 'edit';
    state.thumbsDir = null;
    const stem = path.basename(sel.file).replace(/\.[^.]+$/, '');
    state.workDir = path.join(ROOT, 'out', 'panel', `${stem}_${stamp()}`);

    const via = sel.chain.length > 1 ? ` <span class="dim">via ${sel.chain.slice(1).map(escapeHtml).join(' › ')}</span>` : '';
    $('shot-empty').classList.add('hidden');
    $('shot-info').classList.remove('hidden');
    $('shot-info').innerHTML =
      `<div class="line"><b>${escapeHtml(sel.layerName)}</b> · ${escapeHtml(path.basename(sel.file))}${via}</div>` +
      `<div class="line dim">Réf. image ${sel.frame} · images ${sel.rangeStart}–${sel.rangeEnd} ` +
      `(${sel.rangeEnd - sel.rangeStart + 1}) · « ${escapeHtml(sel.compName)} »</div>`;
    const w = $('shot-warnings');
    w.innerHTML = '';
    sel.warnings.forEach((m) => { const li = document.createElement('li'); li.textContent = m; w.appendChild(li); });
    $('summary').innerHTML = '';
    $('apply-msg').classList.add('hidden');
    $('result-actions').classList.add('hidden');
    $('frame-label').textContent = '—';

    $('btn-load').disabled = true;
    try {
      const [fr, info] = await Promise.all([
        runEngine(['frame', sel.file, String(sel.frame), path.join(state.workDir, 'ref.jpg')]),
        runEngine(['info', sel.file]).catch(() => ({ lens: null })),
      ]);
      state.lensMm = info.lens ? info.lens.focal35_mm : null;
      $('focal-wrap').classList.toggle('hidden', !!state.lensMm);
      await loadImage(fr.path);
      enable('s-surface', true);
      enable('s-track', true);
      setupBrowse();
    } catch (e) {
      toast(e.message);
    } finally {
      $('btn-load').disabled = false;
      refresh();
    }
  }

  function loadImage(p) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { state.img = img; fitView(); resolve(); };
      img.onerror = () => reject(new Error("Impossible d'afficher l'image : " + p));
      img.src = p.indexOf('demo') === 0 ? p : fileUrl(p);
    });
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

  /** Contour du rectangle arrondi (même construction que le moteur : arcs dans le carré unité). */
  function roundedOutline(q, roundness) {
    const H = squareHomography(q);
    if (!H) return q;
    const r = 0.5 * roundness, pts = [];
    if (r <= 1e-6) return q;
    [[1 - r, r, -90], [1 - r, 1 - r, 0], [r, 1 - r, 90], [r, r, 180]].forEach(([cx, cy, a0]) => {
      for (let k = 0; k < 12; k++) {
        const a = (a0 + 90 * k / 11) * Math.PI / 180;
        pts.push(warp(H, cx + r * Math.cos(a), cy + r * Math.sin(a)));
      }
    });
    return pts;
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
    return mm / 36 * Math.max(state.img.width, state.img.height);
  }
  function ray(p) { // direction (repère caméra) du pixel p
    const f = focalPx();
    return norm([(p[0] - state.img.width / 2) / f, (p[1] - state.img.height / 2) / f, 1]);
  }
  function project(X) {
    const f = focalPx();
    return [state.img.width / 2 + f * X[0] / X[2], state.img.height / 2 + f * X[1] / X[2]];
  }

  const isDisc = () => state.tool === 'rect' && +$('in-round').value >= 100;

  function rotate(v, axis, ang) { // rotation de Rodrigues autour d'un axe unitaire
    const c = Math.cos(ang), s = Math.sin(ang), k = dot(axis, v);
    return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, k * (1 - c)));
  }

  /** Modèle 3D du rectangle déduit des 4 coins : X(a, b) = C + a·eu + b·ev, a et b dans [-½, ½]. */
  function rectModel() {
    if (state.points.length !== 4) return null;
    const H = squareHomography(orderRect(state.points));
    if (!H) return null;
    const f = focalPx(), cx = state.img.width / 2, cy = state.img.height / 2;
    const col = (j) => [(H[0][j] - cx * H[2][j]) / f, (H[1][j] - cy * H[2][j]) / f, H[2][j]];
    const eu = col(0), ev = col(1);
    return { C: add(add(scale(eu, 0.5), scale(ev, 0.5)), col(2)), eu, ev };
  }

  function cornersOf(m) {
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => project(add(m.C, add(scale(m.eu, a / 2), scale(m.ev, b / 2)))));
  }

  /** Repère 3D de la surface sur l'image de référence (comme dans l'aperçu après tracking) :
   *  {C, x, y, n (vers l'arrière-plan), model (rectangle) ou grid [a0, a1, b0, b1] (forme libre), auto}. */
  function gizmo() {
    if (!state.img || !ready()) return null;
    if (state.tool === 'rect') {
      const m = rectModel();
      if (!m) return null;
      let n = norm(cross(m.eu, m.ev));
      if (dot(n, m.C) < 0) n = scale(n, -1);
      if (isDisc() && state.flip) { const d = norm(m.C); n = norm(add(scale(d, 2 * dot(n, d)), scale(n, -1))); }
      const x = norm(add(m.eu, scale(n, -dot(m.eu, n)))), y = cross(n, x);
      return { C: m.C, x, y, n, model: m };
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
    return { C, x, y, n, grid: [a0, a1, b0, b1], auto: !state.orientManual };
  }

  /** Normale à transmettre au moteur (disque : tranche entre les 2 inclinaisons ; forme libre : réglage manuel). */
  function chosenNormal() {
    const g = gizmo();
    if (!g || !(isDisc() || (state.tool === 'free' && state.orientManual))) return null;
    return g.n;
  }

  // ------------------------------------------------------------------ éditeur
  const canvas = $('view');
  const ctx = canvas.getContext('2d');

  function shownImage() {
    if (state.show === 'live' && state.live) return state.live.img;
    if (state.show === 'browse' && state.browseImg) return state.browseImg;
    return state.show === 'result' && state.previewImg ? state.previewImg : state.img;
  }

  function fitView() {
    const img = state.img;
    if (!img) return;
    resizeCanvas();
    const s = Math.min(canvas.width / img.width, canvas.height / img.height) * 0.98;
    state.view = { s, ox: (canvas.width - img.width * s) / 2, oy: (canvas.height - img.height * s) / 2, fit: s };
    draw();
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
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
    const dpr = canvas.width / r.width;
    return [(ev.clientX - r.left) * dpr, (ev.clientY - r.top) * dpr];
  }

  function hitPoint(x, y) {
    const R = 9 * (window.devicePixelRatio || 1);
    let best = -1, bd = R;
    state.points.forEach((p, i) => {
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

  function draw() {
    resizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = shownImage();
    $('canvas-empty').classList.toggle('hidden', !!img);
    if (!img || !state.view) return;
    const v = state.view;
    const k = state.img.width / img.width; // aperçus réduits : même cadre que l'image de référence
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, v.ox, v.oy, img.width * k * v.s, img.height * k * v.s);
    if (state.show === 'edit') drawShape();
    if (state.show === 'live' && state.live && state.live.poly.length) {
      polyPath(state.live.poly.map((p) => [p[0] * k, p[1] * k]), true);
      ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
      ctx.strokeStyle = '#3ce07a';
      ctx.stroke();
      ctx.fillStyle = 'rgba(60, 224, 122, 0.12)';
      ctx.fill();
    }
  }

  function drawShape() {
    const dpr = window.devicePixelRatio || 1;
    const pts = state.points, ok = ready();
    const shape = state.tool === 'rect' && ok ? roundedOutline(orderRect(pts), +$('in-round').value / 100) : pts;
    if (state.tool === 'rect' && ok && +$('in-round').value > 0) { // rectangle « pointu » en pointillés
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      polyPath(orderRect(pts), true);
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
      if (ok) { ctx.fillStyle = 'rgba(60, 224, 122, 0.10)'; ctx.fill(); }
    }
    if (ok) drawGizmo();
    const labels = ['HG', 'HD', 'BD', 'BG'];
    const ordered = state.tool === 'rect' && pts.length === 4 ? orderRect(pts) : null;
    pts.forEach((p, i) => {
      const [x, y] = toScreen(p);
      ctx.beginPath();
      ctx.arc(x, y, (i === state.hover ? 6 : 4.5) * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = i === state.hover ? '#ffffff' : '#3ce07a';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
      if (ordered) {
        ctx.font = `${10 * dpr}px -apple-system, sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.fillText(labels[ordered.indexOf(p)], x + 7 * dpr, y - 7 * dpr);
      }
    });
    if (state.drag && state.drag.kind === 'point') drawLoupe(state.points[state.drag.i]);
  }

  /** Grille 3D sur la surface + axes (X rouge, Y vert, Z bleu vers la caméra) + poignée de rotation. */
  function drawGizmo() {
    const g = gizmo();
    if (!g) return;
    const dpr = window.devicePixelRatio || 1;
    const P = (a, b) => (g.model ? add(g.model.C, add(scale(g.model.eu, a), scale(g.model.ev, b)))
      : add(g.C, add(scale(g.x, a), scale(g.y, b))));
    let a0 = -0.5, a1 = 0.5, b0 = -0.5, b1 = 0.5;
    if (g.grid) [a0, a1, b0, b1] = g.grid;
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = g.auto ? 'rgba(0, 220, 255, 0.25)' : 'rgba(0, 220, 255, 0.7)';
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (a1 - a0) * i / 8, b = b0 + (b1 - b0) * i / 8;
      polyPath([project(P(a, b0)), project(P(a, b1))]); ctx.stroke();
      polyPath([project(P(a0, b)), project(P(a1, b))]); ctx.stroke();
    }
    const size = g.model ? Math.min(Math.hypot(...g.model.eu), Math.hypot(...g.model.ev))
      : Math.min(a1 - a0, b1 - b0);
    const L = 0.5 * size;
    const o = toScreen(project(g.C));
    [[g.x, '#ff4d4d'], [g.y, '#3ce07a'], [scale(g.n, -1), '#4aa3ff']].forEach(([axis, col]) => {
      const e = toScreen(project(add(g.C, scale(axis, L))));
      ctx.lineWidth = 2.5 * dpr;
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(e[0], e[1]); ctx.stroke();
      const ang = Math.atan2(e[1] - o[1], e[0] - o[0]), hl = 8 * dpr;
      ctx.beginPath();
      ctx.moveTo(e[0], e[1]); ctx.lineTo(e[0] - hl * Math.cos(ang - 0.4), e[1] - hl * Math.sin(ang - 0.4));
      ctx.moveTo(e[0], e[1]); ctx.lineTo(e[0] - hl * Math.cos(ang + 0.4), e[1] - hl * Math.sin(ang + 0.4));
      ctx.stroke();
    });
    ctx.beginPath(); // poignée : glisser pour tourner la surface
    ctx.arc(o[0], o[1], 7 * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = state.drag && state.drag.kind === 'rotate' ? '#ffffff' : 'rgba(255,255,255,0.85)';
    ctx.fill();
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }

  function hitGizmo(x, y) {
    const g = gizmo();
    if (!g) return false;
    const o = toScreen(project(g.C));
    return Math.hypot(o[0] - x, o[1] - y) < 11 * (window.devicePixelRatio || 1);
  }

  /** Loupe x4 autour du point déplacé, dans le coin opposé. */
  function drawLoupe(p) {
    const dpr = window.devicePixelRatio || 1;
    const size = 130 * dpr, zoom = 4;
    const [sx] = toScreen(p);
    const dx = sx < canvas.width / 2 ? canvas.width - size - 8 * dpr : 8 * dpr, dy = 8 * dpr;
    const src = size / (zoom * state.view.s);
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(dx - 1, dy - 1, size + 2, size + 2);
    ctx.drawImage(state.img, p[0] - src / 2, p[1] - src / 2, src, src, dx, dy, size, size);
    ctx.strokeStyle = '#3ce07a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dx + size / 2, dy); ctx.lineTo(dx + size / 2, dy + size);
    ctx.moveTo(dx, dy + size / 2); ctx.lineTo(dx + size, dy + size / 2);
    ctx.stroke();
    ctx.strokeRect(dx, dy, size, size);
    ctx.restore();
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (ev) => {
    if (!state.img || !state.view) return;
    const [x, y] = canvasXY(ev);
    const hit = state.show === 'edit' ? hitPoint(x, y) : -1;
    if (ev.button === 2 && hit >= 0) { // clic droit sur un point : supprimer
      state.points.splice(hit, 1);
      invalidateResult();
      refresh();
      return;
    }
    if (ev.button === 1 || ev.button === 2 || state.space || state.show !== 'edit') {
      state.drag = { kind: 'pan', x, y };
      canvas.classList.add('pan');
      return;
    }
    if (hit < 0 && ev.button === 0 && hitGizmo(x, y)) { // tourner la surface en 3D
      const g = gizmo();
      state.drag = { kind: 'rotate', x0: x, y0: y, model: g.model, n0: g.n };
      return;
    }
    if (hit >= 0) {
      state.drag = { kind: 'point', i: hit };
    } else {
      if (state.tool === 'rect' && state.points.length >= 4) {
        toast('Le rectangle a déjà 4 coins : glissez-les pour les ajuster, ou effacez-les.', 3500);
        return;
      }
      state.points.push(toImage(x, y));
      state.drag = { kind: 'point', i: state.points.length - 1 };
    }
    invalidateResult();
    refresh();
  });

  window.addEventListener('mousemove', (ev) => {
    if (!state.view) return;
    const [x, y] = canvasXY(ev);
    if (state.drag && state.drag.kind === 'point') {
      const p = toImage(x, y);
      p[0] = Math.max(0, Math.min(state.img.width, p[0]));
      p[1] = Math.max(0, Math.min(state.img.height, p[1]));
      state.points[state.drag.i] = p;
      draw();
    } else if (state.drag && state.drag.kind === 'rotate') {
      const d = state.drag, dpr = window.devicePixelRatio || 1, k = 0.008 / dpr;
      const turn = ev.shiftKey  // Maj : rotation dans le plan de la surface
        ? (v) => rotate(v, d.n0, (x - d.x0) * k)
        : (v) => rotate(rotate(v, [0, 1, 0], (x - d.x0) * k), [1, 0, 0], -(y - d.y0) * k);
      if (d.model) { // rectangle / disque : les coins suivent la rotation
        state.points = cornersOf({ C: d.model.C, eu: turn(d.model.eu), ev: turn(d.model.ev) });
      } else {
        state.freeNormal = norm(turn(d.n0));
        state.orientManual = true;
      }
      invalidateResult();
      draw();
    } else if (state.drag && state.drag.kind === 'pan') {
      state.view.ox += x - state.drag.x;
      state.view.oy += y - state.drag.y;
      state.drag.x = x;
      state.drag.y = y;
      draw();
    } else if (ev.target === canvas && state.show === 'edit') {
      const h = hitPoint(x, y);
      canvas.style.cursor = h < 0 && hitGizmo(x, y) ? 'move' : '';
      if (h !== state.hover) { state.hover = h; draw(); }
    }
  });

  window.addEventListener('mouseup', () => {
    if (!state.drag) return;
    state.drag = null;
    canvas.classList.remove('pan');
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

  window.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    if (ev.code === 'Space') { state.space = true; canvas.classList.add('pan'); ev.preventDefault(); }
    if ((ev.key === 'Backspace' || ev.key === 'Delete') && state.show === 'edit' && state.points.length) {
      state.points.pop();
      invalidateResult();
      refresh();
      ev.preventDefault();
    }
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') { state.space = false; if (!state.drag) canvas.classList.remove('pan'); }
  });
  window.addEventListener('resize', draw);

  // ------------------------------------------------------------------ outils
  document.querySelectorAll('#toolbar [data-tool]').forEach((b) => b.addEventListener('click', () => {
    if (state.child || b.dataset.tool === state.tool) return;
    document.querySelectorAll('#toolbar [data-tool]').forEach((x) => x.classList.toggle('on', x === b));
    state.tool = b.dataset.tool;
    state.points = [];
    state.show = 'edit';
    invalidateResult();
    refresh();
  }));
  $('in-round').addEventListener('input', () => { invalidateResult(); refresh(); });
  $('btn-flip').addEventListener('click', () => { state.flip = !state.flip; invalidateResult(); refresh(); });
  $('btn-orient-auto').addEventListener('click', () => {
    state.orientManual = false;
    state.freeNormal = null;
    invalidateResult();
    refresh();
  });
  $('in-focal').addEventListener('input', () => { invalidateResult(); refresh(); });
  $('btn-clear').addEventListener('click', () => {
    if (state.child) return;
    state.points = [];
    state.show = 'edit';
    invalidateResult();
    refresh();
  });

  function refresh() {
    const n = state.points.length, round = +$('in-round').value;
    let hint = '';
    if (state.show === 'result') hint = 'Aperçu du résultat : vert = zone suivie, cyan = surface 3D.';
    else if (state.show === 'live') hint = 'Suivi en cours : arrêtez dès que la zone verte décroche, ce qui est déjà tracké est gardé.';
    else if (state.show === 'browse') hint = 'Relâchez sur une image nette où la surface est bien visible : elle devient la référence.';
    else if (state.img && state.tool === 'rect') {
      hint = n < 4 ? `Cliquez les 4 coins (${n}/4). Arrondi à fond = disque.`
        : isDisc() ? 'Disque : ajustez les coins pour que le cercle épouse le bord ; ⇅ inverse l\'inclinaison.'
          : round > 0 ? 'Placez les coins là où les bords droits se rejoindraient (pointillés).'
            : 'Prêt.';
      if (n === 4) hint += ' Glissez la poignée blanche pour tourner la surface (Maj : dans son plan).';
    } else if (state.img) {
      hint = n < 3 ? `Cliquez le contour d'une zone plane (${n}/3 min.).`
        : state.orientManual ? 'Grille alignée à la main : elle sera utilisée telle quelle.'
          : 'Orientation déduite du mouvement au tracking. Pour l\'imposer, glissez la poignée blanche jusqu\'à aligner la grille sur la scène.';
    }
    if (state.img && state.show === 'edit') hint += ' Molette : zoom · Espace : déplacer · Double-clic : recadrer.';
    $('hint').textContent = hint;
    $('round-val').textContent = round >= 100 ? 'disque' : `${round} %`;
    $('round-wrap').classList.toggle('hidden', state.tool !== 'rect');
    $('btn-flip').classList.toggle('hidden', !isDisc());
    $('btn-flip').classList.toggle('on', state.flip);
    $('orient-wrap').classList.toggle('hidden', !(state.tool === 'free' && state.orientManual));
    $('btn-track').disabled = !ready() || !!state.child || !inCEP;
    $('live-badge').classList.toggle('hidden', !((state.show === 'live' && state.live) || state.show === 'browse'));
    draw();
  }

  // ------------------------------------------------------------------ tracking
  function invalidateResult() {
    if (!state.result) return;
    stopPlay();
    state.result = null;
    if (state.show === 'result') state.show = 'edit';
    $('summary').innerHTML = '';
    $('result-actions').classList.add('hidden');
    $('apply-msg').classList.add('hidden');
    resetTimeline();
  }

  // ------------------------------------------------------------------ timeline avant tracking
  /** La timeline parcourt la plage du calque ; relâcher choisit l'image de référence. */
  function resetTimeline() {
    const sh = state.shot, sc = $('scrub');
    if (!sh) return;
    sc.min = String(sh.rangeStart);
    sc.max = String(sh.rangeEnd);
    sc.value = String(sh.frame);
    sc.disabled = false;
    $('btn-play').disabled = false;
    $('frame-label').textContent = `réf ${sh.frame}`;
  }

  function setupBrowse() {
    resetTimeline();
    if (!inCEP) return;
    const sh = state.shot, dir = path.join(state.workDir, 'thumbs');
    state.thumbsDir = dir;  // les vignettes apparaissent au fil de l'eau (~6 s pour 200 images 4K)
    runEngine(['thumbs', sh.file, String(sh.rangeStart), String(sh.rangeEnd), dir], () => {}, false).catch(() => {});
  }

  function browseTo(i) {
    $('frame-label').textContent = String(i);
    const p = state.thumbsDir && path.join(state.thumbsDir, String(i).padStart(5, '0') + '.jpg');
    if (!p || !fs.existsSync(p)) {
      $('live-badge').textContent = `Image ${i} — vignettes en préparation…`;
      return;
    }
    $('live-badge').textContent = `Image ${i} — relâchez pour en faire la référence`;
    const img = new Image();
    img.onload = () => { state.browseImg = img; if (state.show === 'browse') draw(); };
    img.src = fileUrl(p);
  }

  async function setReference(i) {
    const sh = state.shot;
    if (sh && i !== sh.frame) {
      $('live-badge').textContent = `Chargement de l'image ${i}…`;
      try {
        const fr = await runEngine(['frame', sh.file, String(i), path.join(state.workDir, `ref_${i}.jpg`)]);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = fileUrl(fr.path); });
        state.img = img;
        sh.frame = i;
      } catch (e) {
        toast(e.message || `Impossible de lire l'image ${i}.`);
      }
    }
    state.show = 'edit';
    resetTimeline();
    refresh();
  }

  async function track() {
    if (!ready() || !inCEP) return;
    stopPlay();
    const sh = state.shot;
    const pts = state.tool === 'rect' ? orderRect(state.points) : state.points;
    const args = ['track', sh.file, '--surface', state.tool,
      '--points', pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' '),
      '--ref-frame', String(sh.frame), '--start', String(sh.rangeStart), '--end', String(sh.rangeEnd),
      '--mode', 'object',  // la surface est animée, la caméra AE reste fixe : juste dans tous les cas
      '--out-dir', path.join(state.workDir, `run${++state.runCount}`),
      '--name', sh.footageName.replace(/\.[^.]+$/, '')];
    if (state.tool === 'rect') args.push('--roundness', String(+$('in-round').value / 100));
    const normal = chosenNormal();
    if (normal) args.push('--normal', normal.map((x) => x.toFixed(6)).join(','));
    const focal = parseFloat($('in-focal').value);
    if (focal > 0) args.push('--focal-mm', String(focal));

    $('log').textContent = '';
    state.live = null;
    state.show = 'live';
    invalidateResult();
    setBusy(true);
    try {
      const res = await runEngine(args, (ev) => {
        if (ev.type === 'log') {
          log(ev.msg);
        } else if (ev.type === 'live') {
          const img = new Image();
          img.onload = () => {
            state.live = { img, poly: ev.poly, frame: ev.frame };
            $('live-badge').textContent = `Image ${ev.frame}`;
            $('frame-label').textContent = String(ev.frame);
            if (state.show === 'live') draw();
          };
          img.src = ev.img;
        } else if (ev.type === 'progress') {
          const f = ev.stage === 'track' ? 0.9 * ev.done / ev.total : 0.9 + 0.1 * ev.done / ev.total;
          $('progress-bar').style.width = `${Math.round(100 * f)}%`;
          if (ev.stage === 'preview') $('live-badge').textContent = 'Calcul de la 3D et de l\'aperçu…';
        }
      });
      showResult(res);
    } catch (e) {
      state.show = 'edit';
      if (e.message !== 'Annulé.') toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(on) {
    $('btn-track').classList.toggle('hidden', on);
    $('btn-stop').classList.toggle('hidden', !on);
    $('btn-stop').disabled = false;
    $('btn-stop').textContent = '■ Arrêter';
    $('progress').classList.toggle('hidden', !on);
    $('scrub').classList.toggle('hidden', on);
    $('progress-bar').style.width = '0%';
    $('btn-load').disabled = on;
    $('toolbar').classList.toggle('disabled', on);
    $('orient-wrap').classList.toggle('disabled', on);
    refresh();
  }

  $('btn-track').addEventListener('click', track);
  $('btn-stop').addEventListener('click', () => {
    if (!state.child) return;
    state.child.stdin.write('stop\n');  // le moteur termine avec les images déjà trackées
    $('btn-stop').disabled = true;
    $('btn-stop').textContent = 'Arrêt…';
  });

  // ------------------------------------------------------------------ résultat
  function showResult(res) {
    state.result = res;
    state.show = 'result';
    const ul = $('summary');
    ul.innerHTML = '';
    const add = (cls, txt) => { const li = document.createElement('li'); li.className = cls; li.textContent = txt; ul.appendChild(li); };
    const lost = res.lost.length;
    add(lost ? 'warn' : 'ok', `${res.frames - lost}/${res.frames} images trackées` +
      (lost ? (res.stopped ? ' (arrêté : le reste n\'a pas de clé)' : ` (suivi perdu sur ${lost}, sans clé)`) : ''));
    if (!/métadonnées|saisie/.test(res.focal_source)) add('warn', `Focale : ${res.focal_source}`);
    add(res.error_mean < 1.5 ? 'ok' : 'warn',
      `Calage 3D sur la 2D : ${res.error_mean.toFixed(2)} px en moyenne (max ${res.error_max.toFixed(1)})`);
    $('flip-wrap').classList.toggle('hidden', !res.alt_jsx);
    $('chk-flip').checked = false;
    $('result-actions').classList.remove('hidden');
    $('apply-msg').classList.add('hidden');

    const sc = $('scrub');
    sc.min = String(res.start);
    sc.max = String(res.end);
    sc.value = String(state.shot.frame);
    sc.disabled = false;
    $('btn-play').disabled = false;
    showFrame(+sc.value);
    refresh();
  }

  function previewDir() {
    const r = state.result;
    return $('chk-flip').checked && r.alt_preview_dir ? r.alt_preview_dir : r.preview_dir;
  }

  function showFrame(i) {
    if (!state.result) return;
    $('frame-label').textContent = String(i);
    const img = new Image();
    img.onload = () => { state.previewImg = img; if (state.show === 'result') draw(); };
    img.src = fileUrl(path.join(previewDir(), String(i).padStart(5, '0') + '.jpg'));
  }

  let syncTimer = null;
  function syncAE(i) { // l'instant d'AE suit l'aperçu (hors lecture)
    if (state.playTimer || !state.shot) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => host('stGoToFrame', state.shot.compId, state.shot.timeOffset, state.shot.fps, i), 120);
  }

  $('scrub').addEventListener('input', () => {
    const i = +$('scrub').value;
    if (state.result) {
      if (state.show !== 'result') { state.show = 'result'; refresh(); }
      showFrame(i);
    } else {
      if (state.show !== 'browse') { state.show = 'browse'; refresh(); }
      browseTo(i);
    }
    syncAE(i);
  });
  $('scrub').addEventListener('change', () => {
    if (!state.result && !state.playTimer) setReference(+$('scrub').value);
  });
  $('chk-flip').addEventListener('change', () => showFrame(+$('scrub').value));

  function stopPlay() {
    if (state.playTimer) clearInterval(state.playTimer);
    state.playTimer = null;
    $('btn-play').textContent = '▶';
  }
  $('btn-play').addEventListener('click', () => {
    if (state.playTimer) {
      stopPlay();
      syncAE(+$('scrub').value);
      if (!state.result) setReference(+$('scrub').value);  // avant tracking : la pause choisit la référence
      return;
    }
    $('btn-play').textContent = '❚❚';
    state.show = state.result ? 'result' : 'browse';
    refresh();
    const fps = Math.min(25, state.shot.fps || 25);
    state.playTimer = setInterval(() => {
      const sc = $('scrub');
      const i = +sc.value >= +sc.max ? +sc.min : +sc.value + 1;
      sc.value = String(i);
      if (state.result) showFrame(i); else browseTo(i);
    }, 1000 / fps);
  });

  $('btn-edit').addEventListener('click', () => { // revenir aux points sans les effacer
    stopPlay();
    state.show = 'edit';
    refresh();
  });

  $('btn-apply').addEventListener('click', async () => {
    const r = state.result;
    if (!r) return;
    const jsx = $('chk-flip').checked && r.alt_jsx ? r.alt_jsx : r.jsx;
    $('btn-apply').disabled = true;
    const out = await host('stApply', state.shot.compId, state.shot.layerIndex, jsx, state.shot.timeOffset);
    $('btn-apply').disabled = false;
    const box = $('apply-msg');
    box.classList.remove('hidden');
    box.style.color = out.ok ? '' : 'var(--err)';
    box.textContent = out.ok ? out.msg.replace(/^3D Surface Tracker — /, '') : out.msg;
  });

  $('btn-load').addEventListener('click', () => host('stGetSelection').then(loadShot));

  // ------------------------------------------------------------------ démarrage
  if (!inCEP) {
    // aperçu dans un navigateur : éditeur seul, avec une image de démonstration si présente
    $('shot-empty').textContent = 'Mode démo (hors After Effects) : éditeur seul.';
    $('btn-load').disabled = true;
    enable('s-surface', true);
    loadImage('demo.jpg').then(refresh).catch(() => refresh());
  } else {
    heartbeat();
    setInterval(heartbeat, 1000);
    refresh();
  }
})();
