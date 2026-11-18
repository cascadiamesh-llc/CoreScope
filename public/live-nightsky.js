/* Night-sky Live mode: a full-screen, panel-free view of MediaMesh for a
 * screen at a meetup. Repeaters are stars; each photo, video or voice packet
 * crosses as a comet, hop by hop, coloured by kind; main-mesh traffic glows
 * faintly underneath. live.js feeds it (LiveNightSky.packet / .ember) while
 * it is open, and can hand it the last day to replay in a minute
 * (LiveNightSky.replay). Drawn on its own canvas; nothing here touches the
 * Live map. */
'use strict';

(function (root) {
  const KINDS = {
    photo: { label: 'Photo', rgb: [240, 171, 252] },
    video: { label: 'Video', rgb: [125, 211, 252] },
    voice: { label: 'Voice clip', rgb: [253, 224, 71] },
    clip: { label: 'Media clip', rgb: [221, 214, 254] },
  };
  const HOP_S = 0.55;          // seconds a comet takes per hop
  const TRAIL = 14;            // trail samples behind a comet's head
  const TRANSFER_IDLE_MS = 8000;

  function kindOf(k) { return KINDS[k] ? k : 'clip'; }

  /** Fits lat/lon points into a w x h box with a margin: { P(lat, lon) -> [x, y] }. */
  function projection(points, w, h, margin) {
    const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && !(p.lat === 0 && p.lon === 0));
    let s = 90, n = -90, west = 180, e = -180;
    pts.forEach((p) => { s = Math.min(s, p.lat); n = Math.max(n, p.lat); west = Math.min(west, p.lon); e = Math.max(e, p.lon); });
    if (!pts.length) { s = 47.5; n = 47.7; west = -122.45; e = -122.2; }
    // never tighter than about 6 km, so one repeater isn't a full screen
    const minSpan = 0.055;
    if (n - s < minSpan) { const c = (n + s) / 2; s = c - minSpan / 2; n = c + minSpan / 2; }
    if (e - west < minSpan * 1.5) { const c = (e + west) / 2; west = c - minSpan * 0.75; e = c + minSpan * 0.75; }
    const kx = Math.cos(((n + s) / 2) * Math.PI / 180);
    // margin: a number, or { top, right, bottom, left } to keep clear of the HUD
    const mm = margin == null ? 70 : margin;
    const m = typeof mm === 'number' ? { top: mm, right: mm, bottom: mm, left: mm } : mm;
    const sc = Math.min((w - m.left - m.right) / ((e - west) * kx), (h - m.top - m.bottom) / (n - s));
    const ox = m.left + (w - m.left - m.right - (e - west) * kx * sc) / 2, oy = m.top + (h - m.top - m.bottom - (n - s) * sc) / 2;
    return { P: (lat, lon) => [ox + (lon - west) * kx * sc, oy + (n - lat) * sc], bounds: { s, n, w: west, e } };
  }

  /** "Photo · First Hill → Rainier View" */
  function transferLabel(kind, hops, seconds) {
    const k = KINDS[kindOf(kind)];
    let t = k.label + (kind !== 'photo' && seconds > 0 ? `, ${seconds} s` : '');
    const a = hops && hops[0] && hops[0].name, b = hops && hops.length > 1 && hops[hops.length - 1].name;
    if (a && b) t += ` · ${a} → ${b}`;
    return t;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function rnd(i) { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

  let st = null;   // state while open

  function open(opts) {
    if (st) return;
    const el = document.createElement('div');
    el.className = 'nightsky';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'MediaMesh night sky');
    el.innerHTML = `<canvas class="nightsky-canvas" aria-hidden="true"></canvas>
      <div class="nightsky-brand"><b>MEDIAMESH</b> LIVE${opts && opts.place ? ' · ' + esc(String(opts.place).toUpperCase()) : ''}</div>
      <div class="nightsky-clock" aria-hidden="true"><span data-ns-time></span><small data-ns-date></small></div>
      <div class="nightsky-counters" aria-live="off">
        <div><span data-ns-count="all">0</span><small>transfers</small></div>
        <div><span data-ns-count="photo">0</span><small>photos</small></div>
        <div><span data-ns-count="video">0</span><small>videos</small></div>
        <div><span data-ns-count="voice">0</span><small>voice clips</small></div>
        <div><span data-ns-count="hops">0</span><small>hops crossed</small></div>
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
      el, cv, g: cv.getContext('2d'), opts: opts || {}, comets: [], pulses: [], embers: [],
      transfers: new Map(), counts: { all: 0, photo: 0, video: 0, voice: 0, hops: 0 }, ticker: [],
      stars: [], w: 0, h: 0, raf: 0, replay: null, startedAt: performance.now(),
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
    el.querySelector('[data-ns-act="close"]').focus();
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
    st.proj = projection(focus.length ? focus : nodes, st.w, st.h, { top: hudEdge('top'), bottom: hudEdge('bottom'), left: side, right: side });
    st.nodes = nodes.map((n) => ({ xy: st.proj.P(n.lat, n.lon), star: !!n.star, name: n.name, tw: rnd(n.lat * 1000 + n.lon) * 6 }));
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

  /** A photo, video or voice packet: { key (its transfer), kind, hops:
   * [{lat, lon, name}], seconds }. now: ms on the sky's clock (default now). */
  function packet(p, now) {
    if (!st || !p || !p.hops || p.hops.length < 2) return;
    const t = (now == null ? performance.now() : now) / 1000;
    const kind = kindOf(p.kind);
    const pts = p.hops.map((h) => st.proj.P(h.lat, h.lon));
    st.comets.push({ pts, kind, t0: t, names: p.hops });
    st.counts.hops += p.hops.length - 1;
    // one ticker line and one count per transfer
    const key = p.key || (kind + '|' + p.hops[0].lat + ',' + p.hops[0].lon);
    let tr = st.transfers.get(key);
    const ms = t * 1000;
    if (!tr || ms - tr.last > TRANSFER_IDLE_MS) {
      tr = { kind, first: ms, last: ms, label: transferLabel(kind, p.hops, p.seconds), counted: false };
      st.counts.all++;
      st.transfers.set(key, tr);
      st.ticker.unshift(tr);
      st.ticker.length = Math.min(st.ticker.length, 3);
      if (st.transfers.size > 300) st.transfers.delete(st.transfers.keys().next().value);
    }
    if (tr.kind === 'clip' && kind !== 'clip') { tr.kind = kind; tr.label = transferLabel(kind, p.hops, p.seconds); }
    tr.last = ms;
    if (!tr.counted && kind !== 'clip') { st.counts[kind]++; tr.counted = true; }
  }

  /** A main-mesh packet somewhere: a faint glow at lat/lon. */
  function ember(lat, lon, now) {
    if (!st || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const [x, y] = st.proj.P(lat, lon);
    st.embers.push({ x, y, t0: (now == null ? performance.now() : now) / 1000 });
    if (st.embers.length > 400) st.embers.shift();
  }

  /** Replays events [{ t (epoch ms), ...packet }] over opts.durationMs, the
   * clock running from opts.from to opts.to (epoch ms). */
  function replay(events, opts) {
    if (!st) return;
    const dur = (opts && opts.durationMs) || 60000;
    st.counts = { all: 0, photo: 0, video: 0, voice: 0, hops: 0 };
    st.transfers.clear(); st.ticker = []; st.comets = [];
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
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#03050b'; g.fillRect(0, 0, W, H);
    const vg = g.createRadialGradient(W * 0.5, H * 0.55, 40, W * 0.5, H * 0.55, Math.max(W, H) * 0.6);
    vg.addColorStop(0, 'rgba(60,20,90,0.32)'); vg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
    for (const s of st.stars) { g.globalAlpha = s.a * (0.6 + 0.4 * Math.sin(t * s.f + s.x)); g.fillStyle = '#cbd5ff'; g.fillRect(s.x, s.y, s.r, s.r); }
    // every known node, faint: the city emerges from them
    g.globalAlpha = 0.22; g.fillStyle = '#64748b';
    for (const n of st.nodes) if (!n.star) { g.beginPath(); g.arc(n.xy[0], n.xy[1], 1.2, 0, 7); g.fill(); }
    // main-mesh embers
    st.embers = st.embers.filter((e) => t - e.t0 < 1.6);
    for (const e of st.embers) { const a = 1 - (t - e.t0) / 1.6; g.globalAlpha = 0.35 * a; g.fillStyle = '#94a3b8'; g.beginPath(); g.arc(e.x, e.y, 1.5 + (1 - a) * 5, 0, 7); g.fill(); }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'lighter';
    // comets, with their lit route and pulses at each relay
    st.comets = st.comets.filter((c) => t - c.t0 < (c.pts.length - 1) * HOP_S + 2.5);
    for (const c of st.comets) {
      const rgb = KINDS[c.kind].rgb.join(',');
      const hf = (t - c.t0) / HOP_S, last = c.pts.length - 1;
      const fade = Math.max(0, Math.min(1, 1 - (hf - last) / 3));
      for (let h = 0; h < last; h++) {
        const lit = ease(hf - h);
        if (lit <= 0) continue;
        const [ax, ay] = c.pts[h], [bx, by] = c.pts[h + 1];
        g.strokeStyle = `rgba(${rgb},${0.22 * fade})`; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + (bx - ax) * lit, ay + (by - ay) * lit); g.stroke();
      }
      for (let h = 1; h <= last; h++) {
        const since = (hf - h) * HOP_S;
        if (since >= 0 && since < 0.9) {
          const [x, y] = c.pts[h];
          g.strokeStyle = `rgba(${rgb},${(0.9 - since) * 0.7})`; g.lineWidth = 1.5;
          g.beginPath(); g.arc(x, y, 4 + since * 30, 0, 7); g.stroke();
        }
      }
      if (hf >= last) continue;
      for (let k = TRAIL; k >= 0; k--) {
        const hk = hf - k * 0.035;
        if (hk < 0) continue;
        const h = Math.floor(hk), u = ease(hk - h);
        const [ax, ay] = c.pts[h], [bx, by] = c.pts[h + 1];
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
    g.globalCompositeOperation = 'source-over';
    // MediaMesh repeaters as stars
    for (const n of st.nodes) {
      if (!n.star) continue;
      const tw = 0.75 + 0.25 * Math.sin(t * 2 + n.tw);
      const gl = g.createRadialGradient(n.xy[0], n.xy[1], 0, n.xy[0], n.xy[1], 9);
      gl.addColorStop(0, `rgba(240,171,252,${0.55 * tw})`); gl.addColorStop(1, 'rgba(240,171,252,0)');
      g.fillStyle = gl; g.beginPath(); g.arc(n.xy[0], n.xy[1], 9, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(n.xy[0], n.xy[1], 1.8, 0, 7); g.fill();
    }
    // names at both ends of what's crossing
    g.font = '500 12px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
    for (const c of st.comets) {
      const vis = Math.min(1, (t - c.t0) * 3) * Math.max(0, Math.min(1, 1 - ((t - c.t0) / HOP_S - (c.pts.length - 1)) / 2));
      if (vis <= 0) continue;
      for (const i of [0, c.pts.length - 1]) {
        const nm = c.names[i] && c.names[i].name;
        if (!nm) continue;
        g.fillStyle = `rgba(226,232,240,${0.85 * vis})`;
        // to the left of the point when the name would run off the right edge
        const tw = g.measureText(nm).width, x = c.pts[i][0];
        g.textAlign = x + 10 + tw > W - 8 ? 'right' : 'left';
        g.fillText(nm, g.textAlign === 'right' ? x - 10 : x + 10, c.pts[i][1] - 10);
      }
    }
    g.textAlign = 'left';
    hud(clockMs, nowMs);
    st.raf = requestAnimationFrame(frame);
  }

  let lastHud = '';
  function hud(clockMs, nowMs) {
    const d = new Date(clockMs);
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const date = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase();
    const tick = st.ticker.map((tr) => {
      const done = nowMs - tr.last > TRANSFER_IDLE_MS;
      return `<div>${done ? '' : '<i class="nightsky-dot" style="--c:rgb(' + KINDS[tr.kind].rgb.join(',') + ')"></i>'}${esc(tr.label)}${done ? ' <span class="nightsky-muted">· finished</span>' : ''}</div>`;
    }).join('');
    const sig = time + date + JSON.stringify(st.counts) + tick;
    if (sig === lastHud) return;
    lastHud = sig;
    st.el.querySelector('[data-ns-time]').textContent = time;
    st.el.querySelector('[data-ns-date]').textContent = date;
    for (const k of ['all', 'photo', 'video', 'voice', 'hops']) st.el.querySelector(`[data-ns-count="${k}"]`).textContent = st.counts[k].toLocaleString();
    st.el.querySelector('[data-ns-ticker]').innerHTML = tick;
  }

  root.LiveNightSky = { open, close, isOpen, packet, ember, replay, stopReplay, projection, transferLabel, kindOf, KINDS };
})(typeof window !== 'undefined' ? window : globalThis);
