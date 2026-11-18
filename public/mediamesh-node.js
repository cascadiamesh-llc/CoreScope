/* MediaMesh on a node's page: when it joined, what it relayed, where its
 * signal reaches and the hops photos, video and voice took through it.
 * Fills a hidden card (nodes.js) from /api/nodes/{pubkey}/mediamesh, and
 * stays hidden for a node that isn't a MediaMesh repeater. */
'use strict';

(function (root) {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const ICON = (id) => `<svg class="ph-icon" aria-hidden="true"><use href="/icons/phosphor-sprite.svg#${id}"/></svg>`;

  function km(v) { return v < 100 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v).toLocaleString(); }

  /** The 14-day bar chart of packets relayed, as SVG. */
  function dailySvg(days, opts) {
    const W = (opts && opts.width) || 280, H = (opts && opts.height) || 56;
    const list = Array.isArray(days) ? days : [];
    if (!list.length) return '';
    const max = Math.max(1, ...list.map((d) => d.packets || 0));
    const gap = 3, bw = (W - gap * (list.length - 1)) / list.length;
    const bars = list.map((d, i) => {
      const h = d.packets ? Math.max(2, Math.round((d.packets / max) * (H - 14))) : 1;
      const x = (i * (bw + gap)).toFixed(1), y = H - 12 - h;
      return `<rect x="${x}" y="${y}" width="${bw.toFixed(1)}" height="${h}" rx="1.5" class="${d.packets ? 'mm-node-bar' : 'mm-node-bar mm-node-bar--zero'}">`
        + `<title>${esc(d.day)}: ${Number(d.packets || 0).toLocaleString()}</title></rect>`;
    }).join('');
    const label = (d) => new Date(d.day + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<svg class="mm-node-daily" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Photos, video and voice relayed per day, last 14 days">`
      + bars
      + `<text x="0" y="${H - 1}" class="mm-node-axis">${esc(label(list[0]))}</text>`
      + `<text x="${W}" y="${H - 1}" text-anchor="end" class="mm-node-axis">today</text></svg>`;
  }

  /** The card's HTML (the footprint map fills #mmNodeMap afterwards). */
  function cardHtml(rep, report, now) {
    const r = report.repeater || {};
    const name = r.name || String(report.public_key || '').slice(0, 8);
    const first = Date.parse(r.first_seen);
    const joined = Number.isFinite(first)
      ? `${new Date(first).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
      + ` <span class="text-muted">(${Math.max(0, Math.floor((now - first) / 86400000))} days ago)</span>`
      : '<span class="text-muted">not yet known</span>';
    const week = Number(r.media_relayed_7d || 0);
    // whole clips among them; "about" when some were estimated from bursts
    const nClips = Number(r.media_clips_7d || 0);
    const clips = nClips ? `${Number(r.media_clips_estimated_7d || 0) > 0 ? 'about ' : ''}${nClips.toLocaleString()} whole clip${nClips === 1 ? '' : 's'} (photos, video, voice)` : '';
    const rank = report.rank > 0 ? `#${report.rank} of ${report.rank_of} repeaters` : 'none this week';
    const hops = (Array.isArray(report.backbone) ? report.backbone : []).slice().sort((x, y) => (y.packets || 0) - (x.packets || 0));
    const partner = (e) => (e.a === report.public_key ? { pk: e.b, name: e.b_name } : { pk: e.a, name: e.a_name });
    const hopList = hops.slice(0, 8).map((e) => {
      const p = partner(e);
      return `<li><a href="#/nodes/${encodeURIComponent(p.pk)}">${esc(p.name || p.pk.slice(0, 8))}</a> <span class="text-muted">${Number(e.packets).toLocaleString()}</span></li>`;
    }).join('');
    const placed = Number.isFinite(rep && rep.lat) && Number.isFinite(rep && rep.lon) && !(rep.lat === 0 && rep.lon === 0);
    return `<h4>${ICON('ph-share-network')} MediaMesh</h4>
      <div class="mm-node-tiles">
        <div class="mm-node-tile"><div class="mm-node-label">On MediaMesh since</div><div class="mm-node-value">${joined}</div></div>
        <div class="mm-node-tile"><div class="mm-node-label">Media packets relayed this week</div><div class="mm-node-value">${week.toLocaleString()} <span class="text-muted">${esc(rank)}</span></div>${clips ? `<div class="text-muted mm-node-sub">${clips}</div>` : ''}</div>
        <div class="mm-node-tile"><div class="mm-node-label">Covers on its own</div><div class="mm-node-value" id="mmNodeArea">${placed ? '…' : '<span class="text-muted">no saved position</span>'}</div></div>
      </div>
      <div class="mm-node-cols">
        <div class="mm-node-col">
          <div class="mm-node-label">Relayed per day, last 14 days</div>
          ${dailySvg(report.daily)}
          <div class="mm-node-label" style="margin-top:10px">Its hops this week <span class="text-muted">(packets)</span></div>
          ${hopList ? `<ol class="mm-lb-list">${hopList}</ol>` : '<p class="text-muted" style="margin:4px 0 0">None with a placed neighbour yet.</p>'}
        </div>
        ${placed ? `<div class="mm-node-col mm-node-col--map"><div id="mmNodeMap" class="mm-node-map" aria-label="Where ${esc(name)}'s MediaMesh signal should reach people on the ground"></div>
          <div class="text-muted mm-node-note">Estimated coverage for people on the ground from ${esc(name)} alone, and its hops this week. <a href="#/analytics?tab=mediamesh">The whole network →</a></div>
          ${whatIfHtml(rep)}</div>` : ''}
      </div>`;
  }

  // ---- What if: another height, power or antenna ------------------------------

  const WI = [
    { key: 'heightM', label: 'Antenna height', min: 2, max: 60, step: 1, unit: 'm' },
    { key: 'txDbm', label: 'Transmit power', min: 10, max: 30, step: 1, unit: 'dBm' },
    { key: 'gainDbi', label: 'Antenna gain', min: 0, max: 9, step: 0.5, unit: 'dBi' },
  ];
  const EIRP_LIMIT_DBM = 36; // FCC 15.247: 30 dBm into up to 6 dBi
  const fmtNum = (v) => String(Math.round(v * 10) / 10);

  function defaultsOf(rep) {
    const M = root.MediaMeshCoverage;
    return M && M.whatIfDefaults ? M.whatIfDefaults(rep) : { heightM: 10, txDbm: 22, gainDbi: 2 };
  }

  /** The what-if panel (closed until asked for; the terrain is read then). */
  function whatIfHtml(rep) {
    const d = defaultsOf(rep);
    const rows = WI.map((w) => `<label class="mm-wi-row"><span class="mm-wi-name">${w.label}</span>
        <input type="range" min="${w.min}" max="${w.max}" step="${w.step}" value="${d[w.key]}" data-wi="${w.key}" aria-label="${w.label} in ${w.unit}">
        <output class="mm-wi-val" data-wi-out="${w.key}">${fmtNum(d[w.key])} ${w.unit}</output></label>`).join('');
    return `<details class="mm-wi" id="mmNodeWhatIf"><summary>What if it had a taller mast, more power or a better antenna?</summary>
      <div class="mm-wi-body">${rows}
        <p class="mm-wi-eirp text-muted" data-wi-eirp></p>
        <div class="mm-wi-result" data-wi-result aria-live="polite"></div>
        <p class="mm-wi-key text-muted"><span class="mm-wi-sw mm-wi-sw--gain"></span> reached only with the change · <span class="mm-wi-sw mm-wi-sw--lost"></span> lost with it · <span class="mm-wi-sw mm-wi-sw--both"></span> reached either way</p>
        <button type="button" class="btn-secondary mm-wi-reset" data-wi-reset>Back to today's settings</button>
        <p class="text-muted mm-wi-note">Today's estimate gives every repeater ${fmtNum(d.heightM)} m, ${fmtNum(d.txDbm)} dBm and a ${fmtNum(d.gainDbi)} dBi antenna. Same terrain and the same conservative model, out to ${(root.MediaMeshCoverage && root.MediaMeshCoverage.CONFIG.modes.ground.radiusKm) || 30} km. People: 2020 census.</p>
      </div></details>`;
  }

  /** "312 km² (+41 km²)": an amount, and its change when there is one. */
  function withChange(v, before, unit, round) {
    const r = round || ((x) => x);
    const d = r(v) - r(before);
    const sign = d > 0 ? '+' : '−';
    return `<strong>${r(v).toLocaleString()}${unit}</strong>${d ? ` <span class="${d > 0 ? 'mm-wi-up' : 'mm-wi-down'}">(${sign}${Math.abs(d).toLocaleString()}${unit})</span>` : ''}`;
  }

  /** The result line: area and people, and how they change. */
  function whatIfResultHtml(now, before) {
    const km = (x) => (x < 100 ? Math.round(x * 10) / 10 : Math.round(x));
    const ppl = (x) => (x < 1000 ? Math.round(x) : Math.round(x / 100) * 100);
    return `Covers ${withChange(now.km2, before.km2, ' km²', km)}`
      + (now.people != null && before.people != null ? ` · reaches about ${withChange(now.people, before.people, ' people', ppl)}` : '');
  }

  /** "EIRP 23 dBm", and a note above the legal limit. */
  function eirpText(s) {
    const M = root.MediaMeshCoverage;
    const cable = (M && M.CONFIG && M.CONFIG.cableDb) || 1;
    const e = Number(s.txDbm) + Number(s.gainDbi) - cable;
    return `Radiated: ${fmtNum(e)} dBm EIRP` + (e > EIRP_LIMIT_DBM ? ` · above the ${EIRP_LIMIT_DBM} dBm the FCC allows on 915 MHz` : '');
  }

  /**
   * Wires the what-if panel: on opening, reads the terrain under the
   * repeater's rays once; each change then works the coverage out again
   * in a worker (the newest settings win) and redraws the map.
   */
  function attachWhatIf(token, panel, rep, onCov) {
    const M = root.MediaMeshCoverage;
    if (!panel || !M || !M.whatIfBase) return;
    const result = panel.querySelector('[data-wi-result]'), eirp = panel.querySelector('[data-wi-eirp]');
    const inputs = [...panel.querySelectorAll('[data-wi]')];
    const d = defaultsOf(rep);
    const settings = () => Object.fromEntries(inputs.map((i) => [i.dataset.wi, Number(i.value)]));
    const isToday = (s) => WI.every((w) => s[w.key] === d[w.key]);
    let base = null, pool = null, running = false, pending = false, before = null, points = null;
    const people = (cov) => (points && root.MediaMeshReach && root.MediaMeshReach.peopleIn ? root.MediaMeshReach.peopleIn(cov, points).reached : null);
    async function run() {
      if (running) { pending = true; return; }
      running = true;
      try {
        do {
          pending = false;
          const s = settings();
          if (result) result.innerHTML = '<span class="text-muted">Working it out…</span>';
          const cov = await M.whatIfCoverage(base, s, pool ? pool.run : null);
          if (token.gone) return;
          const now = { km2: M.unionKm2(cov), people: people(cov) };
          if (!pending) {
            if (result) result.innerHTML = whatIfResultHtml(now, before);
            onCov(isToday(s) ? null : cov, before.cov);
          }
        } while (pending && !token.gone);
      } catch (_) {
        if (result) result.innerHTML = '<span class="text-muted">Couldn\'t be worked out.</span>';
      } finally { running = false; }
    }
    let timer = null;
    const changed = () => {
      const s = settings();
      inputs.forEach((i) => {
        const w = WI.find((x) => x.key === i.dataset.wi), out = panel.querySelector(`[data-wi-out="${w.key}"]`);
        if (out) out.textContent = `${fmtNum(s[w.key])} ${w.unit}`;
      });
      if (eirp) eirp.textContent = eirpText(s);
      if (!base) return;
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    };
    inputs.forEach((i) => i.addEventListener('input', changed));
    const reset = panel.querySelector('[data-wi-reset]');
    if (reset) reset.addEventListener('click', () => { inputs.forEach((i) => { i.value = String(d[i.dataset.wi]); }); changed(); });
    if (eirp) eirp.textContent = eirpText(settings());
    panel.addEventListener('toggle', async () => {
      if (!panel.open || base || token.loadingBase) return;
      token.loadingBase = true;
      if (result) result.innerHTML = '<span class="text-muted">Reading the terrain around it…</span>';
      try {
        const api = root.api;
        const [b, pts] = await Promise.all([M.whatIfBase(rep, 'ground'),
          typeof api === 'function' ? Promise.resolve(api('/places/population', { ttl: 3600000 })).then((x) => (x && x.points) || null).catch(() => null) : null]);
        if (token.gone) return;
        if (!b) { if (result) result.innerHTML = '<span class="text-muted">No terrain data here.</span>'; return; }
        base = b; points = pts;
        pool = M.workerPool ? M.workerPool(1) : null;
        token.cleanup.push(() => { if (pool) pool.close(); });
        const cov = await M.whatIfCoverage(base, d, pool ? pool.run : null);
        if (token.gone) return;
        before = { cov, km2: M.unionKm2(cov), people: people(cov) };
        if (isToday(settings())) { if (result) result.innerHTML = whatIfResultHtml(before, before); } else run();
      } catch (_) {
        if (result) result.innerHTML = '<span class="text-muted">Couldn\'t be worked out.</span>';
      }
    });
  }

  /** Draws the footprint map: this repeater's coverage and its hops. */
  async function drawMap(mapEl, rep, report, areaEl) {
    const L = root.L, M = root.MediaMeshCoverage;
    if (!L || !M || !mapEl) return null;
    const map = L.map(mapEl, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
    const tileUrl = typeof root.getTileUrl === 'function' ? root.getTileUrl() : null;
    if (tileUrl) L.tileLayer(tileUrl, { maxZoom: 18 }).addTo(map);
    map.attributionControl.addAttribution(M.CONFIG.terrainAttribution);
    map.createPane('mmCoverage').style.zIndex = 450;
    map.setView([rep.lat, rep.lon], 11);
    const css = getComputedStyle(document.documentElement);
    const col = css.getPropertyValue('--mediamesh-node-color').trim() || '#d946ef';
    const casing = css.getPropertyValue('--card-bg').trim() || '#ffffff';
    const hops = (report.backbone || []).filter((e) => [e.a_lat, e.a_lon, e.b_lat, e.b_lon].every(Number.isFinite));
    const maxP = Math.max(1, ...hops.map((e) => e.packets || 0));
    const bounds = L.latLngBounds([[rep.lat, rep.lon]]);
    hops.forEach((e) => {
      const w = M.backboneWeight(e.packets, maxP), ll = [[e.a_lat, e.a_lon], [e.b_lat, e.b_lon]];
      L.polyline(ll, { color: casing, weight: w + 3, opacity: 0.9, interactive: false }).addTo(map);
      L.polyline(ll, { color: col, weight: w, opacity: 0.95 }).bindTooltip(M.backboneTip(e), { sticky: true }).addTo(map);
      const other = e.a === report.public_key ? [e.b_lat, e.b_lon] : [e.a_lat, e.a_lon];
      L.circleMarker(other, { radius: 4, weight: 2, color: '#fff', fillColor: col, fillOpacity: 1 }).addTo(map);
      bounds.extend(other);
    });
    L.circleMarker([rep.lat, rep.lon], { radius: 6, weight: 2, color: '#fff', fillColor: col, fillOpacity: 1 }).addTo(map);
    try {
      const fp = await M.footprint(rep, 'ground');
      if (!fp) { if (areaEl) areaEl.innerHTML = '<span class="text-muted">no terrain data</span>'; return map; }
      const b = fp.cov.bounds;
      M.merge(fp.cov);
      let overlay = (M.canvasOverlay ? M.canvasOverlay(L, M.coverageCanvas(fp.cov), [[b.south, b.west], [b.north, b.east]], { pane: 'mmCoverage', className: 'mm-cov-overlay' }) : L.imageOverlay(M.coverageImage(fp.cov), [[b.south, b.west], [b.north, b.east]], { pane: 'mmCoverage', className: 'mm-cov-overlay' })).addTo(map);
      // what if: the change drawn in place of today's coverage
      map.mmShow = (after, before) => {
        if (!M.whatIfCanvas || !M.canvasOverlay) return;
        const src = after || before, bb = src.bounds;
        map.removeLayer(overlay);
        overlay = M.canvasOverlay(L, after ? M.whatIfCanvas(before, after) : M.coverageCanvas(before), [[bb.south, bb.west], [bb.north, bb.east]], { pane: 'mmCoverage', className: 'mm-cov-overlay' }).addTo(map);
      };
      if (areaEl) areaEl.innerHTML = `${km(fp.km2)} km² <span class="text-muted">for people on the ground</span>`;
    } catch (_) {
      if (areaEl) areaEl.innerHTML = '<span class="text-muted">couldn\'t be worked out</span>';
    }
    // frame the repeater and the hops it took part in; the coverage spreads round them
    if (hops.length) map.fitBounds(bounds.pad(0.35), { maxZoom: 14 });
    else map.setView([rep.lat, rep.lon], 12);
    return map;
  }

  let current = null;

  /** Fills el (hidden until there's something to show) for node n. */
  async function load(el, pubkey, n) {
    if (!el || !pubkey) return;
    if (current) {
      current.gone = true;
      current.cleanup.forEach((f) => { try { f(); } catch (_) { /* gone */ } });
      if (current.map) { try { current.map.remove(); } catch (_) { /* gone */ } }
    }
    const token = current = { pubkey, map: null, cleanup: [] };
    let report;
    try {
      report = typeof root.api === 'function'
        ? await root.api('/nodes/' + encodeURIComponent(pubkey) + '/mediamesh', { ttl: 60000 })
        : await (await fetch('/api/nodes/' + encodeURIComponent(pubkey) + '/mediamesh')).json();
    } catch (_) { return; }
    if (current !== token || !report || !report.repeater || !el.isConnected) return;
    const rep = { name: report.repeater.name || (n && n.name), lat: Number(n && n.lat), lon: Number(n && n.lon), radio: report.repeater.radio };
    el.innerHTML = cardHtml(rep, report, Date.now());
    el.hidden = false;
    if (el.querySelector('#mmNodeMap')) {
      token.map = await drawMap(el.querySelector('#mmNodeMap'), rep, report, el.querySelector('#mmNodeArea'));
      if (current !== token) return;
      attachWhatIf(token, el.querySelector('#mmNodeWhatIf'), rep, (after, before) => { if (token.map && token.map.mmShow) token.map.mmShow(after, before); });
    }
  }

  root.MediaMeshNode = { load, cardHtml, dailySvg, whatIfHtml, whatIfResultHtml, eirpText };
})(typeof window !== 'undefined' ? window : globalThis);
