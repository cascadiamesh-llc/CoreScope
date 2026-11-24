/* MediaMesh on an observer's page: when the observer listens to MediaMesh
 * (its status says radio2 is on) or has heard MediaMesh packets, what it
 * listens on, how much of what it hears is MediaMesh, who it hears straight
 * on radio2 (a table and a map), and its own MediaMesh repeater card
 * (mediamesh-node.js) when it is one. Fills a hidden element (observer-
 * detail.js) from /api/analytics/mediamesh for the page's time range, and
 * stays hidden for an observer with nothing to do with MediaMesh. */
'use strict';

(function (root) {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const fmtN = (n) => Number(n || 0).toLocaleString();
  const db = (v) => (Number.isFinite(v) ? (v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' dB' : '—');
  const dbm = (v) => (Number.isFinite(v) ? (v < 0 ? '−' : '') + Math.abs(Math.round(v)) + ' dBm' : '—');

  function distKm(a, b, c, d) {
    const t = Math.PI / 180, s = Math.sin((c - a) * t / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin((d - b) * t / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(s));
  }

  function ago(t, now) {
    const ms = now - Date.parse(t);
    if (!Number.isFinite(ms)) return '—';
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.round(ms / 60000) + ' min ago';
    if (ms < 172800000) return Math.round(ms / 3600000) + ' h ago';
    return Math.round(ms / 86400000) + ' days ago';
  }

  /** "911.15,250,7,5" → "911.150 MHz · SF7 · BW 250 kHz". */
  function radioText(r) {
    const p = String(r || '').split(',');
    const f = Number(p[0]), bw = Number(p[1]), sf = Number(p[2]);
    if (!Number.isFinite(f) || !Number.isFinite(bw) || !Number.isFinite(sf)) return '';
    return `${f.toFixed(3)} MHz · SF${sf} · BW ${bw} kHz`;
  }

  /** The observer's radio2 setting: its latest radio2 stretch in the radio
   * history, else what it reports as a MediaMesh repeater. */
  function radio2Of(obs, rep) {
    const hist = (obs && Array.isArray(obs.radio_history) ? obs.radio_history : []).filter((h) => h && h.radio_id === 'radio2');
    hist.sort((a, b) => String(b.last_seen || '').localeCompare(String(a.last_seen || '')));
    return (hist[0] && hist[0].radio) || (rep && rep.radio) || '';
  }

  /**
   * What the section shows, from the analytics response for this observer
   * (id): null when it has nothing to do with MediaMesh.
   * { row (analytics observers entry), links (heard straight on radio2,
   *   busiest first), rep (its repeater entry), radio2 }
   */
  function viewOf(data, obs, id) {
    const key = String(id || '').toLowerCase();
    const row = ((data && data.observers) || []).find((o) => String(o.id || '').toLowerCase() === key) || null;
    const rep = ((data && data.repeaters) || []).find((r) => String(r.public_key || '').toLowerCase() === key) || null;
    const links = ((data && data.links) || []).filter((l) => String(l.observer_id || '').toLowerCase() === key)
      .sort((a, b) => (b.count || 0) - (a.count || 0));
    const radio2 = radio2Of(obs, rep);
    if (!row && !rep && !links.length && !radio2) return null;
    if (row && !row.runs_mediamesh && !row.mediamesh_observations && !rep && !links.length && !radio2) return null;
    return { row, links, rep, radio2 };
  }

  function sectionHtml(v, opts) {
    const now = (opts && opts.now) || Date.now();
    const label = (opts && opts.rangeLabel) || 'in this time range';
    const r = v.row || {};
    const runs = !!(r.runs_mediamesh || v.radio2);
    const rt = radioText(v.radio2);
    const listens = runs
      ? `Listens to MediaMesh on radio2${rt ? `: <strong>${esc(rt)}</strong>` : ''}, beside the main mesh.`
      : 'Doesn\'t report radio2 on: the MediaMesh packets here came through repeaters onto the main mesh.';
    const here = Number.isFinite(v.rep && v.rep.lat) && Number.isFinite(v.rep && v.rep.lon) ? [v.rep.lat, v.rep.lon]
      : v.links.length && Number.isFinite(v.links[0].to_lat) ? [v.links[0].to_lat, v.links[0].to_lon] : null;
    const rows = v.links.slice(0, 15).map((l) => {
      const name = l.from_name || String(l.from || '').slice(0, 8);
      const km = here && Number.isFinite(l.from_lat) && Number.isFinite(l.from_lon) ? distKm(here[0], here[1], l.from_lat, l.from_lon) : null;
      return `<tr><td><a href="#/nodes/${encodeURIComponent(l.from || '')}">${esc(name)}</a>${l.from_role ? ` <span class="text-muted">${esc(l.from_role)}</span>` : ''}</td>`
        + `<td class="mm-obs-num">${km === null ? '—' : km < 10 ? km.toFixed(1) + ' km' : Math.round(km) + ' km'}</td>`
        + `<td class="mm-obs-num">${fmtN(l.count)}</td><td class="mm-obs-num">${db(l.avg_snr)}</td><td class="mm-obs-num">${dbm(l.avg_rssi)}</td>`
        + `<td>${esc(ago(l.last_heard, now))}</td></tr>`;
    }).join('');
    const mapped = v.links.some((l) => Number.isFinite(l.from_lat) && Number.isFinite(l.from_lon)) && here;
    const tile = (lab, val, sub) => `<div class="stat-card mm-obs-stat"><div class="stat-label">${lab}</div><div class="stat-value">${val}</div>${sub ? `<div class="mm-obs-sub">${sub}</div>` : ''}</div>`;
    return `<div class="node-full-card mm-obs-card" data-testid="observer-mediamesh">
      <div class="mm-obs-head">
        <h4>MediaMesh</h4>
        <span class="badge-mediamesh pk-mm-badge">${runs ? 'MediaMesh observer' : 'Hears MediaMesh'}</span>
        <a class="mm-obs-more" href="#/analytics?tab=mediamesh">MediaMesh analytics →</a>
      </div>
      <p class="mm-obs-listens">${listens}</p>
      <div class="mm-obs-stats">
        ${tile('MediaMesh packets heard', fmtN(r.mediamesh_observations), esc(label))}
        ${tile('Share of what it hears', Number.isFinite(r.share_pct) ? r.share_pct.toFixed(1) + '%' : '—', `of ${fmtN(r.total_observations)} packets`)}
        ${tile('Last MediaMesh packet', r.last_heard ? esc(ago(r.last_heard, now)) : 'none yet', r.last_heard ? esc(new Date(r.last_heard).toLocaleString()) : '')}
        ${tile('Heard straight on radio2', fmtN(v.links.length), v.links.length === 1 ? 'node, no repeater between' : 'nodes, no repeater between')}
      </div>
      ${v.links.length ? `<div class="mm-obs-heard${mapped ? '' : ' mm-obs-heard--nomap'}">
        <div class="mm-obs-table"><table class="data-table"><thead><tr><th>Heard on radio2 from</th><th class="mm-obs-num">Distance</th><th class="mm-obs-num">Packets</th><th class="mm-obs-num">SNR</th><th class="mm-obs-num">RSSI</th><th>Last</th></tr></thead><tbody>${rows}</tbody></table>
        ${v.links.length > 15 ? `<p class="text-muted mm-obs-note">And ${v.links.length - 15} more.</p>` : ''}
        <p class="text-muted mm-obs-note">Packets this observer received on radio2 straight from the node, averaged. A strong link here is a path photos, video and voice can take.</p></div>
        ${mapped ? '<div class="mm-obs-map" id="mmObsMap" role="img" aria-label="Map of the nodes this observer hears on radio2"></div>' : ''}
      </div>` : `<p class="text-muted mm-obs-note">Nothing heard straight on radio2 ${esc(label)}${runs ? ': no MediaMesh node close enough, or none sending' : ''}.</p>`}
      <div class="mm-obs-repeater" id="mmObsRepeater" hidden></div>
    </div>`;
  }

  function cssColor(name, fallback) {
    const v = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '';
    return v || fallback;
  }

  function drawMap(el, v) {
    const L = root.L;
    if (!L || !el) return null;
    const here = Number.isFinite(v.rep && v.rep.lat) ? [v.rep.lat, v.rep.lon] : [v.links[0].to_lat, v.links[0].to_lon];
    const map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
    const url = typeof root.getTileUrl === 'function' ? root.getTileUrl() : null;
    if (url) L.tileLayer(url, { maxZoom: 18 }).addTo(map);
    const col = cssColor('--mediamesh-node-color', '#d946ef'), casing = cssColor('--card-bg', '#ffffff');
    const max = Math.max(1, ...v.links.map((l) => l.count || 0));
    const placed = v.links.filter((l) => Number.isFinite(l.from_lat) && Number.isFinite(l.from_lon));
    // the view first: a line added to a map with none can't be drawn
    map.fitBounds(L.latLngBounds([here].concat(placed.map((l) => [l.from_lat, l.from_lon]))).pad(0.25), { maxZoom: 14 });
    placed.slice().reverse().forEach((l) => {
      const ll = [l.from_lat, l.from_lon], w = 1.5 + 4 * Math.sqrt((l.count || 0) / max);
      L.polyline([ll, here], { color: casing, weight: w + 3, opacity: 0.85, interactive: false }).addTo(map);
      L.polyline([ll, here], { color: col, weight: w, opacity: 0.95 })
        .bindTooltip(`${esc(l.from_name || String(l.from || '').slice(0, 8))}: ${fmtN(l.count)} packets, SNR ${db(l.avg_snr)}`, { sticky: true }).addTo(map);
      L.circleMarker(ll, { radius: 5, weight: 2, color: col, fillColor: casing, fillOpacity: 1 })
        .bindTooltip(esc(l.from_name || String(l.from || '').slice(0, 8))).addTo(map);
    });
    L.circleMarker(here, { radius: 7, weight: 2, color: casing, fillColor: col, fillOpacity: 1 }).bindTooltip('This observer').addTo(map);
    return map;
  }

  let current = null;

  /** Fills el for observer obs over the last `days` days (1, 3, 7 or 30). */
  async function load(el, obs, days) {
    if (!el || !obs || !obs.id) return;
    if (current && current.map) { try { current.map.remove(); } catch (_) { /* gone */ } }
    const token = current = { map: null };
    const win = { 1: '24h', 3: '3d', 7: '7d', 30: '30d' }[days] || '7d';
    let data;
    try {
      data = typeof root.api === 'function'
        ? await root.api('/analytics/mediamesh?window=' + win, { ttl: 60000 })
        : await (await CSApi.fetch('/api/analytics/mediamesh?window=' + win)).json();
    } catch (_) { return; }
    if (current !== token || !el.isConnected) return;
    const v = viewOf(data, obs, obs.id);
    if (!v) { el.hidden = true; el.innerHTML = ''; return; }
    const rangeLabel = { 1: 'in the last 24 hours', 3: 'in the last 3 days', 7: 'in the last 7 days', 30: 'in the last 30 days' }[days] || 'in the last 7 days';
    el.innerHTML = sectionHtml(v, { rangeLabel });
    el.hidden = false;
    token.map = drawMap(el.querySelector('#mmObsMap'), v);
    // its own MediaMesh repeater card, when it is one
    const repEl = el.querySelector('#mmObsRepeater');
    if (v.rep && repEl && root.MediaMeshNode) {
      root.MediaMeshNode.load(repEl, String(obs.id).toLowerCase(), { name: v.rep.name, lat: v.rep.lat, lon: v.rep.lon }, { title: 'As a MediaMesh repeater' });
    }
  }

  root.MediaMeshObserver = { load, viewOf, sectionHtml, radioText, radio2Of };
})(typeof window !== 'undefined' ? window : globalThis);
