'use strict';
// PDF Notizen – PDFs lesen, beschriften und weiterschicken.
// Notizen werden in PDF-Koordinaten gespeichert, damit sie beim Zoomen an der richtigen Stelle bleiben.

pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const SIZES = { pen: [1.5, 3, 6], marker: [10, 16, 24], text: [10, 14, 20] };
const COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#212121'];
const MAX_PIXELS = 12e6; // Obergrenze pro Bild, damit das Handy nicht überlastet wird

const S = {
  bytes: null, doc: null, name: '', scale: 1, fit: true, tool: 'hand',
  color: { pen: '#e53935', marker: '#fdd835', text: '#1e88e5' }, size: 1,
  pages: [], undo: [], dirty: false, observer: null,
};

const $ = (s) => document.querySelector(s);
const viewer = $('#viewer');
const pagesEl = $('#pages');

// ---------- Hilfsfunktionen ----------
function setBusy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busyText').textContent = text;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function hexToRgb(h) {
  return PDFLib.rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
}
function ratioFor(vp) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  return Math.min(dpr, Math.sqrt(MAX_PIXELS / (vp.width * vp.height)));
}

// ---------- PDF öffnen ----------
async function openFile(file) {
  if (S.dirty && !confirm('Deine Notizen sind noch nicht gespeichert oder gesendet. Trotzdem ein anderes PDF öffnen?')) return;
  setBusy('PDF wird geöffnet …');
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjsLib.getDocument({ data: buf.slice() }).promise;
    if (S.doc) S.doc.destroy();
    if (S.observer) S.observer.disconnect();
    S.doc = doc;
    S.bytes = buf;
    S.name = (file.name || 'Dokument').replace(/\.pdf$/i, '');
    S.pages = []; S.undo = []; S.dirty = false;
    pagesEl.innerHTML = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const pdfPage = await doc.getPage(i);
      const wrap = document.createElement('div');
      wrap.className = 'page';
      wrap.dataset.i = i - 1;
      const canvas = document.createElement('canvas');
      const overlay = document.createElement('canvas');
      overlay.className = 'ink';
      wrap.append(canvas, overlay);
      pagesEl.append(wrap);
      const p = { i: i - 1, pdfPage, wrap, canvas, overlay, annots: [], visible: false, task: null, ratio: 1 };
      bindInk(p);
      S.pages.push(p);
    }
    document.body.classList.add('has-doc');
    $('#docname').textContent = S.name;
    S.fit = true;
    layoutAll();
    makeObserver();
    viewer.scrollTop = 0;
    viewer.scrollLeft = 0;
    updatePageInfo();
    updateButtons();
  } catch (err) {
    console.error(err);
    const msg = err && err.name === 'PasswordException'
      ? 'Dieses PDF ist mit einem Passwort geschützt und kann nicht geöffnet werden.'
      : 'Dieses PDF konnte nicht geöffnet werden.\n\n' + (err.message || err);
    alert(msg);
  } finally {
    setBusy(null);
  }
}

// ---------- Seiten anzeigen ----------
function fitScale() {
  const w = S.pages[0].pdfPage.getViewport({ scale: 1 }).width;
  return Math.max(0.2, (viewer.clientWidth - 16) / w);
}

function layoutAll() {
  if (!S.pages.length) return;
  if (S.fit) S.scale = fitScale();
  for (const p of S.pages) {
    if (p.task) { p.task.cancel(); p.task = null; }
    p.vp = p.pdfPage.getViewport({ scale: S.scale });
    p.wrap.style.width = p.vp.width + 'px';
    p.wrap.style.height = p.vp.height + 'px';
    if (p.visible) { p.visible = false; showPage(p); }
  }
}

function makeObserver() {
  S.observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = S.pages[+e.target.dataset.i];
      if (!p) continue;
      if (e.isIntersecting) showPage(p); else hidePage(p);
    }
  }, { root: viewer, rootMargin: '800px 400px' });
  S.pages.forEach((p) => S.observer.observe(p.wrap));
}

function sizeCanvas(c, vp) {
  const r = ratioFor(vp);
  c.width = Math.floor(vp.width * r);
  c.height = Math.floor(vp.height * r);
  c.style.width = vp.width + 'px';
  c.style.height = vp.height + 'px';
  return r;
}

async function showPage(p) {
  if (p.visible) return;
  p.visible = true;
  p.ratio = sizeCanvas(p.overlay, p.vp);
  drawInk(p);
  const r = sizeCanvas(p.canvas, p.vp);
  const task = p.pdfPage.render({
    canvasContext: p.canvas.getContext('2d'),
    viewport: p.vp,
    transform: r !== 1 ? [r, 0, 0, r, 0, 0] : null,
  });
  p.task = task;
  try { await task.promise; } catch (e) { /* abgebrochen, z. B. beim Zoomen */ }
  if (p.task === task) p.task = null;
}

function hidePage(p) {
  if (!p.visible) return;
  p.visible = false;
  if (p.task) { p.task.cancel(); p.task = null; }
  p.canvas.width = p.canvas.height = 0; // Speicher freigeben
  p.overlay.width = p.overlay.height = 0;
}

function setZoom(ns, cx = viewer.clientWidth / 2, cy = viewer.clientHeight / 2) {
  if (!S.pages.length) return;
  const old = S.scale;
  ns = clamp(ns, 0.25, 6);
  if (Math.abs(ns - old) < 0.001) return;
  const px = viewer.scrollLeft + cx, py = viewer.scrollTop + cy;
  S.fit = false;
  S.scale = ns;
  layoutAll();
  const k = ns / old;
  viewer.scrollLeft = px * k - cx;
  viewer.scrollTop = py * k - cy;
}

function updatePageInfo() {
  if (!S.pages.length) { $('#pageinfo').textContent = ''; return; }
  const mid = viewer.scrollTop + viewer.clientHeight / 2;
  let cur = 1;
  for (const p of S.pages) { if (p.wrap.offsetTop <= mid) cur = p.i + 1; else break; }
  $('#pageinfo').textContent = 'Seite ' + cur + ' von ' + S.pages.length;
}
let scrollRaf = 0;
viewer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updatePageInfo(); });
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (S.fit) layoutAll(); }, 200);
});

// ---------- Zwei-Finger-Zoom ----------
let pinch = null;
function touchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
viewer.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 2 || !S.pages.length) return;
  S.pages.forEach((p) => p.cancel && p.cancel());
  const r = viewer.getBoundingClientRect();
  const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
  const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
  pinch = { d0: touchDist(e.touches), k: 1, cx, cy };
  pagesEl.style.transformOrigin = (cx + viewer.scrollLeft) + 'px ' + (cy + viewer.scrollTop) + 'px';
}, { passive: true });
viewer.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  pinch.k = clamp(touchDist(e.touches) / pinch.d0, 0.25 / S.scale, 6 / S.scale);
  pagesEl.style.transform = 'scale(' + pinch.k + ')';
}, { passive: false });
viewer.addEventListener('touchend', (e) => {
  if (!pinch || e.touches.length >= 2) return;
  const { k, cx, cy } = pinch;
  pinch = null;
  pagesEl.style.transform = '';
  setZoom(S.scale * k, cx, cy);
});

// ---------- Notizen zeichnen ----------
function toPdf(p, x, y) { return p.vp.convertToPdfPoint(x, y); }
function toView(p, pt) { return p.vp.convertToViewportPoint(pt[0], pt[1]); }

function drawInk(p, extra) {
  const c = p.overlay;
  if (!c.width) return;
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(p.ratio, 0, 0, p.ratio, 0, 0);
  for (const a of p.annots) drawAnnot(ctx, p, a);
  if (extra) drawAnnot(ctx, p, extra);
}

function drawAnnot(ctx, p, a) {
  const s = p.vp.scale;
  ctx.save();
  if (a.type === 'stroke') {
    ctx.globalAlpha = a.tool === 'marker' ? 0.35 : 1;
    ctx.strokeStyle = a.color;
    ctx.lineWidth = a.width * s;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    a.points.forEach((pt, j) => {
      const [x, y] = toView(p, pt);
      if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
  } else if (a.type === 'text') {
    const fs = a.size * s;
    ctx.fillStyle = a.color;
    ctx.font = fs + 'px Helvetica, Arial, sans-serif';
    const [x, y] = toView(p, a.at);
    const lines = a.text.split('\n');
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const pad = fs * 0.25;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - pad, y - pad, w + 2 * pad, lines.length * fs * 1.2 + pad);
    ctx.globalAlpha = 1;
    ctx.fillStyle = a.color;
    lines.forEach((ln, j) => ctx.fillText(ln, x, y + fs * 0.8 + j * fs * 1.2));
  }
  ctx.restore();
}

function bindInk(p) {
  const o = p.overlay;
  let cur = null, erasing = false, pid = null;
  const pos = (e) => { const r = o.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  p.cancel = () => { cur = null; erasing = false; pid = null; drawInk(p); };

  o.addEventListener('pointerdown', async (e) => {
    if (S.tool === 'hand' || pid !== null || !e.isPrimary || pinch) return;
    e.preventDefault();
    const [x, y] = pos(e);
    if (S.tool === 'text') {
      const at = toPdf(p, x, y);
      const t = await askText();
      if (t && t.trim()) add(p, { type: 'text', at, text: t.replace(/\s+$/, ''), color: S.color.text, size: SIZES.text[S.size] });
      return;
    }
    pid = e.pointerId;
    try { o.setPointerCapture(pid); } catch (_) { /* egal */ }
    if (S.tool === 'eraser') { erasing = true; eraseAt(p, x, y); return; }
    cur = { type: 'stroke', tool: S.tool, color: S.color[S.tool], width: SIZES[S.tool][S.size], points: [toPdf(p, x, y)] };
    drawInk(p, cur);
  });

  o.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid || pinch) return;
    const [x, y] = pos(e);
    if (erasing) { eraseAt(p, x, y); return; }
    if (cur) { cur.points.push(toPdf(p, x, y)); drawInk(p, cur); }
  });

  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null; erasing = false;
    if (cur) {
      if (cur.points.length === 1) { const [a, b] = cur.points[0]; cur.points.push([a + 0.01, b]); }
      const done = cur; cur = null;
      add(p, done);
    }
  };
  o.addEventListener('pointerup', end);
  o.addEventListener('pointercancel', end);
}

function add(p, a) {
  p.annots.push(a);
  S.undo.push({ op: 'add', p, a });
  changed(p);
}

function eraseAt(p, x, y) {
  const ctx = p.overlay.getContext('2d');
  for (let k = p.annots.length - 1; k >= 0; k--) {
    if (hit(ctx, p, p.annots[k], x, y)) {
      const [a] = p.annots.splice(k, 1);
      S.undo.push({ op: 'del', p, a, k });
      changed(p);
      return;
    }
  }
}

function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? clamp(((x - a[0]) * dx + (y - a[1]) * dy) / l, 0, 1) : 0;
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

function hit(ctx, p, a, x, y) {
  const s = p.vp.scale, tol = 14;
  if (a.type === 'stroke') {
    const r = (a.width * s) / 2 + tol;
    let prev = null;
    for (const pt of a.points) {
      const v = toView(p, pt);
      if (prev ? segDist(x, y, prev, v) <= r : Math.hypot(x - v[0], y - v[1]) <= r) return true;
      prev = v;
    }
    return false;
  }
  const fs = a.size * s;
  const lines = a.text.split('\n');
  ctx.save();
  ctx.font = fs + 'px Helvetica, Arial, sans-serif';
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  const [tx, ty] = toView(p, a.at);
  return x >= tx - tol && x <= tx + w + tol && y >= ty - tol && y <= ty + lines.length * fs * 1.2 + tol;
}

function undo() {
  const u = S.undo.pop();
  if (!u) return;
  if (u.op === 'add') {
    const k = u.p.annots.indexOf(u.a);
    if (k >= 0) u.p.annots.splice(k, 1);
  } else {
    u.p.annots.splice(u.k, 0, u.a);
  }
  changed(u.p);
}

function changed(p) {
  S.dirty = S.pages.some((q) => q.annots.length > 0);
  drawInk(p);
  updateButtons();
}

function askText() {
  return new Promise((resolve) => {
    const m = $('#textModal'), ta = $('#textInput');
    ta.value = '';
    m.hidden = false;
    setTimeout(() => ta.focus(), 50);
    const done = (v) => {
      m.hidden = true;
      $('#textOk').onclick = $('#textCancel').onclick = null;
      resolve(v);
    };
    $('#textOk').onclick = () => done(ta.value);
    $('#textCancel').onclick = () => done(null);
  });
}

// ---------- PDF mit Notizen erzeugen ----------
async function buildPdf() {
  const { PDFDocument, StandardFonts, LineCapStyle } = PDFLib;
  const doc = await PDFDocument.load(S.bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ok = new Set(font.getCharacterSet());
  const clean = (t) => Array.from(t).map((ch) => (ok.has(ch.codePointAt(0)) ? ch : '?')).join('');
  const pages = doc.getPages();
  S.pages.forEach((p, i) => {
    const pg = pages[i];
    if (!pg) return;
    for (const a of p.annots) {
      const color = hexToRgb(a.color);
      if (a.type === 'stroke') {
        const d = a.points.map((pt, j) => (j ? 'L' : 'M') + pt[0].toFixed(2) + ',' + (-pt[1]).toFixed(2)).join(' ');
        pg.drawSvgPath(d, {
          x: 0, y: 0, borderColor: color, borderWidth: a.width,
          borderOpacity: a.tool === 'marker' ? 0.35 : 1, borderLineCap: LineCapStyle.Round,
        });
      } else if (a.type === 'text') {
        const lines = a.text.split('\n').map(clean);
        const w = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, a.size)));
        const pad = a.size * 0.25;
        pg.drawRectangle({
          x: a.at[0] - pad, y: a.at[1] - lines.length * a.size * 1.2, width: w + 2 * pad,
          height: lines.length * a.size * 1.2 + pad, color: PDFLib.rgb(1, 1, 1), opacity: 0.85,
        });
        lines.forEach((ln, j) => {
          if (!ln) return;
          pg.drawText(clean(ln), { x: a.at[0], y: a.at[1] - a.size * 0.8 - j * a.size * 1.2, size: a.size, font, color });
        });
      }
    }
  });
  return doc.save();
}

async function makeFile() {
  setBusy('PDF wird vorbereitet …');
  try {
    const bytes = await buildPdf();
    return new File([bytes], S.name + '-Notizen.pdf', { type: 'application/pdf' });
  } finally {
    setBusy(null);
  }
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const canShareFile = (file) => !!(navigator.canShare && navigator.canShare({ files: [file] }));

async function shareFile(file) {
  await navigator.share({ files: [file], title: file.name });
  S.dirty = false;
}

async function onShare() {
  if (!S.doc) return;
  let file;
  try { file = await makeFile(); } catch (e) { alert('Das PDF konnte nicht erstellt werden.\n\n' + e.message); return; }
  if (canShareFile(file)) {
    try { await shareFile(file); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  openShareModal(file);
}

function openShareModal(file) {
  const can = canShareFile(file);
  $('#shareText').textContent = can
    ? 'Tippe auf „Jetzt senden“ und wähle dann WhatsApp, Gmail oder eine andere App.'
    : 'Dein Browser kann hier nicht direkt teilen. Speichere das PDF und hänge es dann in WhatsApp oder deiner Mail-App an (Ordner „Downloads“).';
  $('#shareNow').hidden = !can;
  $('#shareModal').hidden = false;
  $('#shareNow').onclick = async () => {
    try { await shareFile(file); $('#shareModal').hidden = true; } catch (e) { if (e.name !== 'AbortError') alert('Teilen hat nicht geklappt: ' + e.message); }
  };
  $('#shareDownload').onclick = () => { download(file); S.dirty = false; $('#shareModal').hidden = true; };
  $('#shareClose').onclick = () => { $('#shareModal').hidden = true; };
}

async function onSave() {
  if (!S.doc) return;
  try {
    const file = await makeFile();
    download(file);
    S.dirty = false;
  } catch (e) {
    alert('Das PDF konnte nicht gespeichert werden.\n\n' + e.message);
  }
}

// ---------- Werkzeugleiste ----------
function setTool(t) {
  S.tool = t;
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  document.body.classList.toggle('drawing', t !== 'hand');
  document.body.classList.toggle('show-options', t === 'pen' || t === 'marker' || t === 'text');
  renderOptions();
}

function renderOptions() {
  const sw = $('#swatches'), sz = $('#sizes');
  sw.innerHTML = ''; sz.innerHTML = '';
  if (!SIZES[S.tool]) return;
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (S.color[S.tool] === c ? ' on' : '');
    b.style.background = c;
    b.onclick = () => { S.color[S.tool] = c; renderOptions(); };
    sw.append(b);
  }
  [8, 13, 19].forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'size' + (S.size === i ? ' on' : '');
    b.title = ['Dünn', 'Mittel', 'Dick'][i];
    const dot = document.createElement('span');
    dot.style.width = dot.style.height = d + 'px';
    b.append(dot);
    b.onclick = () => { S.size = i; renderOptions(); };
    sz.append(b);
  });
}

function updateButtons() {
  $('#btnUndo').disabled = S.undo.length === 0;
}

document.querySelectorAll('.tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#btnUndo').addEventListener('click', undo);
$('#btnOpen').addEventListener('click', () => $('#fileInput').click());
$('#btnOpen2').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openFile(f);
});
$('#btnZoomIn').addEventListener('click', () => setZoom(S.scale * 1.25));
$('#btnZoomOut').addEventListener('click', () => setZoom(S.scale / 1.25));
$('#btnSave').addEventListener('click', onSave);
$('#btnShare').addEventListener('click', onShare);

// Am Computer: PDF per Drag & Drop, Strg+Z zum Rückgängigmachen
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
  if (f) openFile(f);
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && $('#textModal').hidden) { e.preventDefault(); undo(); }
});

window.addEventListener('beforeunload', (e) => {
  if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- Offline-Fähigkeit und "Teilen an diese App" ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
}

async function openSharedFile() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('shared-files');
    const res = await cache.match('shared-file');
    if (!res) return;
    const name = decodeURIComponent(res.headers.get('x-file-name') || 'Dokument.pdf');
    const blob = await res.blob();
    await cache.delete('shared-file');
    openFile(new File([blob], name, { type: 'application/pdf' }));
  } catch (e) {
    console.error(e);
  }
}

setTool('hand');
openSharedFile();
