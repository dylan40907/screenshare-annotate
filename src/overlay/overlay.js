// Overlay renderer.
//
// Core idea: every shape is stored in NORMALIZED coordinates (0..1) relative to
// the shared region. Each client renders those normals into its own "mapRect":
//   • Sharer: mapRect = the shared monitor inset by `inset` px. The calibration
//     brackets are drawn at this rect's corners so Discord broadcasts them.
//   • Viewer: mapRect = a movable, aspect-locked alignment rectangle the user
//     drags to line up with Discord's rendering of the share (nesting its corner
//     handles into the sharer's brackets).
// Because coords are normalized, a stroke drawn anywhere maps consistently for
// everyone regardless of how their rectangle is positioned or scaled.

const params = new URLSearchParams(location.search);
const ROLE = params.get('role'); // 'share' | 'view'
const MY_NAME = decodeURIComponent(params.get('name') || 'anon');
const SHARE_TYPE = params.get('shareType'); // 'window' | 'screen' | 'view'
const INSET = parseInt(params.get('inset') || '0', 10);
// Window share: the region is auto-tracked from the real window bounds (fed by
// the main process), drawing is locked to it, and there's no calibration.
const AUTO_REGION = ROLE === 'share' && SHARE_TYPE === 'window';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let W = 0, H = 0, DPR = 1;

// ---- app state ----
let mode = 'idle';                // idle | align | draw
let tool = 'pen';
let color = '#ff3b30';
let widthVal = 4;                 // px-on-a-1000px-wide-rect (scales with mapRect)
let myUserId = null;
let calibrationOn = false;        // sharer's brackets visible?

const shapes = new Map();         // id -> committed shape
const liveShapes = new Map();     // userId -> in-progress shape from a peer
const redoStack = [];             // my undone shapes (most-recent last)
const labels = new Map();         // userId -> { name, n:{x,y}, t } transient name tags

let aspect = 16 / 9;              // shared region aspect (w/h), from sharer
let canvasInfo = null;            // {width,height} announced by sharer
// The shared region as a rectangle in this client's css px. It IS the mapRect.
//   • Sharer: the area being shared - a whole monitor, or a window they drag to
//     cover in Align mode (free-form; the sharer defines the true aspect ratio).
//   • Viewer: the alignment rectangle, aspect-locked to the sharer's dimensions.
let regionRect = null;
let mapRect = null;               // active mapping rect for this client (= regionRect)

let current = null;               // local in-progress shape
let drag = null;                  // active pointer interaction

const PALETTE = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#ffffff', '#000000'];
const WIDTHS = [2, 4, 8, 16];

// ---------------------------------------------------------------- geometry ----

function resize() {
  DPR = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  // Backing store in physical pixels...
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  // ...but pin the CSS/display size to the window's logical size. A <canvas> is
  // a replaced element, so without this it uses its (physical-pixel) backing
  // size as its display size and everything renders scaled by DPR from the
  // origin - the "constant" down-right offset.
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  recomputeMapRect();
}
window.addEventListener('resize', resize);

function recomputeMapRect() {
  if (!regionRect) {
    if (AUTO_REGION) {
      // Wait for the tracker's first region-update; nothing to draw until then.
    } else if (ROLE === 'share') {
      // Screen share: region = whole monitor (inset by the starting margin).
      regionRect = { x: INSET, y: INSET, w: W - 2 * INSET, h: H - 2 * INSET };
    } else {
      initRegionViewer();
    }
  }
  mapRect = regionRect;
}

// Window-share: the main process streams the tracked window's DIP bounds
// (relative to this overlay's monitor). Adopt them as the drawing region.
window.api.onRegionUpdate((r) => {
  if (!AUTO_REGION) return; // only window-share overlays track a live region
  if (r.gone) { showBanner('The shared window was closed.'); return; }
  regionRect = { x: r.x, y: r.y, w: r.w, h: r.h };
  mapRect = regionRect;
  announceCanvasDebounced();
});

let announceTimer = null;
function announceCanvasDebounced() {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => announceCanvas(), 120);
}

function initRegionViewer() {
  // Start small (~30% width) - a shared screen shows up much smaller inside the
  // viewer's client, so this is closer to what they'll adjust to.
  let w = W * 0.3;
  let h = w / aspect;
  if (h > H * 0.5) { h = H * 0.5; w = h * aspect; }
  regionRect = { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function n2p(n) { return { x: mapRect.x + n.x * mapRect.w, y: mapRect.y + n.y * mapRect.h }; }
function p2n(p) { return { x: (p.x - mapRect.x) / mapRect.w, y: (p.y - mapRect.y) / mapRect.h }; }
function scaledWidth(s) { return Math.max(1, (s.width / 1000) * mapRect.w); }

// ---------------------------------------------------------------- networking ----

function send(obj) { window.api.wsSend(obj); }

window.api.onConn((d) => {
  const dot = document.getElementById('dot');
  dot.classList.toggle('on', d.status === 'connected');
  dot.classList.toggle('off', d.status !== 'connected');
  if (d.status === 'connected' && ROLE === 'share') announceCanvas();
});

function announceCanvas() {
  if (!mapRect) return; // window share: not tracked yet
  // Sharer defines the canvas dimensions (drives viewers' aspect lock).
  send({ type: 'canvas-info', width: Math.round(mapRect.w), height: Math.round(mapRect.h) });
}

window.api.onWsMessage((raw) => {
  let m; try { m = JSON.parse(raw); } catch { return; }
  switch (m.type) {
    case 'welcome':
      myUserId = m.userId;
      if (m.canvas) applyCanvasInfo(m.canvas);
      shapes.clear();
      m.shapes.forEach((s) => shapes.set(s.id, s));
      calibrationOn = m.calibration;
      syncCalibBtn();
      break;
    case 'canvas-info':
      applyCanvasInfo({ width: m.width, height: m.height });
      break;
    case 'draw':
      shapes.set(m.shape.id, m.shape);
      liveShapes.delete(m.shape.userId);
      if (m.shape.userId !== myUserId) touchLabel(m.shape);
      break;
    case 'draw-update':
      liveShapes.set(m.shape.userId, m.shape);
      if (m.shape.userId !== myUserId) touchLabel(m.shape);
      break;
    case 'delete':
      m.ids.forEach((id) => shapes.delete(id));
      break;
    case 'clear':
      shapes.clear();
      liveShapes.clear();
      redoStack.length = 0;
      break;
    case 'calibration':
      calibrationOn = m.on;
      syncCalibBtn();
      break;
  }
});

function applyCanvasInfo(c) {
  canvasInfo = c;
  aspect = c.width / c.height;
  if (ROLE === 'view') {
    // Re-lock the alignment rect's aspect around its current center.
    if (!regionRect) initRegionViewer();
    else {
      const cx = regionRect.x + regionRect.w / 2;
      const cy = regionRect.y + regionRect.h / 2;
      regionRect.h = regionRect.w / aspect;
      regionRect.x = cx - regionRect.w / 2;
      regionRect.y = cy - regionRect.h / 2;
    }
    mapRect = regionRect;
  }
}

// ---------------------------------------------------------------- rendering ----

function draw() {
  ctx.clearRect(0, 0, W, H);

  if (!mapRect) { // window share before the first region-update
    requestAnimationFrame(draw);
    return;
  }

  // All committed + live shapes.
  for (const s of shapes.values()) drawShape(s);
  for (const s of liveShapes.values()) drawShape(s);
  if (current) drawShape(current);

  // Region UI: grab-handles while editing (either role); the sharer's plain
  // calibration brackets otherwise (if enabled).
  if (mode === 'align') drawBrackets(regionRect, '#00e5ff', true);
  else if (ROLE === 'share' && calibrationOn) drawBrackets(regionRect, '#00e5ff', false);

  drawLabels();
  requestAnimationFrame(draw);
}

// ---- transient "who's drawing" name tags ----

function latestPoint(shape) {
  if (shape.kind === 'pen') return shape.points && shape.points[shape.points.length - 1];
  if (shape.kind === 'text') return { x: shape.x, y: shape.y };
  return { x: shape.x1, y: shape.y1 };
}

// Refresh a peer's name tag at their latest draw point. One tag per user; it
// rides along as they keep drawing and fades 2–3s after they stop.
function touchLabel(shape) {
  if (shape.kind === 'eraser') return;
  const n = latestPoint(shape);
  if (!n) return;
  labels.set(shape.userId, { name: shape.name || 'anon', n, t: performance.now() });
}

function drawLabels() {
  const now = performance.now();
  for (const [uid, lab] of labels) {
    const age = now - lab.t;
    if (age > 3000) { labels.delete(uid); continue; }
    const alpha = age < 2000 ? 1 : 1 - (age - 2000) / 1000;
    const p = n2p(lab.n);
    drawTag(p.x, p.y, lab.name, alpha);
  }
}

function drawTag(px, py, text, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '600 13px -apple-system, "Segoe UI", sans-serif';
  const padX = 7, h = 22;
  const w = ctx.measureText(text).width + padX * 2;
  let x = px + 12, y = py - h - 8;
  if (x + w > W) x = W - w - 2;
  if (x < 0) x = 2;
  if (y < 0) y = py + 12;
  ctx.fillStyle = 'rgba(81,112,255,0.92)';
  roundRect(x, y, w, h, 6); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2 + 0.5);
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawShape(s) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = scaledWidth(s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (s.kind) {
    case 'pen': {
      if (!s.points || s.points.length === 0) break;
      ctx.beginPath();
      const p0 = n2p(s.points[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < s.points.length; i++) {
        const p = n2p(s.points[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      break;
    }
    case 'line': {
      const a = n2p({ x: s.x0, y: s.y0 }), b = n2p({ x: s.x1, y: s.y1 });
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      break;
    }
    case 'arrow': {
      const a = n2p({ x: s.x0, y: s.y0 }), b = n2p({ x: s.x1, y: s.y1 });
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(10, scaledWidth(s) * 3);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 6), b.y - head * Math.sin(ang - Math.PI / 6));
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 6), b.y - head * Math.sin(ang + Math.PI / 6));
      ctx.stroke();
      break;
    }
    case 'rect': {
      const a = n2p({ x: s.x0, y: s.y0 }), b = n2p({ x: s.x1, y: s.y1 });
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      break;
    }
    case 'circle': {
      const a = n2p({ x: s.x0, y: s.y0 }), b = n2p({ x: s.x1, y: s.y1 });
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'text': {
      const p = n2p({ x: s.x, y: s.y });
      ctx.font = `${Math.max(10, (s.size / 1000) * mapRect.w)}px -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(s.text, p.x, p.y);
      break;
    }
  }
  ctx.restore();
}

function drawBrackets(rect, col, withFill) {
  const len = Math.min(48, rect.w * 0.08, rect.h * 0.08);
  const corners = [
    { x: rect.x, y: rect.y, dx: 1, dy: 1 },
    { x: rect.x + rect.w, y: rect.y, dx: -1, dy: 1 },
    { x: rect.x + rect.w, y: rect.y + rect.h, dx: -1, dy: -1 },
    { x: rect.x, y: rect.y + rect.h, dx: 1, dy: -1 },
  ];
  ctx.save();
  // faint full outline for the whole rect
  ctx.strokeStyle = 'rgba(0,229,255,0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.setLineDash([]);

  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 4;
  ctx.lineCap = 'square';
  for (const c of corners) {
    ctx.beginPath();
    ctx.moveTo(c.x + c.dx * len, c.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(c.x, c.y + c.dy * len);
    ctx.stroke();
    if (withFill) { // viewer grab handle
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- pointer ----

function evPt(e) { return { x: e.clientX, y: e.clientY }; }

function cornerHit(p) {
  const r = regionRect, t = 14;
  const cs = [
    ['nw', r.x, r.y], ['ne', r.x + r.w, r.y],
    ['se', r.x + r.w, r.y + r.h], ['sw', r.x, r.y + r.h],
  ];
  for (const [name, cx, cy] of cs) {
    if (Math.hypot(p.x - cx, p.y - cy) <= t) return name;
  }
  return null;
}

function insideRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#toolbar') || e.target.id === 'textInput') return;
  const p = evPt(e);

  if (mode === 'align') { // both roles can edit their region
    const corner = cornerHit(p);
    if (corner) { drag = { kind: 'resize', corner, start: p, orig: { ...regionRect } }; }
    else if (insideRect(p, regionRect)) { drag = { kind: 'move', start: p, orig: { ...regionRect } }; }
    return;
  }

  if (mode === 'draw') startDraw(p);
});

document.addEventListener('pointermove', (e) => {
  updateInteractivity(e);
  if (!drag) return;
  const p = evPt(e);

  if (drag.kind === 'move') {
    regionRect.x = drag.orig.x + (p.x - drag.start.x);
    regionRect.y = drag.orig.y + (p.y - drag.start.y);
  } else if (drag.kind === 'resize') {
    resizeAlign(drag, p);
  } else if (drag.kind === 'draw') {
    updateDraw(p);
  }
});

document.addEventListener('pointerup', () => {
  if (drag && drag.kind === 'draw') finishDraw();
  // Sharer moved/resized the shared region -> re-announce its true dimensions.
  if (drag && (drag.kind === 'move' || drag.kind === 'resize') && ROLE === 'share') announceCanvas();
  drag = null;
});

function resizeAlign(d, p) {
  const o = d.orig;
  const anchor = {
    nw: { x: o.x + o.w, y: o.y + o.h },
    ne: { x: o.x, y: o.y + o.h },
    se: { x: o.x, y: o.y },
    sw: { x: o.x + o.w, y: o.y },
  }[d.corner];

  if (ROLE === 'view') {
    // Aspect-locked scaling from the opposite corner (viewer must match aspect).
    let w = Math.max(40, Math.abs(p.x - anchor.x));
    let h = w / aspect;
    const left = (d.corner === 'nw' || d.corner === 'sw');
    const top = (d.corner === 'nw' || d.corner === 'ne');
    regionRect.w = w; regionRect.h = h;
    regionRect.x = left ? anchor.x - w : anchor.x;
    regionRect.y = top ? anchor.y - h : anchor.y;
  } else {
    // Free-form for the sharer - they define the true aspect ratio.
    regionRect.x = Math.min(anchor.x, p.x);
    regionRect.y = Math.min(anchor.y, p.y);
    regionRect.w = Math.max(40, Math.abs(p.x - anchor.x));
    regionRect.h = Math.max(40, Math.abs(p.y - anchor.y));
  }
}

// ---- drawing ----

function newId() { return Math.random().toString(36).slice(2, 10); }

// Keep annotations inside the shared region so they map cleanly for everyone.
function clampN(n) {
  return { x: Math.min(1, Math.max(0, n.x)), y: Math.min(1, Math.max(0, n.y)) };
}
function inRegion(p) {
  const n = p2n(p);
  return n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1;
}

function startDraw(p) {
  if (!mapRect || !inRegion(p)) return; // no drawing outside the shared window
  const n = clampN(p2n(p));
  if (tool === 'text') { placeText(p, n); return; }
  if (tool === 'eraser') { drag = { kind: 'draw' }; eraseAt(p); return; }

  if (tool === 'pen') {
    current = { id: newId(), userId: myUserId, name: MY_NAME, kind: 'pen', color, width: widthVal, points: [n] };
  } else {
    current = { id: newId(), userId: myUserId, name: MY_NAME, kind: tool, color, width: widthVal, x0: n.x, y0: n.y, x1: n.x, y1: n.y };
  }
  drag = { kind: 'draw' };
}

let lastUpdate = 0;
function updateDraw(p) {
  if (tool === 'eraser') { eraseAt(p); return; }
  if (!current) return;
  const n = clampN(p2n(p));
  if (current.kind === 'pen') current.points.push(n);
  else { current.x1 = n.x; current.y1 = n.y; }

  const now = performance.now();
  if (now - lastUpdate > 30) { // throttle live broadcast
    lastUpdate = now;
    send({ type: 'draw-update', shape: current });
  }
}

function finishDraw() {
  if (tool === 'eraser') return;
  if (!current) return;
  // Ignore accidental zero-size shapes.
  const trivial = current.kind !== 'pen' &&
    Math.hypot(current.x1 - current.x0, current.y1 - current.y0) < 0.005;
  if (!trivial) {
    shapes.set(current.id, current);
    send({ type: 'draw', shape: current });
    redoStack.length = 0; // a fresh stroke invalidates the redo stack
  }
  current = null;
}

function eraseAt(p) {
  const ids = [];
  for (const s of shapes.values()) {
    if (hitShape(s, p, 12)) ids.push(s.id);
  }
  if (ids.length) {
    ids.forEach((id) => shapes.delete(id));
    send({ type: 'delete', ids });
  }
}

function samplePoints(s) {
  const pts = [];
  const push = (nx, ny) => pts.push(n2p({ x: nx, y: ny }));
  if (s.kind === 'pen') { s.points.forEach((q) => push(q.x, q.y)); }
  else if (s.kind === 'line' || s.kind === 'arrow') {
    for (let t = 0; t <= 1; t += 0.05) push(s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t);
  } else if (s.kind === 'rect') {
    for (let t = 0; t <= 1; t += 0.05) {
      push(s.x0 + (s.x1 - s.x0) * t, s.y0); push(s.x0 + (s.x1 - s.x0) * t, s.y1);
      push(s.x0, s.y0 + (s.y1 - s.y0) * t); push(s.x1, s.y0 + (s.y1 - s.y0) * t);
    }
  } else if (s.kind === 'circle') {
    const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2, rx = (s.x1 - s.x0) / 2, ry = (s.y1 - s.y0) / 2;
    for (let a = 0; a < Math.PI * 2; a += 0.2) push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  } else if (s.kind === 'text') { push(s.x, s.y); }
  return pts;
}

function hitShape(s, p, tol) {
  return samplePoints(s).some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol);
}

// ---- text tool ----

const textInput = document.getElementById('textInput');
function placeText(p, n) {
  textInput.style.display = 'block';
  textInput.style.left = p.x + 'px';
  textInput.style.top = p.y + 'px';
  textInput.style.color = color;
  textInput.style.fontSize = Math.max(12, (28 / 1000) * mapRect.w) + 'px';
  textInput.value = '';
  setTimeout(() => textInput.focus(), 0);

  const commit = () => {
    const val = textInput.value.trim();
    textInput.style.display = 'none';
    textInput.onblur = null; textInput.onkeydown = null;
    if (val) {
      const s = { id: newId(), userId: myUserId, name: MY_NAME, kind: 'text', color, size: 28, text: val, x: n.x, y: n.y };
      shapes.set(s.id, s);
      send({ type: 'draw', shape: s });
      redoStack.length = 0;
    }
  };
  textInput.onblur = commit;
  textInput.onkeydown = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    else if (ev.key === 'Escape') { textInput.style.display = 'none'; textInput.onblur = null; }
  };
}

// ---------------------------------------------------------------- click-through ----

// Default overlay is click-through (Discord usable). We flip it interactive when:
//   • the pointer is over the toolbar (any mode), or
//   • we're in a working mode (draw / align) - the whole surface is live.
let lastIgnore = null;
function updateInteractivity(e) {
  const overToolbar = !!(e.target && e.target.closest && e.target.closest('#toolbar'));
  const interactive = mode !== 'idle' || overToolbar;
  const ignore = !interactive;
  if (ignore !== lastIgnore) {
    lastIgnore = ignore;
    window.api.setIgnoreMouse(ignore);
  }
}

// ---------------------------------------------------------------- toolbar wiring ----

function buildPalette() {
  const box = document.getElementById('colors');
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === 0 ? ' active' : '');
    b.style.background = c;
    b.addEventListener('click', () => {
      color = c;
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      b.classList.add('active');
    });
    box.appendChild(b);
  });
}

function buildWidths() {
  const box = document.getElementById('widths');
  WIDTHS.forEach((w, i) => {
    const b = document.createElement('button');
    b.className = 'wbtn' + (i === 1 ? ' active' : '');
    const d = document.createElement('span');
    d.className = 'dotw';
    const sz = 4 + i * 3;
    d.style.width = sz + 'px'; d.style.height = sz + 'px';
    b.appendChild(d);
    b.addEventListener('click', () => {
      widthVal = w;
      document.querySelectorAll('.wbtn').forEach((s) => s.classList.remove('active'));
      b.classList.add('active');
    });
    box.appendChild(b);
  });
}

function setMode(m) {
  mode = m;
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  updateBanner();
  lastIgnore = null; // force re-eval on next move
  window.api.setIgnoreMouse(m === 'idle'); // idle => click-through immediately
}

function updateBanner() {
  let msg = '';
  if (mode === 'align') msg = 'ALIGN - drag the rectangle over the shared screen; corners scale it (aspect locked). Nest the corners into the sharer\'s cyan brackets.';
  else if (mode === 'draw') msg = `DRAW - ${tool}. Switch to Idle to click through again.`;
  showBanner(msg, false);
}

let bannerTimer = null;
function showBanner(msg, transient = true) {
  const el = document.getElementById('banner');
  clearTimeout(bannerTimer);
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
  if (msg && transient) bannerTimer = setTimeout(() => updateBanner(), 4000);
}

function syncCalibBtn() {
  const b = document.getElementById('calib');
  if (b) b.classList.toggle('active', calibrationOn);
}

document.querySelectorAll('.mode').forEach((b) => {
  b.addEventListener('click', () => setMode(b.dataset.mode));
});
document.querySelectorAll('.tool').forEach((b) => {
  b.addEventListener('click', () => {
    tool = b.dataset.tool;
    document.querySelectorAll('.tool').forEach((t) => t.classList.remove('active'));
    b.classList.add('active');
    if (mode !== 'draw') setMode('draw');
    else updateBanner();
  });
});
document.getElementById('calib').addEventListener('click', () => {
  calibrationOn = !calibrationOn;
  syncCalibBtn();
  send({ type: 'calibration', on: calibrationOn });
});
function doUndo() {
  let last = null;
  for (const s of shapes.values()) if (s.userId === myUserId) last = s; // insertion order
  if (!last) return;
  shapes.delete(last.id);
  redoStack.push(last);
  send({ type: 'delete', ids: [last.id] });
}
function doRedo() {
  const s = redoStack.pop();
  if (!s) return;
  shapes.set(s.id, s);
  send({ type: 'draw', shape: s });
}
document.getElementById('undo').addEventListener('click', doUndo);
document.getElementById('redo').addEventListener('click', doRedo);
document.getElementById('clear').addEventListener('click', () => {
  send({ type: 'clear' });
});
document.getElementById('disconnect').addEventListener('click', () => {
  window.api.disconnect();
});

// Show/hide role- and mode-specific controls.
//   • Align is viewer-only (sharer's region is either the whole screen or the
//     auto-tracked window - nothing to align).
//   • Calibration brackets only make sense for a full-SCREEN share (they must be
//     captured by Discord). A single-window capture can't include our overlay,
//     so no calibration button in window mode.
if (ROLE === 'share') {
  document.querySelectorAll('.viewer-only').forEach((el) => (el.style.display = 'none'));
  if (SHARE_TYPE !== 'screen') {
    document.querySelectorAll('.sharer-only').forEach((el) => (el.style.display = 'none'));
  }
} else {
  document.querySelectorAll('.sharer-only').forEach((el) => (el.style.display = 'none'));
}

// ---------------------------------------------------------------- toolbar drag ----

const toolbar = document.getElementById('toolbar');
(function restoreToolbarPos() {
  const saved = localStorage.getItem('toolbarPos');
  if (saved) {
    try {
      const { left, top } = JSON.parse(saved);
      toolbar.style.left = left + 'px';
      toolbar.style.top = top + 'px';
      toolbar.style.transform = 'none';
    } catch {}
  }
})();

const grip = document.getElementById('grip');
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const rect = toolbar.getBoundingClientRect();
  const offX = e.clientX - rect.left;
  const offY = e.clientY - rect.top;
  const move = (ev) => {
    const left = Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - offX));
    const top = Math.max(0, Math.min(window.innerHeight - 20, ev.clientY - offY));
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
    toolbar.style.transform = 'none';
  };
  const up = (ev) => {
    grip.releasePointerCapture(e.pointerId);
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    const rc = toolbar.getBoundingClientRect();
    localStorage.setItem('toolbarPos', JSON.stringify({ left: rc.left, top: rc.top }));
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
});

// ---------------------------------------------------------------- boot ----

buildPalette();
buildWidths();
resize();
// Viewers always need to align first, so start there. Sharers start passive.
setMode(ROLE === 'view' ? 'align' : 'idle');
draw();
window.api.overlayReady(); // tell main we're ready -> it opens the WS connection
