/* Replay a clip's path on a map: every piece the observers heard, run along
 * the path it took, from its flight recorder
 * (/api/analytics/mediamesh/clips/{sid}, kept for a week). Opened in place
 * under a clip's row in Recent clips (mediamesh-insights.js). Pure functions
 * turn the flight recorder into timed events; open() draws the map and the
 * controls. */
'use strict';

(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const DUR = 2.5; // seconds a relay stays drawn
  const QUIET = 6; // stretches with nothing heard for longer are skipped while playing
  const SPEEDS = [1, 4, 16];

  const fmtClock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

  /** The flight recorder as events, each one observer hearing one piece:
   * { t (seconds after the clip was sent), path (hashes), parity, index, by }.
   * Sorted by t; end is the last t. */
  function replayEvents(log) {
    const out = [];
    const pieces = (log && log.pieces) || [];
    const ann = log && log.announcement && Date.parse(log.announcement.at);
    let t0 = Number.isFinite(ann) ? ann : NaN;
    if (!Number.isFinite(t0)) {
      pieces.forEach((p) => (p.heard || []).forEach((h) => { const t = Date.parse(h.at); if (Number.isFinite(t) && !(t >= t0)) t0 = t; }));
    }
    pieces.forEach((p) => (p.heard || []).forEach((h) => {
      const t = Date.parse(h.at);
      if (!Number.isFinite(t)) return;
      out.push({ t: Math.max(0, (t - t0) / 1000), path: (h.path || []).map((x) => String(x).toLowerCase()), parity: !!p.parity, index: p.index, by: h.name || h.observer || '' });
    }));
    out.sort((a, b) => a.t - b.t);
    return { t0, events: out, end: out.length ? out[out.length - 1].t : 0 };
  }

  /** Where each hop is, from the flight recorder's hops: hash -> [lat, lon]. */
  function hopPlaces(log) {
    const out = {};
    Object.entries((log && log.hops) || {}).forEach(([k, h]) => {
      if (h && Number.isFinite(h.lat) && Number.isFinite(h.lon) && (h.lat || h.lon)) out[k.toLowerCase()] = [h.lat, h.lon];
    });
    return out;
  }

  /** The events being relayed at t (at most 6, the latest). */
  function activeAt(events, t) {
    return events.filter((e) => t >= e.t && t < e.t + DUR).slice(-6);
  }

  /** Where a piece is along its path at fraction f (0..1) of the way. */
  function along(pts, f) {
    if (pts.length < 2) return pts[0];
    const lens = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); lens.push(l); total += l; }
    let want = Math.max(0, Math.min(1, f)) * total;
    for (let i = 1; i < pts.length; i++) {
      if (want <= lens[i - 1] || i === pts.length - 1) {
        const g = lens[i - 1] ? Math.min(1, want / lens[i - 1]) : 1;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * g, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * g];
      }
      want -= lens[i - 1];
    }
    return pts[pts.length - 1];
  }

  /** The next time to play from: t + step, jumping over quiet stretches. */
  function nextT(events, t, step, end) {
    let n = t + step;
    const busy = events.some((e) => (e.t >= n && e.t <= n + QUIET) || (e.t <= n && n < e.t + DUR));
    if (!busy) {
      const next = events.find((e) => e.t > n);
      n = next ? Math.max(n, next.t - 0.5) : end + DUR + 1;
    }
    return n > end + DUR ? 0 : n;
  }

  /** What's been heard by t: data pieces by number, parity relays, the
   * latest few events. */
  function heardBy(events, t) {
    const past = events.filter((e) => e.t <= t);
    return {
      data: new Set(past.filter((e) => !e.parity && e.index >= 0).map((e) => e.index)).size,
      parity: past.filter((e) => e.parity).length,
      relays: past.length,
      recent: past.slice(-6).reverse(),
    };
  }

  function panelHtml(log, title) {
    const c = log.clip || {};
    const priv = !!log.private;
    const speed = SPEEDS.map((s) => `<button type="button" class="mmr-speed" data-mmr-speed="${s}" aria-pressed="${s === 4}">${s}×</button>`).join('');
    return `<div class="mmr">
      <div class="mmr-map-box"><div class="mmr-map" role="img" aria-label="Map of the repeaters this clip's pieces crossed"></div>
        <p class="text-muted mmr-note">Hops without a known place are drawn straight across.</p></div>
      <div class="mmr-side">
        <div class="mmr-head"><div><h3>Replay: ${esc(title)}</h3><p class="text-muted">Every piece the observers heard, along the path it took${priv ? '. On a private channel the pieces can\'t be read, only where they went' : ''}.</p></div>
          <button type="button" class="mmr-close" data-mmr-close aria-label="Close the replay"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="mmr-controls"><button type="button" class="mmr-play" data-mmr-play>Pause</button>${speed}<span class="mmr-clock"><strong data-mmr-clock>0:00</strong> <span class="text-muted">of <span data-mmr-end></span></span></span></div>
        <div class="mmr-ticks" aria-hidden="true"></div>
        <label class="mmr-scrub"><span class="text-muted">Scrub through the clip</span><input type="range" min="0" step="1" value="0" data-mmr-range></label>
        <p class="text-muted mmr-key">${priv ? '<span class="mmr-sw"></span>a piece' : '<span class="mmr-sw"></span>a piece of the clip <span class="mmr-sw mmr-sw--parity"></span>parity or repair'} <span class="mmr-sw mmr-sw--now"></span>relaying now · Quiet stretches are skipped while playing.</p>
        <div class="mm-ins-tiles mmr-tiles">
          <div class="mm-ins-tile"><div class="mm-ins-big mm-ins-accent" data-mmr-data></div><div class="mm-ins-label">${priv ? 'times observers heard its pieces' : 'pieces heard by number'}</div></div>
          ${priv ? '' : '<div class="mm-ins-tile"><div class="mm-ins-big" data-mmr-parity></div><div class="mm-ins-label">parity and repair relays</div></div>'}
          <div class="mm-ins-tile"><div class="mmr-whole" data-mmr-whole></div><div class="mm-ins-label">${esc(c.observerName ? `at ${c.observerName}, the far end` : 'at the far end')}</div></div>
        </div>
        <h4 class="mmr-h4">Just heard</h4><ol class="mmr-recent" data-mmr-recent></ol>
      </div></div>`;
  }

  /** When the far end could rebuild it, seconds after it was sent (null
   * when it couldn't, or for a private-channel clip). */
  function wholeAtS(log, t0) {
    const c = log.clip || {};
    if (log.private || !(c.outcome === 'whole' || c.outcome === 'parity')) return null;
    const t = Date.parse(c.lastAt);
    return Number.isFinite(t) && Number.isFinite(t0) ? Math.max(0, (t - t0) / 1000) : null;
  }

  let current = null;

  function close() {
    if (!current) return;
    clearInterval(current.timer);
    if (current.map) current.map.remove();
    if (current.box && current.onClick) current.box.removeEventListener('click', current.onClick);
    if (current.onClose) current.onClose();
    current = null;
  }

  /** Opens the replay of clip key in box. opts: { api, title, onClose }. */
  async function open(box, key, opts) {
    close();
    const o = opts || {};
    const me = { box, onClose: o.onClose };
    current = me;
    box.innerHTML = '<p class="text-muted">Loading the replay…</p>';
    let log;
    try {
      log = await o.api('/analytics/mediamesh/clips/' + encodeURIComponent(key), { ttl: 60000 });
    } catch (_) {
      log = null;
    }
    if (current !== me) return;
    const { t0, events, end } = replayEvents(log);
    const places = hopPlaces(log);
    if (!events.length) { box.innerHTML = '<p class="text-muted">Nothing of this clip is kept to replay.</p>'; return; }
    box.innerHTML = panelHtml(log, o.title || 'this clip');
    const L = root.L, q = (s) => box.querySelector(s);
    const css = (n, f) => { const v = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue(n).trim() : ''; return v || f; };
    const cData = css('--mediamesh-path-color', '#d946ef'), cParity = css('--accent', '#14b8a6'), cNow = css('--status-amber', '#f59e0b');
    const names = {};
    Object.entries((log && log.hops) || {}).forEach(([k, h]) => { names[k.toLowerCase()] = (h && h.name) || k.toUpperCase(); });
    const name = (h) => names[h] || h.toUpperCase();
    const pts = Object.values(places);
    const nodeMarks = {};
    if (L && pts.length) {
      const map = L.map(q('.mmr-map'), { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
      const tileUrl = typeof root.getTileUrl === 'function' ? root.getTileUrl() : null;
      if (tileUrl) L.tileLayer(tileUrl, { maxZoom: 18 }).addTo(map);
      map.fitBounds(L.latLngBounds(pts).pad(0.15));
      Object.entries(places).forEach(([k, p]) => {
        nodeMarks[k] = L.circleMarker(p, { radius: 6, weight: 2, color: '#ffffff', fillColor: cData, fillOpacity: 0.55 }).bindTooltip(esc(name(k))).addTo(map);
      });
      me.map = map;
      me.layer = L.layerGroup().addTo(map);
    }
    const range = q('[data-mmr-range]');
    range.max = String(Math.ceil(end + DUR));
    q('[data-mmr-end]').textContent = fmtClock(end);
    q('.mmr-ticks').innerHTML = events.map((e) => `<i class="${e.parity ? 'is-parity' : ''}" style="left:${(e.t / Math.max(1, end + DUR) * 100).toFixed(2)}%"></i>`).join('');
    const wholeS = wholeAtS(log, t0);
    Object.assign(me, { t: events[0].t, playing: true, speed: 4 });
    const render = () => {
      const t = me.t;
      q('[data-mmr-clock]').textContent = fmtClock(t);
      range.value = String(Math.round(t));
      const h = heardBy(events, t);
      q('[data-mmr-data]').innerHTML = log.private ? String(h.relays) : `${h.data} <span class="mmr-of">of ${(log.clip && log.clip.total) || '?'}</span>`;
      const par = q('[data-mmr-parity]');
      if (par) par.textContent = String(h.parity);
      const w = q('[data-mmr-whole]');
      w.textContent = wholeS == null ? (log.private ? 'Can\'t be told' : 'Not rebuilt from what was heard') : t >= wholeS ? `Enough to rebuild it, at ${fmtClock(wholeS)}` : 'Not enough yet';
      w.classList.toggle('is-whole', wholeS != null && t >= wholeS);
      q('[data-mmr-recent]').innerHTML = h.recent.map((e) => `<li><span class="text-muted">${fmtClock(e.t)}</span><span class="${e.parity ? 'mmr-parity' : 'mmr-data'}">${log.private ? 'a piece' : e.parity ? 'parity / repair' : `piece ${e.index}`}</span><span>${esc(e.path.map(name).join(' → ') || 'straight from the sender')} <span class="text-muted">· heard by ${esc(e.by)}</span></span></li>`).join('');
      if (!me.layer) return;
      me.layer.clearLayers();
      const lit = new Set();
      activeAt(events, t).forEach((e) => {
        const line = e.path.filter((x) => places[x]).map((x) => { lit.add(x); return places[x]; });
        if (!line.length) return;
        const col = e.parity && !log.private ? cParity : cData;
        if (line.length > 1) L.polyline(line, { color: col, weight: 4, opacity: 0.9, interactive: false }).addTo(me.layer);
        L.circleMarker(along(line, (t - e.t) / (DUR * 0.8)), { radius: 6, weight: 3, color: col, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(me.layer);
      });
      Object.entries(nodeMarks).forEach(([k, m]) => m.setStyle({ fillColor: lit.has(k) ? cNow : cData, fillOpacity: lit.has(k) ? 1 : 0.55 }));
    };
    me.onClick = (e) => {
      if (e.target.closest('[data-mmr-close]')) { close(); return; }
      if (e.target.closest('[data-mmr-play]')) {
        me.playing = !me.playing;
        q('[data-mmr-play]').textContent = me.playing ? 'Pause' : 'Play';
        return;
      }
      const s = e.target.closest('[data-mmr-speed]');
      if (s) {
        me.speed = Number(s.dataset.mmrSpeed);
        box.querySelectorAll('[data-mmr-speed]').forEach((b) => b.setAttribute('aria-pressed', String(b === s)));
      }
    };
    box.addEventListener('click', me.onClick);
    range.addEventListener('input', () => {
      me.t = Number(range.value);
      me.playing = false;
      q('[data-mmr-play]').textContent = 'Play';
      render();
    });
    me.timer = setInterval(() => {
      if (!me.playing || current !== me) return;
      me.t = nextT(events, me.t, 0.1 * me.speed, end);
      render();
    }, 100);
    render();
  }

  root.MediaMeshReplay = { open, close, replayEvents, hopPlaces, activeAt, along, nextT, heardBy, wholeAtS, fmtClock };
})(typeof window !== 'undefined' ? window : globalThis);
