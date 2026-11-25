/* MediaMesh on the Analytics tab: how clips cross radio2. Six cards beside
 * the insights (mediamesh-insights.js): what the observers heard against
 * what arrived, how long until a clip is whole (both from the receipts),
 * and, in their own section, how many repeaters relay each piece, each
 * repeater's airtime, where pieces are lost hop by hop and which pieces go
 * missing. Pure functions build the HTML; draw() fills the cards. */
'use strict';

(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = (v) => `${Math.round(v * 100)}%`;
  const FEW = 3;

  function median(xs) {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  /** "45 s", "1 min 40 s", "12 min", "1 h 5 min". */
  function fmtDur(s) {
    if (s == null || !Number.isFinite(s)) return '—';
    s = Math.round(s);
    if (s < 60) return `${s} s`;
    if (s < 600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    const m = Math.round((s % 3600) / 60);
    return `${Math.floor(s / 3600)} h${m ? ` ${m} min` : ''}`;
  }

  function toggleRow(name, items, current) {
    return `<div class="mmj-toggles" role="group">${items.map(([v, label]) => `<button type="button" class="mmj-toggle" data-mmj-${name}="${esc(v)}" aria-pressed="${v === current}">${esc(label)}</button>`).join('')}</div>`;
  }

  function tile(big, label, accent) {
    return `<div class="mm-ins-tile"><div class="mm-ins-big${accent ? ' mm-ins-accent' : ''}">${big}</div><div class="mm-ins-label">${label}</div></div>`;
  }

  // ---- What the observers heard, against what arrived ------------------------

  /** One dot per delivery with a receipt: x, how much of the clip the far
   * end observer heard (0..1); whole, whether that recipient had it whole. */
  function receiptDots(clips) {
    const dots = [];
    (clips || []).forEach((c) => {
      const d = c.delivery;
      if (!d || !(d.recipients > 0) || !(c.total > 0)) return;
      const x = Math.min(1, (c.heard || 0) / c.total);
      const obsWhole = c.outcome === 'whole' || c.outcome === 'parity';
      for (let i = 0; i < d.recipients; i++) dots.push({ x, whole: i < (d.whole || 0), obsWhole });
    });
    return dots;
  }

  function vsReceiptsHtml(clips, unannounced) {
    const head = `<h3>What the observers heard, against what arrived</h3><p class="text-muted mm-ins-sub">Each dot is one delivery with a receipt: across, how much of the clip the observer furthest along heard; up or down, whether the receiving app ended up with it whole. Dots on the left of the top row are clips the observers barely heard that arrived anyway.</p>`;
    const dots = receiptDots((clips || []).concat((unannounced || []).filter((c) => c.totalFrom === 'receipt')));
    if (!dots.length) return head + '<p class="text-muted">No receipts yet for clips the observers judged.</p>';
    const X = (x) => 50 + x * 520;
    const jitter = (i) => ((i * 37) % 29) - 14;
    const marks = dots.map((d, i) => d.whole
      ? `<circle class="mmj-dot" cx="${X(d.x).toFixed(1)}" cy="${60 + jitter(i)}" r="5"></circle>`
      : `<circle class="mmj-ring" cx="${X(d.x).toFixed(1)}" cy="${160 + jitter(i)}" r="5"></circle>`).join('');
    const under = dots.filter((d) => d.x < 0.5), underWhole = under.filter((d) => d.whole).length;
    const heardNotWhole = dots.filter((d) => d.obsWhole && !d.whole).length;
    const svg = `<svg class="mmj-chart" role="img" aria-label="${esc(`${dots.length} deliveries: ${underWhole} of ${under.length} whose clip the observers heard under half of arrived whole`)}" viewBox="0 0 600 230">
      <line class="mmj-gl" x1="50" y1="110" x2="570" y2="110"></line><line class="mmj-axis" x1="50" y1="200" x2="570" y2="200"></line>
      <line class="mmj-gl mmj-dash" x1="310" y1="20" x2="310" y2="200"></line>
      <text class="mmj-label" x="0" y="64">Whole</text><text class="mmj-label" x="0" y="164">In part</text>
      <text class="mmj-tick" x="50" y="220">0%</text><text class="mmj-tick" x="310" y="220" text-anchor="middle">50%</text><text class="mmj-tick" x="570" y="220" text-anchor="end">100%</text>
      <text class="mmj-tick" x="310" y="14" text-anchor="middle">heard by the observer furthest along</text>${marks}</svg>`;
    return head + `<div class="mmj-split"><div class="mmj-plot">${svg}</div><div class="mmj-side">
      ${tile(`${underWhole.toLocaleString()} of ${under.length.toLocaleString()}`, 'deliveries whose clip the observers heard under half of still arrived whole', true)}
      ${tile(heardNotWhole.toLocaleString(), 'deliveries of clips heard whole by an observer that didn\'t arrive whole')}
      <p class="text-muted mmj-note">Filled: arrived whole. Ring: arrived in part.</p></div></div>`;
  }

  // ---- How long until a clip is whole ----------------------------------------

  const hopGroup = (h) => (h >= 5 ? '5+ hops' : h >= 3 ? '3–4 hops' : '1–2 hops');

  /** Seconds until each recipient had it whole, by kind and by hops. */
  function wholeTimes(clips, unannounced) {
    const out = [];
    (clips || []).concat(unannounced || []).forEach((c) => {
      const d = c.delivery;
      if (!d || !Array.isArray(d.wholeAfterS)) return;
      const kind = c.kind && c.kind !== 'unknown' ? c.kind : (d.kind || 'unknown');
      d.wholeAfterS.forEach((s) => { if (Number.isFinite(s) && s >= 0) out.push({ s, kind, hops: hopGroup(c.hops || 0) }); });
    });
    return out;
  }

  /** The time by which share q (0..1) of xs (sorted) were whole. */
  function quantile(xs, q) {
    if (!xs.length) return null;
    return xs[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)];
  }

  const KINDS = [['photo', 'Photos'], ['voice', 'Voice'], ['video', 'Video'], ['hops', 'By hops']];

  function timeToWholeHtml(clips, unannounced, view) {
    view = view || 'photo';
    const head = `<h3>How long until a clip is whole</h3><p class="text-muted mm-ins-sub">From the receipts: how long after it was sent each clip was whole at the phone or standalone that got it. Read across from a share to the time it took.</p>`;
    const all = wholeTimes(clips, unannounced);
    if (!all.length) return head + '<p class="text-muted">No receipts with a whole clip yet.</p>';
    const groups = view === 'hops'
      ? ['1–2 hops', '3–4 hops', '5+ hops'].map((k) => [k, all.filter((x) => x.hops === k).map((x) => x.s)])
      : KINDS.slice(0, 3).map(([k, label]) => [label, all.filter((x) => x.kind === k).map((x) => x.s), k === view]);
    groups.forEach((g) => g[1].sort((a, b) => a - b));
    const sel = view === 'hops' ? all.map((x) => x.s).sort((a, b) => a - b) : (groups.find((g) => g[2]) || [0, []])[1];
    const p95 = quantile(all.map((x) => x.s).sort((a, b) => a - b), 0.95) || 60;
    const maxS = Math.max(120, Math.min(3600, Math.ceil(p95 / 60) * 60));
    const X = (s) => 50 + Math.min(1, s / maxS) * 530, Y = (q) => 220 - q * 200;
    const cls = ['mmj-line-a', 'mmj-line-b', 'mmj-line-c'];
    const lines = groups.map((g, i) => {
      const xs = g[1];
      if (!xs.length) return '';
      let d = `M${X(0)},${Y(0)}`;
      xs.forEach((s, k) => { d += ` L${X(s).toFixed(1)},${Y(k / xs.length).toFixed(1)} L${X(s).toFixed(1)},${Y((k + 1) / xs.length).toFixed(1)}`; });
      d += ` L${X(maxS)},${Y(1)}`;
      const faded = view !== 'hops' && !g[2];
      const last = xs.length;
      return `<path class="mmj-cdf ${cls[i]}${faded ? ' mmj-faded' : ''}" d="${d}"></path><text class="mmj-legend ${cls[i]}${faded ? ' mmj-faded' : ''}" x="${X(maxS) - 4}" y="${210 - (groups.length - 1 - i) * 16}" text-anchor="end">${esc(g[0])} (${last})</text>`;
    }).join('');
    const q50 = quantile(sel, 0.5), q90 = quantile(sel, 0.9);
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<text class="mmj-tick" x="${X(maxS * f)}" y="240" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${f === 0 ? '0' : fmtDur(maxS * f)}</text>`).join('');
    const marks = (q50 != null ? `<circle class="mmj-mark" cx="${X(q50)}" cy="${Y(0.5)}" r="5"></circle>` : '') + (q90 != null ? `<circle class="mmj-mark" cx="${X(q90)}" cy="${Y(0.9)}" r="5"></circle>` : '');
    const what = view === 'hops' ? 'clips' : (KINDS.find((k) => k[0] === view) || ['', 'clips'])[1].toLowerCase();
    const svg = `<svg class="mmj-chart" role="img" aria-label="${esc(`Half of ${what} whole within ${fmtDur(q50)}, nine in ten within ${fmtDur(q90)}`)}" viewBox="0 0 600 260">
      <line class="mmj-axis" x1="50" y1="220" x2="580" y2="220"></line><line class="mmj-gl mmj-dash" x1="50" y1="120" x2="580" y2="120"></line><line class="mmj-gl mmj-dash" x1="50" y1="40" x2="580" y2="40"></line>
      <text class="mmj-tick" x="44" y="124" text-anchor="end">50%</text><text class="mmj-tick" x="44" y="44" text-anchor="end">90%</text><text class="mmj-tick" x="44" y="224" text-anchor="end">0</text>${ticks}${lines}${marks}</svg>`;
    return head + `<div class="mmj-split"><div class="mmj-plot">${svg}</div><div class="mmj-side">
      ${tile(sel.length ? fmtDur(q50) : '—', `half of ${esc(what)} were whole by then`, true)}
      ${tile(sel.length ? fmtDur(q90) : '—', `nine in ten ${esc(what)}; the slowest tenth is where repair rounds go`)}
      ${toggleRow('wait', KINDS, view)}
      ${sel.length && sel.length < 5 ? `<p class="text-muted mmj-note">Only ${sel.length} so far: too few to go on.</p>` : ''}</div></div>`;
  }

  // ---- How many repeaters relay each piece ------------------------------------

  function relaysHtml(r, view, nameOf) {
    view = view || 'week';
    const head = `<h3>How many repeaters relay each piece</h3><p class="text-muted mm-ins-sub">Every flooded piece, by how many MediaMesh repeaters sent it on. One re-send per hop is all a clip needs; the rest is airtime other pieces wait for.</p>`;
    if (!r || !(r.pieces > 0)) return head + '<p class="text-muted">No relayed pieces heard yet in this period.</p>';
    const tiles = `<div class="mm-ins-tiles mmj-tiles-2">${tile(String(r.medianRelays), 'repeaters relay a flooded piece, median', true)}${tile(`${(r.airPerPieceS || 0).toFixed(1)} s`, `of radio2 airtime per piece, all relays together (${esc(r.preset || '')})`)}</div>`;
    let chart;
    if (view === 'weeks' && (r.weeks || []).length) {
      const ws = r.weeks, maxM = Math.max(1, ...ws.map((w) => w.median));
      const bw = Math.min(70, 560 / ws.length - 12);
      chart = `<svg class="mmj-chart" role="img" aria-label="Median relays per piece, week by week" viewBox="0 0 620 230"><line class="mmj-axis" x1="30" y1="190" x2="610" y2="190"></line>${ws.map((w, i) => {
        const x = 40 + i * (bw + 12), h = Math.round(w.median / maxM * 160);
        return `<rect class="mmj-bar${w.pieces < 20 ? ' mmj-faded' : ''}" x="${x}" y="${190 - h}" width="${bw}" height="${h}" rx="2"></rect><text class="mmj-tick" x="${x + bw / 2}" y="${184 - h}" text-anchor="middle">${w.median}</text><text class="mmj-tick" x="${x + bw / 2}" y="208" text-anchor="middle">${esc(w.week.slice(5))}</text>`;
      }).join('')}<text class="mmj-tick" x="320" y="226" text-anchor="middle">week starting (median relays)</text></svg>`;
    } else {
      const bins = r.bins || [], maxN = Math.max(1, ...bins.map((b) => b.pieces));
      const medBin = Math.min(bins.length - 1, Math.max(0, Math.floor((r.medianRelays - 1) / 5)));
      const medX = 40 + medBin * 82 + Math.min(60, Math.max(0, ((r.medianRelays - 1) % 5) / 5 * 60));
      chart = `<svg class="mmj-chart" role="img" aria-label="${esc(`Pieces by relays: median ${r.medianRelays}`)}" viewBox="0 0 620 230"><line class="mmj-axis" x1="30" y1="190" x2="610" y2="190"></line>${bins.map((b, i) => {
        const x = 40 + i * 82, h = Math.round(b.pieces / maxN * 160);
        return `<rect class="mmj-bar" x="${x}" y="${190 - h}" width="60" height="${h}" rx="2"><title>${b.pieces.toLocaleString()} pieces</title></rect><text class="mmj-tick" x="${x + 30}" y="208" text-anchor="middle">${esc(b.label)}</text>`;
      }).join('')}<line class="mmj-median" x1="${medX}" y1="14" x2="${medX}" y2="190"></line><text class="mmj-label" x="${medX + 6}" y="22">median ${r.medianRelays}</text><text class="mmj-tick" x="320" y="226" text-anchor="middle">relays per piece</text></svg>`;
    }
    const starts = (r.byStart || []).slice(0, 3);
    const maxS = Math.max(1, ...starts.map((s) => s.median));
    const startHtml = starts.length ? `<h4 class="mmj-h4">Most relays, by where the clip entered the mesh</h4>${starts.map((s) => `<div class="mmj-hbar"><span>${esc(s.name || nameOf(s.hash) || s.hash)}</span><span class="mmj-track"><i style="width:${Math.round(s.median / maxS * 100)}%"></i></span><span class="mm-ins-num">${s.median}</span></div>`).join('')}` : '';
    return head + tiles + chart + startHtml + toggleRow('relays', [['week', 'This week'], ['weeks', 'Week by week']], view);
  }

  // ---- Airtime per repeater ----------------------------------------------------

  function airtimeHtml(r) {
    const line = (r && r.busyLinePct) || 60;
    const head = `<h3>Airtime per repeater</h3><p class="text-muted mm-ins-sub">How much of an hour each MediaMesh repeater's radio2 spends sending clip pieces: typical, and in its busiest hour. Past the line there's little time left to listen, so pieces start to collide.</p>`;
    const reps = ((r && r.repeaters) || []).slice(0, 8);
    if (!reps.length) return head + '<p class="text-muted">No relayed pieces heard yet in this period.</p>';
    const w = (v) => `${Math.min(100, Math.max(0, v)).toFixed(1)}%`;
    const rows = reps.map((p) => `<div class="mmj-air-row"><span>${esc(p.name)}</span>
      <span class="mmj-air-track" role="img" aria-label="${esc(`${p.name}: typical ${Math.round(p.typicalPct)}%, busiest ${Math.round(p.busiestPct)}%`)}"><i class="mmj-air-busy" style="width:${w(p.busiestPct)}"></i><i class="mmj-air-typ" style="width:${w(p.typicalPct)}"></i><b style="left:${w(line)}"></b></span>
      <span class="mm-ins-num">${Math.round(p.typicalPct)}%</span><span class="mm-ins-num${p.busiestPct >= line ? ' mmj-over' : ''}">${Math.round(p.busiestPct)}%</span></div>`).join('');
    return head + `<div class="mmj-air"><div class="mmj-air-row mmj-air-head"><span>Repeater</span><span>Share of the hour</span><span class="mm-ins-num">Typical</span><span class="mm-ins-num">Busiest</span></div>${rows}</div>
      <p class="text-muted mmj-key"><span class="mmj-sw mmj-air-typ"></span>typical hour <span class="mmj-sw mmj-air-busy"></span>busiest hour <span class="mmj-sw-line"></span>${line}%: little time left to listen</p>`;
  }

  // ---- Where pieces are lost, hop by hop --------------------------------------

  function routeKeyOf(c, nameOf) {
    const first = (c.path || []).length ? nameOf(c.path[0]) : '';
    const end = c.observerName || c.observer || '';
    return first && end ? `${first} → ${end}` : '';
  }

  /** Per hop out (1..6, 6 meaning 6 or more): of the clips that got that far,
   * the average share of their pieces some observer heard that far out. */
  function hopFunnel(clips, routeKey, nameOf) {
    const list = (clips || []).filter((c) => c.total > 0 && Array.isArray(c.heardByHop) && c.heardByHop.length
      && (!routeKey || routeKeyOf(c, nameOf) === routeKey));
    const rows = [];
    for (let h = 1; h <= 6; h++) {
      const got = list.filter((c) => c.heardByHop.length >= h);
      const shares = got.map((c) => Math.min(1, c.heardByHop[h - 1] / c.total));
      rows.push({ hop: h, n: got.length, share: shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null });
    }
    let biggest = null;
    rows.forEach((r, i) => {
      if (i === 0 || r.share == null || rows[i - 1].share == null) return;
      r.drop = rows[i - 1].share - r.share;
      if (r.n >= FEW && (!biggest || r.drop > biggest.drop)) biggest = r;
    });
    if (biggest && biggest.drop > 0) biggest.biggest = true;
    return { clips: list.length, rows: rows.filter((r) => r.n > 0) };
  }

  function topRoutes(clips, nameOf) {
    const by = {};
    (clips || []).forEach((c) => {
      if (!Array.isArray(c.heardByHop) || !c.heardByHop.length) return;
      const k = routeKeyOf(c, nameOf);
      if (k) by[k] = (by[k] || 0) + 1;
    });
    return Object.keys(by).filter((k) => by[k] >= 2).sort((a, b) => by[b] - by[a] || a.localeCompare(b)).slice(0, 3);
  }

  function hopsHtml(clips, nameOf, routeKey) {
    const head = `<h3>Where pieces are lost, hop by hop</h3><p class="text-muted mm-ins-sub">Of a clip's pieces, how many observers heard at each hop out from where it started, over the clips that went that far. The biggest step down is the hop to look at.</p>`;
    const f = hopFunnel(clips, routeKey, nameOf);
    const routes = topRoutes(clips, nameOf);
    const chips = toggleRow('route', [['', 'All routes']].concat(routes.map((k) => [k, k])), routeKey || '');
    if (!f.rows.length) return head + chips + '<p class="text-muted">No announced clips heard past their first hop yet.</p>';
    const rows = f.rows.map((r) => `<div class="mmj-funnel${r.n < FEW ? ' mmj-faded' : ''}${r.biggest ? ' mmj-biggest' : ''}"${r.n < FEW ? ' title="Fewer than 3 clips went this far"' : ''}><span>${r.hop}${r.hop === 6 ? '+' : ''} hop${r.hop === 1 ? '' : 's'}</span>
      <span class="mmj-track mmj-track--tall"><i style="width:${Math.round((r.share || 0) * 100)}%"></i></span><span class="mm-ins-num">${pct(r.share || 0)}</span>
      <span class="mmj-drop">${r.drop == null ? '' : r.biggest ? `−${Math.round(r.drop * 100)} biggest` : `${r.drop >= 0 ? '−' : '+'}${Math.abs(Math.round(r.drop * 100))}`}</span><span class="text-muted mm-ins-n">${r.n} clip${r.n === 1 ? '' : 's'}</span></div>`).join('');
    const big = f.rows.find((r) => r.biggest);
    return head + chips + `<div class="mmj-funnels">${rows}</div>`
      + (big ? `<p class="mmj-note">The hop to ${big.hop}${big.hop === 6 ? '+' : ''} loses the most${routeKey ? ' on this route' : ''}.</p>` : '')
      + `<p class="text-muted mmj-note">Observers sit at different distances, so a hop few clips reached says little: hops fewer than ${FEW} clips reached are faded.</p>`;
  }

  // ---- Which pieces go missing --------------------------------------------------

  const BUCKETS = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 9], [10, 14], [15, 19], [20, 29], [30, 1e9]];

  function busyHours(hours) {
    const vals = (hours || []).map((h) => h.packets || 0).filter((v) => v > 0).sort((a, b) => a - b);
    if (!vals.length) return new Set();
    const cut = vals[Math.floor(vals.length * 0.75)];
    return new Set((hours || []).filter((h) => (h.packets || 0) >= cut).map((h) => h.t));
  }

  /** How often each piece number went unheard at the far end (missing or
   * rebuilt from parity or repair pieces), in buckets. */
  function missingSummary(clips, filter, hours) {
    const busy = filter === 'busy' ? busyHours(hours) : null;
    const hourOf = (at) => { const t = new Date(Date.parse(at)); t.setUTCMinutes(0, 0, 0); return t.toISOString().replace('.000Z', 'Z'); };
    const list = (clips || []).filter((c) => c.total > 0 && c.outcome && c.outcome !== 'none' && c.outcome !== 'unannounced'
      && (!filter || filter === 'all' || filter === 'busy' ? true : c.kind === filter)
      && (!busy || busy.has(hourOf(c.at))));
    const has = [], miss = [];
    list.forEach((c) => {
      const un = new Set([].concat(c.missing || [], c.rebuilt || []));
      for (let i = 0; i < c.total; i++) { has[i] = (has[i] || 0) + 1; if (un.has(i)) miss[i] = (miss[i] || 0) + 1; }
    });
    const sum = (a, lo, hi) => { let n = 0; for (let i = lo; i <= Math.min(hi, a.length - 1); i++) n += a[i] || 0; return n; };
    const buckets = BUCKETS.map(([lo, hi]) => { const h = sum(has, lo, hi); return { label: lo === hi ? String(lo) : hi > 1e8 ? `${lo}+` : `${lo}–${hi}`, share: h ? sum(miss, lo, hi) / h : null, n: h }; }).filter((b) => b.n);
    const start = sum(has, 0, 2) ? sum(miss, 0, 2) / sum(has, 0, 2) : null;
    const rest = sum(has, 3, 1e9) ? sum(miss, 3, 1e9) / sum(has, 3, 1e9) : null;
    return { clips: list.length, buckets, ratio: start != null && rest ? start / rest : null };
  }

  function missingHtml(clips, filter, hours) {
    filter = filter || 'all';
    const head = `<h3>Which pieces go missing</h3><p class="text-muted mm-ins-sub">Across every announced clip, how often each piece number went unheard at the far end. Losses bunched at the start point to repeaters still listening to the main mesh when a clip begins; losses spread evenly point to collisions.</p>`;
    const s = missingSummary(clips, filter, hours);
    const chips = toggleRow('missing', [['all', 'Every clip'], ['photo', 'Photos'], ['voice', 'Voice'], ['busy', 'Sent in a busy hour']], filter);
    if (s.clips < 5) return head + chips + `<p class="text-muted">${s.clips ? `Only ${s.clips} clip${s.clips === 1 ? '' : 's'} here: too few to go on.` : 'No announced clips here yet.'}</p>`;
    const cells = s.buckets.map((b) => `<div class="mmj-cell"><span class="mmj-cell-box" style="background: color-mix(in srgb, var(--mediamesh-path-color) ${Math.round(12 + (b.share || 0) * 160)}%, transparent)"></span><span class="mmj-cell-n">${esc(b.label)}</span><span class="mmj-cell-v">${pct(b.share || 0)}</span></div>`).join('');
    const bunched = s.ratio != null && s.ratio >= 1.5;
    const verdict = s.ratio == null ? '' : `<div class="mm-ins-tiles mmj-tiles-2">${tile(`${s.ratio.toFixed(1)}×`, 'the first three pieces are missed this much as often as the rest', true)}${tile(bunched ? 'Bunched at the start' : 'Spread evenly', bunched ? 'The repeaters likely aren\'t on radio2 yet when a clip starts; the rest of the clip loses pieces evenly.' : 'More likely collisions than repeaters still on the main mesh when a clip starts.')}</div>`;
    return head + chips + `<div class="mmj-cells" role="img" aria-label="${esc(`Missed share by piece number over ${s.clips} clips`)}">${cells}</div>` + verdict;
  }

  // ---- The section and drawing --------------------------------------------------

  function sectionHtml() {
    return `<div class="mmj-section"><h2>How clips cross radio2</h2><p class="text-muted">Four views of a clip's journey: how radio2 shares its airtime as repeaters pass pieces along, and which hops and pieces have the most room to get faster. Each is worked out from what the observers already hear; nothing changes on the repeaters.</p></div>`;
  }

  /** The card slots, in the order the insights place them. */
  function cards() {
    const card = (id) => `<div class="analytics-row"><div class="analytics-card flex-1 mm-ins-card" id="${id}"><p class="text-muted">Loading…</p></div></div>`;
    return {
      afterDelivery: card('mmjVsCard'),
      afterSpeed: card('mmjWaitCard'),
      section: sectionHtml() + `<div class="mmj-grid">${['mmjRelaysCard', 'mmjAirCard', 'mmjHopsCard', 'mmjMissingCard'].map((id) => `<div class="analytics-card mm-ins-card" id="${id}"><p class="text-muted">Loading…</p></div>`).join('')}</div>`,
    };
  }

  let state = null;

  /** Fills the six cards in el from the clips answer, and the relays. */
  async function draw(el, data, nameOf, fetcher) {
    const me = { el, data, nameOf, view: { wait: 'photo', relays: 'week', route: '', missing: 'all' }, relays: null };
    if (state && state.el === el && state.onClick) el.removeEventListener('click', state.onClick);
    state = me;
    const put = (sel, html) => { const c = el.querySelector(sel); if (c) c.innerHTML = html; };
    const clips = (data && data.clips) || [], un = (data && data.unannounced) || [];
    const paint = () => {
      put('#mmjVsCard', vsReceiptsHtml(clips, un));
      put('#mmjWaitCard', timeToWholeHtml(clips, un, me.view.wait));
      put('#mmjRelaysCard', me.relays === null ? '<h3>How many repeaters relay each piece</h3><p class="text-muted">Loading…</p>' : relaysHtml(me.relays, me.view.relays, nameOf));
      put('#mmjAirCard', me.relays === null ? '<h3>Airtime per repeater</h3><p class="text-muted">Loading…</p>' : airtimeHtml(me.relays));
      put('#mmjHopsCard', hopsHtml(clips, nameOf, me.view.route));
      put('#mmjMissingCard', missingHtml(clips, me.view.missing, data && data.hours));
    };
    me.onClick = (e) => {
      const b = e.target.closest('.mmj-toggle');
      if (!b) return;
      const k = ['wait', 'relays', 'route', 'missing'].find((n) => b.hasAttribute('data-mmj-' + n));
      if (!k) return;
      me.view[k] = b.getAttribute('data-mmj-' + k);
      paint();
    };
    el.addEventListener('click', me.onClick);
    paint();
    if (typeof fetcher !== 'function') return;
    try {
      me.relays = await fetcher('/analytics/mediamesh/relays?days=7', { ttl: 60000 });
    } catch (_) {
      me.relays = { pieces: 0 };
    }
    if (state === me) paint();
  }

  function destroy() {
    if (state && state.el && state.onClick) state.el.removeEventListener('click', state.onClick);
    state = null;
  }

  root.MediaMeshJourney = {
    draw, destroy, cards, sectionHtml, fmtDur, median, quantile, receiptDots, vsReceiptsHtml, wholeTimes, timeToWholeHtml,
    relaysHtml, airtimeHtml, hopFunnel, topRoutes, hopsHtml, missingSummary, missingHtml, busyHours,
  };
})(typeof window !== 'undefined' ? window : globalThis);
