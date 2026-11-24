/* === CoreScope — mediamesh-lab.js ===
 * MediaMeshLab (#/mediamesh-lab): change the mesh and see what happens.
 * Take repeaters down, add planned ones (anywhere on the map, or the
 * analyzer's repeaters not yet on MediaMesh, each at its own antenna height;
 * their links worked out over the terrain), count or leave out the links only the model predicts, and see:
 * whether the mesh stays in one piece, how many routes between repeaters
 * still connect and in how many hops, what is still reached, which single
 * repeaters would split it, and the last 30 days' real clips replayed:
 * which would still arrive, by which way round, and which would be lost.
 */
'use strict';

(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const repName = (r) => (r ? String(r.name || String(r.public_key || '').slice(0, 8)) : '');
  const fmtKm2 = (v) => (v < 100 ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : Math.round(v).toLocaleString());

  /** Adjacency lists over n repeaters from [a, b] pairs. */
  function adjacency(n, pairs) {
    const adj = Array.from({ length: n }, () => new Set());
    pairs.forEach(([a, b]) => { if (a !== b && a < n && b < n) { adj[a].add(b); adj[b].add(a); } });
    return adj.map((s) => [...s]);
  }

  /** Hops from src to every repeater that is up (-1: no way there). */
  function hopsFrom(adj, up, src) {
    const d = new Array(adj.length).fill(-1);
    if (!up[src]) return d;
    d[src] = 0;
    const q = [src];
    while (q.length) {
      const u = q.shift();
      for (const v of adj[u]) if (up[v] && d[v] < 0) { d[v] = d[u] + 1; q.push(v); }
    }
    return d;
  }

  /** Between every pair of linked repeaters (`linked`), how many still
   * connect among those up, and the median hops of those that do. */
  function routes(adj, up, linked) {
    const nodes = linked.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
    let pairs = 0, ok = 0;
    const hops = [];
    nodes.forEach((a, ai) => {
      const d = hopsFrom(adj, up, a);
      for (let bi = ai + 1; bi < nodes.length; bi++) {
        pairs++;
        const h = d[nodes[bi]];
        if (h > 0) { ok++; hops.push(h); }
      }
    });
    hops.sort((x, y) => x - y);
    return { pairs, ok, medianHops: hops.length ? hops[hops.length >> 1] : null };
  }

  /** The repeater a path hash (a few hex digits) stands for, or -1 when
   * none or more than one of `placed` starts so. */
  function hopIndex(placed, hash) {
    const h = String(hash || '').toLowerCase();
    if (!h) return -1;
    let found = -1;
    for (let i = 0; i < placed.length; i++) {
      if (String(placed[i].public_key || '').toLowerCase().startsWith(h)) {
        if (found >= 0) return -1;
        found = i;
      }
    }
    return found;
  }

  /**
   * A real clip, replayed: { ok, hops, way (repeater indices) | null,
   * reason } where reason is '' (as it went), 'rerouted', 'first-down'
   * (the repeater it entered by is down), 'last-down', 'no-way' or
   * 'unknown' (a hop the analyzer can't name).
   */
  function replayClip(clip, placed, adj, up) {
    const idx = (clip.path || []).map((h) => hopIndex(placed, h));
    if (!idx.length || idx.some((i) => i < 0)) return { ok: null, hops: clip.hops || 0, way: null, reason: 'unknown' };
    const first = idx[0], last = idx[idx.length - 1];
    if (!up[first]) return { ok: false, hops: 0, way: null, reason: 'first-down' };
    if (!up[last]) return { ok: false, hops: 0, way: null, reason: 'last-down' };
    if (idx.every((i) => up[i])) return { ok: true, hops: idx.length, way: idx, reason: '' };
    // round the gap: the shortest way from where it entered to where it was heard
    const prev = new Array(adj.length).fill(-1), seen = new Array(adj.length).fill(false);
    seen[first] = true;
    const q = [first];
    while (q.length) {
      const u = q.shift();
      if (u === last) break;
      for (const v of adj[u]) if (up[v] && !seen[v]) { seen[v] = true; prev[v] = u; q.push(v); }
    }
    if (!seen[last]) return { ok: false, hops: 0, way: null, reason: 'no-way' };
    const way = [];
    for (let v = last; v >= 0; v = prev[v]) way.unshift(v);
    return { ok: true, hops: way.length, way, reason: 'rerouted' };
  }

  function reasonText(r, placed, clip) {
    const name = (i) => esc(repName(placed[i]));
    switch (r.reason) {
      case '': return `arrives, as it went (${r.hops} hop${r.hops === 1 ? '' : 's'})`;
      case 'rerouted': return `arrives another way: ${r.way.map(name).join(' → ')}`;
      case 'first-down': return `lost: the repeater it went in by is down`;
      case 'last-down': return `lost: the repeater it was heard from last is down`;
      case 'no-way': return 'lost: no way round';
      default: return `can't tell: a hop the analyzer can't name (${esc((clip.path || []).join(' → '))})`;
    }
  }

  /** Repeaters from /api/nodes that could join MediaMesh: not already on
   * it (`mmKeys`, lower-case public keys), by name; `placed` says whether
   * it sent a position to work its links out from. */
  function candidates(nodes, mmKeys) {
    const on = new Set([...(mmKeys || [])].map((k) => String(k).toLowerCase()));
    return (Array.isArray(nodes) ? nodes : [])
      .filter((r) => r && r.public_key && !on.has(String(r.public_key).toLowerCase()) && (!r.role || r.role === 'repeater'))
      .map((r) => ({ name: repName(r), public_key: r.public_key, lat: Number(r.lat), lon: Number(r.lon),
        placed: Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)) && !(Number(r.lat) === 0 && Number(r.lon) === 0) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const X_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const PLUS_ICON = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  const BACK_ICON = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';

  /** The search results; those already added (`addedKeys`, lower-case
   * public keys) say so instead of offering Add. */
  function candidatesHtml(list, query, addedKeys) {
    if (!list.length) return `<p class="text-muted mml-note">No repeater by that name${query ? ` (“${esc(query)}”)` : ''} that isn't already on MediaMesh.</p>`;
    const added = addedKeys || new Set();
    return `<ul class="mml-found" role="list">${list.map((r) => {
      const key = `<span class="text-muted">${esc(String(r.public_key).slice(0, 8))}</span>`;
      if (!r.placed) return `<li><span class="mml-found-off" title="It hasn't sent a position, so its links can't be worked out">${esc(r.name)} <span class="text-muted">no position</span></span></li>`;
      if (added.has(String(r.public_key).toLowerCase())) return `<li><span class="mml-found-off">${esc(r.name)} ${key} <span class="mml-found-added">Added</span></span></li>`;
      return `<li><button type="button" class="mml-found-btn" data-mml-add="${esc(r.public_key)}"><span>${esc(r.name)} ${key}</span><span class="mml-found-plus">${PLUS_ICON}Add</span></button></li>`;
    }).join('')}</ul>`;
  }

  /** What one added repeater's line says under its name. */
  function planNote(p) {
    const where = p.as ? `Already up · ${String(p.as.public_key).slice(0, 8)}` : 'Placed on the map';
    let what;
    if (p.state === 'working') what = 'working out its links…';
    else if (p.state === 'waiting') what = 'its links are worked out once the terrain has loaded';
    else if (p.state === 'no-terrain') what = 'without the terrain its links can\'t be worked out';
    else if (!p.links || !p.links.length) what = 'links to no repeater: it would stand on its own';
    else what = `links to ${p.links.slice(0, 3).map((l) => repName(l.rep)).join(', ')}${p.links.length > 3 ? ` and ${p.links.length - 3} more` : ''}`;
    return `${where} · ${what}`;
  }

  /** Every added repeater, with its own antenna height and an X. */
  function addedHtml(plans) {
    const head = `<div class="mml-group">Added · ${plans.length}</div>`;
    if (!plans.length) return head + '<p class="text-muted mml-note">None yet.</p>';
    return head + plans.map((p) => `<div class="mml-added">
      <span class="mml-mark mml-mark--add" aria-hidden="true"></span>
      <span class="mml-added-text"><span class="mml-added-name">${esc(p.name)}</span><span class="text-muted mml-added-note">${esc(planNote(p))}</span></span>
      <label class="mml-added-h"><input type="number" min="2" max="300" inputmode="numeric" value="${p.heightM}" data-mml-height="${p.id}" aria-label="Antenna height of ${esc(p.name)}, metres above the ground"> m up</label>
      <button type="button" class="mml-x" data-mml-remove="${p.id}" aria-label="Remove ${esc(p.name)}" title="Remove ${esc(p.name)}">${X_ICON}</button>
    </div>`).join('');
  }

  /** The MediaMesh repeaters: those taken down first, each with Bring
   * back, then those up, each with an X to take it down; `query` filters
   * both by name or place. */
  function repListHtml(placed, down, query) {
    const q = String(query || '').trim().toLowerCase();
    const hit = (r) => !q || (repName(r) + ' ' + (r.near || '')).toLowerCase().includes(q);
    const near = (r) => (r.near ? ` <span class="text-muted">${esc(String(r.near).split(',')[0])}</span>` : '');
    const off = placed.map((r, i) => ({ r, i })).filter((x) => down[x.i]);
    const on = placed.map((r, i) => ({ r, i })).filter((x) => !down[x.i] && hit(x.r));
    const offHtml = off.length ? `<div class="mml-group">Taken down · ${off.length}</div>${off.map(({ r, i }) => `<div class="mml-down">
      <span class="mml-mark mml-mark--down" aria-hidden="true"></span><span class="mml-down-name">${esc(repName(r))}</span>
      <button type="button" class="mml-back" data-mml-up="${i}">${BACK_ICON}Bring back</button></div>`).join('')}` : '';
    const onHtml = `<div class="mml-group">On MediaMesh · ${placed.length - off.length}</div>`
      + (on.length ? on.map(({ r, i }) => `<div class="mml-up"><span class="mml-mark mml-mark--on" aria-hidden="true"></span><span class="mml-up-name">${esc(repName(r))}${near(r)}</span>
      <button type="button" class="mml-x" data-mml-down="${i}" aria-label="Take down ${esc(repName(r))}" title="Take down ${esc(repName(r))}">${X_ICON}</button></div>`).join('')
        : `<p class="text-muted mml-note">${q ? 'None by that name.' : 'All taken down.'}</p>`);
    return offHtml + `<div class="mml-reps">${onHtml}</div>`;
  }

  // ---- The page --------------------------------------------------------------

  let map = null, destroyed = false, off = null;

  function pageHtml() {
    return `<div class="mml-page">
      ${root.MediaMeshNav ? root.MediaMeshNav.html('lab') : ''}
      <div class="mml-head">
        <h1>MediaMeshLab</h1>
        <p class="text-muted">Change the mesh and see what happens: add repeaters, take some down, and replay the last month's clips through it. Nothing you do here changes the real mesh.</p>
      </div>
      <div class="mml-split">
        <form class="mml-controls" id="mmlControls" onsubmit="return false">
          <h2>Add a repeater</h2>
          <button type="button" class="tab-btn mml-place" id="mmlPlace" aria-pressed="false">Place one on the map</button>
          <p class="text-muted mml-note" id="mmlPlanNote">Click Place, then the map. Each one you place joins the list below, its links worked out over the terrain.</p>
          <label class="mml-find-label" for="mmlFind">Or add one or several of the repeaters already up, not on MediaMesh yet.</label>
          <input type="search" class="mml-search" id="mmlFind" placeholder="Find a repeater by name" autocomplete="off">
          <div id="mmlFound" aria-live="polite"></div>
          <div class="mml-added-list" id="mmlAdded"></div>
          <h2 class="mml-sep">Take down</h2>
          <input type="search" class="mml-search" id="mmlSearch" placeholder="Find a MediaMesh repeater" aria-label="Find a MediaMesh repeater">
          <div id="mmlReps"><p class="text-muted">Loading the mesh…</p></div>
          <h2 class="mml-sep">Links</h2>
          <label class="mml-check"><input type="checkbox" id="mmlModel" checked> Count links the model predicts but nobody has heard</label>
          <button type="button" class="tab-btn" id="mmlReset">Back to the real mesh</button>
        </form>
        <div class="mml-main">
          <div class="mml-tiles" id="mmlTiles"></div>
          <div id="mmlMap" class="mml-map" role="img" aria-label="Map of the mesh as changed: repeaters taken down in red, those added in green"></div>
          <p class="text-muted mml-note" id="mmlStatus"></p>
          <h2>The last 30 days' clips, replayed</h2>
          <div id="mmlClips"></div>
          <h2>Wind tunnel</h2>
          <p class="text-muted mml-note">The same clips sent again 200 times each, through the mesh as changed above and with the radio2 preset and repair below: how many arrive whole, how long they take and the airtime they use, now and as changed. A rough model, best for comparing.</p>
          <div id="mmlWind"></div>
        </div>
      </div>
    </div>`;
  }

  async function init(app) {
    destroyed = false;
    app.innerHTML = pageHtml();
    const L = root.L, M = root.MediaMeshCoverage, S = root.MediaMeshStatus;
    const $ = (id) => app.querySelector('#' + id);
    let mm, clipsData;
    try {
      [mm, clipsData] = await Promise.all([
        CSApi.fetch('/api/analytics/mediamesh').then((r) => r.json()),
        CSApi.fetch('/api/analytics/mediamesh/clips?days=30').then((r) => r.json()).catch(() => ({})),
      ]);
    } catch (_) {
      $('mmlReps').innerHTML = '<p class="text-muted">The analyzer could not be reached.</p>';
      return;
    }
    if (destroyed) return;
    const placed = ((mm && mm.repeaters) || []).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    const n = placed.length;
    const heard = S ? S.heardEdges(placed, mm.backbone, mm.links) : [];
    const linked = new Array(n).fill(false);
    heard.forEach(([a, b]) => { linked[a] = linked[b] = true; });
    const clips = [].concat((clipsData && clipsData.clips) || [], (clipsData && clipsData.unannounced) || [])
      .filter((c) => Array.isArray(c.path) && c.path.length)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    const down = new Array(n).fill(false);
    const W = root.MediaMeshWindTunnel;
    if (W) $('mmlWind').innerHTML = W.controlsHtml();
    const hopP = W ? W.hopChance(clips) : 0.85;
    // plans: the added repeaters, in the order added. Each { id, name, as
    // (the repeater already up it is, or null), lat, lon, heightM, links
    // (to placed repeaters), cov, state, overlay, token }; in the graph
    // repeater n + its place in the list.
    let plans = [], planPairs = [], nextId = 1;
    let predicted = null, cov = null, elevAt = null, placing = false, noTerrain = false;

    const showReps = () => { $('mmlReps').innerHTML = repListHtml(placed, down, $('mmlSearch').value); };
    const showAdded = () => { $('mmlAdded').innerHTML = addedHtml(plans); };
    showReps();
    showAdded();

    // the map
    let overlay = null;
    const layer = L ? L.layerGroup() : null;
    if (L && $('mmlMap')) {
      map = L.map($('mmlMap'), { zoomControl: true });
      const tileUrl = typeof root.getTileUrl === 'function' ? root.getTileUrl() : null;
      if (tileUrl) L.tileLayer(tileUrl, { maxZoom: 18 }).addTo(map);
      map.createPane('mmlCov').style.zIndex = 450;
      if (n) map.fitBounds(L.latLngBounds(placed.map((r) => [r.lat, r.lon])).pad(0.2)); else map.setView([47.6, -122.33], 11);
      layer.addTo(map);
      map.on('click', (e) => { if (placing) addPlan(e.latlng.lat, e.latlng.lng, null); });
    }

    // links between the added repeaters themselves, [i, j] by place in plans
    function pairPlans() {
      planPairs = [];
      if (!elevAt || !M) return;
      plans.forEach((p, i) => {
        M.planLinks(p, plans.slice(i + 1), elevAt).forEach((l) => planPairs.push([i, i + 1 + l.index]));
      });
    }

    function graph(withPlans) {
      const pairs = heard.slice();
      if ($('mmlModel').checked && predicted) predicted.forEach((p) => pairs.push([p.a, p.b]));
      if (withPlans) {
        plans.forEach((p, k) => (p.links || []).forEach((l) => pairs.push([l.index, n + k])));
        planPairs.forEach(([i, j]) => pairs.push([n + i, n + j]));
      }
      return adjacency(n + plans.length, pairs);
    }

    function draw() {
      const N = n + plans.length;
      const adj = graph(true);
      const adjReal = graph(false);
      const upNow = down.map((d) => !d).concat(plans.map(() => true));
      const upAll = placed.map(() => true).concat(plans.map(() => false));
      const linkedNow = linked.concat(plans.map((p, k) => (p.links || []).length > 0 || planPairs.some(([i, j]) => i === k || j === k)));
      if ($('mmlModel').checked && predicted) predicted.forEach((p) => { linkedNow[p.a] = linkedNow[p.b] = true; });
      const before = routes(adjReal, upAll, linkedNow.map((l, i) => l && i < n));
      const after = routes(adj, upNow, linkedNow.map((l, i) => l && upNow[i]));
      const piecesBefore = S ? S.pieces(N, adjPairs(adjReal), upAll).length : 0;
      const piecesAfter = S ? S.pieces(N, adjPairs(adj), upNow).length : 0;
      const spofAfter = S ? S.singlePoints(N, adjPairs(adj), upNow) : [];
      let kmBefore = null, kmAfter = null;
      if (cov && M) {
        const all = placed.map(() => true), live = down.map((d) => !d);
        const a = M.meshCells(cov, placed.map(() => 'often'), all).km2, b = M.meshCells(cov, placed.map((_, i) => (live[i] ? 'often' : 'none')), live).km2;
        kmBefore = a[3] + a[4];
        kmAfter = b[3] + b[4];
        const covs = plans.map((p) => p.cov).filter(Boolean);
        if (covs.length) {
          M.merge(cov, live);
          kmAfter += M.plansGainKm2(covs, cov);
        }
        if (map) {
          if (overlay) map.removeLayer(overlay);
          const bb = cov.bounds;
          overlay = M.canvasOverlay(L, M.meshCanvas(cov, M.meshCells(cov, placed.map((_, i) => (live[i] ? 'often' : 'none')), live)), [[bb.south, bb.west], [bb.north, bb.east]], { pane: 'mmlCov', opacity: 1 }).addTo(map);
        }
      }
      const tile = (label, was, now, good) => `<div class="mml-tile"><div class="mml-label">${label}</div><div class="mml-big">${was} <span class="mml-arrow" aria-label="becomes">→</span> <span class="${good == null ? '' : good ? 'mms-good' : 'mms-bad'}">${now}</span></div></div>`;
      const same = (a, b) => (a === b ? null : b > a);
      $('mmlTiles').innerHTML = tile('Mesh in one piece', piecesBefore <= 1 ? 'Yes' : `${piecesBefore} pieces`, piecesAfter <= 1 ? 'Yes' : `${piecesAfter} pieces`, piecesAfter === piecesBefore ? null : piecesAfter < piecesBefore)
        + tile('Routes between repeaters that connect', `${before.ok} of ${before.pairs}`, `${after.ok} of ${after.pairs}`, same(before.pairs ? before.ok / before.pairs : 0, after.pairs ? after.ok / after.pairs : 0))
        + tile('Typical route', before.medianHops == null ? '—' : `${before.medianHops} hop${before.medianHops === 1 ? '' : 's'}`, after.medianHops == null ? '—' : `${after.medianHops} hop${after.medianHops === 1 ? '' : 's'}`, before.medianHops == null || after.medianHops == null ? null : same(after.medianHops, before.medianHops))
        + tile('Reached, land and water', kmBefore == null ? '…' : `${fmtKm2(kmBefore)} km²`, kmAfter == null ? '…' : `${fmtKm2(kmAfter)} km²`, kmBefore == null ? null : same(Math.round(kmBefore), Math.round(kmAfter)))
        + tile('Repeaters whose loss alone would split it', String(S ? S.singlePoints(N, adjPairs(adjReal), upAll).length : 0), String(spofAfter.length), null);
      // links and repeaters
      if (layer) {
        layer.clearLayers();
        const ink = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#1a1a2e';
        const pos = (i) => (i >= n ? [plans[i - n].lat, plans[i - n].lon] : [placed[i].lat, placed[i].lon]);
        heard.forEach(([a, b]) => { if (upNow[a] && upNow[b]) L.polyline([pos(a), pos(b)], { color: ink, weight: 2, opacity: 0.6, interactive: false }).addTo(layer); });
        if ($('mmlModel').checked && predicted) predicted.forEach(({ a, b }) => { if (upNow[a] && upNow[b]) L.polyline([pos(a), pos(b)], { color: '#7c3aed', weight: 2, opacity: 0.8, dashArray: '2 6', interactive: false }).addTo(layer); });
        const planLine = { color: '#16a34a', weight: 3, opacity: 0.9, dashArray: '8 6', interactive: false };
        plans.forEach((p, k) => (p.links || []).forEach((l) => { if (upNow[l.index]) L.polyline([pos(l.index), pos(n + k)], planLine).addTo(layer); }));
        planPairs.forEach(([i, j]) => L.polyline([pos(n + i), pos(n + j)], planLine).addTo(layer));
        placed.forEach((r, i) => L.circleMarker([r.lat, r.lon], down[i]
          ? { radius: 8, weight: 3, color: '#ef4444', fillColor: '#ffffff', fillOpacity: 1 }
          : { radius: 5, weight: 2, color: '#ffffff', fillColor: '#d946ef', fillOpacity: 1 }).bindTooltip(repName(r) + (down[i] ? ' · taken down' : '')).addTo(layer));
        plans.forEach((p) => L.circleMarker([p.lat, p.lon], { radius: 8, weight: 3, color: '#ffffff', fillColor: '#16a34a', fillOpacity: 1 })
          .bindTooltip(`${p.as ? `${p.name} on MediaMesh` : p.name}, ${p.heightM} m up`).addTo(layer));
      }
      // clips
      const rows = clips.slice(0, 60).map((c) => ({ c, r: replayClip(c, placed, adj, upNow) }));
      if (W) wind(adj, upNow);
      const lost = rows.filter((x) => x.r.ok === false).length, rerouted = rows.filter((x) => x.r.reason === 'rerouted').length;
      $('mmlClips').innerHTML = !rows.length
        ? '<p class="text-muted">No clips heard in the last 30 days whose path the analyzer knows.</p>'
        : `<p class="mml-sum">${rows.length - lost} of ${rows.length} would still arrive${rerouted ? `, ${rerouted} by another way` : ''}${lost ? `; ${lost} would be lost` : ''}.</p>
          <ul class="mml-clips">${rows.map(({ c, r }) => `<li class="mml-clip mml-clip--${r.ok === false ? 'lost' : r.ok ? 'ok' : 'unknown'}"><span class="mml-dot" aria-hidden="true"></span><span><strong>${esc(new Date(c.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</strong> · ${esc(c.kind && c.kind !== 'unknown' ? c.kind : 'clip')}, heard at ${esc(c.observerName || '')}<br><span class="text-muted">${reasonText(r, placed.concat(plans), c)}</span></span></li>`).join('')}</ul>`;
    }

    // The wind tunnel: the clips as they went, against the mesh as changed
    // with the preset and repair picked.
    function wind(adj, upNow) {
      const pick = (list, id) => list.find((o) => o.id === $(id).value) || list[0];
      const now = { preset: W.PRESETS[0], repair: W.REPAIRS[0], rounds: 3 };
      const changed = { preset: pick(W.PRESETS, 'mmwPreset'), repair: pick(W.REPAIRS, 'mmwRepair'), rounds: Number($('mmwRounds').value) || 3 };
      const asWent = W.itemsFrom(clips, (c) => c.path.length);
      const asChanged = W.itemsFrom(clips, (c) => {
        const r = replayClip(c, placed, adj, upNow);
        return r.ok === false ? null : r.ok ? r.hops : c.path.length;
      });
      if (!asWent.length) {
        $('mmwTiles').innerHTML = '<p class="text-muted">No announced clips in the last 30 days whose path the analyzer knows.</p>';
        $('mmwNote').textContent = '';
        return;
      }
      const a = W.runAll(asWent, hopP, now), b = W.runAll(asChanged, hopP, changed);
      $('mmwTiles').innerHTML = W.tilesHtml(a, b);
      $('mmwNote').textContent = `${asWent.length} clip${asWent.length === 1 ? '' : 's'}. A piece crosses a hop ${Math.round(a.hopChance * 100)}% of the time now, by what the observers heard${b.hopChance !== a.hopChance ? `, and ${Math.round(b.hopChance * 100)}% with the preset picked` : ''}.`;
    }

    function adjPairs(adj) {
      const out = [];
      adj.forEach((vs, a) => vs.forEach((b) => { if (a < b) out.push([a, b]); }));
      return out;
    }

    // One added repeater's links (now) and coverage (when its terrain has
    // loaded); again when its height changes.
    async function workOut(p) {
      const mine = p.token = (p.token || 0) + 1;
      p.links = []; p.cov = null;
      if (p.overlay && map) { map.removeLayer(p.overlay); p.overlay = null; }
      if (!elevAt || !M) { p.state = noTerrain || !M ? 'no-terrain' : 'waiting'; showAdded(); draw(); return; }
      p.state = 'working';
      p.links = M.planLinks(p, placed, elevAt);
      pairPlans();
      showAdded(); draw();
      try {
        const t = await M.loadTerrainLevels(M.terrainPlan([p], M.CONFIG.modes.ground));
        const pc = await M.computeCoverage([p], t.elevAt, 'ground', null, null);
        if (mine !== p.token || destroyed || !plans.includes(p)) return;
        p.cov = pc ? M.adjustCov(pc, 'outdoors') : null;
        if (map && p.cov) {
          const b = p.cov.bounds;
          p.overlay = M.canvasOverlay(L, M.coverageCanvas(p.cov, [22, 163, 74]), [[b.south, b.west], [b.north, b.east]], { pane: 'mmlCov', opacity: 0.8 }).addTo(map);
        }
      } catch (_) { /* links stand; its coverage isn't shown */ }
      if (mine !== p.token || destroyed || !plans.includes(p)) return;
      p.state = '';
      showAdded(); draw();
    }

    function addPlan(lat, lon, as) {
      placing = false;
      $('mmlPlace').setAttribute('aria-pressed', 'false');
      const id = nextId++;
      const p = { id, name: as ? as.name : `Planned repeater ${plans.filter((x) => !x.as).length + 1}`, as: as || null, lat, lon, heightM: 10, radio: '', links: [], cov: null, state: 'working' };
      plans.push(p);
      workOut(p);
    }

    function removePlan(id) {
      const p = plans.find((x) => x.id === id);
      if (!p) return;
      p.token = (p.token || 0) + 1;
      if (p.overlay && map) map.removeLayer(p.overlay);
      plans = plans.filter((x) => x !== p);
      pairPlans();
      showAdded(); draw();
      if (found.length) $('mmlFound').innerHTML = candidatesHtml(found, $('mmlFind').value.trim(), addedKeys());
    }

    // repeaters the analyzer knows that aren't on MediaMesh, by name
    const mmKeys = ((mm && mm.repeaters) || []).map((r) => r.public_key);
    const addedKeys = () => new Set(plans.filter((p) => p.as).map((p) => String(p.as.public_key).toLowerCase()));
    let found = [], findTimer = null, findToken = 0;
    const find = (q) => {
      const mine = ++findToken;
      if (q.length < 2) { found = []; $('mmlFound').innerHTML = ''; return; }
      CSApi.fetch('/api/nodes?role=repeater&limit=25&search=' + encodeURIComponent(q)).then((r) => r.json()).then((d) => {
        if (mine !== findToken || destroyed) return;
        found = candidates(Array.isArray(d) ? d : (d && d.nodes) || [], mmKeys);
        $('mmlFound').innerHTML = candidatesHtml(found, q, addedKeys());
      }).catch(() => { if (mine === findToken && !destroyed) $('mmlFound').innerHTML = '<p class="text-muted mml-note">The repeaters could not be loaded.</p>'; });
    };
    // the search stays open, so several can be added one after another
    const addExisting = (r) => {
      if (addedKeys().has(String(r.public_key).toLowerCase())) return;
      if (map) map.panTo([r.lat, r.lon]);
      addPlan(r.lat, r.lon, { name: r.name, public_key: r.public_key });
      if (found.length) $('mmlFound').innerHTML = candidatesHtml(found, $('mmlFind').value.trim(), addedKeys());
    };

    const onChange = (e) => {
      const t = e.target;
      if (t.matches('[data-mml-height]')) {
        const p = plans.find((x) => x.id === Number(t.dataset.mmlHeight));
        if (p) { p.heightM = Math.max(2, Math.min(300, Number(t.value) || 10)); t.value = p.heightM; workOut(p); }
      } else if (t.id === 'mmwPreset' || t.id === 'mmwRepair' || t.id === 'mmwRounds' || t.id === 'mmlModel') draw();
    };
    const onInput = (e) => {
      if (e.target.id === 'mmlFind') {
        clearTimeout(findTimer);
        const q = e.target.value.trim();
        findTimer = setTimeout(() => find(q), 250);
      } else if (e.target.id === 'mmlSearch') showReps();
    };
    const onClick = (e) => {
      const t = e.target;
      const add = t.closest('[data-mml-add]');
      if (add) {
        const r = found.find((c) => c.public_key === add.dataset.mmlAdd);
        if (r) addExisting(r);
        return;
      }
      const rm = t.closest('[data-mml-remove]');
      if (rm) { removePlan(Number(rm.dataset.mmlRemove)); return; }
      const dn = t.closest('[data-mml-down]');
      if (dn) { down[Number(dn.dataset.mmlDown)] = true; showReps(); draw(); return; }
      const up = t.closest('[data-mml-up]');
      if (up) { down[Number(up.dataset.mmlUp)] = false; showReps(); draw(); return; }
      if (t.closest('#mmlPlace')) {
        placing = !placing;
        $('mmlPlace').setAttribute('aria-pressed', placing ? 'true' : 'false');
        $('mmlPlanNote').textContent = placing ? 'Click the map where it should go.' : 'Click Place, then the map. Each one you place joins the list below, its links worked out over the terrain.';
      } else if (t.closest('#mmlReset')) {
        down.fill(false);
        plans.slice().forEach((p) => removePlan(p.id));
        $('mmlModel').checked = true;
        $('mmlSearch').value = '';
        showReps(); draw();
      }
    };
    app.addEventListener('change', onChange);
    app.addEventListener('input', onInput);
    app.addEventListener('click', onClick);
    off = () => {
      clearTimeout(findTimer);
      app.removeEventListener('change', onChange);
      app.removeEventListener('input', onInput);
      app.removeEventListener('click', onClick);
    };
    draw();

    // #/mediamesh-lab?lat=…&lon=… (from Grow the mesh) or ?add={public key}:
    // start with a repeater added there
    const start = async () => {
      const q = new URLSearchParams(String(location.hash.split('?')[1] || ''));
      const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
      if (q.get('lat') !== null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        if (map) map.setView([lat, lon], 12);
        addPlan(lat, lon, null);
      } else if (/^[0-9a-f]{8,64}$/i.test(q.get('add') || '')) {
        const node = await CSApi.fetch('/api/nodes/' + encodeURIComponent(q.get('add'))).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const c = candidates([node && (node.node || node)], mmKeys)[0];
        if (c && c.placed && !destroyed) { if (map) map.setView([c.lat, c.lon], 11); addExisting(c); }
      }
    };

    if (M && typeof M.groundCoverage === 'function' && n) {
      try {
        const res = await M.groundCoverage(placed, mm.links || [], {}, (d, t) => { if (!destroyed) $('mmlStatus').textContent = `Working out the coverage… ${d} of ${t} repeaters`; });
        if (destroyed) return;
        cov = res.cov; elevAt = res.elevAt;
        predicted = M.predictedLinks(placed, elevAt).filter((p) => !heard.some(([a, b]) => a === p.a && b === p.b));
        $('mmlStatus').textContent = '';
        draw();
      } catch (_) {
        noTerrain = true;
        $('mmlStatus').textContent = 'Terrain could not be loaded, so what is reached and the links the model predicts aren\'t shown.';
      }
      if (destroyed) return;
      plans.forEach((p) => workOut(p)); // added while the terrain loaded
      start();
    } else start();
  }

  function destroy() {
    destroyed = true;
    if (off) off();
    off = null;
    if (map) map.remove();
    map = null;
  }

  root.MediaMeshLab = { adjacency, hopsFrom, routes, hopIndex, replayClip, reasonText, candidates, candidatesHtml, planNote, addedHtml, repListHtml, init, destroy };
  if (typeof root.registerPage === 'function') root.registerPage('mediamesh-lab', { init, destroy });
})(typeof window !== 'undefined' ? window : globalThis);
