/* 3D Surface Tracker — panneau After Effects (CEP).
 *
 * Le panneau pilote le moteur Python (engine.py, lignes JSON sur stdout) via Node.js
 * et parle à After Effects via ExtendScript (jsx/host.jsx).
 * Hors d'After Effects (navigateur), il passe en mode démo : éditeur de points seul.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const inCEP = !!window.__adobe_cep__;
  const nodeRequire = typeof require === 'function' ? require : (window.cep_node && window.cep_node.require);
  const fs = nodeRequire && nodeRequire('fs');
  const path = nodeRequire && nodeRequire('path');
  const cp = nodeRequire && nodeRequire('child_process');
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

  // ------------------------------------------------------------------ état
  const state = {
    shot: null,          // calque chargé (réponse de stGetSelection)
    workDir: null,
    surface: 'rect',
    mode: 'object',
    points: [],          // en pixels de la vidéo
    img: null,           // image de référence
    view: null,          // {s, ox, oy} en pixels canvas
    show: 'edit',        // 'edit' | 'result'
    drag: null,          // {kind:'point', i} | {kind:'pan', x, y}
    hover: -1,
    space: false,
    result: null,
    previewImg: null,
    child: null,
    runCount: 0,
    playTimer: null,
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
  function runEngine(args, onEvent) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(PY)) {
        reject(new Error("Environnement Python introuvable :\n" + PY +
          "\n\nDans le Terminal, depuis le dossier du projet :\n/usr/bin/python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"));
        return;
      }
      const env = Object.assign({}, nodeProcess.env, { PYTHONUNBUFFERED: '1' });
      // AE ne transmet pas le PATH du Terminal : on ajoute Homebrew pour ffmpeg (métadonnées caméra)
      env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', env.PATH || '/usr/bin:/bin'].join(':');
      const child = cp.spawn(PY, [ENGINE].concat(args), { cwd: ROOT, env });
      state.child = child;
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

  // ------------------------------------------------------------------ 1. chargement du plan
  async function loadShot() {
    const sel = await host('stGetSelection');
    if (!sel.ok) { toast(sel.msg); return; }
    stopPlay();
    state.shot = sel;
    state.points = [];
    state.result = null;
    state.show = 'edit';
    const stem = path.basename(sel.file).replace(/\.[^.]+$/, '');
    state.workDir = path.join(ROOT, 'out', 'panel', `${stem}_${stamp()}`);

    $('shot-info').classList.remove('hidden');
    const via = sel.chain.length > 1 ? ` <span class="dim">(via ${sel.chain.slice(1).map(escapeHtml).join(' › ')})</span>` : '';
    $('shot-info').innerHTML = `<b>${escapeHtml(sel.layerName)}</b> — ${escapeHtml(path.basename(sel.file))}${via}<br>` +
      `Compo « ${escapeHtml(sel.compName)} » · image de référence <b>${sel.frame}</b> (instant courant)`;
    const w = $('shot-warnings');
    w.innerHTML = '';
    sel.warnings.forEach((m) => { const li = document.createElement('li'); li.textContent = m; w.appendChild(li); });
    $('focal-note').textContent = '';

    $('btn-load').disabled = true;
    $('btn-load').textContent = "Lecture de l'image…";
    try {
      const fr = await runEngine(['frame', sel.file, String(sel.frame), path.join(state.workDir, 'ref.jpg')]);
      await loadImage(fr.path);
      enable('s-surface', true);
      enable('s-track', true);
      enable('s-result', false);
      runEngine(['info', sel.file]).then((info) => {
        $('focal-note').textContent = info.lens
          ? `Métadonnées : ${info.lens.focal35_mm} mm (${info.lens.camera}), utilisée automatiquement.`
          : 'Pas de métadonnées de focale : saisissez-la si vous la connaissez (indispensable pour un disque).';
        if (!info.lens && state.surface === 'disc') $('advanced').open = true;
      }).catch(() => {});
    } catch (e) {
      toast(e.message);
    } finally {
      $('btn-load').disabled = false;
      $('btn-load').textContent = 'Charger le calque sélectionné';
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ------------------------------------------------------------------ 2. éditeur de surface
  const canvas = $('view');
  const ctx = canvas.getContext('2d');

  function shownImage() {
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
      if (v && canvas.width) { // garder le centre de la vue
        v.ox += (w - canvas.width) / 2;
        v.oy += (h - canvas.height) / 2;
      }
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

  /** Coins d'un rectangle dans l'ordre haut-gauche, haut-droit, bas-droit, bas-gauche. */
  function orderRect(pts) {
    if (pts.length !== 4) return pts;
    const cx = pts.reduce((a, p) => a + p[0], 0) / 4, cy = pts.reduce((a, p) => a + p[1], 0) / 4;
    const s = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let k = 0;
    s.forEach((p, i) => { if (p[0] + p[1] < s[k][0] + s[k][1]) k = i; });
    return s.slice(k).concat(s.slice(0, k));
  }

  /** Ellipse aux moindres carrés (ax²+bxy+cy²+dx+ey=1) -> {cx, cy, a, b, theta} ou null. */
  function fitEllipse(pts) {
    if (pts.length < 5) return null;
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const sc = Math.max(...pts.map((p) => Math.hypot(p[0] - mx, p[1] - my))) || 1;
    const M = Array.from({ length: 5 }, () => new Array(6).fill(0));
    pts.forEach((p) => {
      const x = (p[0] - mx) / sc, y = (p[1] - my) / sc;
      const r = [x * x, x * y, y * y, x, y];
      for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) M[i][j] += r[i] * r[j]; M[i][5] += r[i]; }
    });
    for (let c = 0; c < 5; c++) { // élimination de Gauss
      let piv = c;
      for (let r = c + 1; r < 5; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < 5; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k < 6; k++) M[r][k] -= f * M[c][k];
      }
    }
    const [a, b, c, d, e] = M.map((row, i) => row[5] / row[i]);
    const det = 4 * a * c - b * b;
    if (det <= 0) return null;
    const x0 = (b * e - 2 * c * d) / det, y0 = (b * d - 2 * a * e) / det;
    const f0 = a * x0 * x0 + b * x0 * y0 + c * y0 * y0 + d * x0 + e * y0 - 1;
    const th = 0.5 * Math.atan2(b, a - c);
    const co = Math.cos(th), si = Math.sin(th);
    const l1 = a * co * co + b * co * si + c * si * si, l2 = a * si * si - b * co * si + c * co * co;
    if (-f0 / l1 <= 0 || -f0 / l2 <= 0) return null;
    return { cx: x0 * sc + mx, cy: y0 * sc + my, a: Math.sqrt(-f0 / l1) * sc, b: Math.sqrt(-f0 / l2) * sc, theta: th };
  }

  function ready() {
    return state.surface === 'rect' ? state.points.length === 4 : state.points.length >= 5;
  }

  function draw() {
    resizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = shownImage();
    $('canvas-empty').classList.toggle('hidden', !!img);
    if (!img || !state.view) return;
    const v = state.view;
    // l'aperçu est plus petit que l'image de référence : on l'étire au même cadre
    const k = state.img.width / img.width;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, v.ox, v.oy, img.width * k * v.s, img.height * k * v.s);
    if (state.show === 'edit') drawShape();
  }

  function drawShape() {
    const dpr = window.devicePixelRatio || 1;
    const pts = state.points;
    const ok = ready();
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = ok ? '#3ce07a' : '#f0c040';
    if (state.surface === 'rect' && pts.length > 1) {
      const o = pts.length === 4 ? orderRect(pts) : pts;
      ctx.beginPath();
      o.forEach((p, i) => { const [x, y] = toScreen(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      if (pts.length === 4) ctx.closePath();
      ctx.stroke();
    }
    if (state.surface === 'disc') {
      const e = fitEllipse(pts);
      if (e) {
        const [cx, cy] = toScreen([e.cx, e.cy]);
        ctx.beginPath();
        ctx.ellipse(cx, cy, e.a * state.view.s, e.b * state.view.s, e.theta, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
    const labels = ['HG', 'HD', 'BD', 'BG'];
    const ordered = state.surface === 'rect' && pts.length === 4 ? orderRect(pts) : null;
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

  /** Loupe x4 autour du point déplacé, dans le coin opposé. */
  function drawLoupe(p) {
    const dpr = window.devicePixelRatio || 1;
    const size = 130 * dpr, zoom = 4;
    const [sx, sy] = toScreen(p);
    const dx = sx < canvas.width / 2 ? canvas.width - size - 8 * dpr : 8 * dpr;
    const dy = 8 * dpr;
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
      refresh();
      return;
    }
    if (ev.button === 1 || ev.button === 2 || state.space || state.show === 'result') {
      state.drag = { kind: 'pan', x, y };
      canvas.classList.add('pan');
      return;
    }
    if (hit >= 0) {
      state.drag = { kind: 'point', i: hit };
    } else {
      if (state.surface === 'rect' && state.points.length >= 4) {
        toast('Le rectangle a déjà 4 coins : glissez-les pour les ajuster, ou « Effacer ».', 3500);
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
    } else if (state.drag && state.drag.kind === 'pan') {
      state.view.ox += x - state.drag.x;
      state.view.oy += y - state.drag.y;
      state.drag.x = x;
      state.drag.y = y;
      draw();
    } else if (ev.target === canvas && state.show === 'edit') {
      const h = hitPoint(x, y);
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
    const f = Math.pow(1.0015, -ev.deltaY);
    const s = Math.max(v.fit * 0.5, Math.min(v.fit * 24, v.s * f));
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

  function segment(id, key, onChange) {
    $(id).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      state[key] = b.dataset.v;
      if (onChange) onChange();
    }));
  }
  segment('seg-surface', 'surface', () => { state.points = []; invalidateResult(); refresh(); });
  segment('seg-mode', 'mode', () => invalidateResult());

  $('btn-clear').addEventListener('click', () => {
    if (state.show === 'result') { // « Retoucher » : revenir aux points sans les effacer
      stopPlay();
      state.show = 'edit';
    } else {
      state.points = [];
      invalidateResult();
    }
    refresh();
  });
  $('in-smooth').addEventListener('input', () => {
    const v = +$('in-smooth').value;
    $('smooth-val').textContent = v < 0 ? 'auto' : String(v);
    invalidateResult();
  });
  $('in-focal').addEventListener('input', invalidateResult);

  function refresh() {
    const n = state.points.length;
    let hint;
    if (state.show === 'result') hint = 'Aperçu du résultat : vert = zone suivie, cyan = surface 3D.';
    else if (!state.img) hint = '';
    else if (state.surface === 'rect') {
      hint = n < 4 ? `Cliquez les 4 coins du rectangle (${n}/4).` : 'Prêt. Glissez un coin pour l\'ajuster.';
    } else {
      hint = n < 5 ? `Cliquez des points sur le bord du disque (${n}/5 min., 8+ conseillé).`
        : `Prêt (${n} points). Ajoutez-en ou glissez-les pour ajuster.`;
    }
    if (state.img && state.show === 'edit') hint += ' Molette : zoom · Espace/clic droit : déplacer · Clic droit sur un point : supprimer.';
    $('hint').textContent = hint;
    $('btn-track').disabled = !ready() || !!state.child;
    $('btn-clear').textContent = state.show === 'result' ? 'Retoucher' : 'Effacer';
    draw();
  }

  // ------------------------------------------------------------------ 3. tracking
  function invalidateResult() {
    if (!state.result) return;
    stopPlay();
    state.result = null;
    state.show = 'edit';
    enable('s-result', false);
  }

  async function track() {
    if (!ready() || !inCEP) return;
    stopPlay();
    const sh = state.shot;
    const pts = state.surface === 'rect' ? orderRect(state.points) : state.points;
    const args = ['track', sh.file, '--surface', state.surface,
      '--points', pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' '),
      '--ref-frame', String(sh.frame), '--mode', state.mode,
      '--out-dir', path.join(state.workDir, `run${++state.runCount}`),
      '--name', sh.footageName.replace(/\.[^.]+$/, '')];
    const focal = parseFloat($('in-focal').value);
    if (focal > 0) args.push('--focal-mm', String(focal));
    const smooth = +$('in-smooth').value;
    if (smooth >= 0) args.push('--smooth', String(smooth));

    $('log').textContent = '';
    state.warnings = [];
    setBusy(true);
    try {
      const res = await runEngine(args, (ev) => {
        if (ev.type === 'log') {
          log(ev.msg);
          if (ev.msg.indexOf('⚠') === 0) state.warnings.push(ev.msg.replace(/^⚠\s*/, ''));
        } else if (ev.type === 'progress') {
          const f = ev.stage === 'track' ? 0.9 * ev.done / ev.total : 0.9 + 0.1 * ev.done / ev.total;
          setProgress(f, ev.stage === 'track' ? `Tracking ${ev.done}/${ev.total}` : 'Préparation de l\'aperçu…');
        }
      });
      showResult(res);
    } catch (e) {
      if (e.message !== 'Annulé.') toast(e.message);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(on) {
    $('btn-track').classList.toggle('hidden', on);
    $('btn-cancel').classList.toggle('hidden', !on);
    $('progress').classList.toggle('hidden', !on);
    $('btn-load').disabled = on;
    enable('s-surface', !on && !!state.img);
    if (on) setProgress(0, 'Démarrage…');
    refresh();
  }

  function setProgress(f, label) {
    $('progress-bar').style.width = `${Math.round(100 * f)}%`;
    $('progress-label').textContent = label;
  }

  $('btn-track').addEventListener('click', track);
  $('btn-cancel').addEventListener('click', () => { if (state.child) state.child.kill(); });

  // ------------------------------------------------------------------ 4. résultat
  function showResult(res) {
    state.result = res;
    state.show = 'result';
    const ul = $('summary');
    ul.innerHTML = '';
    const add = (cls, txt) => { const li = document.createElement('li'); li.className = cls; li.textContent = txt; ul.appendChild(li); };
    const lost = res.lost.length;
    add(lost ? 'warn' : 'ok', `${res.frames - lost}/${res.frames} images trackées` +
      (lost ? ` — suivi perdu sur ${lost} image(s), sans image clé` : ''));
    const metaFocal = /métadonnées|saisie/.test(res.focal_source);
    add(metaFocal ? 'ok' : 'warn', `Focale ${Math.round(res.focal)} px — ${res.focal_source}`);
    add(res.error_mean < 1.5 ? 'ok' : 'warn',
      `Calage 3D sur la 2D : ${res.error_mean.toFixed(2)} px en moyenne (max ${res.error_max.toFixed(1)} px)`);
    if (res.alt_jsx) add('warn', 'Inclinaison ambiguë (peu de perspective) : comparez avec « Inclinaison inversée ».');
    $('flip-wrap').classList.toggle('hidden', !res.alt_jsx);
    $('chk-flip').checked = false;
    $('apply-msg').classList.add('hidden');

    const sc = $('scrub');
    sc.max = String(res.frames - 1);
    sc.value = String(state.shot.frame);
    enable('s-result', true);
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
  function syncAE(i) {
    if (!$('chk-sync').checked || state.playTimer) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => host('stGoToFrame', state.shot.compId, state.shot.timeOffset, state.shot.fps, i), 120);
  }

  $('scrub').addEventListener('input', () => {
    const i = +$('scrub').value;
    if (state.show !== 'result') { state.show = 'result'; refresh(); }
    showFrame(i);
    syncAE(i);
  });
  $('chk-flip').addEventListener('change', () => showFrame(+$('scrub').value));

  function stopPlay() {
    if (state.playTimer) clearInterval(state.playTimer);
    state.playTimer = null;
    $('btn-play').textContent = '▶';
  }
  $('btn-play').addEventListener('click', () => {
    if (state.playTimer) { stopPlay(); syncAE(+$('scrub').value); return; }
    $('btn-play').textContent = '❚❚';
    const fps = Math.min(25, state.shot.fps || 25);
    state.playTimer = setInterval(() => {
      const sc = $('scrub');
      const i = (+sc.value + 1) % (+sc.max + 1);
      sc.value = String(i);
      showFrame(i);
    }, 1000 / fps);
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

  $('btn-load').addEventListener('click', loadShot);

  // ------------------------------------------------------------------ démarrage
  if (!inCEP) {
    // aperçu dans un navigateur : éditeur seul, avec une image de démonstration si présente
    $('version').textContent = '0.1 · mode démo (hors After Effects)';
    $('btn-load').disabled = true;
    enable('s-surface', true);
    loadImage('demo.jpg').then(refresh).catch(() => refresh());
  } else {
    refresh();
  }
})();
