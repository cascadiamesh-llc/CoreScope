/* Night-sky Live mode: a full-screen, panel-free view of MediaMesh for a
 * screen at a meetup. Repeaters are stars; each photo, video or voice packet
 * crosses as a comet, hop by hop, coloured by kind; main-mesh traffic glows
 * faintly underneath. live.js feeds it (LiveNightSky.packet / .ember) while
 * it is open, and can hand it the last day to replay in a minute
 * (LiveNightSky.replay). Drawn on its own canvas; nothing here touches the
 * Live map.
 *
 * - The camera follows what's crossing: it eases in on the routes in use and
 *   back out to every MediaMesh repeater when the sky is quiet. Names are
 *   placed so none covers another, busiest first.
 * - The land glows faintly underneath, shoreline and hills, from the same
 *   elevation tiles the coverage estimate uses (MediaMeshCoverage).
 * - When a clip's last piece has passed, how it went shows where it
 *   arrived: a burst when every piece got there, a shimmer when parity
 *   pieces made up for losses, red embers falling for pieces lost. Only
 *   clips whose announcement says how many pieces they have are judged.
 * - Moments: a banner for the first photo, video and voice of the day, a new
 *   longest route today, a whole clip across many hops, and round numbers of
 *   relays.
 */
'use strict';

(function (root) {
  const KINDS = {
    photo: { label: 'Photo', rgb: [124, 217, 145] },
    video: { label: 'Video', rgb: [239, 240, 242] },
    voice: { label: 'Voice clip', rgb: [96, 150, 240] },
    clip: { label: 'Media clip', rgb: [180, 205, 235] },
  };
  const HOP_S = 0.55;          // seconds a comet takes per hop
  const TRAIL = 14;            // trail samples behind a comet's head
  const TRANSFER_IDLE_MS = 8000;
  const REPLAY_IDLE_MS = 1500; // a replayed clip arrives in a blink: judged sooner
  const ACTIVE_S = 40;         // routes the camera keeps in view after a comet starts
  const CAM_EASE_S = 2.4;      // how quickly the camera settles
  const MIN_SPAN = 0.055;      // never tighter than about 6 km
  const BANNER_MS = 5200;
  const RELAY_MARKS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
  const RED = [248, 113, 113];

  function kindOf(k) { return KINDS[k] ? k : 'clip'; }

  // ---- Geometry -------------------------------------------------------------

  /** The box around points (lat/lon), at least MIN_SPAN across; null for none. */
  function boundsOf(points) {
    const pts = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && !(p.lat === 0 && p.lon === 0));
    if (!pts.length) return null;
    let s = 90, n = -90, w = 180, e = -180;
    pts.forEach((p) => { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); });
    return padBounds({ s, n, w, e }, 0);
  }

  /** Bounds grown by a share of their size on every side, then to MIN_SPAN. */
  function padBounds(b, share) {
    let { s, n, w, e } = b;
    const dl = (n - s) * share, dw = (e - w) * share;
    s -= dl; n += dl; w -= dw; e += dw;
    if (n - s < MIN_SPAN) { const c = (n + s) / 2; s = c - MIN_SPAN / 2; n = c + MIN_SPAN / 2; }
    if (e - w < MIN_SPAN * 1.5) { const c = (e + w) / 2; w = c - MIN_SPAN * 0.75; e = c + MIN_SPAN * 0.75; }
    return { s, n, w, e };
  }

  /**
   * Fits bounds into a w x h box with a margin (a number, or { top, right,
   * bottom, left } to keep clear of the HUD): { P(lat, lon) -> [x, y],
   * inv(x, y) -> [lat, lon], bounds }. North up, equal scale both ways.
   */
  function fit(b, w, h, margin) {
    const kx = Math.cos(((b.n + b.s) / 2) * Math.PI / 180);
    const mm = margin == null ? 70 : margin;
    const m = typeof mm === 'number' ? { top: mm, right: mm, bottom: mm, left: mm } : mm;
    const sc = Math.min((w - m.left - m.right) / ((b.e - b.w) * kx), (h - m.top - m.bottom) / (b.n - b.s));
    const ox = m.left + (w - m.left - m.right - (b.e - b.w) * kx * sc) / 2, oy = m.top + (h - m.top - m.bottom - (b.n - b.s) * sc) / 2;
    return {
      P: (lat, lon) => [ox + (lon - b.w) * kx * sc, oy + (b.n - lat) * sc],
      inv: (x, y) => [b.n - (y - oy) / sc, b.w + (x - ox) / (kx * sc)],
      bounds: b,
    };
  }

  /** Fits lat/lon points into a w x h box with a margin: { P(lat, lon) -> [x, y] }. */
  function projection(points, w, h, margin) {
    return fit(boundsOf(points) || padBounds({ s: 47.5, n: 47.7, w: -122.45, e: -122.2 }, 0), w, h, margin);
  }

  /** Kilometres along a route of { lat, lon } points. */
  function routeKm(hops) {
    let km = 0;
    for (let i = 1; i < (hops || []).length; i++) {
      const a = hops[i - 1], b = hops[i];
      const dy = (b.lat - a.lat) * 111.32, dx = (b.lon - a.lon) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
      km += Math.sqrt(dx * dx + dy * dy);
    }
    return km;
  }

  /** Where the camera should look: the routes crossing lately, else the base view. */
  function cameraTarget(base, recentHops) {
    const b = boundsOf(recentHops);
    if (!b) return base;
    // a little room round the routes, and never a smaller patch than a few km
    return padBounds(b, 0.22);
  }

  /** Eases bounds a toward b by a share of the way (0-1). */
  function easeBounds(a, b, k) {
    return { s: a.s + (b.s - a.s) * k, n: a.n + (b.n - a.n) * k, w: a.w + (b.w - a.w) * k, e: a.e + (b.e - a.e) * k };
  }

  /**
   * Places labels so none covers another: [{ text, x, y, pri, width }] ->
   * those kept, each with tx, ty, align. Highest pri first; each tries the
   * right of its point, then the left, then above, then below. keepOut:
   * boxes [x0, y0, x1, y1] (the HUD) no label may cover.
   */
  function placeLabels(items, W, H, keepOut) {
    const placed = [], out = [];
    const boxes = (keepOut || []).slice();
    const free = (b) => b[0] >= 4 && b[2] <= W - 4 && b[1] >= 4 && b[3] <= H - 4 && !boxes.some((q) => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]);
    const seen = new Set();
    items.slice().sort((a, b) => b.pri - a.pri).forEach((it) => {
      if (!it.text || seen.has(it.text)) return;
      const w = it.width, h = 14;
      const tries = [
        ['left', it.x + 9, it.y - 9, [it.x + 7, it.y - 16, it.x + 11 + w, it.y - 2]],
        ['right', it.x - 9, it.y - 9, [it.x - 11 - w, it.y - 16, it.x - 7, it.y - 2]],
        ['center', it.x, it.y - 20, [it.x - w / 2 - 2, it.y - 27, it.x + w / 2 + 2, it.y - 13]],
        ['center', it.x, it.y + 16, [it.x - w / 2 - 2, it.y + 9, it.x + w / 2 + 2, it.y + 9 + h]],
      ];
      for (const [align, tx, ty, box] of tries) {
        if (!free(box)) continue;
        boxes.push(box); seen.add(it.text);
        out.push(Object.assign({}, it, { tx, ty, align }));
        placed.push(box);
        break;
      }
    });
    return out;
  }

  // ---- Clips ----------------------------------------------------------------

  /**
   * How a clip went, from what passed: { outcome: 'whole' | 'parity' |
   * 'lost' | null (can't tell), missing, rebuilt }. Pieces come in blocks of
   * 20; a block makes up as many lost pieces as parity pieces it has.
   */
  function outcomeOf(tr) {
    if (!tr || !(tr.total > 0) || !tr.idx || !tr.idx.size) return { outcome: null, missing: 0, rebuilt: 0 };
    let missing = 0, rebuilt = 0;
    const blocks = Math.ceil(tr.total / 20);
    for (let b = 0; b < blocks; b++) {
      let miss = 0;
      for (let i = b * 20; i < Math.min(tr.total, b * 20 + 20); i++) if (!tr.idx.has(i)) miss++;
      const par = (tr.parity && tr.parity[b]) || 0;
      if (miss <= par) rebuilt += miss; else missing += miss;
    }
    return { outcome: missing ? 'lost' : rebuilt ? 'parity' : 'whole', missing, rebuilt };
  }

  /** "Photo · First Hill → Rainier View" */
  function transferLabel(kind, hops, seconds) {
    const k = KINDS[kindOf(kind)];
    let t = k.label + (kind !== 'photo' && seconds > 0 ? `, ${seconds} s` : '');
    const a = hops && hops[0] && hops[0].name, b = hops && hops.length > 1 && hops[hops.length - 1].name;
    if (a && b) t += ` · ${a} → ${b}`;
    return t;
  }

  function outcomeText(o) {
    if (o.outcome === 'whole') return 'every piece arrived';
    if (o.outcome === 'parity') return `whole: ${o.rebuilt} rebuilt from parity`;
    if (o.outcome === 'lost') return `${o.missing} piece${o.missing === 1 ? '' : 's'} lost`;
    return 'finished';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function rnd(i) { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

  const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const midnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

  // ---- The land ---------------------------------------------------------------

  /**
   * The land under bounds as a faint picture: hills shaded from the
   * north-west, open water left dark, the shoreline traced. elevAt(lat, lon)
   * in metres (NaN for none). Water: the sea (0.5 m or lower) and lakes,
   * which elevation data holds dead flat. Returns a canvas pw x ph.
   */
  function landCanvas(b, elevAt, pw, ph) {
    const el = new Float32Array(pw * ph);
    for (let y = 0, i = 0; y < ph; y++) {
      const lat = b.n - ((y + 0.5) / ph) * (b.n - b.s);
      for (let x = 0; x < pw; x++, i++) el[i] = elevAt(lat, b.w + ((x + 0.5) / pw) * (b.e - b.w));
    }
    const water = new Uint8Array(pw * ph);
    for (let y = 1; y < ph - 1; y++) {
      for (let x = 1, i = y * pw + 1; x < pw - 1; x++, i++) {
        const e = el[i];
        if (!Number.isFinite(e)) { water[i] = 2; continue; }
        if (e <= 0.5) { water[i] = 1; continue; }
        if (e < 40 && Math.abs(el[i - 1] - e) <= 0.2 && Math.abs(el[i + 1] - e) <= 0.2 && Math.abs(el[i - pw] - e) <= 0.2 && Math.abs(el[i + pw] - e) <= 0.2) water[i] = 3;
      }
    }
    // a lake is a flat stretch, not a flat speck (a field, a car park): flat
    // pixels count as water only with most of their neighbours flat too
    const lake = new Uint8Array(pw * ph);
    for (let y = 1; y < ph - 1; y++) {
      for (let x = 1, i = y * pw + 1; x < pw - 1; x++, i++) {
        if (water[i] !== 3) continue;
        let k = 0;
        for (const j of [i - pw - 1, i - pw, i - pw + 1, i - 1, i + 1, i + pw - 1, i + pw, i + pw + 1]) if (water[j] === 1 || water[j] === 3) k++;
        lake[i] = k >= 6 ? 1 : 0;
      }
    }
    for (let i = 0; i < water.length; i++) if (water[i] === 3) water[i] = lake[i];
    const mPerPx = ((b.n - b.s) * 111320) / ph;
    const cv = document.createElement('canvas');
    cv.width = pw; cv.height = ph;
    const g = cv.getContext('2d');
    const img = g.createImageData(pw, ph), d = img.data;
    for (let y = 1; y < ph - 1; y++) {
      for (let x = 1, i = y * pw + 1; x < pw - 1; x++, i++) {
        if (water[i]) continue;
        // light from the north-west, 45° up
        const dzdx = (el[i + 1] - el[i - 1]) / (2 * mPerPx), dzdy = (el[i + pw] - el[i - pw]) / (2 * mPerPx);
        const shade = Math.max(0, Math.min(1, 0.55 + (-dzdx - dzdy) * 0.9 / Math.sqrt(1 + dzdx * dzdx + dzdy * dzdy)));
        const coast = water[i - 1] === 1 || water[i + 1] === 1 || water[i - pw] === 1 || water[i + pw] === 1;
        const k = i * 4;
        if (coast) { d[k] = 239; d[k + 1] = 240; d[k + 2] = 242; d[k + 3] = 120; continue; }
        const hi = Math.min(1, Math.max(0, el[i] / 400));
        d[k] = 24 + 20 * hi; d[k + 1] = 70 + 40 * hi; d[k + 2] = 144 + 50 * hi;
        d[k + 3] = Math.round(18 + 34 * shade + 18 * hi);
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  // ---- The sky ----------------------------------------------------------------

  let st = null;   // state while open

  function open(opts) {
    if (st) return;
    const el = document.createElement('div');
    el.className = 'nightsky' + (opts && opts.kiosk ? ' nightsky--kiosk' : '');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'MediaMesh night sky');
    el.innerHTML = `<canvas class="nightsky-canvas" aria-hidden="true"></canvas>
      <div class="nightsky-brand"><b>CASCADIA</b>MESH <span>· MEDIAMESH LIVE${opts && opts.place ? ' · ' + esc(String(opts.place).toUpperCase()) : ''}</span></div>
      <div class="nightsky-clock" aria-hidden="true"><span data-ns-time></span><small data-ns-date></small></div>
      <div class="nightsky-moment" data-ns-moment aria-live="polite"></div>
      <div class="nightsky-counters" aria-live="off">
        <div><span data-ns-count="all">0</span><small>transfers</small></div>
        <div><span data-ns-count="photo">0</span><small>photos</small></div>
        <div><span data-ns-count="video">0</span><small>videos</small></div>
        <div><span data-ns-count="voice">0</span><small>voice clips</small></div>
        <div title="Sent on a channel the analyzer has no key for, so whether it is a photo, video or voice can't be told"><span data-ns-count="unknown">0</span><small>kind unknown</small></div>
        <div title="Each time a repeater passed on a photo, video or voice packet"><span data-ns-count="relays">0</span><small>repeater relays</small></div>
      </div>
      <div class="nightsky-ticker" data-ns-ticker aria-live="polite"></div>
      <div class="nightsky-replay" data-ns-replay hidden><span data-ns-replay-label></span><i><b data-ns-replay-bar></b></i></div>
      <div class="nightsky-controls">
        <button type="button" data-ns-act="replay" title="Replay the last day's photos, video and voice in a minute">Replay the last day</button>
        <button type="button" data-ns-act="close" title="Leave the night sky (Esc)" aria-label="Leave the night sky">Close</button>
      </div>`;
    document.body.appendChild(el);
    const cv = el.querySelector('canvas');
    st = {
      el, cv, g: cv.getContext('2d'), opts: opts || {}, comets: [], embers: [], fx: [],
      transfers: new Map(), counts: { all: 0, photo: 0, video: 0, voice: 0, relays: 0 }, relayed: new Map(), ticker: [],
      stars: [], w: 0, h: 0, raf: 0, replay: null, startedAt: performance.now(), lastT: 0, lastJudge: 0,
      activity: new Map(), today: { day: dayKey(Date.now()), known: false, kinds: new Set(), longestKm: 0, marks: 0 },
      moments: [], banner: null, land: null,
    };
    resize();
    st.onResize = () => resize();
    st.onKey = (e) => { if (e.key === 'Escape') close(); };
    st.onClick = (e) => {
      const b = e.target.closest('[data-ns-act]');
      if (!b) return;
      if (b.dataset.nsAct === 'close') close();
      else if (b.dataset.nsAct === 'replay' && st.opts.onReplay) st.opts.onReplay();
    };
    window.addEventListener('resize', st.onResize);
    document.addEventListener('keydown', st.onKey);
    el.addEventListener('click', st.onClick);
    if (el.requestFullscreen && st.opts.fullscreen !== false) el.requestFullscreen().catch(() => {});
    if (!(opts && opts.kiosk)) el.querySelector('[data-ns-act="close"]').focus();
    loadLand();
    seedToday();
    st.raf = requestAnimationFrame(frame);
  }

  function resize() {
    if (!st) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    st.w = window.innerWidth; st.h = window.innerHeight;
    st.cv.width = Math.round(st.w * dpr); st.cv.height = Math.round(st.h * dpr);
    st.cv.style.width = st.w + 'px'; st.cv.style.height = st.h + 'px';
    st.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    st.stars = Array.from({ length: Math.round(st.w * st.h / 3500) }, (_, i) => ({ x: rnd(i) * st.w, y: rnd(i + 500) * st.h, r: rnd(i + 900) * 1.1 + 0.2, a: rnd(i + 1300) * 0.5 + 0.1, f: rnd(i + 1700) * 3 + 1 }));
    const nodes = (st.opts.nodes && st.opts.nodes()) || [];
    const focus = (st.opts.focus && st.opts.focus()) || nodes;
    // clear of the controls and replay bar above, and the counters and ticker below
    const side = Math.min(90, st.w * 0.08);
    st.margin = { top: hudEdge('top'), bottom: hudEdge('bottom'), left: side, right: side };
    st.base = boundsOf(focus.length ? focus : nodes) || padBounds({ s: 47.5, n: 47.7, w: -122.45, e: -122.2 }, 0);
    if (!st.cam) st.cam = st.base;
    st.proj = fit(st.cam, st.w, st.h, st.margin);
    st.nodes = nodes.map((n) => ({ lat: n.lat, lon: n.lon, star: !!n.star, name: n.name, tw: rnd(n.lat * 1000 + n.lon) * 6 }));
    st.keepOut = [...st.el.querySelectorAll('.nightsky-controls, .nightsky-replay, .nightsky-clock, .nightsky-brand, .nightsky-counters, .nightsky-ticker')]
      .map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height).map((r) => [r.left - 6, r.top - 6, r.right + 6, r.bottom + 6]);
  }

  // How far the HUD reaches in from the top or bottom edge, plus room for a name.
  function hudEdge(side) {
    let edge = 0;
    const sel = side === 'top' ? '.nightsky-controls, .nightsky-replay, .nightsky-clock, .nightsky-brand' : '.nightsky-counters, .nightsky-ticker';
    st.el.querySelectorAll(sel).forEach((e) => {
      const r = e.getBoundingClientRect();
      if (!r.height) return;
      edge = Math.max(edge, side === 'top' ? r.bottom : st.h - r.top);
    });
    return Math.min(st.h * 0.3, (edge || 60) + 30);
  }

  /** Reads the land under the whole view once (terrain tiles, cached by the browser). */
  async function loadLand() {
    const M = root.MediaMeshCoverage;
    if (!st || !M || typeof M.loadTerrainLevels !== 'function') return;
    const me = st;
    // the base view's screen, and as much again round it for the camera to roam
    const pr = fit(st.base, st.w, st.h, st.margin);
    const [n0, w0] = pr.inv(0, 0), [s0, e0] = pr.inv(st.w, st.h);
    const b = padBounds({ s: s0, n: n0, w: w0, e: e0 }, 0.35);
    const pw = Math.min(1400, Math.round(st.w * 1.2)), ph = Math.max(2, Math.round(pw * (b.n - b.s) / ((b.e - b.w) * Math.cos(((b.n + b.s) / 2) * Math.PI / 180))));
    const z = Math.max(8, Math.min(12, Math.round(Math.log2((360 * pw) / ((b.e - b.w) * 256)))));
    try {
      const terrain = await M.loadTerrainLevels([{ z, boxes: [{ south: b.s, north: b.n, west: b.w, east: b.e }] }], st.opts.loadTile);
      if (st !== me || (terrain.total && terrain.failed === terrain.total)) return;
      // in slices, so the comets keep moving while it draws
      await new Promise((res) => setTimeout(res, 0));
      if (st !== me) return;
      st.land = { cv: landCanvas(b, terrain.elevAt, pw, Math.min(ph, 1600)), b, t0: performance.now() / 1000 };
    } catch (_) { /* no land: the sky alone */ }
  }

  /** What today already holds (the replay endpoint), so "first of the day" is true. */
  async function seedToday() {
    if (!st || typeof st.opts.seed !== 'function') return;
    const me = st;
    let events = null;
    try { events = await st.opts.seed(); } catch (_) { events = null; }
    if (st !== me || !Array.isArray(events) || st.replay) return;
    const day0 = midnight(Date.now());
    const today = { day: dayKey(Date.now()), known: true, kinds: new Set(), longestKm: 0, marks: st.today.marks };
    events.forEach((ev) => {
      if (!(ev.t >= day0)) return;
      if (ev.kind && ev.kind !== 'clip') today.kinds.add(ev.kind);
      if ((ev.hops || []).length >= 3) today.longestKm = Math.max(today.longestKm, routeKm(ev.hops));
    });
    // what crossed while the seed was loading counts too
    st.today.kinds.forEach((k) => today.kinds.add(k));
    today.longestKm = Math.max(today.longestKm, st.today.longestKm);
    st.today = today;
  }

  function close() {
    if (!st) return;
    cancelAnimationFrame(st.raf);
    window.removeEventListener('resize', st.onResize);
    document.removeEventListener('keydown', st.onKey);
    if (document.fullscreenElement === st.el && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    st.el.remove();
    const cb = st.opts.onClose;
    st = null;
    if (cb) cb();
  }

  function isOpen() { return !!st; }

  function moment(title, sub, key) {
    if (!st) return;
    // a newer one of the same sort replaces one still waiting
    if (key) st.moments = st.moments.filter((m) => m.key !== key);
    st.moments.push({ title, sub, key });
    if (st.moments.length > 4) st.moments.shift();
  }

  /** The day a packet belongs to, starting a new one at midnight. */
  function dayOf(epochMs) {
    const k = dayKey(epochMs);
    if (st.today.day !== k) st.today = { day: k, known: !st.replay || epochMs - midnight(epochMs) < 36e5 * 24, kinds: new Set(), longestKm: 0, marks: st.today.marks };
    return st.today;
  }

  /**
   * A photo, video or voice packet: { key (its transfer), kind, hops:
   * [{lat, lon, name}] (those with a position), seconds, hash, relays (the
   * repeaters on its path, placed or not), sid, index (a data piece's
   * number), parity (a parity piece), total (pieces announced), t (epoch
   * ms, a replay's) }. now: ms on the sky's clock (default now).
   */
  function packet(p, now) {
    if (!st || !p || !p.hops || p.hops.length < 2) return;
    const t = (now == null ? performance.now() : now) / 1000;
    const kind = kindOf(p.kind);
    st.comets.push({ hops: p.hops, kind, t0: t });
    p.hops.forEach((h) => { if (h.name) st.activity.set(h.name, (st.activity.get(h.name) || 0) + 1); });
    // Relays: each repeater on its path passed it on once. Observers hear one
    // packet over several paths that share their start, so a packet counts
    // its longest path once, not each copy heard.
    const relays = Number.isFinite(p.relays) ? p.relays : p.hops.length;
    const before = st.counts.relays;
    if (p.hash) {
      const was = st.relayed.get(p.hash) || 0;
      if (relays > was) { st.counts.relays += relays - was; st.relayed.set(p.hash, relays); }
      if (st.relayed.size > 5000) st.relayed.delete(st.relayed.keys().next().value);
    } else {
      st.counts.relays += relays;
    }
    const mark = RELAY_MARKS.find((m) => before < m && st.counts.relays >= m);
    if (mark) moment(`${mark.toLocaleString()} repeater relays`, st.replay ? 'in this replay' : 'since the sky opened', 'relays');
    // one ticker line and one count per transfer
    const key = p.key || (kind + '|' + p.hops[0].lat + ',' + p.hops[0].lon);
    let tr = st.transfers.get(key);
    const ms = t * 1000;
    const idle = st.replay ? REPLAY_IDLE_MS : TRANSFER_IDLE_MS;
    if (!tr || ms - tr.last > idle) {
      tr = { kind, first: ms, last: ms, label: transferLabel(kind, p.hops, p.seconds), counted: false, idx: new Set(), parity: {}, total: 0, hops: p.hops, maxHops: 0, judged: false, epoch: p.t || Date.now() };
      st.counts.all++;
      st.transfers.set(key, tr);
      st.ticker.unshift(tr);
      st.ticker.length = Math.min(st.ticker.length, 3);
      if (st.transfers.size > 300) st.transfers.delete(st.transfers.keys().next().value);
    }
    if (tr.kind === 'clip' && kind !== 'clip') { tr.kind = kind; tr.label = transferLabel(kind, tr.hops, p.seconds); }
    tr.last = ms;
    if (p.total > 0) tr.total = p.total;
    if (p.parity && Number.isFinite(p.index)) { const b = Math.floor(p.index / 8); tr.parity[b] = (tr.parity[b] || 0) + 1; } else if (Number.isFinite(p.index)) tr.idx.add(p.index);
    // the longest path it travelled names its ends
    if (p.hops.length > tr.maxHops) { tr.maxHops = p.hops.length; tr.hops = p.hops; tr.label = transferLabel(tr.kind, p.hops, p.seconds); }
    const day = dayOf(p.t || Date.now());
    if (!tr.counted && kind !== 'clip') {
      st.counts[kind]++; tr.counted = true;
      if (day.known && !day.kinds.has(kind)) moment(`First ${KINDS[kind].label.toLowerCase()} of the day`, ends(tr.hops), 'first-' + kind);
      day.kinds.add(kind);
    }
    if (p.hops.length >= 3) {
      const km = routeKm(p.hops);
      if (km > day.longestKm + 0.3) {
        if (day.known && day.longestKm > 0) moment('Longest route today', `${p.hops.length} hops · ${km.toFixed(1)} km · ${ends(p.hops)}`, 'longest');
        day.longestKm = km;
      }
    }
  }

  const ends = (hops) => {
    const a = hops[0] && hops[0].name, b = hops[hops.length - 1] && hops[hops.length - 1].name;
    return a && b ? `${a} → ${b}` : '';
  };

  /** Clips whose last piece has passed: how each went, where it arrived. */
  function judge(nowMs) {
    const idle = st.replay ? REPLAY_IDLE_MS : TRANSFER_IDLE_MS;
    st.transfers.forEach((tr) => {
      if (tr.judged || nowMs - tr.last <= idle) return;
      tr.judged = true;
      const o = outcomeOf(tr);
      tr.outcome = o;
      if (!o.outcome) return;
      const dest = tr.hops[tr.hops.length - 1];
      const rgb = KINDS[tr.kind].rgb;
      const t0 = nowMs / 1000;
      if (o.outcome === 'whole' || o.outcome === 'parity') st.fx.push({ type: 'burst', lat: dest.lat, lon: dest.lon, rgb, t0 });
      if (o.outcome === 'parity') st.fx.push({ type: 'shimmer', lat: dest.lat, lon: dest.lon, rgb: [253, 230, 138], t0, n: Math.min(14, 4 + o.rebuilt * 3) });
      if (o.outcome === 'lost') st.fx.push({ type: 'fall', lat: dest.lat, lon: dest.lon, rgb: RED, t0, n: Math.min(12, o.missing) });
      if (o.outcome !== 'lost' && tr.maxHops >= 4) moment(`A whole ${KINDS[tr.kind].label.toLowerCase()} across ${tr.maxHops} hops`, ends(tr.hops), 'whole');
    });
  }

  /** A main-mesh packet somewhere: a faint glow at lat/lon. */
  function ember(lat, lon, now) {
    if (!st || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    st.embers.push({ lat, lon, t0: (now == null ? performance.now() : now) / 1000 });
    if (st.embers.length > 400) st.embers.shift();
  }

  /** Replays events [{ t (epoch ms), ...packet }] over opts.durationMs, the
   * clock running from opts.from to opts.to (epoch ms). */
  function replay(events, opts) {
    if (!st) return;
    const dur = (opts && opts.durationMs) || 60000;
    st.counts = { all: 0, photo: 0, video: 0, voice: 0, relays: 0 };
    st.relayed = new Map();
    st.transfers.clear(); st.ticker = []; st.comets = []; st.fx = []; st.moments = []; st.banner = null;
    // the day the replay starts in is only partly in it: no "first of the day" for it
    st.today = { day: dayKey(opts.from), known: opts.from <= midnight(opts.from) + 60000, kinds: new Set(), longestKm: 0, marks: 0 };
    st.replay = { events: events.slice().sort((a, b) => a.t - b.t), i: 0, start: performance.now(), dur, from: opts.from, to: opts.to, label: opts.label || 'Replay' };
    const box = st.el.querySelector('[data-ns-replay]');
    box.hidden = false;
    st.el.querySelector('[data-ns-replay-label]').textContent = st.replay.label;
  }

  function stopReplay() {
    if (!st || !st.replay) return;
    st.replay = null;
    st.el.querySelector('[data-ns-replay]').hidden = true;
  }

  const ease = (u) => (u < 0 ? 0 : u > 1 ? 1 : u * u * (3 - 2 * u));

  function frame(nowMs) {
    if (!st) return;
    const g = st.g, W = st.w, H = st.h, t = nowMs / 1000;
    const dt = Math.min(0.1, st.lastT ? t - st.lastT : 0);
    st.lastT = t;
    // replay: release the events due, and drive the clock
    let clockMs = Date.now();
    if (st.replay) {
      const r = st.replay, f = Math.min(1, (nowMs - r.start) / r.dur);
      const due = r.from + (r.to - r.from) * f;
      while (r.i < r.events.length && r.events[r.i].t <= due) { packet(r.events[r.i], nowMs); r.i++; }
      clockMs = due;
      const bar = st.el.querySelector('[data-ns-replay-bar]');
      if (bar) bar.style.width = (f * 100).toFixed(1) + '%';
      if (f >= 1 && nowMs - r.start > r.dur + 4000) stopReplay();
    }
    if (nowMs - st.lastJudge > 250) { st.lastJudge = nowMs; judge(nowMs); }

    // the camera: in on the routes crossing lately, out to every repeater when quiet
    const recent = [];
    // (a replay runs a day in a minute: only the last few seconds' routes)
    const activeS = st.replay ? 6 : ACTIVE_S;
    for (const c of st.comets) if (t - c.t0 < activeS) recent.push(...c.hops);
    const target = cameraTarget(st.base, recent.length >= 2 ? recent : null);
    st.cam = easeBounds(st.cam, target, 1 - Math.exp(-dt / CAM_EASE_S));
    const pr = st.proj = fit(st.cam, W, H, st.margin);
    const P = pr.P;

    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#060a14'; g.fillRect(0, 0, W, H);
    const vg = g.createRadialGradient(W * 0.5, H * 0.55, 40, W * 0.5, H * 0.55, Math.max(W, H) * 0.6);
    vg.addColorStop(0, 'rgba(24,70,144,0.55)'); vg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
    for (const s of st.stars) { g.globalAlpha = s.a * (0.6 + 0.4 * Math.sin(t * s.f + s.x)); g.fillStyle = '#eff0f2'; g.fillRect(s.x, s.y, s.r, s.r); }
    // the land, fading in once read
    if (st.land) {
      const L = st.land, [x0, y0] = P(L.b.n, L.b.w), [x1, y1] = P(L.b.s, L.b.e);
      g.globalAlpha = Math.min(1, (t - L.t0) / 2.5);
      g.imageSmoothingEnabled = true;
      g.drawImage(L.cv, x0, y0, x1 - x0, y1 - y0);
    }
    // every known node, faint: the city emerges from them
    g.globalAlpha = 0.22; g.fillStyle = '#7cd991';
    for (const n of st.nodes) if (!n.star) { const [x, y] = P(n.lat, n.lon); g.beginPath(); g.arc(x, y, 1.2, 0, 7); g.fill(); }
    // main-mesh embers
    st.embers = st.embers.filter((e) => t - e.t0 < 1.6);
    for (const e of st.embers) { const a = 1 - (t - e.t0) / 1.6, [x, y] = P(e.lat, e.lon); g.globalAlpha = 0.35 * a; g.fillStyle = '#9fb4d8'; g.beginPath(); g.arc(x, y, 1.5 + (1 - a) * 5, 0, 7); g.fill(); }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'lighter';
    // comets, with their lit route and pulses at each relay
    st.comets = st.comets.filter((c) => t - c.t0 < Math.max(ACTIVE_S, (c.hops.length - 1) * HOP_S + 2.5));
    for (const c of st.comets) {
      const last = c.hops.length - 1, hf = (t - c.t0) / HOP_S;
      if (hf > last + 3) continue;
      const pts = c.hops.map((h) => P(h.lat, h.lon));
      const rgb = KINDS[c.kind].rgb.join(',');
      const fade = Math.max(0, Math.min(1, 1 - (hf - last) / 3));
      for (let h = 0; h < last; h++) {
        const lit = ease(hf - h);
        if (lit <= 0) continue;
        const [ax, ay] = pts[h], [bx, by] = pts[h + 1];
        g.strokeStyle = `rgba(${rgb},${0.22 * fade})`; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + (bx - ax) * lit, ay + (by - ay) * lit); g.stroke();
      }
      for (let h = 1; h <= last; h++) {
        const since = (hf - h) * HOP_S;
        if (since >= 0 && since < 0.9) {
          const [x, y] = pts[h];
          g.strokeStyle = `rgba(${rgb},${(0.9 - since) * 0.7})`; g.lineWidth = 1.5;
          g.beginPath(); g.arc(x, y, 4 + since * 30, 0, 7); g.stroke();
        }
      }
      if (hf >= last) continue;
      for (let k = TRAIL; k >= 0; k--) {
        const hk = hf - k * 0.035;
        if (hk < 0) continue;
        const h = Math.floor(hk), u = ease(hk - h);
        const [ax, ay] = pts[h], [bx, by] = pts[h + 1];
        const x = ax + (bx - ax) * u, y = ay + (by - ay) * u;
        g.fillStyle = `rgba(${rgb},${(1 - k / (TRAIL + 1)) * (k ? 0.5 : 1)})`;
        g.beginPath(); g.arc(x, y, k ? 2.8 * (1 - k / 16) : 3.2, 0, 7); g.fill();
        if (!k) {
          const gl = g.createRadialGradient(x, y, 0, x, y, 18);
          gl.addColorStop(0, `rgba(${rgb},0.55)`); gl.addColorStop(1, `rgba(${rgb},0)`);
          g.fillStyle = gl; g.beginPath(); g.arc(x, y, 18, 0, 7); g.fill();
        }
      }
    }
    drawEffects(g, t, P);
    g.globalCompositeOperation = 'source-over';
    // MediaMesh repeaters as stars
    for (const n of st.nodes) {
      if (!n.star) continue;
      const [x, y] = P(n.lat, n.lon);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      const tw = 0.75 + 0.25 * Math.sin(t * 2 + n.tw);
      const gl = g.createRadialGradient(x, y, 0, x, y, 9);
      gl.addColorStop(0, `rgba(124,217,145,${0.55 * tw})`); gl.addColorStop(1, 'rgba(124,217,145,0)');
      g.fillStyle = gl; g.beginPath(); g.arc(x, y, 9, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 1.8, 0, 7); g.fill();
    }
    drawLabels(g, t, P);
    hud(clockMs, nowMs);
    st.raf = requestAnimationFrame(frame);
  }

  /** Bursts, shimmers and falling embers where clips arrived. */
  function drawEffects(g, t, P) {
    st.fx = st.fx.filter((f) => t - f.t0 < (f.type === 'fall' ? 3.2 : 2.4));
    for (const f of st.fx) {
      const [x, y] = P(f.lat, f.lon), u = t - f.t0, rgb = f.rgb.join(',');
      if (f.type === 'burst') {
        for (let r = 0; r < 3; r++) {
          const v = u - r * 0.18;
          if (v <= 0) continue;
          g.strokeStyle = `rgba(${rgb},${Math.max(0, 0.8 - v / 1.8)})`; g.lineWidth = 2.2 - r * 0.5;
          g.beginPath(); g.arc(x, y, 6 + v * (60 + r * 18), 0, 7); g.stroke();
        }
        const gl = g.createRadialGradient(x, y, 0, x, y, 40);
        gl.addColorStop(0, `rgba(${rgb},${Math.max(0, 0.6 - u / 1.2)})`); gl.addColorStop(1, `rgba(${rgb},0)`);
        g.fillStyle = gl; g.beginPath(); g.arc(x, y, 40, 0, 7); g.fill();
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2 + rnd(f.t0 + k) * 0.4, d = 8 + u * 70 * (0.6 + rnd(k + f.t0) * 0.6);
          g.fillStyle = `rgba(${rgb},${Math.max(0, 0.9 - u / 1.6)})`;
          g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 1.6, 0, 7); g.fill();
        }
      } else if (f.type === 'shimmer') {
        for (let k = 0; k < f.n; k++) {
          const a = rnd(k * 7.1 + f.t0) * Math.PI * 2, d = 10 + rnd(k * 3.3 + f.t0) * 34;
          const tw = Math.max(0, Math.sin((u * 6 + rnd(k) * 6)) * (1 - u / 2.4));
          g.fillStyle = `rgba(${rgb},${0.9 * tw})`;
          const sx = x + Math.cos(a) * d, sy = y + Math.sin(a) * d - u * 6;
          g.fillRect(sx - 0.6, sy - 3, 1.2, 6); g.fillRect(sx - 3, sy - 0.6, 6, 1.2);
        }
      } else if (f.type === 'fall') {
        // a dull red flash, then the lost pieces falling away
        if (u < 0.9) {
          g.strokeStyle = `rgba(${rgb},${0.7 * (1 - u / 0.9)})`; g.lineWidth = 2;
          g.beginPath(); g.arc(x, y, 6 + u * 26, 0, 7); g.stroke();
        }
        for (let k = 0; k < Math.max(5, f.n); k++) {
          const vx = (rnd(k * 5.7 + f.t0) - 0.5) * 70, vy = -30 - rnd(k * 2.9 + f.t0) * 45;
          const pos = (v) => [x + vx * v, y + vy * v + 60 * v * v];
          const [sx, sy] = pos(u), [px, py] = pos(Math.max(0, u - 0.18));
          const a = Math.max(0, 1 - u / 3.2);
          g.strokeStyle = `rgba(${rgb},${0.45 * a})`; g.lineWidth = 2;
          g.beginPath(); g.moveTo(px, py); g.lineTo(sx, sy); g.stroke();
          const gl = g.createRadialGradient(sx, sy, 0, sx, sy, 9);
          gl.addColorStop(0, `rgba(${rgb},${0.95 * a})`); gl.addColorStop(1, `rgba(${rgb},0)`);
          g.fillStyle = gl; g.beginPath(); g.arc(sx, sy, 9, 0, 7); g.fill();
        }
      }
    }
  }

  /** Names: both ends of what's crossing first, then the busiest repeaters; none covering another. */
  function drawLabels(g, t, P) {
    g.font = '500 12px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
    const items = [];
    const add = (h, pri, alpha) => {
      if (!h || !h.name) return;
      const [x, y] = P(h.lat, h.lon);
      items.push({ text: h.name, x, y, pri, alpha, width: g.measureText(h.name).width });
    };
    for (const c of st.comets) {
      const age = t - c.t0, last = c.hops.length - 1;
      const vis = Math.min(1, age * 3) * Math.max(0, Math.min(1, 1 - (age / HOP_S - last) / 2));
      if (vis <= 0) continue;
      add(c.hops[0], 100 + vis, 0.85 * vis);
      add(c.hops[last], 100 + vis, 0.85 * vis);
    }
    // the busiest repeaters keep a quiet name
    [...st.activity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([name, n], i) => {
      const node = st.nodes.find((x) => x.name === name);
      if (node) add(node, 10 - i + Math.min(5, n / 50), 0.38);
    });
    // and none under the moment on show
    let keepOut = st.keepOut;
    if (st.banner) {
      const r = st.el.querySelector('[data-ns-moment]').getBoundingClientRect();
      if (r.width) keepOut = keepOut.concat([[r.left - 8, r.top - 8, r.right + 8, r.bottom + 8]]);
    }
    placeLabels(items, st.w, st.h, keepOut).forEach((l) => {
      g.textAlign = l.align;
      g.fillStyle = `rgba(239,240,242,${l.alpha})`;
      g.fillText(l.text, l.tx, l.ty);
    });
    g.textAlign = 'left';
  }

  let lastHud = '';
  function hud(clockMs, nowMs) {
    const d = new Date(clockMs);
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const date = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase();
    const idle = st.replay ? REPLAY_IDLE_MS : TRANSFER_IDLE_MS;
    const tick = st.ticker.map((tr) => {
      const done = nowMs - tr.last > idle;
      const end = done ? ` <span class="nightsky-muted">· ${esc(outcomeText(tr.outcome || {}))}</span>` : '';
      return `<div>${done ? '' : '<i class="nightsky-dot" style="--c:rgb(' + KINDS[tr.kind].rgb.join(',') + ')"></i>'}${esc(tr.label)}${end}</div>`;
    }).join('');
    // one moment at a time, each for a few seconds
    const box = st.el.querySelector('[data-ns-moment]');
    if (st.banner && nowMs - st.banner.at > BANNER_MS) { st.banner = null; box.classList.remove('is-on'); }
    if (!st.banner && st.moments.length && (!st.lastBannerAt || nowMs - st.lastBannerAt > BANNER_MS + 700)) {
      const m = st.moments.shift();
      st.banner = { at: nowMs };
      st.lastBannerAt = nowMs;
      box.innerHTML = `<b>${esc(m.title)}</b>${m.sub ? `<span>${esc(m.sub)}</span>` : ''}`;
      box.classList.remove('is-on'); void box.offsetWidth; box.classList.add('is-on');
    }
    const sig = time + date + JSON.stringify(st.counts) + tick;
    if (sig === lastHud) return;
    lastHud = sig;
    st.el.querySelector('[data-ns-time]').textContent = time;
    st.el.querySelector('[data-ns-date]').textContent = date;
    const c = st.counts;
    const shown = Object.assign({ unknown: Math.max(0, c.all - c.photo - c.video - c.voice) }, c);
    for (const k of ['all', 'photo', 'video', 'voice', 'unknown', 'relays']) st.el.querySelector(`[data-ns-count="${k}"]`).textContent = shown[k].toLocaleString();
    st.el.querySelector('[data-ns-ticker]').innerHTML = tick;
  }

  root.LiveNightSky = {
    open, close, isOpen, packet, ember, replay, stopReplay, projection, transferLabel, kindOf, KINDS,
    boundsOf, padBounds, fit, cameraTarget, easeBounds, placeLabels, outcomeOf, outcomeText, routeKm, landCanvas,
  };
})(typeof window !== 'undefined' ? window : globalThis);
