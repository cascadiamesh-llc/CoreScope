/* === CoreScope — mediamesh-status.js ===
 * "Is MediaMesh up?" (#/mediamesh-status): a public page for outages. Which
 * MediaMesh repeaters have gone quiet on the main mesh, whether the rest are
 * still linked in one piece, which single repeater would now split them,
 * where photos and voice still get through, and the nearest working
 * repeater for places cut off. Refreshes every minute; the coverage is
 * worked out once and re-counted for whichever repeaters are up.
 *
 * Quiet: not heard on the main mesh for four times its usual gap between
 * packets (from its relays in the last 24 hours), at least 30 minutes and
 * at most 6 hours. A repeater the analyzer has no record of is left out.
 */
'use strict';

(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const key8 = (k) => String(k || '').slice(0, 8).toLowerCase();
  const repName = (r) => (r ? String(r.name || String(r.public_key || '').slice(0, 8)) : '');

  const QUIET_MIN = 30, QUIET_MAX = 360, QUIET_GAPS = 4;

  /** Minutes without a packet after which a repeater counts as quiet, from
   * how many it relayed in the last 24 hours. */
  function quietAfterMin(relays24h) {
    const gap = relays24h > 0 ? 1440 / relays24h : Infinity;
    return Math.max(QUIET_MIN, Math.min(QUIET_MAX, QUIET_GAPS * gap));
  }

  /** { quiet, since (ms), age (min) } for a repeater's /api/nodes record, or
   * null when there is none (unknown, left out). */
  function quietState(node, now) {
    if (!node) return null;
    const t = Date.parse(node.last_heard || node.last_seen || '');
    if (!Number.isFinite(t)) return null;
    const age = (now - t) / 60000;
    return { quiet: age > quietAfterMin(Number(node.relay_count_24h) || 0), since: t, age };
  }

  /** Groups of repeaters (by index) joined by edges among those `up`
   * allows; only groups of repeaters that are linked at all. */
  function pieces(n, edges, up) {
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const linked = new Array(n).fill(false);
    edges.forEach(([a, b]) => {
      if (!up[a] || !up[b]) return;
      parent[find(a)] = find(b);
      linked[a] = linked[b] = true;
    });
    const by = new Map();
    for (let i = 0; i < n; i++) {
      if (!up[i] || !linked[i]) continue;
      const g = find(i);
      if (!by.has(g)) by.set(g, []);
      by.get(g).push(i);
    }
    return [...by.values()].sort((x, y) => y.length - x.length);
  }

  /** Repeaters (by index) whose loss alone would split the ones `up` into
   * more pieces: the articulation points of the graph. */
  function singlePoints(n, edges, up) {
    const adj = Array.from({ length: n }, () => []);
    edges.forEach(([a, b]) => { if (up[a] && up[b] && a !== b) { adj[a].push(b); adj[b].push(a); } });
    const disc = new Array(n).fill(-1), low = new Array(n).fill(0), out = new Set();
    let t = 0;
    const dfs = (u, parent) => {
      disc[u] = low[u] = t++;
      let kids = 0;
      for (const v of adj[u]) {
        if (disc[v] < 0) {
          kids++;
          dfs(v, u);
          low[u] = Math.min(low[u], low[v]);
          if (parent >= 0 && low[v] >= disc[u]) out.add(u);
        } else if (v !== parent) {
          low[u] = Math.min(low[u], disc[v]);
        }
      }
      if (parent < 0 && kids > 1) out.add(u);
    };
    for (let i = 0; i < n; i++) if (up[i] && disc[i] < 0 && adj[i].length) dfs(i, -1);
    return [...out].sort((a, b) => a - b);
  }

  /** The links heard this week between placed repeaters, as index pairs. */
  function heardEdges(placed, backbone, links) {
    const at = new Map();
    placed.forEach((r, i) => { const k = key8(r.public_key); if (k && !at.has(k)) at.set(k, i); });
    const seen = new Set(), out = [];
    const add = (a, b) => {
      const i = at.get(key8(a)), j = at.get(key8(b));
      if (i === undefined || j === undefined || i === j) return;
      const k = Math.min(i, j) + ':' + Math.max(i, j);
      if (seen.has(k)) return;
      seen.add(k);
      out.push([Math.min(i, j), Math.max(i, j)]);
    };
    (backbone || []).forEach((e) => add(e.a, e.b));
    (links || []).forEach((l) => add(l.from, l.observer_id));
    return out;
  }

  /** For each cell, how many repeaters that are up reach it, and the best
   * one (by margin): { count: Uint8Array, best: Int16Array }. */
  function reachCounts(cov, up) {
    const n = cov.width * cov.height, count = new Uint8Array(n), best = new Int16Array(n).fill(-1), top = new Int16Array(n).fill(-32768);
    (cov.rasters || []).forEach((r, ri) => {
      if (!r || !r.data || !up[ri]) return;
      for (let y = 0; y < r.h; y++) {
        let i = (r.row0 + y) * cov.width + r.col0, k = y * r.w;
        for (let x = 0; x < r.w; x++, i++, k++) {
          const m = r.data[k];
          if (!(m >= 0)) continue;
          if (count[i] < 9) count[i]++;
          if (m > top[i]) { top[i] = m; best[i] = ri; }
        }
      }
    });
    return { count, best };
  }

  function cellIndex(cov, lat, lon) {
    const col = Math.floor(((lon - cov.bounds.west) / (cov.bounds.east - cov.bounds.west)) * cov.width);
    const row = Math.floor(((cov.bounds.north - lat) / (cov.bounds.north - cov.bounds.south)) * cov.height);
    if (col < 0 || col >= cov.width || row < 0 || row >= cov.height) return -1;
    return row * cov.width + col;
  }

  /** Each place (the first part of a repeater's Near) at its repeaters'
   * spots: 'up' (two or more repeaters that are up reach it), 'weak' (one),
   * or 'down' (none), with the repeaters it goes through or, cut off, the
   * nearest one that still works. */
  function placeStatus(cov, placed, up, counts) {
    const by = new Map();
    placed.forEach((r, i) => {
      const area = String(r.near || '').split(',')[0].trim();
      if (!area) return;
      if (!by.has(area)) by.set(area, []);
      by.get(area).push(i);
    });
    const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111.2, (a.lon - b.lon) * 111.2 * Math.cos(a.lat * Math.PI / 180));
    const out = [];
    by.forEach((idx, area) => {
      let n = 0, through = new Set(), anyQuiet = false;
      idx.forEach((i) => {
        if (!up[i]) anyQuiet = true;
        const c = cellIndex(cov, placed[i].lat, placed[i].lon);
        if (c < 0) return;
        n = Math.max(n, counts.count[c]);
        // which repeaters that are up reach this spot
        (cov.rasters || []).forEach((r, ri) => {
          if (!r || !r.data || !up[ri]) return;
          const row = Math.floor(c / cov.width) - r.row0, col = (c % cov.width) - r.col0;
          if (row < 0 || col < 0 || row >= r.h || col >= r.w) return;
          if (r.data[row * r.w + col] >= 0) through.add(ri);
        });
      });
      const state = n >= 2 ? 'up' : n === 1 ? 'weak' : 'down';
      let nearest = null;
      if (state === 'down') {
        let bd = Infinity;
        placed.forEach((r, ri) => {
          if (!up[ri]) return;
          const d = Math.min(...idx.map((i) => dist(placed[i], r)));
          if (d < bd) { bd = d; nearest = { index: ri, km: d }; }
        });
      }
      out.push({ area, state, anyQuiet, through: [...through], nearest });
    });
    const rank = { down: 0, weak: 1, up: 2 };
    return out.sort((a, b) => rank[a.state] - rank[b.state] || (b.anyQuiet - a.anyQuiet) || a.area.localeCompare(b.area));
  }

  const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtKm2 = (v) => (v < 100 ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : Math.round(v).toLocaleString());

  function bannerHtml(placed, states, now) {
    const known = states.filter(Boolean);
    const quiet = known.filter((s) => s.quiet);
    if (!known.length) return '<div class="mms-banner mms-banner--unknown" role="status">Waiting for what the analyzer has heard…</div>';
    if (!quiet.length) {
      return `<div class="mms-banner mms-banner--ok" role="status"><strong>All ${known.length} MediaMesh repeaters heard recently.</strong> <span>Updated ${esc(fmtTime(now))}, every minute.</span></div>`;
    }
    const first = Math.min(...quiet.map((s) => s.since));
    return `<div class="mms-banner mms-banner--alert" role="alert"><strong>${quiet.length} of ${known.length} MediaMesh repeaters ${quiet.length === 1 ? 'has' : 'have'} gone quiet</strong> <span>the first last heard at ${esc(fmtTime(first))}. Updated ${esc(fmtTime(now))}, every minute.</span></div>`;
  }

  function tilesHtml(o) {
    const t = (big, label, cls) => `<div class="mms-tile"><div class="mms-big${cls ? ' ' + cls : ''}">${big}</div><div class="mms-label">${label}</div></div>`;
    const one = o.pieces.length <= 1;
    return t(`${o.upCount} of ${o.known}`, 'repeaters heard recently', o.upCount === o.known ? 'mms-good' : 'mms-warn')
      + t(one ? 'One piece' : `${o.pieces.length} pieces`, one ? 'every linked repeater that is up still reaches the rest' : 'the mesh is split: media can\'t cross between the pieces', one ? 'mms-good' : 'mms-bad')
      + (o.km2Now == null ? t('…', 'working out what is still reached') : t(`${fmtKm2(o.km2Now)} km²`, `still reached, of ${fmtKm2(o.km2All)} with every repeater up`, o.km2Now >= o.km2All - 0.05 ? 'mms-good' : 'mms-warn'))
      + t(String(o.spof.length), o.spof.length ? `whose loss alone would now split the mesh: ${o.spof.map((i) => esc(repName(o.placed[i]))).join(', ')}` : 'single repeaters whose loss would split the mesh', o.spof.length ? 'mms-bad' : 'mms-good');
  }

  function placesHtml(list, placed) {
    if (!list || !list.length) return '<p class="text-muted">Working out where media still gets through…</p>';
    const word = { up: 'Two or more', weak: 'One repeater', down: 'Cut off' };
    return `<ul class="mms-places">${list.map((p) => {
      const via = p.state === 'down'
        ? (p.nearest ? `Nearest that still works: ${esc(repName(placed[p.nearest.index]))}, ${p.nearest.km < 10 ? p.nearest.km.toFixed(1) : Math.round(p.nearest.km)} km away` : 'No repeater is up')
        : `Through ${p.through.slice(0, 3).map((i) => esc(repName(placed[i]))).join(', ')}${p.through.length > 3 ? ` and ${p.through.length - 3} more` : ''}`;
      const state = p.state === 'weak' && p.anyQuiet ? 'One repeater left' : word[p.state];
      return `<li class="mms-place mms-place--${p.state}"><span class="mms-dot" aria-hidden="true"></span><span class="mms-place-text"><strong>${esc(p.area)}</strong><br><span class="text-muted">${via}</span></span><span class="mms-state">${state}</span></li>`;
    }).join('')}</ul>`;
  }

  // ---- The page --------------------------------------------------------------

  let timer = null, map = null, overlay = null, layer = null, destroyed = false;

  function pageHtml() {
    return `<div class="mms-page">
      <div id="mmsBanner"></div>
      <div class="mms-body">
        <div class="mms-head">
          <h1>Is MediaMesh up?</h1>
          <p class="text-muted">Where photos, video and voice on MediaMesh can still get through right now: for ARES, CERT, neighbours, anyone. <a href="#/analytics?tab=mediamesh">More about MediaMesh</a></p>
        </div>
        <div class="mms-tiles" id="mmsTiles"></div>
        <div class="mms-split">
          <div class="mms-mapwrap">
            <div id="mmsMap" class="mms-map" role="img" aria-label="Map: where repeaters that are up still reach, and the repeaters that went quiet"></div>
            <div class="mms-key">
              <span><span class="mm-cov-sw mm-mesh-sw mm-mesh-sw--two"></span>2+ repeaters up reach it</span>
              <span><span class="mm-cov-sw mm-mesh-sw mm-mesh-sw--one"></span>1 repeater</span>
              <span><span class="mms-ring" aria-hidden="true"></span>Gone quiet</span>
            </div>
            <p class="text-muted mms-note" id="mmsStatus"></p>
          </div>
          <div class="mms-side">
            <h2>Places</h2>
            <div id="mmsPlaces"></div>
            <h2>Gone quiet</h2>
            <div id="mmsQuiet"></div>
          </div>
        </div>
        <p class="text-muted mms-note">A repeater counts as quiet when the analyzer hasn't heard it on the main mesh for four times its usual gap between packets (at least 30 minutes). Where media gets through comes from the coverage estimate for people on the ground; links are the ones heard this week.</p>
      </div>
    </div>`;
  }

  async function init(app) {
    destroyed = false;
    app.innerHTML = pageHtml();
    const L = root.L, M = root.MediaMeshCoverage;
    const mapEl = app.querySelector('#mmsMap');
    if (L && mapEl) {
      map = L.map(mapEl, { zoomControl: true });
      const tileUrl = typeof root.getTileUrl === 'function' ? root.getTileUrl() : null;
      if (tileUrl) L.tileLayer(tileUrl, { maxZoom: 18 }).addTo(map);
      map.setView([47.6, -122.33], 11);
      map.createPane('mmsCov').style.zIndex = 450;
      layer = L.layerGroup().addTo(map);
    }
    let cov = null, placed = [], edges = [], working = false;
    async function refresh() {
      if (destroyed) return;
      let mm, nodes;
      try {
        [mm, nodes] = await Promise.all([
          fetch('/api/analytics/mediamesh').then((r) => r.json()),
          fetch('/api/nodes?role=repeater&limit=5000').then((r) => r.json()),
        ]);
      } catch (_) {
        const s = app.querySelector('#mmsStatus');
        if (s) s.textContent = 'The analyzer could not be reached. Trying again in a minute.';
        return;
      }
      if (destroyed) return;
      const byKey = new Map(((nodes && (nodes.nodes || nodes)) || []).map((n) => [String(n.public_key || '').toLowerCase(), n]));
      const reps = (mm && mm.repeaters) || [];
      const nextPlaced = reps.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
      const now = Date.now();
      const states = nextPlaced.map((r) => quietState(byKey.get(String(r.public_key).toLowerCase()), now));
      const up = states.map((s) => !!s && !s.quiet);
      const known = states.filter(Boolean).length;
      edges = heardEdges(nextPlaced, mm.backbone, mm.links);
      const ps = pieces(nextPlaced.length, edges, up);
      const spof = singlePoints(nextPlaced.length, edges, up);
      const samePlaced = JSON.stringify(placed.map((r) => r.public_key)) === JSON.stringify(nextPlaced.map((r) => r.public_key));
      placed = nextPlaced;
      app.querySelector('#mmsBanner').innerHTML = bannerHtml(placed, states, now);
      const draw = () => {
        let km2Now = null, km2All = null, list = null;
        if (cov && M) {
          const all = placed.map(() => true);
          const mcAll = M.meshCells(cov, placed.map(() => 'often'), all);
          const mcNow = M.meshCells(cov, placed.map((_, i) => (up[i] ? 'often' : 'none')), up);
          km2All = mcAll.km2[3] + mcAll.km2[4];
          km2Now = mcNow.km2[3] + mcNow.km2[4];
          const counts = reachCounts(cov, up);
          list = placeStatus(cov, placed, up, counts);
          if (map) {
            if (overlay) map.removeLayer(overlay);
            const b = cov.bounds;
            overlay = M.canvasOverlay(L, M.meshCanvas(cov, mcNow), [[b.south, b.west], [b.north, b.east]], { pane: 'mmsCov', opacity: 1 }).addTo(map);
          }
        }
        app.querySelector('#mmsTiles').innerHTML = tilesHtml({ upCount: up.filter(Boolean).length, known, pieces: ps, spof, placed, km2Now, km2All });
        app.querySelector('#mmsPlaces').innerHTML = placesHtml(list, placed);
        const quiet = placed.map((r, i) => ({ r, s: states[i] })).filter((x) => x.s && x.s.quiet).sort((a, b) => b.s.since - a.s.since);
        app.querySelector('#mmsQuiet').innerHTML = quiet.length
          ? `<ul class="mms-quiet">${quiet.map((x) => `<li><a href="#/nodes/${encodeURIComponent(x.r.public_key)}">${esc(repName(x.r))}</a> <span class="text-muted">last heard ${esc(fmtTime(x.s.since))}${x.r.near ? ' · ' + esc(x.r.near) : ''}</span></li>`).join('')}</ul>`
          : '<p class="text-muted">None.</p>';
        if (map && layer) {
          layer.clearLayers();
          const ink = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e8ecf5';
          edges.forEach(([a, b]) => {
            if (!up[a] || !up[b]) return;
            L.polyline([[placed[a].lat, placed[a].lon], [placed[b].lat, placed[b].lon]], { color: ink, weight: 1.5, opacity: 0.5, interactive: false }).addTo(layer);
          });
          placed.forEach((r, i) => {
            const q = states[i] && states[i].quiet;
            L.circleMarker([r.lat, r.lon], q
              ? { radius: 8, weight: 3, color: '#ef4444', fillColor: '#ffffff', fillOpacity: 1 }
              : { radius: 5, weight: 2, color: '#ffffff', fillColor: '#d946ef', fillOpacity: 1 })
              .bindTooltip(repName(r) + (q ? ` · quiet since ${fmtTime(states[i].since)}` : '')).addTo(layer);
          });
        }
      };
      draw();
      if ((!cov || !samePlaced) && !working && M && typeof M.groundCoverage === 'function' && placed.length) {
        working = true;
        const s = app.querySelector('#mmsStatus');
        try {
          const res = await M.groundCoverage(placed, mm.links || [], {}, (done, total) => { if (s && !destroyed) s.textContent = `Working out the coverage… ${done} of ${total} repeaters`; });
          if (destroyed) return;
          cov = res.cov;
          if (s) s.textContent = '';
          if (map) { const b = L.latLngBounds(placed.map((r) => [r.lat, r.lon])); map.fitBounds(b.pad(0.2)); }
          draw();
        } catch (_) {
          if (s) s.textContent = 'Terrain could not be loaded, so where media gets through isn\'t shown.';
        } finally {
          working = false;
        }
      }
    }
    await refresh();
    timer = setInterval(refresh, 60000);
  }

  function destroy() {
    destroyed = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (map) map.remove();
    map = overlay = layer = null;
  }

  root.MediaMeshStatus = { quietAfterMin, quietState, pieces, singlePoints, heardEdges, reachCounts, placeStatus, bannerHtml, tilesHtml, placesHtml, init, destroy };
  if (typeof root.registerPage === 'function') root.registerPage('mediamesh-status', { init, destroy });
})(typeof window !== 'undefined' ? window : globalThis);
