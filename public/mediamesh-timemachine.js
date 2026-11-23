/* === CoreScope — mediamesh-timemachine.js ===
 * The time machine (#/mediamesh-timemachine): MediaMesh as it was on any
 * day, two days side by side. Each day the analyzer keeps the MediaMesh
 * repeaters, the backbone and the day's packet counts
 * (/api/mediamesh/history, cmd/server/mediamesh_days.go). Days before it
 * started keeping them are put together from when each repeater was first
 * seen, so they have repeaters and coverage but no links; days it missed
 * carry the day before.
 */
'use strict';

(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtKm2 = (v) => (v < 100 ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : Math.round(v).toLocaleString());
  const DAY_MS = 86400000;

  /** YYYY-MM-DD (UTC) of a time, or '' when it isn't one. */
  function dayOf(t) {
    if (t == null || t === '') return '';
    let ms = typeof t === 'number' ? t : Date.parse(t);
    if (!Number.isFinite(ms) && typeof t === 'string') ms = Date.parse(t.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? '' : 'Z'));
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
  }

  /** Every day from the earliest kept day or first-seen repeater to today. */
  function dayList(days, repeaters, today) {
    const starts = [].concat((days || []).map((d) => d.day), (repeaters || []).map((r) => dayOf(r.first_seen))).filter(Boolean).sort();
    const end = today || dayOf(Date.now());
    if (!starts.length) return [end];
    const out = [];
    for (let t = Date.parse(starts[0] + 'T00:00:00Z'), last = Date.parse(end + 'T00:00:00Z'); t <= last && out.length < 3660; t += DAY_MS) out.push(dayOf(t));
    return out;
  }

  /**
   * MediaMesh on a day: { day, repeaters [{ k, n, lat, lon }], backbone,
   * links, transmissions, media_packets, how } where how is 'kept' (the
   * analyzer's own record), 'carried' (a day it missed: the last kept day
   * before) or 'rebuilt' (before it kept any: the repeaters first seen by
   * then, where they are now).
   */
  function stateOn(day, days, repeaters) {
    const kept = (days || []).filter((d) => d && d.day).sort((a, b) => (a.day < b.day ? -1 : 1));
    const exact = kept.find((d) => d.day === day);
    if (exact) return Object.assign({}, exact, { how: 'kept' });
    const before = kept.filter((d) => d.day < day).pop();
    if (before) return Object.assign({}, before, { day, how: 'carried' });
    const reps = (repeaters || [])
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon) && !r.position_from_name && dayOf(r.first_seen) && dayOf(r.first_seen) <= day)
      .map((r) => ({ k: r.public_key, n: r.name || '', lat: r.lat, lon: r.lon }));
    return { day, repeaters: reps, links: [], backbone: [], transmissions: null, media_packets: null, how: 'rebuilt' };
  }

  /** What changed from a to b: repeaters added and gone, and the counts. */
  function diff(a, b) {
    const ka = new Set(a.repeaters.map((r) => r.k)), kb = new Set(b.repeaters.map((r) => r.k));
    return {
      added: b.repeaters.filter((r) => !ka.has(r.k)),
      gone: a.repeaters.filter((r) => !kb.has(r.k)),
      repeaters: [a.repeaters.length, b.repeaters.length],
      backbone: [a.backbone.length, b.backbone.length],
    };
  }

  /** A small SVG line of repeaters a day, with A and B marked. */
  function chartSvg(list, counts, ia, ib) {
    const W = 600, H = 70, P = 4;
    const max = Math.max(1, ...counts);
    const x = (i) => P + (list.length < 2 ? 0 : (i / (list.length - 1)) * (W - 2 * P));
    const y = (v) => H - P - (v / max) * (H - 2 * P);
    const pts = counts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const mark = (i, cls) => `<line class="${cls}" x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="0" y2="${H}"></line>`;
    const pctX = (i) => ((x(i) / W) * 100).toFixed(2);
    const label = (i, t) => `<span class="mmt-chart-label${x(i) > W * 0.9 ? ' mmt-chart-label--end' : ''}" style="left:${pctX(i)}%" aria-hidden="true">${t}</span>`;
    return `<div class="mmt-chartbox"><svg class="mmt-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="MediaMesh repeaters a day, from ${esc(list[0])} (${counts[0]}) to ${esc(list[list.length - 1])} (${counts[counts.length - 1]})"><polyline class="mmt-chart-line" points="${pts}"></polyline>${mark(ia, 'mmt-chart-a')}${mark(ib, 'mmt-chart-b')}</svg>${label(ia, 'A')}${label(ib, 'B')}</div>`;
  }

  const fmtDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const howText = { kept: 'as the analyzer kept it', carried: 'not kept that day: the day before shown', rebuilt: 'rebuilt from when each repeater was first seen: no links' };

  // ---- The page --------------------------------------------------------------

  let maps = [], destroyed = false, off = null, timer = null;

  function pageHtml() {
    const side = (s) => `<div class="mmt-side">
      <label class="mmt-pick"><span class="mmt-letter">${s}</span> <input type="range" id="mmt${s}" min="0" max="0" value="0" aria-label="Day ${s}"> <strong id="mmt${s}Day"></strong></label>
      <p class="text-muted mmt-how" id="mmt${s}How"></p>
      <div id="mmt${s}Map" class="mmt-map" role="img" aria-label="Map of MediaMesh on day ${s}"></div>
    </div>`;
    return `<div class="mml-page mmt-page">
      ${root.MediaMeshNav ? root.MediaMeshNav.html('timemachine') : ''}
      <div class="mml-head">
        <h1>Time machine</h1>
        <p class="text-muted">MediaMesh on any day since it began, two days side by side: its repeaters, the links they pass photos, video and voice over, and the ground they reach.</p>
      </div>
      <div class="mmt-bar">
        <button type="button" class="tab-btn" id="mmtPlay" aria-pressed="false">Play from A</button>
        <button type="button" class="tab-btn" id="mmtMonth">A month apart</button>
        <button type="button" class="tab-btn" id="mmtAll">First day and today</button>
      </div>
      <div id="mmtChart"></div>
      <div class="mml-tiles" id="mmtTiles"></div>
      <div class="mmt-split">${side('A')}${side('B')}</div>
      <p class="text-muted mml-note" id="mmtStatus">Loading MediaMesh's days…</p>
      <h2 class="mmt-h2">What changed</h2>
      <div id="mmtChanges"></div>
    </div>`;
  }

  async function init(app) {
    destroyed = false;
    app.innerHTML = pageHtml();
    const L = root.L, M = root.MediaMeshCoverage;
    const $ = (id) => app.querySelector('#' + id);
    let hist, mm;
    try {
      [hist, mm] = await Promise.all([
        fetch('/api/mediamesh/history').then((r) => r.json()).catch(() => ({ days: [] })),
        fetch('/api/analytics/mediamesh').then((r) => r.json()),
      ]);
    } catch (_) {
      $('mmtStatus').textContent = 'The analyzer could not be reached.';
      return;
    }
    if (destroyed) return;
    const kept = (hist && hist.days) || [];
    const reps = ((mm && mm.repeaters) || []).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon) && !r.position_from_name);
    const list = dayList(kept, reps, dayOf(Date.now()));
    const states = list.map((d) => stateOn(d, kept, reps));
    const counts = states.map((s) => s.repeaters.length);
    const keyIdx = new Map(reps.map((r, i) => [r.public_key, i]));
    let cov = null, noTerrain = false;
    const kmCache = new Map();
    const km2 = (s) => {
      if (!cov || !M) return null;
      if (!kmCache.has(s.day)) {
        const mask = reps.map(() => false);
        s.repeaters.forEach((r) => { if (keyIdx.has(r.k)) mask[keyIdx.get(r.k)] = true; });
        const k = M.meshCells(cov, mask.map((m) => (m ? 'often' : 'none')), mask).km2;
        kmCache.set(s.day, { km: k[3] + k[4], mask });
      }
      return kmCache.get(s.day);
    };

    ['A', 'B'].forEach((s) => { const el = $('mmt' + s); el.max = String(list.length - 1); });
    const q = new URLSearchParams(String(location.hash.split('?')[1] || ''));
    const at = (d, fallback) => { const i = list.indexOf(d); return i >= 0 ? i : fallback; };
    $('mmtA').value = String(at(q.get('a'), Math.max(0, list.length - 31)));
    $('mmtB').value = String(at(q.get('b'), list.length - 1));

    // the maps, moving together
    const layers = [], overlays = [null, null];
    if (L) {
      const tileUrl = typeof root.getTileUrl === 'function' ? root.getTileUrl() : null;
      const all = reps.length ? L.latLngBounds(reps.map((r) => [r.lat, r.lon])).pad(0.15) : null;
      let syncing = false;
      ['A', 'B'].forEach((s, i) => {
        const m = L.map($('mmt' + s + 'Map'), { zoomControl: true });
        if (tileUrl) L.tileLayer(tileUrl, { maxZoom: 18 }).addTo(m);
        m.createPane('mmtCov').style.zIndex = 450;
        if (all) m.fitBounds(all); else m.setView([47.6, -122.33], 10);
        layers[i] = L.layerGroup().addTo(m);
        maps[i] = m;
      });
      maps.forEach((m, i) => m.on('move', () => {
        if (syncing) return;
        syncing = true;
        maps[1 - i].setView(m.getCenter(), m.getZoom(), { animate: false });
        syncing = false;
      }));
    }

    function drawSide(i, s, other) {
      if (!L || !layers[i]) return;
      const layer = layers[i];
      layer.clearLayers();
      const ink = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#1a1a2e';
      s.backbone.forEach((e) => {
        if ([e.a_lat, e.a_lon, e.b_lat, e.b_lon].every(Number.isFinite)) L.polyline([[e.a_lat, e.a_lon], [e.b_lat, e.b_lon]], { color: ink, weight: Math.min(5, 1.5 + Math.log10(1 + e.packets)), opacity: 0.6, interactive: false }).addTo(layer);
      });
      const theirs = new Set(other.repeaters.map((r) => r.k));
      s.repeaters.forEach((r) => {
        const isNew = i === 1 && !theirs.has(r.k);
        L.circleMarker([r.lat, r.lon], isNew
          ? { radius: 8, weight: 3, color: '#ffffff', fillColor: '#16a34a', fillOpacity: 1 }
          : { radius: 5, weight: 2, color: '#ffffff', fillColor: '#d946ef', fillOpacity: 1 }).bindTooltip(esc(r.n || String(r.k).slice(0, 8)) + (isNew ? ' · new since A' : '')).addTo(layer);
      });
      // repeaters at A that are gone by B, on B's map
      if (i === 1) other.repeaters.filter((r) => !s.repeaters.some((x) => x.k === r.k)).forEach((r) => L.circleMarker([r.lat, r.lon], { radius: 7, weight: 3, color: '#ef4444', fillColor: '#ffffff', fillOpacity: 1 }).bindTooltip(esc(r.n || String(r.k).slice(0, 8)) + ' · gone since A').addTo(layer));
      const k = km2(s);
      if (k && maps[i]) {
        if (overlays[i]) maps[i].removeLayer(overlays[i]);
        const bb = cov.bounds;
        overlays[i] = M.canvasOverlay(L, M.meshCanvas(cov, M.meshCells(cov, k.mask.map((m) => (m ? 'often' : 'none')), k.mask)), [[bb.south, bb.west], [bb.north, bb.east]], { pane: 'mmtCov', opacity: 1 }).addTo(maps[i]);
      }
    }

    function draw() {
      const ia = Number($('mmtA').value), ib = Number($('mmtB').value);
      const a = states[ia], b = states[ib];
      $('mmtADay').textContent = fmtDay(a.day);
      $('mmtBDay').textContent = fmtDay(b.day);
      $('mmtAHow').textContent = howText[a.how];
      $('mmtBHow').textContent = howText[b.how];
      $('mmtChart').innerHTML = chartSvg(list, counts, ia, ib);
      const d = diff(a, b), ka = km2(a), kb = km2(b);
      const tile = (label, x, y, good) => `<div class="mml-tile"><div class="mml-label">${label}</div><div class="mml-big">${x} <span class="mml-arrow" aria-label="becomes">→</span> <span class="${good == null ? '' : good ? 'mms-good' : 'mms-bad'}">${y}</span></div></div>`;
      const cmp = (x, y) => (x === y ? null : y > x);
      const linksKnown = a.how !== 'rebuilt' && b.how !== 'rebuilt';
      $('mmtTiles').innerHTML = tile('MediaMesh repeaters', d.repeaters[0], d.repeaters[1], cmp(d.repeaters[0], d.repeaters[1]))
        + tile('Backbone links', a.how === 'rebuilt' ? '—' : d.backbone[0], b.how === 'rebuilt' ? '—' : d.backbone[1], linksKnown ? cmp(d.backbone[0], d.backbone[1]) : null)
        + tile('Reached, land and water', ka ? `${fmtKm2(ka.km)} km²` : noTerrain ? '—' : '…', kb ? `${fmtKm2(kb.km)} km²` : noTerrain ? '—' : '…', ka && kb ? cmp(Math.round(ka.km), Math.round(kb.km)) : null)
        + tile('Photo and voice packets that day', a.media_packets == null || a.how !== 'kept' ? '—' : a.media_packets.toLocaleString(), b.media_packets == null || b.how !== 'kept' ? '—' : b.media_packets.toLocaleString(), null);
      const names = (rs) => rs.map((r) => `<li>${esc(r.n || String(r.k).slice(0, 8))}</li>`).join('');
      $('mmtChanges').innerHTML = !d.added.length && !d.gone.length
        ? '<p class="text-muted">The same repeaters on both days.</p>'
        : `${d.added.length ? `<p class="mml-sum"><span class="mmt-key mmt-key--new" aria-hidden="true"></span>${d.added.length} new by ${esc(fmtDay(b.day))}</p><ul class="mmt-names">${names(d.added)}</ul>` : ''}${d.gone.length ? `<p class="mml-sum"><span class="mmt-key mmt-key--gone" aria-hidden="true"></span>${d.gone.length} gone by ${esc(fmtDay(b.day))}</p><ul class="mmt-names">${names(d.gone)}</ul>` : ''}`;
      drawSide(0, a, b);
      drawSide(1, b, a);
      try { history.replaceState(null, '', `#/mediamesh-timemachine?a=${a.day}&b=${b.day}`); } catch (_) { /* fine */ }
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      $('mmtPlay').setAttribute('aria-pressed', 'false');
      $('mmtPlay').textContent = 'Play from A';
    }
    function play() {
      if (timer) { stop(); return; }
      const ia = Number($('mmtA').value);
      let ib = ia;
      const step = Math.max(1, Math.ceil((list.length - 1 - ia) / 120));
      $('mmtPlay').setAttribute('aria-pressed', 'true');
      $('mmtPlay').textContent = 'Stop';
      $('mmtB').value = String(ib);
      draw();
      timer = setInterval(() => {
        if (destroyed) { stop(); return; }
        ib = Math.min(list.length - 1, ib + step);
        $('mmtB').value = String(ib);
        draw();
        if (ib >= list.length - 1) stop();
      }, 120);
    }

    const onInput = (e) => { if (e.target.id === 'mmtA' || e.target.id === 'mmtB') { if (timer) stop(); draw(); } };
    const onClick = (e) => {
      if (e.target.closest('#mmtPlay')) play();
      else if (e.target.closest('#mmtMonth')) { stop(); $('mmtB').value = String(list.length - 1); $('mmtA').value = String(Math.max(0, list.length - 31)); draw(); }
      else if (e.target.closest('#mmtAll')) { stop(); $('mmtA').value = '0'; $('mmtB').value = String(list.length - 1); draw(); }
    };
    app.addEventListener('input', onInput);
    app.addEventListener('click', onClick);
    off = () => { app.removeEventListener('input', onInput); app.removeEventListener('click', onClick); };

    const firstKept = kept.length ? kept.map((d) => d.day).sort()[0] : '';
    const status = () => (firstKept ? `Kept day by day since ${fmtDay(firstKept)}; earlier days are rebuilt from when each repeater was first seen.` : 'The analyzer has only just begun keeping days, so earlier days are rebuilt from when each repeater was first seen.');
    $('mmtStatus').textContent = status();
    draw();

    if (!M || typeof M.groundCoverage !== 'function' || !reps.length) { noTerrain = true; draw(); }
    else {
      try {
        const res = await M.groundCoverage(reps, mm.links || [], {}, (d, t) => { if (!destroyed) $('mmtStatus').textContent = `Working out the coverage… ${d} of ${t} repeaters`; });
        if (destroyed) return;
        cov = res.cov;
        $('mmtStatus').textContent = status() + ' Coverage is worked out from where the repeaters stand now.';
        draw();
      } catch (_) {
        noTerrain = true;
        draw();
        $('mmtStatus').textContent = status() + ' Terrain could not be loaded, so the ground reached isn\'t shown.';
      }
    }
  }

  function destroy() {
    destroyed = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (off) off();
    off = null;
    maps.forEach((m) => m && m.remove());
    maps = [];
  }

  root.MediaMeshTimeMachine = { dayOf, dayList, stateOn, diff, chartSvg, init, destroy };
  if (typeof root.registerPage === 'function') root.registerPage('mediamesh-timemachine', { init, destroy });
})(typeof window !== 'undefined' ? window : globalThis);
