/* === CoreScope — mediamesh-cascadia.js ===
 * Cascadia-wide view (#/mediamesh-cascadia): this analyzer's MediaMesh and
 * that of the analyzers it is told about (config.json mediameshCoverage.
 * peers), on one map, with the gaps between them: for each pair of regions
 * the two closest repeaters, how far apart, and roughly how many sites in
 * between would join them at this mesh's usual link length. A straight-line
 * guess that ignores the terrain: MediaMeshLab and Grow the mesh are where
 * to work out where.
 */
'use strict';

(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const distKm = (a, b, c, d) => {
    const R = 6371, p = Math.PI / 180;
    const x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  /** The usual link length to plan hops with: this mesh's median link
   * heard, held between 5 and 25 km; 10 when none. */
  function hopKm(regions) {
    const self = (regions || []).find((r) => r.self);
    const v = self && self.link_km > 0 ? self.link_km : 10;
    return Math.max(5, Math.min(25, v));
  }

  /** For each pair of regions with repeaters, the closest pair of their
   * repeaters: [{ a, b (region indices), from, to (repeaters), km, sites }],
   * nearest first. */
  function gaps(regions, hop) {
    const out = [];
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const A = regions[i].repeaters || [], B = regions[j].repeaters || [];
        let best = null;
        A.forEach((x) => B.forEach((y) => {
          const km = distKm(x.lat, x.lon, y.lat, y.lon);
          if (!best || km < best.km) best = { from: x, to: y, km };
        }));
        if (best) out.push(Object.assign(best, { a: i, b: j, sites: Math.max(0, Math.ceil(best.km / hop) - 1) }));
      }
    }
    return out.sort((x, y) => x.km - y.km);
  }

  function regionsTableHtml(regions) {
    return `<div class="mm-ins-scroll"><table class="analytics-table mmc-table"><thead><tr><th scope="col">Region</th><th scope="col" class="mm-ins-num">Repeaters</th><th scope="col" class="mm-ins-num">Links heard</th><th scope="col" class="mm-ins-num">Clips this week</th><th scope="col">Analyzer</th></tr></thead><tbody>${regions.map((r) => `<tr>
      <td><strong>${esc(r.name)}</strong></td><td class="mm-ins-num">${r.ok ? r.repeaters.length : '—'}</td><td class="mm-ins-num">${r.ok ? r.links : '—'}</td><td class="mm-ins-num">${r.ok ? r.media_clips_7d : '—'}</td>
      <td>${r.self ? 'This one' : r.ok ? `<a href="${esc(r.url)}" rel="noopener" target="_blank">${esc(String(r.url).replace(/^https?:\/\//, ''))}</a>` : `<span class="text-muted">couldn't be reached</span>`}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function gapsHtml(list, regions, hop) {
    if (!list.length) return '<p class="text-muted">Once another analyzer is connected, the gaps between the meshes show here.</p>';
    return `<ul class="mmc-gaps">${list.map((g) => `<li><span class="mmc-sites">${g.sites ? `about ${g.sites} site${g.sites === 1 ? '' : 's'}` : 'next to each other'}</span>
      <span><strong>${esc(regions[g.a].name)} ↔ ${esc(regions[g.b].name)}</strong>: ${g.km.toFixed(g.km < 10 ? 1 : 0)} km from ${esc(g.from.name)} to ${esc(g.to.name)}</span></li>`).join('')}</ul>
      <p class="text-muted mmc-note">Sites: in a straight line, at this mesh's usual link of ${hop} km, ignoring the terrain. Try real spots in <a href="#/mediamesh-lab">MediaMeshLab</a>.</p>`;
  }

  // ---- The page --------------------------------------------------------------

  let map = null, destroyed = false;
  const PEER_COLOURS = ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa'];

  async function init(app) {
    destroyed = false;
    app.innerHTML = `<div class="mmc-page">
      ${root.MediaMeshNav ? root.MediaMeshNav.html('cascadia') : ''}
      <div class="mmc-head"><h1>MediaMesh across Cascadia</h1>
        <p class="text-muted">This analyzer's MediaMesh and the other analyzers it knows, on one map, with the gaps between them.</p></div>
      <div class="mmc-split">
        <div id="mmcMap" class="mmc-map" role="img" aria-label="Map of the MediaMesh regions and the gaps between them"></div>
        <div class="mmc-side">
          <div class="mmc-card"><h2>Each region</h2><div id="mmcRegions"><p class="text-muted">Loading…</p></div></div>
          <div class="mmc-card"><h2>Closing the gaps</h2><div id="mmcGaps"></div></div>
          <div class="mmc-card" id="mmcConnect" hidden><h2>Connect your analyzer</h2><p>Any CoreScope analyzer running the CascadiaMesh fork can join: each lists the others in <code>config.json</code> under <code>mediameshCoverage.peers</code> as <code>{"name": "Portland", "url": "https://analyzer.example.org"}</code>. Only what its MediaMesh tab already shows publicly is shared: repeaters with positions, how many links were heard, and the week's clips.</p></div>
        </div>
      </div>
    </div>`;
    const L = root.L;
    let data;
    try { data = await fetch('/api/mediamesh/peers').then((r) => r.json()); } catch (_) { data = null; }
    if (destroyed) return;
    const regions = (data && data.regions) || [];
    const hop = hopKm(regions);
    const list = gaps(regions.filter((r) => r.ok), hop);
    const okRegions = regions.filter((r) => r.ok);
    app.querySelector('#mmcRegions').innerHTML = regions.length ? regionsTableHtml(regions) : '<p class="text-muted">Nothing to show yet.</p>';
    app.querySelector('#mmcGaps').innerHTML = gapsHtml(list, okRegions, hop);
    app.querySelector('#mmcConnect').hidden = regions.length > 1;
    if (!L) return;
    map = L.map(app.querySelector('#mmcMap'), { zoomControl: true });
    const tileUrl = typeof root.getTileUrl === 'function' ? root.getTileUrl() : null;
    if (tileUrl) L.tileLayer(tileUrl, { maxZoom: 18 }).addTo(map);
    const pts = [];
    const fuchsia = getComputedStyle(document.documentElement).getPropertyValue('--mediamesh-node-color').trim() || '#d946ef';
    okRegions.forEach((r, i) => {
      const col = r.self ? fuchsia : PEER_COLOURS[(i - 1 + PEER_COLOURS.length) % PEER_COLOURS.length];
      r.repeaters.forEach((p) => {
        pts.push([p.lat, p.lon]);
        L.circleMarker([p.lat, p.lon], { radius: 5, weight: 2, color: '#ffffff', fillColor: col, fillOpacity: 1 }).bindTooltip(`${p.name} · ${r.name}`).addTo(map);
      });
      if (r.repeaters.length) {
        const c = r.repeaters.reduce((a, p) => [a[0] + p.lat / r.repeaters.length, a[1] + p.lon / r.repeaters.length], [0, 0]);
        L.marker(c, { icon: L.divIcon({ className: 'mmc-label', html: `<span>${esc(r.name)}</span>`, iconSize: null }), interactive: false }).addTo(map);
      }
    });
    list.forEach((g) => {
      L.polyline([[g.from.lat, g.from.lon], [g.to.lat, g.to.lon]], { color: '#ef4444', weight: 3, dashArray: '6 8', opacity: 0.9 })
        .bindTooltip(`${okRegions[g.a].name} ↔ ${okRegions[g.b].name}: ${g.km.toFixed(0)} km, about ${g.sites} site${g.sites === 1 ? '' : 's'}`, { sticky: true }).addTo(map);
    });
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2)); else map.setView([47.6, -122.33], 7);
  }

  function destroy() {
    destroyed = true;
    if (map) map.remove();
    map = null;
  }

  root.MediaMeshCascadia = { hopKm, gaps, regionsTableHtml, gapsHtml, init, destroy };
  if (typeof root.registerPage === 'function') root.registerPage('mediamesh-cascadia', { init, destroy });
})(typeof window !== 'undefined' ? window : globalThis);
