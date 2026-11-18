/* Add-ons to the MediaMesh coverage card (mediamesh-coverage.js calls
 * attach()): "Can I join from here?" for an address or a point, the best
 * spots for a new repeater, coverage counted in people, and the main mesh's
 * coverage side by side with MediaMesh's. They use the card's map, terrain
 * and estimate; the radio sums are mediamesh-coverage.js's. */
'use strict';

(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const C = () => root.MediaMeshCoverage;
  const HEIGHTS = [[1.5, 'Street level, in hand'], [6, '2nd-floor window'], [12, '4th-floor window'], [20, '6th floor or a low roof'], [30, 'High rooftop']];
  const BAND_WORD = { strong: 'Strong', fair: 'Fair', marginal: 'Marginal' };
  const GEOCODER = 'https://nominatim.openstreetmap.org/search';

  function distKm(a, b, c, d) {
    const R = 6371, t = Math.PI / 180;
    const s = Math.sin((c - a) * t / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin((d - b) * t / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function cssColor(name, fallback) {
    const v = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '';
    return /^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback;
  }

  const repName = (r) => String((r && (r.name || (r.public_key || '').slice(0, 8))) || '');
  const fmtDb = (v) => (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '').replace('-', '−');
  const fmtKm = (km) => (km < 10 ? km.toFixed(1) : String(Math.round(km))) + ' km';
  const fmtN = (n) => Math.round(n).toLocaleString();

  // ---- Can I join from here? ------------------------------------------------

  /**
   * Every repeater counted within reach of a point, best first:
   * [{ rep, km, p (pathProfile), margin, band }]. elevAt from the card's
   * terrain; heightM the antenna's height above the ground there.
   */
  function reachFrom(lat, lon, heightM, reps, elevAt, maxKm) {
    const M = C();
    if (!M || !elevAt || !Number.isFinite(elevAt(lat, lon))) return null;
    const out = [];
    (reps || []).forEach((rep) => {
      const km = distKm(lat, lon, rep.lat, rep.lon);
      if (km > (maxKm || 30)) return;
      const p = M.pathProfile(rep, lat, lon, elevAt, 'ground', null, { rxHeightM: heightM });
      if (!p) return;
      out.push({ rep, km, p, margin: p.marginDb, band: M.band(p.marginDb) });
    });
    return out.sort((a, b) => b.margin - a.margin);
  }

  /** The verdict for a reach list: { kind: yes|maybe|no|none, title, text }. */
  function verdict(rows, heightM) {
    if (rows === null) return { kind: 'none', title: 'That\'s outside the area the estimate covers', text: 'Pick a point within about 30 km of a MediaMesh repeater.' };
    const ok = rows.filter((r) => r.margin >= 0);
    const best = rows[0];
    const where = heightM <= 2 ? 'A companion or standalone radio held at street level' : 'A companion or standalone radio by that window';
    if (best && best.margin >= 15) return { kind: 'yes', title: 'Yes, you\'d very likely reach MediaMesh from here', text: `${ok.length} repeater${ok.length === 1 ? '' : 's'} in reach; ${repName(best.rep)} with ${fmtDb(best.margin)} dB to spare. ${where} should work.` };
    if (best && best.margin >= 5) return { kind: 'yes', title: 'Yes, you\'d likely reach MediaMesh from here', text: `${ok.length} repeater${ok.length === 1 ? '' : 's'} in reach; ${repName(best.rep)} with ${fmtDb(best.margin)} dB to spare. ${where} should work, a little better by a window facing it.` };
    if (best && best.margin >= 0) return { kind: 'maybe', title: 'Maybe: just within reach', text: `${repName(best.rep)} with only ${fmtDb(best.margin)} dB to spare. Higher up or outdoors helps; indoors it may not.` };
    if (best) return { kind: 'no', title: 'Not from here yet', text: `The closest call is ${repName(best.rep)}, ${fmtDb(-best.margin)} dB short.` };
    return { kind: 'no', title: 'Not from here yet', text: 'No MediaMesh repeater within 30 km.' };
  }

  /** The lowest height on the list that would reach the best repeater, if higher than now. */
  function heightThatWorks(rows, heightM, elevAt, lat, lon) {
    const M = C();
    if (!rows || !rows.length || rows[0].margin >= 0) return null;
    const cand = rows.slice(0, 3);
    for (const [h, label] of HEIGHTS) {
      if (h <= heightM) continue;
      for (const r of cand) {
        const p = M.pathProfile(r.rep, lat, lon, elevAt, 'ground', null, { rxHeightM: h });
        if (p && p.marginDb >= 0) return { h, label, rep: r.rep };
      }
    }
    return null;
  }

  function joinFormHtml() {
    return `<form class="mm-reach-join" data-mm-join role="search" aria-label="Can I join from here?">
      <label class="mm-reach-title" for="mmJoinQ">Can I join from here?</label>
      <div class="mm-reach-row">
        <input id="mmJoinQ" type="search" class="mm-reach-input" placeholder="An address or place, e.g. 1420 E Pine St" autocomplete="street-address" enterkeyhint="search">
        <select id="mmJoinH" class="mm-reach-select" aria-label="Antenna height">${HEIGHTS.map(([h, l], i) => `<option value="${h}"${i === 2 ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <button type="submit" class="tab-btn active">Check</button>
        <button type="button" class="tab-btn" data-mm-join-pick aria-pressed="false">Pick on the map</button>
      </div>
      <p class="text-muted mm-reach-note">The address is looked up with OpenStreetMap's search; nothing is stored here. Or pick the spot on the map, which sends nothing anywhere.</p>
      <div class="mm-reach-out" id="mmJoinOut" aria-live="polite"></div>
    </form>`;
  }

  function joinResultHtml(place, heightM, rows, v, fix) {
    const hLabel = (HEIGHTS.find(([h]) => h === heightM) || [0, heightM + ' m up'])[1];
    let h = `<div class="mm-reach-verdict mm-reach-verdict--${v.kind}"><strong>${esc(v.title)}</strong><div>${esc(v.text)}</div>`
      + (fix ? `<div class="mm-reach-fix">From a ${esc(fix.label.toLowerCase())} it would reach ${esc(repName(fix.rep))}.</div>` : '') + '</div>';
    h += `<p class="text-muted mm-reach-note">${place ? esc(place) + ' · ' : ''}${esc(hLabel)}</p>`;
    if (rows && rows.length) {
      h += '<table class="analytics-table mm-reach-table"><thead><tr><th scope="col">Repeater</th><th scope="col" class="mm-ins-num">Distance</th><th scope="col" class="mm-ins-num">To spare</th><th scope="col">Path</th></tr></thead><tbody>'
        + rows.slice(0, 6).map((r) => `<tr><td><span class="mm-reach-dot mm-reach-dot--${r.band || 'none'}"></span>${esc(repName(r.rep))}</td><td class="mm-ins-num">${fmtKm(r.km)}</td>
          <td class="mm-ins-num mm-reach-db--${r.band || 'none'}">${r.margin >= 0 ? '+' + fmtDb(r.margin) : '−' + fmtDb(-r.margin)}</td>
          <td>${r.band ? BAND_WORD[r.band] + ', ' : 'Short, '}${r.p.fresnelClear ? 'clear line of sight' : r.p.lineOfSight ? 'line of sight, ground close' : 'over higher ground'}</td></tr>`).join('')
        + '</tbody></table>';
    }
    return h;
  }

  // ---- Coverage in people ----------------------------------------------------

  /** People in covered cells: { reached, total, byPlace {place: [reached, total]} }. */
  function peopleIn(cov, points, keep) {
    const M = C();
    const out = { reached: 0, total: 0, byPlace: {} };
    if (!cov) return out;
    const b = cov.bounds;
    points.forEach((pt) => {
      const [lat, lon, n, place] = pt;
      if (lat < b.south || lat > b.north || lon < b.west || lon > b.east) return;
      const cell = M.cellAt(cov, lat, lon);
      const hit = keep ? keep(lat, lon) : !!(cell && cell.margin >= 0);
      out.total += n;
      if (hit) out.reached += n;
      const k = place || '';
      const e = out.byPlace[k] || (out.byPlace[k] = [0, 0]);
      if (hit) e[0] += n;
      e[1] += n;
    });
    return out;
  }

  /** "Capitol Hill, Seattle" -> { city: 'Seattle', hood: 'Capitol Hill' }; "Bellevue, WA" -> { city: 'Bellevue' }. */
  function splitPlace(p) {
    const s = String(p || '');
    if (/ km from /.test(s) || !s) return { city: '' };
    const i = s.lastIndexOf(', ');
    if (i < 0) return { city: s };
    const tail = s.slice(i + 2);
    return /^[A-Z]{2}$/.test(tail) ? { city: s.slice(0, i) } : { city: tail, hood: s.slice(0, i) };
  }

  /** People reached when only the repeaters `mask` allows count (from the
   * per-repeater rasters, so the time-lapse's past can be counted). */
  function peopleWith(cov, points, mask) {
    const rasters = cov.rasters || [];
    const ch = (cov.bounds.north - cov.bounds.south) / cov.height, cw = (cov.bounds.east - cov.bounds.west) / cov.width;
    let n = 0;
    points.forEach(([lat, lon, people]) => {
      const row = Math.floor((cov.bounds.north - lat) / ch), col = Math.floor((lon - cov.bounds.west) / cw);
      if (row < 0 || col < 0 || row >= cov.height || col >= cov.width) return;
      for (let ri = 0; ri < rasters.length; ri++) {
        const r = rasters[ri];
        if (!r || !r.data || (mask && !mask[ri])) continue;
        const y = row - r.row0, x = col - r.col0;
        if (y < 0 || x < 0 || y >= r.h || x >= r.w) continue;
        const t = r.data[y * r.w + x];
        if (t !== -32768 && t >= 0) { n += people; return; }
      }
    });
    return n;
  }

  function peopleHtml(s, monthAgo) {
    const sea = s.cities.find((c) => c.city === 'Seattle');
    const tiles = `<div class="mm-ins-tiles">
      ${sea ? `<div class="mm-ins-tile"><div class="mm-ins-big mm-ins-accent">${Math.round((sea.reached / sea.total) * 100)}%</div><div class="mm-ins-label">of Seattle residents · about ${fmtN(Math.round(sea.reached / 1000) * 1000)} of ${fmtN(Math.round(sea.total / 1000) * 1000)}</div></div>` : ''}
      <div class="mm-ins-tile"><div class="mm-ins-big">${fmtN(s.reached)}</div><div class="mm-ins-label">people within reach, all told</div></div>
      ${monthAgo !== null ? `<div class="mm-ins-tile"><div class="mm-ins-big">${s.reached - monthAgo >= 0 ? '+' : '−'}${fmtN(Math.abs(s.reached - monthAgo))}</div><div class="mm-ins-label">people in the last 30 days, from new repeaters</div></div>` : ''}
    </div>`;
    const bars = s.cities.slice(0, 8).map((c) => {
      const p = Math.round((c.reached / c.total) * 100);
      return `<div class="mm-ins-bar-row mm-reach-bar"><span>${esc(c.city)}</span><span class="mm-ins-bar"><i style="width:${p}%"></i></span><span class="mm-ins-num">${p}%</span><span class="text-muted mm-ins-n">${fmtN(c.total / 1000)}k</span></div>`;
    }).join('');
    const least = s.hoods.filter((h) => h.total >= 2000).sort((a, b) => a.reached / a.total - b.reached / b.total || b.total - a.total).slice(0, 6);
    const leastHtml = least.length ? `<h4>Seattle neighbourhoods least covered</h4><ul class="mm-reach-least">${least.map((h) => `<li>${esc(h.hood)} <span class="text-muted">${Math.round((h.reached / h.total) * 100)}% of ${fmtN(h.total)}</span></li>`).join('')}</ul>` : '';
    return `<h3>How many people MediaMesh reaches</h3><p class="text-muted mm-ins-sub">The coverage estimate for people on the ground, weighted by where people live: 2020 Census block groups (600 to 3,000 people each), counted by their centre of population.</p>
      ${tiles}<div class="mm-ins-split"><div class="mm-ins-col"><h4>By place, within the estimate's area</h4>${bars}${leastHtml}</div>
      <div class="mm-ins-col mm-ins-wide"><div class="mm-ins-map" id="mmPeopleMap" role="img" aria-label="Where people live, reached or not"></div>
      <p class="text-muted mm-ins-key"><span class="mm-reach-dot mm-reach-dot--mm"></span>reached · <span class="mm-reach-dot mm-reach-dot--none"></span>not yet · dot size: people</p></div></div>
      <p class="text-muted mm-ins-key">Same model as the coverage map, so the same caveats: bare terrain, and street level among buildings is worse.</p>`;
  }

  /** People per city and Seattle neighbourhood from peopleIn's byPlace. */
  function peopleSummary(p) {
    const cities = {}, hoods = {};
    Object.keys(p.byPlace).forEach((k) => {
      const [r, t] = p.byPlace[k];
      const { city, hood } = splitPlace(k);
      if (!city) return;
      const c = cities[city] || (cities[city] = { city, reached: 0, total: 0 });
      c.reached += r; c.total += t;
      if (city === 'Seattle' && hood) {
        const h = hoods[hood] || (hoods[hood] = { hood, reached: 0, total: 0 });
        h.reached += r; h.total += t;
      }
    });
    const list = Object.values(cities).sort((a, b) => (b.city === 'Seattle') - (a.city === 'Seattle') || b.total - a.total);
    return { reached: p.reached, total: p.total, cities: list, hoods: Object.values(hoods) };
  }

  // ---- Best spots for a new repeater ------------------------------------------

  /**
   * High ground worth trying: in a grid of `stepKm` cells over the box, each
   * cell's highest point, kept when it stands above the ground 2 km around
   * and isn't water; at most `max`, the most prominent first, `sepKm` apart.
   */
  function candidateSpots(box, elevAt, opts) {
    const o = Object.assign({ stepKm: 1, sepKm: 1.5, max: 40 }, opts || {});
    const kLat = 1 / 111.32, midLat = (box.south + box.north) / 2, kLon = 1 / (111.32 * Math.cos(midLat * Math.PI / 180));
    const out = [];
    for (let lat = box.south + o.stepKm * kLat / 2; lat < box.north; lat += o.stepKm * kLat) {
      for (let lon = box.west + o.stepKm * kLon / 2; lon < box.east; lon += o.stepKm * kLon) {
        let best = null;
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            const la = lat + i * o.stepKm * kLat / 3, lo = lon + j * o.stepKm * kLon / 3, e = elevAt(la, lo);
            if (Number.isFinite(e) && (!best || e > best.e)) best = { lat: la, lon: lo, e };
          }
        }
        if (!best || best.e < 5) continue;
        let sum = 0, n = 0;
        for (let a = 0; a < 8; a++) {
          const e = elevAt(best.lat + 2 * kLat * Math.cos(a * Math.PI / 4), best.lon + 2 * kLon * Math.sin(a * Math.PI / 4));
          if (Number.isFinite(e)) { sum += Math.max(0, e); n++; }
        }
        if (n < 4) continue;
        best.prominence = best.e - sum / n;
        if (best.prominence > 0) out.push(best);
      }
    }
    out.sort((a, b) => b.prominence - a.prominence);
    const kept = [];
    for (const c of out) {
      if (kept.every((k) => distKm(k.lat, k.lon, c.lat, c.lon) >= o.sepKm)) kept.push(c);
      if (kept.length >= o.max) break;
    }
    return kept;
  }

  /** What a spot adds: new land km² and people, from its quick coverage. */
  function spotGain(spotCov, shown, points) {
    const M = C();
    let cells = 0;
    const b = spotCov.bounds;
    const area = M.cellAreaKm2(spotCov);
    for (let row = 0, i = 0; row < spotCov.height; row++) {
      for (let col = 0; col < spotCov.width; col++, i++) {
        if (!(spotCov.margins[i] >= 0) || (spotCov.water && spotCov.water[i])) continue;
        const ll = M.cellCenter(spotCov, col, row);
        const c = M.cellAt(shown, ll[0], ll[1]);
        if (!(c && c.margin >= 0)) cells++;
      }
    }
    let people = 0;
    (points || []).forEach(([lat, lon, n]) => {
      if (lat < b.south || lat > b.north || lon < b.west || lon > b.east) return;
      const mine = M.cellAt(spotCov, lat, lon), old = M.cellAt(shown, lat, lon);
      if (mine && mine.margin >= 0 && !(old && old.margin >= 0)) people += n;
    });
    return { km2: cells * area, people };
  }

  // ---- attach -------------------------------------------------------------------

  let popPromise = null;
  function population(api) {
    if (!popPromise) {
      popPromise = Promise.resolve(api('/places/population', { ttl: 3600000 })).then((d) => (d && d.points) || []).catch(() => { popPromise = null; return []; });
    }
    return popPromise;
  }

  /**
   * Called by the coverage card with its map and estimate (see init in
   * mediamesh-coverage.js). Returns a cleanup function.
   */
  function attach(card, h) {
    const L = h.L, map = h.map, M = C();
    const api = root.api;
    if (!L || !map || !M) return () => {};
    const cleanup = [];
    const layer = L.layerGroup().addTo(map);
    cleanup.push(() => map.removeLayer(layer));

    // UI on the card: the address check above the map, the buttons with the
    // others, the panels under the map.
    const reps = card.querySelector('#mmCovReps');
    const holder = document.createElement('div');
    holder.innerHTML = joinFormHtml();
    const form = holder.firstElementChild;
    if (reps) reps.parentNode.insertBefore(form, reps);
    const toggle = card.querySelector('.mm-cov-toggle');
    const bestBtn = document.createElement('button');
    bestBtn.type = 'button'; bestBtn.className = 'tab-btn'; bestBtn.dataset.mmReachBest = ''; bestBtn.textContent = 'Best spots';
    bestBtn.setAttribute('aria-pressed', 'false'); bestBtn.title = 'Where a new repeater would help most';
    const cmpBtn = document.createElement('button');
    cmpBtn.type = 'button'; cmpBtn.className = 'tab-btn'; cmpBtn.dataset.mmReachCompare = ''; cmpBtn.textContent = 'Main mesh vs MediaMesh';
    cmpBtn.setAttribute('aria-pressed', 'false');
    if (toggle) { toggle.appendChild(bestBtn); toggle.appendChild(cmpBtn); }
    const plan = card.querySelector('#mmCovPlan');
    const bestEl = document.createElement('div'); bestEl.className = 'mm-reach-panel'; bestEl.id = 'mmBest'; bestEl.hidden = true; bestEl.setAttribute('aria-live', 'polite');
    const cmpEl = document.createElement('div'); cmpEl.className = 'mm-reach-panel'; cmpEl.id = 'mmCompare'; cmpEl.hidden = true; cmpEl.setAttribute('aria-live', 'polite');
    if (plan) { plan.after(cmpEl); plan.after(bestEl); }
    cleanup.push(() => { form.remove(); bestBtn.remove(); cmpBtn.remove(); bestEl.remove(); cmpEl.remove(); });
    const out = form.querySelector('#mmJoinOut');
    const pickBtn = form.querySelector('[data-mm-join-pick]');
    const colors = () => ({ strong: cssColor('--status-green', '#16a34a'), fair: cssColor('--status-green', '#16a34a'), marginal: cssColor('--status-amber', '#d97706'), none: cssColor('--status-red', '#dc2626') });

    // -- Can I join from here?
    let token = 0;
    async function check(lat, lon, place) {
      const my = ++token;
      const heightM = Number(form.querySelector('#mmJoinH').value) || 12;
      const elevAt = h.terrain();
      if (!elevAt) { out.innerHTML = '<p class="text-muted">Waiting for the coverage estimate to finish…</p>'; h.onShown(() => { if (my === token) check(lat, lon, place); }); return; }
      const rows = reachFrom(lat, lon, heightM, h.counted(), elevAt);
      const v = verdict(rows, heightM);
      const fix = rows ? heightThatWorks(rows, heightM, elevAt, lat, lon) : null;
      if (!place && api) {
        try { const n = await api('/places/near?at=' + lat.toFixed(5) + ',' + lon.toFixed(5), { ttl: 600000 }); place = n && n.places && n.places[0]; } catch (_) { /* unnamed */ }
        if (my !== token) return;
      }
      out.innerHTML = joinResultHtml(place, heightM, rows, v, fix);
      layer.clearLayers();
      const col = colors();
      const casing = cssColor('--card-bg', '#ffffff');
      (rows || []).slice(0, 6).reverse().forEach((r) => {
        L.polyline([[lat, lon], [r.rep.lat, r.rep.lon]], { color: casing, weight: r.band ? 7 : 5, opacity: 0.9, interactive: false }).addTo(layer);
        L.polyline([[lat, lon], [r.rep.lat, r.rep.lon]], { color: col[r.band || 'none'], weight: r.band ? 4 : 2.5, opacity: 1, dashArray: r.band ? null : '6 5', interactive: false }).addTo(layer);
      });
      L.circleMarker([lat, lon], { radius: 8, weight: 3, color: '#ffffff', fillColor: cssColor('--accent', '#2563eb'), fillOpacity: 1 }).bindTooltip('Here').addTo(layer);
      const pts = [[lat, lon]].concat((rows || []).slice(0, 4).map((r) => [r.rep.lat, r.rep.lon]));
      map.fitBounds(L.latLngBounds(pts).pad(0.25));
      if (rows && rows.length && M.profileHtml) {
        const prof = document.createElement('details');
        prof.className = 'mm-reach-prof mm-cov-details';
        prof.innerHTML = `<summary>Terrain profile to ${esc(repName(rows[0].rep))}</summary>` + M.profileHtml(rows[0].p, rows[0].rep);
        prof.querySelectorAll('[data-mm-cov-close]').forEach((b) => b.remove());
        out.appendChild(prof);
      }
    }
    const onSubmit = async (e) => {
      e.preventDefault();
      const q = form.querySelector('#mmJoinQ').value.trim();
      if (!q) return;
      out.innerHTML = '<p class="text-muted">Looking it up…</p>';
      const b = map.getBounds().pad(1);
      const url = `${GEOCODER}?format=jsonv2&limit=1&countrycodes=us,ca&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}&q=${encodeURIComponent(q)}`;
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        const hits = res.ok ? await res.json() : [];
        if (!hits.length) { out.innerHTML = '<p class="text-muted">Couldn\'t find that. Try a street address with the city, or pick the spot on the map.</p>'; return; }
        check(Number(hits[0].lat), Number(hits[0].lon), hits[0].display_name.split(',').slice(0, 3).join(','));
      } catch (_) {
        out.innerHTML = '<p class="text-muted">The address search isn\'t answering. Pick the spot on the map instead.</p>';
      }
    };
    const onPick = () => {
      const on = pickBtn.getAttribute('aria-pressed') !== 'true';
      pickBtn.setAttribute('aria-pressed', String(on));
      pickBtn.classList.toggle('active', on);
      pickBtn.textContent = on ? 'Click the map…' : 'Pick on the map';
      h.pick(on ? (ll) => { pickBtn.setAttribute('aria-pressed', 'false'); pickBtn.classList.remove('active'); pickBtn.textContent = 'Pick on the map'; check(ll.lat, ll.lng, null); } : null);
    };
    form.addEventListener('submit', onSubmit);
    pickBtn.addEventListener('click', onPick);
    cleanup.push(() => { form.removeEventListener('submit', onSubmit); pickBtn.removeEventListener('click', onPick); });

    // -- Coverage in people
    const peopleCard = document.getElementById('mmPeopleCard');
    let peopleMap = null;
    if (peopleCard && api) {
      h.onShown(async (shown) => {
        if (!shown || shown.modeKey !== 'ground') return;
        const pts = await population(api);
        if (!pts.length || h.shown() !== shown) return;
        const p = peopleSummary(peopleIn(shown, pts));
        let monthAgo = null;
        const firstSeen = shown.reps.map((r) => r.first_seen || '');
        if (firstSeen.some(Boolean) && M.presentAt) {
          const was = M.presentAt(firstSeen, Date.now() - 30 * 86400000);
          const on = shown.enabled || shown.reps.map(() => true);
          monthAgo = peopleWith(shown, pts.filter(([la, lo]) => la >= shown.bounds.south && la <= shown.bounds.north && lo >= shown.bounds.west && lo <= shown.bounds.east), on.map((x, i) => x && was[i]));
        }
        peopleCard.hidden = false;
        peopleCard.innerHTML = peopleHtml(p, monthAgo);
        if (peopleMap) { peopleMap.remove(); peopleMap = null; }
        const box = peopleCard.querySelector('#mmPeopleMap');
        if (box) {
          peopleMap = L.map(box, { zoomControl: true, scrollWheelZoom: false });
          const tileUrl = typeof root.getTileUrl === 'function' ? root.getTileUrl() : null;
          if (tileUrl) L.tileLayer(tileUrl, { maxZoom: 18 }).addTo(peopleMap);
          const reached = cssColor('--mediamesh-node-color', '#d946ef'), not = cssColor('--text-muted', '#6b7280');
          const b = shown.bounds, inside = pts.filter(([la, lo]) => la >= b.south && la <= b.north && lo >= b.west && lo <= b.east);
          const canvas = L.canvas({ padding: 0.2 });
          inside.forEach(([la, lo, n]) => {
            const c = M.cellAt(shown, la, lo), hit = c && c.margin >= 0;
            L.circleMarker([la, lo], { renderer: canvas, radius: Math.max(1.5, Math.sqrt(n) / 12), stroke: false, fillColor: hit ? reached : not, fillOpacity: hit ? 0.75 : 0.45, interactive: false }).addTo(peopleMap);
          });
          peopleMap.fitBounds(L.latLngBounds(h.counted().map((r) => [r.lat, r.lon])).pad(0.6));
        }
        if (typeof h.onStats === 'function') h.onStats(p);
      });
      cleanup.push(() => { if (peopleMap) peopleMap.remove(); });
    }

    // -- Best spots
    let bestRun = 0, bestMetric = 'people', bestResults = null;
    const bestLayer = L.layerGroup().addTo(map);
    cleanup.push(() => map.removeLayer(bestLayer));
    function bestHtml(state) {
      const tabs = `<div class="mm-ins-toggle" role="group" aria-label="Rank by">${[['people', 'Most people'], ['area', 'Most area'], ['weak', 'Fix weak spots']].map(([k, l]) => `<button type="button" class="tab-btn${k === bestMetric ? ' active' : ''}" data-mm-best-metric="${k}" aria-pressed="${k === bestMetric}">${l}</button>`).join('')}</div>`;
      if (state.busy) return `<h4>Where a new repeater would help most</h4>${tabs}<p class="text-muted">${esc(state.busy)}</p>`;
      const list = state.list.map((c, i) => `<div class="mm-reach-spot"><span class="mm-reach-num">${i + 1}</span><div class="mm-reach-spot-body"><strong>${esc(c.place || (c.lat.toFixed(4) + ', ' + c.lon.toFixed(4)))}</strong>
        <div class="text-muted">+${fmtN(c.km2)} km² · +${fmtN(c.people)} people · hears ${c.links} repeater${c.links === 1 ? '' : 's'}${bestMetric === 'weak' && c.bridges ? ' · links both sides of a weak spot' : ''} · ground ${Math.round(c.e)} m</div></div>
        <button type="button" class="tab-btn" data-mm-best-plan="${i}">Plan it</button></div>`).join('');
      return `<h4>Where a new repeater would help most</h4>${tabs}${list || '<p class="text-muted">Nothing found that adds coverage.</p>'}
        <p class="text-muted mm-reach-note">Searched ${state.searched} spots on high ground, with a 10 m mast and the quick estimate (20 km out). Rooftops change everything, so treat these as places to ask around. "Plan it" puts one on the map as a planned repeater, ready to move.</p>`;
    }
    function rankBest() {
      if (!bestResults) return [];
      const key = bestMetric === 'area' ? (c) => c.km2 : bestMetric === 'weak' ? (c) => (c.bridges ? 1e9 : 0) + c.people : (c) => c.people;
      // three different places, not three corners of one hill
      const out = [];
      for (const c of bestResults.slice().sort((a, b) => key(b) - key(a))) {
        if (out.every((o) => distKm(o.lat, o.lon, c.lat, c.lon) >= 3)) out.push(c);
        if (out.length === 3) break;
      }
      return out;
    }
    function drawBest() {
      const list = rankBest();
      bestEl.innerHTML = bestHtml({ list, searched: bestResults ? bestResults.searched : 0 });
      bestLayer.clearLayers();
      list.forEach((c, i) => {
        L.marker([c.lat, c.lon], { icon: L.divIcon({ className: 'mm-reach-pin', html: `<span>${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }), title: c.place || '' }).addTo(bestLayer);
      });
    }
    async function findBest() {
      const my = ++bestRun;
      const shown = h.shown(), elevAt = h.terrain();
      if (!shown || !elevAt || shown.modeKey !== 'ground') { bestEl.innerHTML = bestHtml({ busy: 'Show "People on the ground" first, and let the estimate finish.' }); return; }
      const reps = h.counted();
      let s = 90, n = -90, w = 180, e = -180;
      reps.forEach((r) => { s = Math.min(s, r.lat); n = Math.max(n, r.lat); w = Math.min(w, r.lon); e = Math.max(e, r.lon); });
      const pad = 8 / 111.32, padL = pad / Math.cos(((s + n) / 2) * Math.PI / 180);
      const spots = candidateSpots({ south: s - pad, north: n + pad, west: w - padL, east: e + padL }, elevAt, { max: 36 });
      bestEl.innerHTML = bestHtml({ busy: `Trying ${spots.length} spots on high ground…` });
      const pts = api ? await population(api) : [];
      const pool = M.workerPool ? M.workerPool() : null;
      const ws = root.MediaMeshInsights ? root.MediaMeshInsights.weakSpots(h.backbone || []) : null;
      const sides = ws && (ws.cuts[0] || ws.bridges[0]) ? new Set((ws.cuts[0] || ws.bridges[0]).cutOffKeys) : null;
      const cutKey = ws && ws.cuts[0] ? ws.cuts[0].key : null;
      const results = [];
      try {
        for (let i = 0; i < spots.length; i++) {
          if (my !== bestRun) return;
          const sp = spots[i];
          const cov = await M.computeCoverage([{ name: 'Spot', lat: sp.lat, lon: sp.lon, radio: '' }], elevAt, 'quick', null, pool ? { run: pool.run } : null);
          if (!cov) continue;
          const g = spotGain(cov, shown, pts);
          const links = M.planLinks({ lat: sp.lat, lon: sp.lon }, reps, elevAt);
          let bridges = false;
          if (sides) {
            const keys = links.map((l) => String(l.rep.public_key || '').toLowerCase()).filter((k) => k && k !== cutKey);
            bridges = keys.some((k) => sides.has(k)) && keys.some((k) => !sides.has(k));
          }
          results.push(Object.assign({}, sp, g, { links: links.length, bridges }));
          if (i % 4 === 3) bestEl.innerHTML = bestHtml({ busy: `Trying ${spots.length} spots on high ground… ${i + 1} done` });
        }
      } finally {
        if (pool) pool.close();
      }
      if (my !== bestRun) return;
      results.searched = spots.length;
      bestResults = results;
      // names for the ones shown
      const top = new Set([].concat(...['people', 'area', 'weak'].map((m) => { bestMetric = m; return rankBest(); })));
      bestMetric = 'people';
      if (api && top.size) {
        try {
          const list = Array.from(top);
          const res = await api('/places/near?' + list.map((c) => 'at=' + c.lat.toFixed(5) + ',' + c.lon.toFixed(5)).join('&'), { ttl: 600000 });
          list.forEach((c, i) => { c.place = res && res.places && res.places[i]; });
        } catch (_) { /* unnamed */ }
      }
      if (my !== bestRun) return;
      drawBest();
    }
    const onBestClick = (e) => {
      const m = e.target.closest('[data-mm-best-metric]');
      if (m) { bestMetric = m.dataset.mmBestMetric; if (bestResults) drawBest(); return; }
      const pl = e.target.closest('[data-mm-best-plan]');
      if (pl) { const c = rankBest()[Number(pl.dataset.mmBestPlan)]; if (c) h.plan(c.lat, c.lon); }
    };
    const onBestBtn = () => {
      const on = bestEl.hidden;
      bestEl.hidden = !on;
      bestBtn.classList.toggle('active', on);
      bestBtn.setAttribute('aria-pressed', String(on));
      if (!on) { bestRun++; bestLayer.clearLayers(); return; }
      if (bestResults) drawBest(); else findBest();
    };
    bestEl.addEventListener('click', onBestClick);
    bestBtn.addEventListener('click', onBestBtn);
    cleanup.push(() => { bestRun++; bestEl.removeEventListener('click', onBestClick); bestBtn.removeEventListener('click', onBestBtn); });

    // -- Main mesh vs MediaMesh
    let cmp = null; // { cov, overlay, gaps, mode }
    const mainPane = map.createPane('mmMain');
    mainPane.style.zIndex = 440;
    const divider = document.createElement('div');
    divider.className = 'mm-reach-divider';
    divider.hidden = true;
    divider.innerHTML = '<span class="mm-reach-handle" role="slider" tabindex="0" aria-label="Divider between the main mesh (left) and MediaMesh (right)" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">⟷</span>';
    h.mapEl.appendChild(divider);
    cleanup.push(() => divider.remove());
    let split = 0.5;
    function clipPanes() {
      const mmPane = map.getPane('mmCoverage');
      if (!cmp || cmp.mode !== 'swipe') {
        mainPane.style.clip = ''; if (mmPane) mmPane.style.clip = '';
        return;
      }
      const size = map.getSize(), nw = map.containerPointToLayerPoint([0, 0]), se = map.containerPointToLayerPoint(size);
      const x = nw.x + size.x * split;
      mainPane.style.clip = `rect(${nw.y}px, ${x}px, ${se.y}px, ${nw.x}px)`;
      if (mmPane) mmPane.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
      divider.style.left = (split * 100) + '%';
      divider.querySelector('[role="slider"]').setAttribute('aria-valuenow', String(Math.round(split * 100)));
    }
    map.on('move zoom resize', clipPanes);
    cleanup.push(() => { map.off('move zoom resize', clipPanes); const p = map.getPane('mmCoverage'); if (p) p.style.clip = ''; });
    let dragging = false;
    const onDown = (e) => { dragging = true; divider.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); };
    const onMove = (e) => {
      if (!dragging) return;
      const r = h.mapEl.getBoundingClientRect();
      split = Math.max(0.02, Math.min(0.98, (e.clientX - r.left) / r.width));
      clipPanes();
    };
    const onUp = () => { dragging = false; };
    const onKey = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { split = Math.max(0.02, Math.min(0.98, split + (e.key === 'ArrowLeft' ? -0.05 : 0.05))); clipPanes(); e.preventDefault(); }
    };
    divider.addEventListener('pointerdown', onDown);
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp);
    divider.addEventListener('keydown', onKey);
    ['click', 'dblclick', 'mousedown', 'wheel'].forEach((ev) => divider.addEventListener(ev, (e) => e.stopPropagation()));
    const mainRgb = () => { const hex = cssColor('--accent', '#2563eb').replace('#', ''); const f = hex.length === 3 ? hex.split('').map((x) => x + x).join('') : hex; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); };
    function drawCompare() {
      if (cmp.overlay) { map.removeLayer(cmp.overlay); cmp.overlay = null; }
      const shown = h.shown(), cov = cmp.cov, b = cov.bounds;
      const keep = cmp.mode === 'gaps' ? (i) => {
        if (cov.water && cov.water[i]) return false;
        const row = Math.floor(i / cov.width), col = i % cov.width, ll = M.cellCenter(cov, col, row);
        const c = shown && M.cellAt(shown, ll[0], ll[1]);
        return !(c && c.margin >= 0);
      } : null;
      cmp.overlay = (M.canvasOverlay ? M.canvasOverlay(L, M.coverageCanvas(cov, mainRgb(), keep), [[b.south, b.west], [b.north, b.east]], { pane: 'mmMain', opacity: 0.85, className: 'mm-cov-overlay' }) : L.imageOverlay(M.coverageImage(cov, mainRgb(), keep), [[b.south, b.west], [b.north, b.east]], { pane: 'mmMain', opacity: 0.85, className: 'mm-cov-overlay' })).addTo(map);
      const mmPane = map.getPane('mmCoverage');
      if (mmPane) mmPane.style.visibility = cmp.mode === 'gaps' ? 'hidden' : '';
      divider.hidden = cmp.mode !== 'swipe';
      clipPanes();
      const mmKm = shown ? M.unionKm2(shown) : 0;
      cmpEl.innerHTML = `<div class="mm-ins-head"><div><h4>Where photos and voice can't reach yet</h4><p class="text-muted mm-reach-note">${cmp.mode === 'swipe' ? 'Drag the divider: the main mesh\'s coverage on the left, MediaMesh\'s on the right.' : 'Only where the main mesh reaches people on the ground and MediaMesh doesn\'t: where a new MediaMesh repeater would do the most.'}</p></div>
        <div class="mm-ins-toggle" role="group" aria-label="Comparison">${[['swipe', 'Swipe'], ['gaps', 'Gaps only']].map(([k, l]) => `<button type="button" class="tab-btn${cmp.mode === k ? ' active' : ''}" data-mm-cmp="${k}" aria-pressed="${cmp.mode === k}">${l}</button>`).join('')}</div></div>
        <div class="mm-reach-legend"><span><span class="mm-reach-sw mm-reach-sw--main"></span>Main mesh: ${fmtN(cmp.km2)} km² from ${cmp.n} repeaters (quick estimate, ${esc(cmp.radio)})</span><span><span class="mm-reach-sw mm-reach-sw--mm"></span>MediaMesh: ${fmtN(mmKm)} km²</span>${cmp.gapKm2 != null ? `<span>Gaps: ${fmtN(cmp.gapKm2)} km²</span>` : ''}</div>`;
    }
    async function startCompare() {
      if (cmp && cmp.cov) { drawCompare(); return; }
      cmpEl.innerHTML = '<p class="text-muted">Loading the main mesh\'s repeaters…</p>';
      let nodes = [];
      try {
        const d = await api('/nodes?limit=5000', { ttl: 300000 });
        nodes = (d && (d.nodes || d)) || [];
      } catch (_) { cmpEl.innerHTML = '<p class="text-muted">Couldn\'t load the main mesh\'s repeaters.</p>'; return; }
      const shown = h.shown();
      const b = shown ? shown.bounds : null;
      const reps = (Array.isArray(nodes) ? nodes : []).filter((n) => /repeater/i.test(n.role || '') && Number.isFinite(n.lat) && Number.isFinite(n.lon) && !(n.lat === 0 && n.lon === 0)
        && (!b || (n.lat > b.south && n.lat < b.north && n.lon > b.west && n.lon < b.east)))
        .map((n) => ({ name: n.name, lat: n.lat, lon: n.lon, radio: M.CONFIG.mainRadio }));
      if (!reps.length) { cmpEl.innerHTML = '<p class="text-muted">No main-mesh repeaters with a position in this area.</p>'; return; }
      cmpEl.innerHTML = `<p class="text-muted">Loading terrain for ${reps.length} main-mesh repeaters…</p>`;
      const pool = M.workerPool ? M.workerPool() : null;
      try {
        const terrain = await M.loadTerrainLevels(M.terrainPlan(reps, M.CONFIG.modes.quick), h.loader);
        const cov = await M.computeCoverage(reps, terrain.elevAt, 'quick', (done, total) => {
          cmpEl.innerHTML = `<p class="text-muted">Working out the main mesh's coverage… ${done} of ${total} repeaters</p>`;
        }, pool ? { run: pool.run } : null);
        if (!cov) return;
        let gapCells = 0;
        if (shown) {
          for (let row = 0, i = 0; row < cov.height; row++) {
            for (let col = 0; col < cov.width; col++, i++) {
              if (!(cov.margins[i] >= 0) || (cov.water && cov.water[i])) continue;
              const ll = M.cellCenter(cov, col, row), c = M.cellAt(shown, ll[0], ll[1]);
              if (!(c && c.margin >= 0)) gapCells++;
            }
          }
        }
        cmp = Object.assign(cmp || {}, { cov, n: reps.length, km2: M.unionKm2(cov), gapKm2: shown ? gapCells * M.cellAreaKm2(cov) : null,
          radio: (M.parseRadio(M.CONFIG.mainRadio) || {}).bwKHz + ' kHz SF' + (M.parseRadio(M.CONFIG.mainRadio) || {}).sf });
        if (cmpBtn.getAttribute('aria-pressed') === 'true') drawCompare();
      } catch (_) {
        cmpEl.innerHTML = '<p class="text-muted">Couldn\'t work out the main mesh\'s coverage.</p>';
      } finally {
        if (pool) pool.close();
      }
    }
    function stopCompare() {
      if (cmp && cmp.overlay) { map.removeLayer(cmp.overlay); cmp.overlay = null; }
      divider.hidden = true;
      const mmPane = map.getPane('mmCoverage');
      if (mmPane) { mmPane.style.visibility = ''; mmPane.style.clip = ''; }
      mainPane.style.clip = '';
    }
    const onCmpBtn = () => {
      const on = cmpEl.hidden;
      cmpEl.hidden = !on;
      cmpBtn.classList.toggle('active', on);
      cmpBtn.setAttribute('aria-pressed', String(on));
      if (on) { cmp = cmp || { mode: 'swipe' }; startCompare(); } else stopCompare();
    };
    const onCmpClick = (e) => {
      const m = e.target.closest('[data-mm-cmp]');
      if (m && cmp && cmp.cov) { cmp.mode = m.dataset.mmCmp; drawCompare(); }
    };
    cmpBtn.addEventListener('click', onCmpBtn);
    cmpEl.addEventListener('click', onCmpClick);
    cleanup.push(() => { stopCompare(); cmpBtn.removeEventListener('click', onCmpBtn); cmpEl.removeEventListener('click', onCmpClick); });

    return () => { cleanup.reverse().forEach((f) => { try { f(); } catch (_) { /* gone */ } }); };
  }

  root.MediaMeshReach = { attach, reachFrom, verdict, heightThatWorks, peopleIn, peopleSummary, peopleWith, splitPlace, candidateSpots, spotGain, HEIGHTS, joinResultHtml, peopleHtml };
})(typeof window !== 'undefined' ? window : globalThis);
