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
        <div class="mm-node-tile"><div class="mm-node-label">Photos, video &amp; voice relayed this week</div><div class="mm-node-value">${week.toLocaleString()} <span class="text-muted">${esc(rank)}</span></div></div>
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
          <div class="text-muted mm-node-note">Estimated coverage for people on the ground from ${esc(name)} alone, and its hops this week. <a href="#/analytics?tab=mediamesh">The whole network →</a></div></div>` : ''}
      </div>`;
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
      L.imageOverlay(M.coverageImage(fp.cov), [[b.south, b.west], [b.north, b.east]], { pane: 'mmCoverage', className: 'mm-cov-overlay' }).addTo(map);
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
    if (current && current.map) { try { current.map.remove(); } catch (_) { /* gone */ } }
    const token = current = { pubkey, map: null };
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
    if (el.querySelector('#mmNodeMap')) token.map = await drawMap(el.querySelector('#mmNodeMap'), rep, report, el.querySelector('#mmNodeArea'));
  }

  root.MediaMeshNode = { load, cardHtml, dailySvg };
})(typeof window !== 'undefined' ? window : globalThis);
