/* === CoreScope — mediamesh-grow.js ===
 * Grow the mesh (#/mediamesh-grow): the five moves that would do the most,
 * one after another (each counted against the mesh with the ones before it).
 * Candidates: main-mesh repeaters already up that could turn radio2 on
 * (heard in the last 3 days, not already on MediaMesh, near the mesh) and
 * high ground with no repeater yet. Each is worked out with the quick
 * estimate (a 10 m mast, 20 km out) and its links over the terrain.
 * Goals: people reached, ground covered twice, water (ferries, water
 * taxis), or closing the mesh's single points of failure.
 */
'use strict';

(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const repName = (r) => (r ? String(r.name || String(r.public_key || '').slice(0, 8)) : '');
  const fmtN = (v) => Math.round(v).toLocaleString();
  const fmtKm2 = (v) => (v < 100 ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : Math.round(v).toLocaleString());
  const distKm = (a, b, c, d) => Math.hypot((c - a) * 111.32, (d - b) * 111.32 * Math.cos(a * Math.PI / 180));

  const GOALS = [
    ['people', 'People reached'],
    ['twice', 'Covered twice'],
    ['water', 'Water (ferries, water taxis)'],
    ['spof', 'No single point of failure'],
  ];

  /**
   * The five best moves, greedily. base: { count: Uint8Array (repeaters
   * reaching each cell of the shared grid), water: Uint8Array|null,
   * cellKm2 }; cands: [{ cells: Int32Array (grid cells it reaches), people:
   * [{ cell, n }], links, bridges (Set of single points it goes round) }];
   * spof: the mesh's single points of failure (Set). Returns
   * [{ index, gain: { people, km2, twice, water }, closes: [...] }].
   */
  function greedy(base, cands, goal, k, spof) {
    const count = Uint8Array.from(base.count);
    const covered = new Set(), open = new Set(spof || []);
    const peopleDone = new Set();
    const picks = [];
    const gainOf = (c) => {
      let fresh = 0, twice = 0, water = 0;
      for (const i of c.cells) {
        if (!count[i]) { fresh++; if (base.water && base.water[i]) water++; } else if (count[i] === 1) twice++;
      }
      let people = 0;
      c.people.forEach((p) => { if (!count[p.cell] && !peopleDone.has(p.cell)) people += p.n; });
      const closes = [...(c.bridges || [])].filter((x) => open.has(x));
      return { people, km2: fresh * base.cellKm2, twice: twice * base.cellKm2, water: water * base.cellKm2, closes };
    };
    const score = (g) => (goal === 'twice' ? g.twice : goal === 'water' ? g.water : goal === 'spof' ? g.closes.length * 1e9 + g.people : g.people) + g.km2 * 1e-3;
    for (let step = 0; step < k; step++) {
      let best = -1, bestG = null, bestS = 0;
      cands.forEach((c, i) => {
        if (covered.has(i)) return;
        // never two moves within 3 km of each other
        if (picks.some((p) => distKm(cands[p.index].lat, cands[p.index].lon, c.lat, c.lon) < 3)) return;
        const g = gainOf(c), sc = score(g);
        if (sc > bestS) { best = i; bestG = g; bestS = sc; }
      });
      if (best < 0) break;
      covered.add(best);
      const c = cands[best];
      for (const i of c.cells) if (count[i] < 9) count[i]++;
      c.people.forEach((p) => peopleDone.add(p.cell));
      bestG.closes.forEach((x) => open.delete(x));
      picks.push({ index: best, gain: bestG });
    }
    return picks;
  }

  /** The cells of the shared grid a candidate's quick coverage reaches,
   * and the people in them. */
  function candCells(M, shown, candCov, points) {
    const cells = new Set();
    for (let row = 0, i = 0; row < candCov.height; row++) {
      for (let col = 0; col < candCov.width; col++, i++) {
        if (!(candCov.margins[i] >= 0)) continue;
        const ll = M.cellCenter(candCov, col, row);
        const j = gridIndex(shown, ll[0], ll[1]);
        if (j >= 0) cells.add(j);
      }
    }
    const people = [];
    (points || []).forEach(([lat, lon, n]) => {
      const c = M.cellAt(candCov, lat, lon);
      if (!(c && c.margin >= 0)) return;
      const j = gridIndex(shown, lat, lon);
      if (j >= 0) people.push({ cell: j, n });
    });
    return { cells: Int32Array.from(cells), people };
  }

  function gridIndex(cov, lat, lon) {
    const col = Math.floor(((lon - cov.bounds.west) / (cov.bounds.east - cov.bounds.west)) * cov.width);
    const row = Math.floor(((cov.bounds.north - lat) / (cov.bounds.north - cov.bounds.south)) * cov.height);
    if (col < 0 || col >= cov.width || row < 0 || row >= cov.height) return -1;
    return row * cov.width + col;
  }

  /** Main-mesh repeaters that could turn radio2 on: heard in the last
   * `days`, not on MediaMesh, within `box`, at least 1 km from a MediaMesh
   * repeater; the busiest `max`. */
  function upgradeCandidates(nodes, mmKeys, box, now, opts) {
    const o = Object.assign({ days: 3, max: 30, minKm: 1 }, opts || {});
    return (nodes || []).filter((n) => {
      if (!Number.isFinite(n.lat) || !Number.isFinite(n.lon) || (n.lat === 0 && n.lon === 0)) return false;
      if (mmKeys.has(String(n.public_key || '').toLowerCase())) return false;
      if (!/repeater/i.test(n.role || 'repeater')) return false;
      if (n.lat < box.south || n.lat > box.north || n.lon < box.west || n.lon > box.east) return false;
      const t = Date.parse(n.last_heard || n.last_seen || '');
      return Number.isFinite(t) && now - t < o.days * 86400000;
    }).filter((n) => !(o.near || []).some((r) => distKm(r.lat, r.lon, n.lat, n.lon) < o.minKm))
      .sort((a, b) => (Number(b.relay_count_24h) || 0) - (Number(a.relay_count_24h) || 0))
      .slice(0, o.max);
  }

  function moveHtml(m, i, cand, goal) {
    const kind = cand.node ? '<span class="mmg-kind mmg-kind--up">Already up: turn radio2 on</span>' : '<span class="mmg-kind mmg-kind--new">New repeater</span>';
    const title = cand.node ? esc(repName(cand.node)) : esc(cand.place || `${cand.lat.toFixed(4)}, ${cand.lon.toFixed(4)}`);
    const act = cand.node
      ? `<a class="mmg-act" href="#/nodes/${encodeURIComponent(cand.node.public_key)}">Ask the owner</a>`
      : `<a class="mmg-act" href="#/mediamesh-lab?lat=${cand.lat.toFixed(5)}&amp;lon=${cand.lon.toFixed(5)}">Try it in MediaMeshLab</a>`;
    const g = m.gain;
    const links = cand.links.length ? `hears ${cand.links.slice(0, 3).map((l) => esc(repName(l.rep))).join(', ')}${cand.links.length > 3 ? ` and ${cand.links.length - 3} more` : ''}` : 'hears no MediaMesh repeater: it would stand on its own';
    const closes = g.closes.length ? ` · goes round ${g.closes.map((x) => esc(x)).join(', ')}` : '';
    return `<li class="mmg-move"><span class="mmg-num">${i + 1}</span><div class="mmg-body"><div class="mmg-title"><strong>${title}</strong> ${kind}</div>
      <div class="mmg-why text-muted">${links}${closes}${cand.node ? '' : ` · ground ${Math.round(cand.e || 0)} m`}</div>
      <div class="mmg-gain"><span${goal === 'people' ? ' class="mmg-goal"' : ''}><strong>+${fmtN(g.people)}</strong> people</span><span><strong>+${fmtKm2(g.km2)}</strong> km² new</span><span${goal === 'twice' ? ' class="mmg-goal"' : ''}><strong>${fmtKm2(g.twice)}</strong> km² covered twice</span><span${goal === 'water' ? ' class="mmg-goal"' : ''}><strong>${fmtKm2(g.water)}</strong> km² water</span></div></div>${act}</li>`;
  }

  // ---- The page --------------------------------------------------------------

  let map = null, destroyed = false, off = null;

  function pageHtml() {
    return `<div class="mmg-page">
      ${root.MediaMeshNav ? root.MediaMeshNav.html('grow') : ''}
      <div class="mmg-head">
        <h1>Grow the mesh</h1>
        <p class="text-muted">The five moves that would do the most, one after another: main-mesh repeaters that could turn radio2 on, and high ground with no repeater yet.</p>
      </div>
      <div class="mmg-goals" role="group" aria-label="Plan for">${GOALS.map(([k, l], i) => `<button type="button" class="tab-btn${i === 0 ? ' active' : ''}" data-mmg-goal="${k}" aria-pressed="${i === 0}">${l}</button>`).join('')}</div>
      <div class="mmg-split">
        <div class="mmg-list"><p class="text-muted" id="mmgStatus">Loading the mesh…</p><ol class="mmg-moves" id="mmgMoves"></ol></div>
        <div class="mmg-side">
          <div id="mmgMap" class="mmg-map" role="img" aria-label="Map of the suggested moves over today's coverage"></div>
          <div class="mmg-tiles" id="mmgTiles"></div>
        </div>
      </div>
      <p class="text-muted mmg-note">Each candidate is worked out with a 10 m mast and the quick estimate (20 km out); a rooftop or a taller mast changes everything, so treat these as places to ask around. People: 2020 Census block groups. Repeater heights the owners have given are used for the mesh as it is.</p>
    </div>`;
  }

  async function init(app) {
    destroyed = false;
    app.innerHTML = pageHtml();
    const L = root.L, M = root.MediaMeshCoverage, S = root.MediaMeshStatus, R = root.MediaMeshReach;
    const $ = (id) => app.querySelector('#' + id);
    const status = (t) => { if (!destroyed && $('mmgStatus')) $('mmgStatus').textContent = t; };
    let goal = 'people';
    if (!M || !R) { status('The coverage estimate is missing on this analyzer.'); return; }
    let mm, nodes;
    try {
      [mm, nodes] = await Promise.all([
        fetch('/api/analytics/mediamesh').then((r) => r.json()),
        fetch('/api/nodes?role=repeater&limit=5000').then((r) => r.json()),
      ]);
    } catch (_) { status('The analyzer could not be reached.'); return; }
    if (destroyed) return;
    const placed = ((mm && mm.repeaters) || []).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    if (!placed.length) { status('No MediaMesh repeater has a position yet.'); return; }
    const markers = L ? L.layerGroup() : null;
    if (L && $('mmgMap')) {
      map = L.map($('mmgMap'), { zoomControl: true });
      const tileUrl = typeof root.getTileUrl === 'function' ? root.getTileUrl() : null;
      if (tileUrl) L.tileLayer(tileUrl, { maxZoom: 18 }).addTo(map);
      map.createPane('mmgCov').style.zIndex = 450;
      map.fitBounds(L.latLngBounds(placed.map((r) => [r.lat, r.lon])).pad(0.25));
      markers.addTo(map);
    }
    status('Working out today\'s coverage…');
    let base;
    try {
      base = await M.groundCoverage(placed, mm.links || [], {}, (d, t) => status(`Working out today's coverage… ${d} of ${t} repeaters`));
    } catch (_) { status('Terrain could not be loaded.'); return; }
    if (destroyed) return;
    const shown = base.cov, elevAt = base.elevAt;
    const all = placed.map(() => true);
    M.merge(shown, all);
    if (map) {
      const b = shown.bounds;
      M.canvasOverlay(L, M.coverageCanvas(shown), [[b.south, b.west], [b.north, b.east]], { pane: 'mmgCov', opacity: 0.7 }).addTo(map);
    }
    // the shared grid: how many repeaters reach each cell today
    const count = new Uint8Array(shown.width * shown.height);
    (shown.rasters || []).forEach((r) => {
      if (!r || !r.data) return;
      for (let y = 0; y < r.h; y++) {
        let i = (r.row0 + y) * shown.width + r.col0, k = y * r.w;
        for (let x = 0; x < r.w; x++, i++, k++) if (r.data[k] >= 0 && count[i] < 9) count[i]++;
      }
    });
    const cellKm2 = M.cellAreaKm2(shown);
    // single points of failure today, by name
    const edges = S ? S.heardEdges(placed, mm.backbone, mm.links) : [];
    const spofIdx = S ? S.singlePoints(placed.length, edges, all) : [];
    const spofNames = new Set(spofIdx.map((i) => repName(placed[i])));
    const pieceWithout = (i) => {
      // which side of repeater i each other repeater is on, when i is gone
      const up = all.map((_, j) => j !== i);
      const ps = S.pieces(placed.length, edges, up);
      const side = new Map();
      ps.forEach((p, k) => p.forEach((j) => side.set(j, k)));
      return side;
    };
    const sides = spofIdx.map((i) => ({ i, name: repName(placed[i]), side: pieceWithout(i) }));

    // candidates
    let s = 90, n = -90, w = 180, e = -180;
    placed.forEach((r) => { s = Math.min(s, r.lat); n = Math.max(n, r.lat); w = Math.min(w, r.lon); e = Math.max(e, r.lon); });
    const pad = 8 / 111.32, padL = pad / Math.cos(((s + n) / 2) * Math.PI / 180);
    const box = { south: s - pad, north: n + pad, west: w - padL, east: e + padL };
    const mmKeys = new Set(placed.map((r) => String(r.public_key).toLowerCase()));
    const ups = upgradeCandidates((nodes && (nodes.nodes || nodes)) || [], mmKeys, box, Date.now(), { near: placed });
    const spots = R.candidateSpots(box, elevAt, { max: 24 }).filter((sp) => !ups.some((u) => distKm(u.lat, u.lon, sp.lat, sp.lon) < 1.5));
    const cands = ups.map((u) => ({ node: u, lat: u.lat, lon: u.lon })).concat(spots.map((sp) => Object.assign({}, sp)));
    let pts = [];
    try {
      const pop = await fetch('/api/places/population').then((r) => r.json());
      pts = (pop && pop.points) || [];
    } catch (_) { /* no people counts */ }
    const pool = M.workerPool ? M.workerPool() : null;
    try {
      for (let i = 0; i < cands.length; i++) {
        if (destroyed) return;
        status(`Trying ${cands.length} candidates (${ups.length} main-mesh repeaters, ${spots.length} spots on high ground)… ${i} done`);
        const c = cands[i];
        const cc = await M.computeCoverage([{ name: 'Candidate', lat: c.lat, lon: c.lon, radio: '' }], elevAt, 'quick', null, pool ? { run: pool.run } : null);
        const got = cc ? candCells(M, shown, cc, pts) : { cells: new Int32Array(0), people: [] };
        c.cells = got.cells; c.people = got.people;
        c.links = M.planLinks({ lat: c.lat, lon: c.lon }, placed, elevAt);
        // goes round a single point of failure: links repeaters on both sides of it
        c.bridges = new Set();
        sides.forEach(({ i: si, name, side }) => {
          const ks = new Set(c.links.filter((l) => l.index !== si && side.has(l.index)).map((l) => side.get(l.index)));
          if (ks.size > 1) c.bridges.add(name);
        });
      }
    } finally {
      if (pool) pool.close();
    }
    if (destroyed) return;
    // names for spots on high ground
    try {
      const named = cands.filter((c) => !c.node);
      if (named.length) {
        const res = await fetch('/api/places/near?' + named.map((c) => 'at=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5)).join('&')).then((r) => r.json());
        named.forEach((c, i) => { c.place = res && res.places && res.places[i]; });
      }
    } catch (_) { /* unnamed */ }
    const baseGrid = { count, water: shown.water || null, cellKm2 };
    let pinLayer = null;
    function draw() {
      const picks = greedy(baseGrid, cands, goal, 5, spofNames);
      $('mmgMoves').innerHTML = picks.map((m, i) => moveHtml(m, i, cands[m.index], goal)).join('') || '<li class="text-muted">Nothing found that adds to the mesh.</li>';
      const tot = picks.reduce((a, m) => ({ people: a.people + m.gain.people, km2: a.km2 + m.gain.km2, closes: a.closes.concat(m.gain.closes) }), { people: 0, km2: 0, closes: [] });
      const left = [...spofNames].filter((x) => !tot.closes.includes(x));
      $('mmgTiles').innerHTML = `<div class="mmg-tile"><div class="mmg-big mmg-accent">+${fmtN(tot.people)}</div><div class="mmg-label">people within reach, all five</div></div>
        <div class="mmg-tile"><div class="mmg-big">+${fmtKm2(tot.km2)} km²</div><div class="mmg-label">land and water</div></div>
        <div class="mmg-tile"><div class="mmg-big">${left.length}</div><div class="mmg-label">single points of failure left (${spofNames.size} today)</div></div>`;
      if (map && L) {
        if (pinLayer) map.removeLayer(pinLayer);
        pinLayer = L.layerGroup().addTo(map);
        picks.forEach((m, i) => {
          const c = cands[m.index];
          L.marker([c.lat, c.lon], { icon: L.divIcon({ className: 'mm-reach-pin', html: `<span>${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }), title: c.node ? repName(c.node) : (c.place || '') }).addTo(pinLayer);
        });
      }
      status(`From ${cands.length} candidates: ${ups.length} main-mesh repeaters heard in the last 3 days, and ${spots.length} spots on high ground.`);
    }
    const onClick = (ev) => {
      const b = ev.target.closest('[data-mmg-goal]');
      if (!b) return;
      goal = b.dataset.mmgGoal;
      app.querySelectorAll('[data-mmg-goal]').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      draw();
    };
    app.addEventListener('click', onClick);
    off = () => app.removeEventListener('click', onClick);
    draw();
  }

  function destroy() {
    destroyed = true;
    if (off) off();
    off = null;
    if (map) map.remove();
    map = null;
  }

  root.MediaMeshGrow = { GOALS, greedy, candCells, upgradeCandidates, moveHtml, init, destroy };
  if (typeof root.registerPage === 'function') root.registerPage('mediamesh-grow', { init, destroy });
})(typeof window !== 'undefined' ? window : globalThis);
