/* Kiosk mode (#/kiosk): one link for a TV at a meetup. Full screen, no
 * controls, cycling every 30 s through the night sky (the last day replayed),
 * the coverage in 3D, the week's top relays, the week's recap and how to
 * join (with a QR code). Esc goes back to Analytics; ← and → step through.
 * Every slide has its own dark design and light text. */
'use strict';

(function (root) {
  const SLIDE_MS = 30000;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const FEC_XOR = 0xFEC0FEC0;
  const ANN_RE = /(?:^|[\s:])(VI1|VV1|VE3|VM1):([0-9a-z]+):([0-9a-z]+):([0-9a-z]+):([0-9a-z]+)/i;
  const KIND = { VI1: 'photo', VV1: 'video', VE3: 'voice', VM1: 'voice' };

  /** The slides kiosk mode shows, in order, given what is ready. */
  function slideList(ready) {
    const out = [];
    if (ready.sky) out.push('sky');
    if (ready.cov) out.push('3d');
    out.push('board', 'week', 'join');
    return out;
  }

  /** Path hop -> {lat, lon, name} when exactly one placed node matches. */
  function hopResolver(nodes) {
    const seen = new Set();
    const list = (nodes || []).filter((n) => n.public_key && Number.isFinite(n.lat) && Number.isFinite(n.lon) && !(n.lat === 0 && n.lon === 0))
      .map((n) => ({ k: String(n.public_key).toLowerCase(), lat: n.lat, lon: n.lon, name: n.name || '' }))
      .filter((n) => !seen.has(n.k) && seen.add(n.k)); // the same node from two lists counts once
    return (hop) => {
      const h = String(hop || '').toLowerCase();
      if (h.length < 2) return null;
      const hit = list.filter((n) => n.k.startsWith(h));
      return hit.length === 1 ? hit[0] : null;
    };
  }

  /** Replay events for the night sky: [{ t, key, kind, hops }]. */
  function skyEvents(replay, resolve) {
    const kinds = {};
    ((replay && replay.announcements) || []).forEach((a) => {
      const m = ANN_RE.exec(String(a.text || ''));
      if (!m) return;
      const sid = (parseInt(m[2], 36) >>> 0).toString(16).padStart(8, '0');
      kinds[sid] = { kind: KIND[m[1].toUpperCase()], seconds: m[1].toUpperCase() === 'VI1' ? 0 : parseInt(m[5], 36) };
    });
    const out = [];
    ((replay && replay.events) || []).forEach((ev) => {
      const hops = (ev.path || []).map(resolve).filter(Boolean);
      if (hops.length < 2) return;
      const bytes = String(ev.decryptedBlob || ev.raw || '').toLowerCase();
      let sid = /^5[3467][0-9a-f]{8}/.test(bytes) ? bytes.slice(2, 10) : '';
      if (sid && !kinds[sid]) {
        const p = ((parseInt(sid, 16) ^ FEC_XOR) >>> 0).toString(16).padStart(8, '0');
        if (kinds[p]) sid = p;
      }
      const a = sid ? kinds[sid] : null;
      out.push({ t: Date.parse(ev.ts), key: sid ? 'sid|' + sid : 'h|' + ev.hash, kind: bytes[1] === '3' || bytes[1] === '4' ? 'voice' : a ? a.kind : 'clip', seconds: a ? a.seconds : 0, hops });
    });
    return out;
  }

  function boardHtml(mm) {
    const reps = ((mm && mm.repeaters) || []).filter((r) => r.media_relayed_7d > 0).sort((a, b) => b.media_relayed_7d - a.media_relayed_7d).slice(0, 6);
    const rows = reps.length ? reps.map((r, i) => `<div class="kiosk-row"><span class="kiosk-rank">${i + 1}</span><span class="kiosk-name">${esc(r.name || String(r.public_key || '').slice(0, 8))}</span><span class="kiosk-val">${Number(r.media_relayed_7d).toLocaleString()} <small>packets</small></span></div>`).join('')
      : '<p class="kiosk-sub">No photos, video or voice relayed yet this week.</p>';
    return `<div class="kiosk-pad"><h1>Top relays this week</h1><div class="kiosk-sub">Photos, video and voice carried across MediaMesh</div><div class="kiosk-board">${rows}</div></div>`;
  }

  function joinHtml(url, qrImg) {
    return `<div class="kiosk-pad kiosk-join"><div><h1>Get on MediaMesh</h1>
      <div class="kiosk-sub">Photos, video and voice by radio, no internet or cell service needed.</div>
      <ol class="kiosk-steps"><li>Check you can reach it from home: the address check on the analyzer</li><li>Flash a companion or standalone radio for MediaMesh</li><li>Or put a repeater on your roof and grow the map</li></ol>
      <div class="kiosk-url">${esc(url)}</div></div>
      <div class="kiosk-qr">${qrImg || ''}</div></div>`;
  }

  function qrFor(url) {
    const f = typeof root.qrcode === 'function' ? root.qrcode : null;
    if (!f) return '';
    try { const q = f(0, 'M'); q.addData(url); q.make(); return q.createImgTag(8, 2); } catch (_) { return ''; }
  }

  let st = null;

  async function init(app) {
    destroy();
    const el = document.createElement('div');
    el.className = 'kiosk';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'MediaMesh kiosk');
    el.innerHTML = '<div class="kiosk-stage" data-kiosk-stage><div class="kiosk-pad"><h1>MediaMesh</h1><div class="kiosk-sub">Loading…</div></div></div>';
    document.body.appendChild(el);
    // the clock, slide dots and progress sit above the night sky and 3D view
    const hud = document.createElement('div');
    hud.className = 'kiosk-hud';
    hud.innerHTML = '<div class="kiosk-clock" aria-hidden="true"></div><div class="kiosk-dots" aria-hidden="true"></div><div class="kiosk-prog"><i></i></div>';
    document.body.appendChild(hud);
    if (app) app.innerHTML = '';
    const me = st = { el, hud, i: -1, ready: {}, timer: 0, tick: 0, mm: null };
    me.onKey = (e) => {
      if (e.key === 'Escape') { location.hash = '#/analytics?tab=mediamesh'; return; }
      if (e.key === 'ArrowRight') show(me.i + 1);
      if (e.key === 'ArrowLeft') show(me.i - 1);
    };
    document.addEventListener('keydown', me.onKey, true);
    let idle = 0;
    me.onMove = () => { el.classList.remove('kiosk--idle'); clearTimeout(idle); idle = setTimeout(() => el.classList.add('kiosk--idle'), 3000); };
    document.addEventListener('pointermove', me.onMove);
    me.onMove();
    me.tick = setInterval(() => {
      const c = hud.querySelector('.kiosk-clock');
      const d = new Date();
      if (c) c.innerHTML = `${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}<small>${d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase()}</small>`;
      const bar = hud.querySelector('.kiosk-prog i');
      if (bar && me.started) bar.style.width = Math.min(100, ((Date.now() - me.started) / SLIDE_MS) * 100) + '%';
    }, 250);
    const api = root.api;
    if (typeof api !== 'function') return;
    try { me.mm = await api('/analytics/mediamesh', { ttl: 60000 }); } catch (_) { me.mm = {}; }
    if (st !== me) return;
    try { const d = await api('/analytics/mediamesh/clips?days=7', { ttl: 60000 }); me.clips = (d && d.clips) || []; } catch (_) { me.clips = []; }
    if (st !== me) return;
    show(0);
    // the night sky and the 3D view take longer: they join the cycle when ready
    loadSky(me);
    loadCoverage(me);
  }

  async function loadSky(me) {
    if (!root.LiveNightSky) return;
    try {
      const [replay, nodes] = await Promise.all([root.api('/analytics/mediamesh/replay?hours=24', { ttl: 60000 }), root.api('/nodes?limit=5000', { ttl: 300000 }).catch(() => ({}))]);
      if (st !== me) return;
      const all = ((nodes && (nodes.nodes || nodes)) || []).concat((me.mm && me.mm.repeaters) || []);
      const resolve = hopResolver(Array.isArray(all) ? all : []);
      me.sky = { events: skyEvents(replay, resolve), from: Date.parse(replay.from), to: Date.parse(replay.to),
        stars: ((me.mm && me.mm.repeaters) || []).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)).map((r) => ({ lat: r.lat, lon: r.lon, name: r.name, star: true })) };
      me.ready.sky = me.sky.events.length > 0 || me.sky.stars.length > 1;
    } catch (_) { /* no sky */ }
  }

  async function loadCoverage(me) {
    const M = root.MediaMeshCoverage;
    if (!M || !root.MediaMesh3D) return;
    const placed = ((me.mm && me.mm.repeaters) || []).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    if (!placed.length) return;
    let pool = null;
    try {
      const terrain = await M.loadTerrainLevels(M.terrainPlan(placed, M.CONFIG.modes.ground), null);
      if (st !== me) return;
      M.setCalibration(0);
      const cal = M.fitCalibration(M.linkRows((me.mm && me.mm.links) || [], terrain.elevAt));
      M.setCalibration(cal.offsetDb);
      pool = M.workerPool ? M.workerPool() : null;
      const cov = await M.computeCoverage(placed, terrain.elevAt, 'ground', null, pool ? { run: pool.run } : null);
      if (st !== me || !cov) return;
      me.cov = { cov, elevAt: terrain.elevAt, reps: placed, km2: M.unionKm2(cov) };
      me.ready.cov = true;
    } catch (_) { /* no 3D */ } finally { if (pool) pool.close(); }
  }

  function leaveSlide() {
    if (root.LiveNightSky && root.LiveNightSky.isOpen()) root.LiveNightSky.close();
    if (root.MediaMesh3D && root.MediaMesh3D.isOpen()) root.MediaMesh3D.close();
  }

  function show(i) {
    const me = st;
    if (!me) return;
    clearTimeout(me.timer);
    leaveSlide();
    const list = slideList(me.ready);
    me.i = ((i % list.length) + list.length) % list.length;
    const name = list[me.i];
    me.started = Date.now();
    const stage = me.el.querySelector('[data-kiosk-stage]');
    me.el.dataset.slide = name;
    me.hud.dataset.slide = name;
    me.hud.querySelector('.kiosk-dots').innerHTML = list.map((n, k) => `<span class="${k === me.i ? 'on' : ''}">${{ sky: 'Night sky', '3d': '3D coverage', board: 'Leaderboard', week: 'This week', join: 'Join' }[n]}</span>`).join('');
    stage.innerHTML = '';
    if (name === 'sky') {
      const sky = me.sky;
      root.LiveNightSky.open({ nodes: () => sky.stars, focus: () => sky.stars, fullscreen: false, kiosk: true });
      root.LiveNightSky.replay(sky.events, { from: sky.from, to: sky.to, durationMs: SLIDE_MS - 2000, label: 'The last day, in half a minute' });
    } else if (name === '3d') {
      const c = me.cov;
      root.MediaMesh3D.open({ cov: c.cov, elevAt: c.elevAt, reps: c.reps, backbone: (me.mm && me.mm.backbone) || [], areaKm2: c.km2, kiosk: true,
        modeLabel: 'Where photos, video and voice reach people on the ground' });
    } else if (name === 'board') {
      stage.innerHTML = boardHtml(me.mm);
    } else if (name === 'week') {
      stage.innerHTML = '<div class="kiosk-week"><canvas class="kiosk-recap" role="img" aria-label="This week on MediaMesh"></canvas></div>';
      if (root.MediaMeshRecap) root.MediaMeshRecap.draw(stage.querySelector('canvas'), root.MediaMeshRecap.recapData(me.mm, me.clips, me.cov ? me.cov.km2 : 0), location.host);
    } else {
      const url = location.origin + '/#/analytics?tab=mediamesh';
      stage.innerHTML = joinHtml(url, qrFor(url));
    }
    me.timer = setTimeout(() => show(me.i + 1), SLIDE_MS);
  }

  function destroy() {
    const me = st;
    if (!me) return;
    st = null;
    clearTimeout(me.timer);
    clearInterval(me.tick);
    document.removeEventListener('keydown', me.onKey, true);
    document.removeEventListener('pointermove', me.onMove);
    leaveSlide();
    me.el.remove();
    me.hud.remove();
  }

  root.MediaMeshKiosk = { init, destroy, slideList, hopResolver, skyEvents, boardHtml, joinHtml, SLIDE_MS };
  if (typeof root.registerPage === 'function') root.registerPage('kiosk', { init, destroy });
})(typeof window !== 'undefined' ? window : globalThis);
