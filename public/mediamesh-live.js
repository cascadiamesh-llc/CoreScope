/* === CoreScope — mediamesh-live.js ===
 * Live packets on the MediaMesh tab's coverage map: photos, video and voice
 * cross the map as they are heard on radio2, with the night sky's effects
 * (live-nightsky.js) drawn over the real map instead of a sky:
 *
 * - each clip packet is a comet, coloured by kind, flying hop by hop along
 *   the repeaters it took and on to the observer that heard it, lighting
 *   its route as it goes, with a ring at every repeater that passed it on;
 * - other radio2 traffic glows faintly where it was heard (embers);
 * - when a clip's last piece has passed: a burst where it arrived when every
 *   piece was heard, and a shimmer when parity pieces made up for some;
 * - moments: the first photo, video and voice of the day, the longest route
 *   today, a whole clip across many hops;
 * - "The last 24 hours in a minute" replays the day.
 *
 * A panel on the map lists the latest transfers. The map is never moved for
 * the person looking at it. With reduced motion, routes show still and fade.
 * Packets come over the page's shared WebSocket (onWS in app.js); clip
 * parsing is live.js's (window._liveMediaMesh), so the two agree.
 */
'use strict';

(function (root) {
  const KINDS = {
    photo: { label: 'Photo', v: '--mmlive-photo', fb: [124, 217, 145] },
    video: { label: 'Video', v: '--mmlive-video', fb: [239, 240, 242] },
    voice: { label: 'Voice', v: '--mmlive-voice', fb: [96, 150, 240] },
    clip: { label: 'Media', v: '--mmlive-clip', fb: [180, 205, 235] },
  };
  const HOP_S = 0.55;            // seconds a comet takes per hop
  const TRAIL = 14;              // trail samples behind a comet's head
  const IDLE_MS = 8000;          // a transfer is over once quiet this long
  const REPLAY_IDLE_MS = 1500;
  const WINDOW_MS = 10 * 60000;  // "in the last 10 minutes"
  const BANNER_MS = 5200;
  const LIST_MAX = 5;
  const icon = (n) => `<svg class="ph-icon" aria-hidden="true"><use href="/icons/phosphor-sprite.svg#${n}"/></svg>`;
  const CHECK = icon('ph-check') + ' ';
  const PLAY = icon('ph-play') + ' The last 24 hours in a minute';
  const STOP = icon('ph-square') + ' Stop the replay';
  const STORE_KEY = 'mmLivePackets';

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const kindOf = (k) => (KINDS[k] ? k : 'clip');
  const ease = (u) => (u < 0 ? 0 : u > 1 ? 1 : u * u * (3 - 2 * u));
  function rnd(i) { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

  /** '#7cd991' or 'rgb(1, 2, 3)' -> [r, g, b], or null. */
  function rgbOf(c) {
    const s = String(c || '').trim();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    }
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  // ---- Where a packet went -------------------------------------------------

  /** Positions to resolve hops with: { byKey: pubkey -> {lat, lon, name},
   * reps: [{ pk, lat, lon, name }] (MediaMesh repeaters, for hop prefixes) }.
   * Observers' own nodes come from the links heard on radio2. */
  function buildIndex(repeaters, links) {
    const byKey = new Map(), reps = [];
    (repeaters || []).forEach((r) => {
      const pk = String(r.public_key || '').toLowerCase();
      if (!pk || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return;
      const p = { pk, lat: r.lat, lon: r.lon, name: r.name || pk.slice(0, 8) };
      byKey.set(pk, p); reps.push(p);
    });
    (links || []).forEach((l) => {
      const pk = String(l.observer_id || '').toLowerCase();
      if (pk && !byKey.has(pk) && Number.isFinite(l.to_lat) && Number.isFinite(l.to_lon)) {
        byKey.set(pk, { pk, lat: l.to_lat, lon: l.to_lon, name: l.observer_name || l.to || pk.slice(0, 8) });
      }
    });
    return { byKey, reps };
  }

  const near2 = (a, b) => (a.lat - b.lat) ** 2 + ((a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180)) ** 2;

  /** A path's places: each hop (by the server's resolved key, else by its
   * prefix among the MediaMesh repeaters, the nearest to the hop before when
   * more than one match), then the observer that heard the last. Hops that
   * can't be placed are left out. -> [{ lat, lon, name }] */
  function placePath(hops, resolved, observerId, idx) {
    const out = [];
    (hops || []).forEach((h, i) => {
      const rk = resolved && resolved[i] ? String(resolved[i]).toLowerCase() : '';
      let p = rk ? idx.byKey.get(rk) : null;
      if (!p) {
        const pre = String(typeof h === 'string' ? h : (h && (h.prefix || h.id)) || '').toLowerCase();
        if (pre.length >= 2) {
          const c = idx.reps.filter((r) => r.pk.startsWith(pre));
          if (c.length === 1) p = c[0];
          else if (c.length > 1 && out.length) { const prev = out[out.length - 1]; p = c.slice().sort((a, b) => near2(a, prev) - near2(b, prev))[0]; }
        }
      }
      if (p && !(out.length && out[out.length - 1] === p)) out.push(p);
    });
    const ob = observerId ? idx.byKey.get(String(observerId).toLowerCase()) : null;
    if (ob && !(out.length && out[out.length - 1] === ob)) out.push(ob);
    return out.map((p) => ({ lat: p.lat, lon: p.lon, name: p.name }));
  }

  /** Kilometres along [{ lat, lon }]. */
  function routeKm(pts) {
    let km = 0;
    for (let i = 1; i < (pts || []).length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dy = (b.lat - a.lat) * 111.32, dx = (b.lon - a.lon) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
      km += Math.sqrt(dx * dx + dy * dy);
    }
    return km;
  }

  /** "A → B → C", or "A → … → D" for long routes. */
  function routeText(pts) {
    const n = (pts || []).map((p) => p.name).filter(Boolean);
    if (n.length <= 3) return n.join(' → ');
    return `${n[0]} → … → ${n[n.length - 1]}`;
  }

  /** How a finished clip went (the night sky's rule): { outcome: 'whole' |
   * 'parity' | 'lost' | null, missing, rebuilt }. Only clips whose
   * announcement says how many pieces they have are judged. */
  function outcomeOf(tr) {
    if (root.LiveNightSky && root.LiveNightSky.outcomeOf) return root.LiveNightSky.outcomeOf(tr);
    if (!tr || !(tr.total > 0) || !tr.idx || !tr.idx.size) return { outcome: null, missing: 0, rebuilt: 0 };
    let missing = 0, rebuilt = 0;
    for (let b = 0; b < Math.ceil(tr.total / 20); b++) {
      let miss = 0;
      for (let i = b * 20; i < Math.min(tr.total, b * 20 + 20); i++) if (!tr.idx.has(i)) miss++;
      const par = (tr.parity && tr.parity[b]) || 0;
      if (miss <= par) rebuilt += miss; else missing += miss;
    }
    return { outcome: missing ? 'lost' : rebuilt ? 'parity' : 'whole', missing, rebuilt };
  }

  // ---- What happened: transfers, the day's moments --------------------------

  /** Tracks transfers and the day from packets: { note(p, ms, replay) ->
   * moments [{ title, sub }], judge(ms, replay) -> finished transfers,
   * list(ms), count(ms) }. p: { key, kind, pts, hash, index, parity,
   * total, seconds }. */
  function createTracker() {
    const transfers = new Map();
    const hashes = new Map(); // packet hash -> ms first seen (for the count)
    let today = { day: '', kinds: new Set(), longestKm: 0, known: false };
    const dayKey = (ms) => new Date(ms).toDateString();
    function dayOf(ms, known) {
      const k = dayKey(ms);
      if (today.day !== k) today = { day: k, kinds: new Set(), longestKm: 0, known };
      return today;
    }
    function note(p, ms, opts) {
      const o = opts || {};
      const moments = [];
      const kind = kindOf(p.kind);
      if (p.hash && !hashes.has(p.hash)) hashes.set(p.hash, ms);
      if (hashes.size > 4000) hashes.delete(hashes.keys().next().value);
      let tr = transfers.get(p.key);
      const idle = o.replay ? REPLAY_IDLE_MS : IDLE_MS;
      if (!tr || ms - tr.last > idle) {
        tr = { key: p.key, kind, first: ms, last: ms, idx: new Set(), parity: {}, total: 0, seconds: 0, pts: p.pts, maxHops: 0, hashes: new Set(), judged: false, counted: false };
        transfers.delete(p.key);
        transfers.set(p.key, tr);
        if (transfers.size > 300) transfers.delete(transfers.keys().next().value);
      }
      if (tr.kind === 'clip' && kind !== 'clip') tr.kind = kind;
      tr.last = ms;
      if (p.total > 0) tr.total = p.total;
      if (p.seconds > 0) tr.seconds = p.seconds;
      if (p.hash) tr.hashes.add(p.hash);
      if (p.parity && Number.isFinite(p.index)) { const b = Math.floor(p.index / 8); tr.parity[b] = (tr.parity[b] || 0) + 1; } else if (Number.isFinite(p.index)) tr.idx.add(p.index);
      if (p.pts.length > tr.maxHops) { tr.maxHops = p.pts.length; tr.pts = p.pts; }
      const day = dayOf(o.dayMs || ms, o.known !== false);
      if (!tr.counted && tr.kind !== 'clip') {
        tr.counted = true;
        if (day.known && !day.kinds.has(tr.kind) && !o.quiet) moments.push({ title: `First ${KINDS[tr.kind].label.toLowerCase()} of the day`, sub: routeText(tr.pts) });
        day.kinds.add(tr.kind);
      }
      if (p.pts.length >= 3) {
        const km = routeKm(p.pts);
        if (km > day.longestKm + 0.3) {
          if (day.known && day.longestKm > 0 && !o.quiet) moments.push({ title: 'Longest route today', sub: `${p.pts.length - 1} hops · ${km.toFixed(1)} km · ${routeText(p.pts)}` });
          day.longestKm = km;
        }
      }
      return moments;
    }
    function judge(ms, replay) {
      const idle = replay ? REPLAY_IDLE_MS : IDLE_MS, done = [];
      transfers.forEach((tr) => {
        if (tr.judged || ms - tr.last <= idle) return;
        tr.judged = true;
        tr.outcome = outcomeOf(tr);
        done.push(tr);
      });
      return done;
    }
    function list(n) { return Array.from(transfers.values()).sort((a, b) => b.last - a.last).slice(0, n || LIST_MAX); }
    function count(ms) { let c = 0; hashes.forEach((t) => { if (ms - t <= WINDOW_MS) c++; }); return c; }
    function reset() { transfers.clear(); hashes.clear(); }
    return { note, judge, list, count, reset, transfers };
  }

  function ago(ms, now) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 5) return 'now';
    if (s < 60) return `${s} s ago`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  }

  /** One line of the panel for a transfer. */
  function transferHtml(tr, now) {
    const k = KINDS[kindOf(tr.kind)];
    const label = k.label + (tr.kind !== 'photo' && tr.seconds > 0 ? `, ${tr.seconds} s` : '');
    const pieces = tr.hashes ? tr.hashes.size : 0;
    const dest = tr.pts && tr.pts.length ? tr.pts[tr.pts.length - 1].name : '';
    const o = tr.outcome && tr.outcome.outcome;
    let text;
    if (o === 'whole') text = `${CHECK}${esc(label)}, ${tr.total} pieces, heard whole at ${esc(dest)}`;
    else if (o === 'parity') text = `${CHECK}${esc(label)}, ${tr.total} pieces, whole at ${esc(dest)} (${tr.outcome.rebuilt} rebuilt from parity)`;
    else text = `${esc(label)} · ${esc(routeText(tr.pts))}${tr.judged && pieces > 1 ? ` · ${pieces} pieces heard` : ''}`;
    return `<li class="mmlive-item${tr.judged ? ' mmlive-item--done' : ''}"><span class="mmlive-dot mmlive-dot--${kindOf(tr.kind)}" aria-hidden="true"></span><span class="mmlive-text">${text} <span class="mmlive-ago">${ago(tr.last, now)}</span></span></li>`;
  }

  // ---- Reading a packet ----------------------------------------------------

  function helpers() { return root._liveMediaMesh || null; }

  /** A WebSocket packet -> { typeName, payload, hops, resolved, observer,
   * hash, mediamesh, text }. */
  function readPacket(pkt) {
    const dec = pkt.decoded || (typeof root.getParsedDecoded === 'function' ? root.getParsedDecoded(pkt) : {}) || {};
    const payload = dec.payload || {};
    let hops = null;
    if (pkt.path_json && typeof root.getParsedPath === 'function') { try { hops = root.getParsedPath(pkt); } catch (_) { hops = null; } }
    if (!hops) hops = (dec.path && dec.path.hops) || [];
    const resolved = typeof root.getResolvedPath === 'function' ? root.getResolvedPath(pkt) : null;
    return {
      typeName: (dec.header && dec.header.payloadTypeName) || pkt.payload_type_name || '',
      payload, hops, resolved, observer: pkt.observer_id || '', hash: pkt.hash || '', mediamesh: pkt.mediamesh === true, text: payload.text || '',
    };
  }

  /** The clip a radio2 packet belongs to, as the night sky counts it, or null. */
  function clipFor(typeName, payload, hops, hash, at, announced, live) {
    const H = helpers();
    if (!H) return null;
    const c = live && H.liveClip ? H.liveClip(typeName, payload, hash, at) : H.clipOf(typeName, payload);
    if (!c) return null;
    let sid = c.sid, parity = false;
    if (sid && !announced.has(sid) && H.paritySid && announced.has(H.paritySid(sid))) { sid = H.paritySid(sid); parity = true; }
    const a = sid ? announced.get(sid) : null;
    return {
      key: H.transferKey(sid, payload, hops), kind: c.talk ? 'voice' : (a ? a.kind : 'clip'),
      seconds: a ? a.seconds : 0, index: c.talk ? null : c.index, parity, total: a ? a.total : 0,
    };
  }

  // ---- On the map -----------------------------------------------------------

  /**
   * Live packets on a Leaflet map. opts: { L, map, mapEl, repeaters,
   * links, toggle (a checkbox) }. Returns a function that takes it all down.
   */
  function attach(opts) {
    const { L, map } = opts;
    const mapEl = opts.mapEl || map.getContainer();
    const doc = mapEl.ownerDocument;
    const win = doc.defaultView || root;
    const idx = buildIndex(opts.repeaters, opts.links);
    const tracker = createTracker();
    const announced = new Map();
    const reduced = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let on = true;
    try { on = win.localStorage.getItem(STORE_KEY) !== '0'; } catch (_) { /* default on */ }
    if (opts.toggle) opts.toggle.checked = on;

    const cv = doc.createElement('canvas');
    cv.className = 'mmlive-canvas';
    cv.setAttribute('aria-hidden', 'true');
    mapEl.appendChild(cv);
    const g = cv.getContext('2d');
    const panel = doc.createElement('div');
    panel.className = 'mmlive-panel';
    panel.innerHTML = `<div class="mmlive-head"><span class="mmlive-live" aria-hidden="true"></span><strong data-mmlive-title>Live · MediaMesh</strong>
      <button type="button" class="mmlive-fold" data-mmlive-fold aria-expanded="true" aria-label="Hide the list">${icon('ph-caret-up')}</button></div>
      <div class="mmlive-body" data-mmlive-body>
        <div class="mmlive-count" data-mmlive-count aria-live="polite"></div>
        <ul class="mmlive-list" data-mmlive-list></ul>
        <div class="mmlive-replay" data-mmlive-replaybox hidden><div class="mmlive-bar"><span data-mmlive-bar></span></div></div>
        <button type="button" class="mmlive-btn" data-mmlive-replay>${PLAY}</button>
      </div>`;
    const banner = doc.createElement('div');
    banner.className = 'mmlive-banner';
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    mapEl.appendChild(panel);
    mapEl.appendChild(banner);
    // the panel is the map's: clicks and wheel on it don't move the map
    if (L && L.DomEvent) { L.DomEvent.disableClickPropagation(panel); L.DomEvent.disableScrollPropagation(panel); }
    const $ = (sel) => panel.querySelector(sel);

    let destroyed = false;
    let comets = [], embers = [], fx = [], raf = 0, W = 0, H = 0, dpr = 1, replay = null, colours = null, bannerTimer = 0, lastJudge = 0;
    const lightTheme = () => {
      const bg = rgbOf(getComputedStyle(doc.documentElement).getPropertyValue('--card-bg'));
      return bg ? (bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114) > 140 : false;
    };
    function readColours() {
      const cs = getComputedStyle(doc.documentElement);
      colours = { light: lightTheme() };
      Object.keys(KINDS).forEach((k) => { colours[k] = (rgbOf(cs.getPropertyValue(KINDS[k].v)) || KINDS[k].fb).join(','); });
      colours.ember = (rgbOf(cs.getPropertyValue('--mmlive-ember')) || [159, 180, 216]).join(',');
      colours.parity = (rgbOf(cs.getPropertyValue('--mmlive-parity')) || [253, 230, 138]).join(',');
    }
    readColours();

    function resize() {
      const r = mapEl.getBoundingClientRect();
      dpr = Math.min(2, win.devicePixelRatio || 1);
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      cv.width = W * dpr; cv.height = H * dpr;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
    }
    resize();
    map.on('resize', resize);
    const P = (lat, lon) => { const p = map.latLngToContainerPoint([lat, lon]); return [p.x, p.y]; };

    function showBanner(m) {
      banner.innerHTML = `<strong>${esc(m.title)}</strong>${m.sub ? `<span>${esc(m.sub)}</span>` : ''}`;
      banner.hidden = !on;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { banner.hidden = true; }, BANNER_MS);
    }

    function renderPanel() {
      const now = replay ? replay.clock : Date.now();
      const n = tracker.count(now);
      $('[data-mmlive-count]').textContent = replay ? replay.label
        : n ? `${n} media packet${n === 1 ? '' : 's'} in the last 10 minutes` : 'Listening for photos, video and voice on radio2…';
      $('[data-mmlive-list]').innerHTML = tracker.list(LIST_MAX).map((tr) => transferHtml(tr, now)).join('');
    }

    function kick() { if (!raf && on && !destroyed) raf = win.requestAnimationFrame(frame); }

    /** A clip packet: its comet, its transfer, any moment. */
    function addClip(p, ms, o) {
      const t = win.performance.now() / 1000;
      if (on && p.pts.length >= 2 && !doc.hidden) {
        comets.push({ pts: p.pts, kind: kindOf(p.kind), t0: t });
        if (comets.length > 120) comets.shift();
      }
      // a live packet during a replay draws, but the list is the replay's
      if (!(replay && !o.replay)) {
        const moments = tracker.note(p, ms, o);
        if (moments.length) showBanner(moments[moments.length - 1]);
      }
      kick();
    }

    function addEmber(pt) {
      if (!on || doc.hidden || !pt) return;
      embers.push({ lat: pt.lat, lon: pt.lon, t0: win.performance.now() / 1000 });
      if (embers.length > 300) embers.shift();
      kick();
    }

    function onPacket(pkt) {
      if (!pkt) return;
      const r = readPacket(pkt);
      const H = helpers();
      if (r.text && H && H.parseAnnouncement) {
        const a = H.parseAnnouncement(r.text);
        if (a) { announced.set(a.sid, a); if (announced.size > 200) announced.delete(announced.keys().next().value); }
      }
      if (!r.mediamesh) return;
      const pts = placePath(r.hops, r.resolved, r.observer, idx);
      const now = Date.now();
      const clip = clipFor(r.typeName, r.payload, r.hops, r.hash, now, announced, true);
      if (clip) addClip(Object.assign({ pts, hash: r.hash }, clip), now, {});
      else addEmber(pts[0]);
    }
    const wsHandler = (msg) => { if (msg && msg.type === 'packet') onPacket(msg.data); };
    if (typeof root.onWS === 'function') root.onWS(wsHandler);

    // ---- the day in a minute ----
    async function startReplay() {
      let data;
      try { data = await fetch('/api/analytics/mediamesh/replay?hours=24').then((r) => r.json()); } catch (_) { data = null; }
      if (!data || destroyed) return;
      const H = helpers();
      const ann = new Map();
      (data.announcements || []).forEach((a) => { const p = H && H.parseAnnouncement(a.text); if (p) ann.set(p.sid, p); });
      const events = [];
      (data.events || []).forEach((ev) => {
        const pts = placePath(ev.path || [], null, ev.observer, idx);
        const clip = clipFor(ev.type, ev, ev.path || [], ev.hash, 0, ann, false);
        if (clip && pts.length >= 2) events.push(Object.assign({ t: Date.parse(ev.ts), pts, hash: ev.hash }, clip));
      });
      events.sort((a, b) => a.t - b.t);
      const from = Date.parse(data.from), to = Date.parse(data.to);
      const hours = Math.max(1, Math.round((to - from) / 3600000));
      tracker.reset();
      replay = { events, i: 0, start: win.performance.now(), dur: 60000, from, to, clock: from,
        label: events.length ? `The last ${hours} hour${hours === 1 ? '' : 's'} in a minute` : `Nothing crossed in the last ${hours} hour${hours === 1 ? '' : 's'}` };
      $('[data-mmlive-replaybox]').hidden = false;
      $('[data-mmlive-replay]').innerHTML = STOP;
      renderPanel();
      kick();
    }
    function stopReplay() {
      replay = null;
      tracker.reset();
      $('[data-mmlive-replaybox]').hidden = true;
      $('[data-mmlive-replay]').innerHTML = PLAY;
      renderPanel();
    }
    const onPanelClick = (e) => {
      if (e.target.closest('[data-mmlive-replay]')) { if (replay) stopReplay(); else startReplay(); }
      const fold = e.target.closest('[data-mmlive-fold]');
      if (fold) {
        const open = fold.getAttribute('aria-expanded') !== 'true';
        fold.setAttribute('aria-expanded', String(open));
        fold.innerHTML = icon(open ? 'ph-caret-up' : 'ph-caret-down');
        fold.setAttribute('aria-label', open ? 'Hide the list' : 'Show the list');
        $('[data-mmlive-body]').hidden = !open;
      }
    };
    panel.addEventListener('click', onPanelClick);

    function setOn(v) {
      on = v;
      try { win.localStorage.setItem(STORE_KEY, v ? '1' : '0'); } catch (_) { /* fine */ }
      cv.hidden = !v; panel.hidden = !v;
      if (!v) { banner.hidden = true; comets = []; embers = []; fx = []; if (replay) stopReplay(); }
      else { readColours(); renderPanel(); }
    }
    const onToggle = () => setOn(!!opts.toggle.checked);
    if (opts.toggle) opts.toggle.addEventListener('change', onToggle);
    setOn(on);
    const ticker = setInterval(() => { if (on && !replay) renderPanel(); }, 15000);

    // ---- drawing ----
    function frame(nowMs) {
      raf = 0;
      if (!on || destroyed) return;
      const t = nowMs / 1000;
      if (replay) {
        const r = replay, f = Math.min(1, (nowMs - r.start) / r.dur);
        const due = r.from + (r.to - r.from) * f;
        while (r.i < r.events.length && r.events[r.i].t <= due) {
          const ev = r.events[r.i++];
          addClip(ev, due, { replay: true, dayMs: ev.t, known: r.from <= new Date(ev.t).setHours(0, 0, 0, 0) });
        }
        r.clock = due;
        const bar = $('[data-mmlive-bar]');
        if (bar) bar.style.width = (f * 100).toFixed(1) + '%';
        if (f >= 1 && nowMs - r.start > r.dur + 4000) stopReplay();
      }
      if (nowMs - lastJudge > 250) {
        lastJudge = nowMs;
        const ms = replay ? replay.clock : Date.now();
        const done = tracker.judge(ms, !!replay);
        done.forEach((tr) => {
          const o = tr.outcome && tr.outcome.outcome, dest = tr.pts[tr.pts.length - 1];
          if (!dest) return;
          if ((o === 'whole' || o === 'parity') && !reduced) fx.push({ type: 'burst', lat: dest.lat, lon: dest.lon, kind: kindOf(tr.kind), t0: t });
          if (o === 'parity' && !reduced) fx.push({ type: 'shimmer', lat: dest.lat, lon: dest.lon, t0: t, n: Math.min(14, 4 + tr.outcome.rebuilt * 3) });
          if ((o === 'whole' || o === 'parity') && tr.maxHops >= 5) showBanner({ title: `A whole ${KINDS[kindOf(tr.kind)].label.toLowerCase()} across ${tr.maxHops - 1} hops`, sub: routeText(tr.pts) });
        });
        if (done.length || replay) renderPanel();
      }
      draw(t);
      const busy = comets.length || embers.length || fx.length || replay || tracker.list(LIST_MAX).some((tr) => !tr.judged);
      if (busy) raf = win.requestAnimationFrame(frame);
      else g.clearRect(0, 0, cv.width, cv.height);
    }

    function draw(t) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const light = colours.light;
      // other radio2 traffic: faint embers
      embers = embers.filter((e) => t - e.t0 < 1.6);
      for (const e of embers) {
        const a = 1 - (t - e.t0) / 1.6, [x, y] = P(e.lat, e.lon);
        g.globalAlpha = (light ? 0.5 : 0.4) * a; g.fillStyle = `rgb(${colours.ember})`;
        g.beginPath(); g.arc(x, y, 1.5 + (1 - a) * 5, 0, 7); g.fill();
      }
      g.globalAlpha = 1;
      // glow adds up on a dark map; on a light one it would wash out
      g.globalCompositeOperation = light ? 'source-over' : 'lighter';
      comets = comets.filter((c) => (t - c.t0) / HOP_S < c.pts.length - 1 + 3);
      for (const c of comets) drawComet(c, t, light);
      drawEffects(t);
      g.globalCompositeOperation = 'source-over';
    }

    function drawComet(c, t, light) {
      const last = c.pts.length - 1, hf = (t - c.t0) / HOP_S;
      const pts = c.pts.map((h) => P(h.lat, h.lon));
      const rgb = colours[c.kind];
      const fade = Math.max(0, Math.min(1, 1 - (hf - last) / 3));
      // the route lights up behind it
      for (let h = 0; h < last; h++) {
        const lit = reduced ? 1 : ease(hf - h);
        if (lit <= 0) continue;
        const [ax, ay] = pts[h], [bx, by] = pts[h + 1];
        if (light) { g.strokeStyle = `rgba(255,255,255,${0.5 * fade})`; g.lineWidth = 4; g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + (bx - ax) * lit, ay + (by - ay) * lit); g.stroke(); }
        g.strokeStyle = `rgba(${rgb},${(reduced ? 0.8 : light ? 0.6 : 0.35) * fade})`; g.lineWidth = light ? 2 : 1.6;
        g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + (bx - ax) * lit, ay + (by - ay) * lit); g.stroke();
      }
      if (reduced) return;
      // a ring at every repeater as it passes it on, and at the observer
      for (let h = 1; h <= last; h++) {
        const since = (hf - h) * HOP_S;
        if (since >= 0 && since < 0.9) {
          const [x, y] = pts[h];
          g.strokeStyle = `rgba(${rgb},${(0.9 - since) * 0.8})`; g.lineWidth = 1.8;
          g.beginPath(); g.arc(x, y, 4 + since * 30, 0, 7); g.stroke();
          // and a four-point twinkle
          const s = (1 - since / 0.9) * 9;
          g.fillStyle = `rgba(${rgb},${(0.9 - since)})`;
          g.fillRect(x - 0.8, y - s, 1.6, s * 2); g.fillRect(x - s, y - 0.8, s * 2, 1.6);
        }
      }
      if (hf >= last) return;
      for (let k = TRAIL; k >= 0; k--) {
        const hk = hf - k * 0.035;
        if (hk < 0) continue;
        const h = Math.floor(hk), u = ease(hk - h);
        const [ax, ay] = pts[h], [bx, by] = pts[h + 1];
        const x = ax + (bx - ax) * u, y = ay + (by - ay) * u;
        g.fillStyle = `rgba(${rgb},${(1 - k / (TRAIL + 1)) * (k ? 0.55 : 1)})`;
        g.beginPath(); g.arc(x, y, k ? 3 * (1 - k / 16) : 3.6, 0, 7); g.fill();
        if (!k) {
          const gl = g.createRadialGradient(x, y, 0, x, y, 20);
          gl.addColorStop(0, `rgba(${rgb},0.6)`); gl.addColorStop(1, `rgba(${rgb},0)`);
          g.fillStyle = gl; g.beginPath(); g.arc(x, y, 20, 0, 7); g.fill();
          if (light) { g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, 3.8, 0, 7); g.stroke(); }
        }
      }
    }

    function drawEffects(t) {
      fx = fx.filter((f) => t - f.t0 < 2.4);
      for (const f of fx) {
        const [x, y] = P(f.lat, f.lon), u = t - f.t0;
        if (f.type === 'burst') {
          const rgb = colours[f.kind];
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
            g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 1.8, 0, 7); g.fill();
          }
        } else if (f.type === 'shimmer') {
          for (let k = 0; k < f.n; k++) {
            const a = rnd(k * 7.1 + f.t0) * Math.PI * 2, d = 10 + rnd(k * 3.3 + f.t0) * 34;
            const tw = Math.max(0, Math.sin(u * 6 + rnd(k) * 6) * (1 - u / 2.4));
            g.fillStyle = `rgba(${colours.parity},${0.95 * tw})`;
            const sx = x + Math.cos(a) * d, sy = y + Math.sin(a) * d - u * 6;
            g.fillRect(sx - 0.7, sy - 3.5, 1.4, 7); g.fillRect(sx - 3.5, sy - 0.7, 7, 1.4);
          }
        }
      }
    }

    // a theme switch: new colours
    const mo = typeof win.MutationObserver === 'function' ? new win.MutationObserver(() => readColours()) : null;
    if (mo) mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    renderPanel();

    return () => {
      destroyed = true;
      if (typeof root.offWS === 'function') root.offWS(wsHandler);
      if (raf) win.cancelAnimationFrame(raf);
      clearInterval(ticker); clearTimeout(bannerTimer);
      if (mo) mo.disconnect();
      map.off('resize', resize);
      if (opts.toggle) opts.toggle.removeEventListener('change', onToggle);
      panel.removeEventListener('click', onPanelClick);
      cv.remove(); panel.remove(); banner.remove();
    };
  }

  root.MediaMeshLive = { KINDS, rgbOf, buildIndex, placePath, routeKm, routeText, outcomeOf, createTracker, transferHtml, readPacket, clipFor, attach };
})(typeof window !== 'undefined' ? window : globalThis);
