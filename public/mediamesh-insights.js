/* MediaMesh insights for the Analytics tab: did clips get through, how
 * fast, when the network is busy (all from /api/analytics/mediamesh/clips),
 * and where the week's backbone is fragile (from the tab's backbone).
 * Pure functions build the figures and the HTML; init() fetches and draws. */
'use strict';

(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const KIND_LABEL = { photo: 'Photo', video: 'Video', voice: 'Voice', unknown: 'Sent privately' };

  function median(xs) {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  /** Names for path hashes and observers: hash prefix -> repeater name. */
  function namer(reps) {
    const list = (reps || []).filter((r) => r.public_key).map((r) => ({ k: String(r.public_key).toLowerCase(), name: r.name || r.public_key.slice(0, 8) }));
    return (hop) => {
      const h = String(hop || '').toLowerCase();
      if (!h) return '';
      const hit = list.filter((r) => r.k.startsWith(h));
      return hit.length === 1 ? hit[0].name : h.toUpperCase();
    };
  }

  function clipLabel(c) {
    return (KIND_LABEL[c.kind] || 'Clip') + (c.kind !== 'photo' && c.seconds ? `, ${c.seconds} s` : '');
  }

  /** When a clip was sent, in the viewer's time: "21 Nov, 12:05". The year
   * only when it isn't this one. */
  function whenHtml(at, now) {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return '<span class="text-muted">—</span>';
    const d = new Date(t), n = new Date(now == null ? Date.now() : now);
    const opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
    if (d.getFullYear() !== n.getFullYear()) opts.year = 'numeric';
    return `<time datetime="${esc(d.toISOString())}" title="${esc(d.toLocaleString())}">${esc(d.toLocaleString(undefined, opts))}</time>`;
  }

  /** "First Hill → … → Rainier View": the first repeater, then who heard it. */
  function routeLabel(c, nameOf) {
    const path = c.path || [];
    const first = path.length ? nameOf(path[0]) : '';
    const end = c.observerName || c.observer || '';
    if (!first) return end || '—';
    const names = path.length <= 2 ? [first].concat(path.slice(1).map(nameOf)) : [first, '…', nameOf(path[path.length - 1])];
    if (end) names.push(end);
    // the observer is often the last repeater itself
    const out = names.filter((n, i) => n && n !== names[i - 1]);
    return out.join(' → ');
  }

  // ---- How much of each clip the observers heard ------------------------------------------------

  /** The judged clips (heard at all) and their outcomes, overall and by hops. */
  function deliverySummary(clips) {
    const judged = (clips || []).filter((c) => c.outcome && c.outcome !== 'none');
    const by = {};
    judged.forEach((c) => {
      const k = Math.min(5, Math.max(1, c.hops || 1));
      by[k] = by[k] || { hops: k, n: 0, ok: 0 };
      by[k].n++;
      if (c.outcome !== 'partial') by[k].ok++;
    });
    return {
      n: judged.length,
      unheard: (clips || []).length - judged.length,
      whole: judged.filter((c) => c.outcome === 'whole').length,
      parity: judged.filter((c) => c.outcome === 'parity').length,
      partial: judged.filter((c) => c.outcome === 'partial').length,
      byHops: [1, 2, 3, 4, 5].map((k) => by[k] || { hops: k, n: 0, ok: 0 }),
    };
  }

  function piecesHtml(c) {
    const miss = new Set(c.missing || []), fix = new Set(c.rebuilt || []);
    const n = Math.min(c.total, 60);
    let h = '<span class="mm-pieces" aria-hidden="true">';
    for (let i = 0; i < n; i++) h += `<span class="${miss.has(i) ? 'is-missing' : fix.has(i) ? 'is-rebuilt' : ''}"></span>`;
    return h + (c.total > n ? '<span class="mm-pieces-more">…</span>' : '') + '</span>';
  }

  function outcomeText(c) {
    if (c.outcome === 'whole') return 'all of it';
    if (c.outcome === 'parity') return 'all of it, with parity';
    if (c.outcome === 'partial') return `${c.total - (c.missing || []).length} of ${c.total}`;
    return 'none of it';
  }

  // ---- Did it arrive? (delivery receipts) -----------------------------------
  // Receiving apps that share delivery receipts say, for each clip they got,
  // whether it was whole: the clip's delivery is { recipients, whole, asked
  // (whole after asking again for missing pieces), rebuilt (whole thanks to
  // parity) }. Only the clip's session id and piece counts: never its content
  // or who sent it.

  /** Totals over every clip with a receipt, announced or sent privately. */
  function arrivalSummary(clips, unannounced) {
    const all = (clips || []).concat(unannounced || []).filter((c) => c.delivery && c.delivery.recipients > 0);
    const sum = (k) => all.reduce((n, c) => n + (Number(c.delivery[k]) || 0), 0);
    return { clips: all.length, recipients: sum('recipients'), whole: sum('whole'), asked: sum('asked'), rebuilt: sum('rebuilt') };
  }

  /** A clip's receipts, in a word or two. */
  function arrivalText(c) {
    const d = c && c.delivery;
    if (!d || !(d.recipients > 0)) return '';
    if (d.recipients === 1) {
      if (!d.whole) return 'arrived in part';
      return d.asked ? 'whole, after asking again' : d.rebuilt ? 'whole, with parity' : 'whole';
    }
    return d.whole === d.recipients ? `whole for all ${d.recipients}` : `whole for ${d.whole} of ${d.recipients}`;
  }

  function arrivalClass(c) {
    const d = c && c.delivery;
    if (!d || !(d.recipients > 0)) return '';
    return d.whole === d.recipients ? 'mm-ins-arrived' : 'mm-ins-arrived-part';
  }

  function arrivalHtml(a) {
    if (!a.recipients) {
      return `<h3>Did it arrive?</h3><p class="text-muted mm-ins-sub">The receiving app knows: with <strong>Share delivery receipts</strong> on in MeshCore Open TAK, it tells the analyzer each clip it got and whether it was whole (never what was in it, or who sent it). None shared yet.</p>`;
    }
    return `<h3>Did it arrive?</h3><p class="text-muted mm-ins-sub">Reported by the receiving phones and standalones: each clip they got, and whether it was whole. Never what was in it, or who sent it.</p>
    <div class="mm-ins-tiles">
      <div class="mm-ins-tile"><div class="mm-ins-big mm-ins-accent">${pct(a.whole, a.recipients)}%</div><div class="mm-ins-label">arrived whole: ${a.whole.toLocaleString()} of ${a.recipients.toLocaleString()} deliver${a.recipients === 1 ? 'y' : 'ies'} of ${a.clips.toLocaleString()} clip${a.clips === 1 ? '' : 's'}</div></div>
      <div class="mm-ins-tile"><div class="mm-ins-big">${a.asked.toLocaleString()}</div><div class="mm-ins-label">whole after the app asked again for a missing piece</div></div>
      <div class="mm-ins-tile"><div class="mm-ins-big">${a.rebuilt.toLocaleString()}</div><div class="mm-ins-label">whole thanks to parity pieces</div></div>
    </div>`;
  }

  function deliveryHtml(clips, nameOf, days, unannounced) {
    const s = deliverySummary(clips);
    const priv = (unannounced || []).length;
    const arrived = arrivalSummary(clips, unannounced);
    const head = arrivalHtml(arrived) + `<h3 class="mm-ins-h3-next">What the observers heard</h3><p class="text-muted mm-ins-sub">Each clip's announcement says how many pieces it has; this is how many of them reached the observer that heard it furthest along (the far end). It isn't whether the clip arrived: observers only hear pieces that pass near them, a MediaMesh repeater misses some while it listens to the main mesh, and the receiving app rebuilds or asks again for anything it missed. Clips announced on channels the analyzer can read, last ${days} days. A clip sent in a direct message or on a private channel has its announcement encrypted, so it isn't counted here; how fast it crossed still shows below.</p>`;
    const privNote = priv ? `<p class="text-muted">${priv.toLocaleString()} clip${priv === 1 ? '' : 's'} sent privately ${priv === 1 ? 'was' : 'were'} heard in this period.</p>` : '';
    if (!s.n) return head + '<p class="text-muted">No announced clips heard yet in this period.</p>' + privNote;
    // Counts, not percentages: observers hearing part of a clip is normal, and
    // "0% whole" would read as MediaMesh failing.
    const maxHops = Math.max(0, ...clips.filter((c) => c.outcome !== 'none').map((c) => c.hops || 0));
    const wholeN = s.whole + s.parity;
    const tiles = `<div class="mm-ins-tiles">
      <div class="mm-ins-tile"><div class="mm-ins-big mm-ins-accent">${s.n.toLocaleString()}</div><div class="mm-ins-label">announced clip${s.n === 1 ? '' : 's'} heard by observers${maxHops ? `, up to ${maxHops} hop${maxHops === 1 ? '' : 's'} from where ${s.n === 1 ? 'it' : 'they'} started` : ''}</div></div>
      ${priv ? `<div class="mm-ins-tile"><div class="mm-ins-big mm-ins-accent">${priv.toLocaleString()}</div><div class="mm-ins-label">more sent privately (direct messages, private channels)</div></div>` : ''}
      ${s.unheard ? `<div class="mm-ins-tile"><div class="mm-ins-big">${s.unheard.toLocaleString()}</div><div class="mm-ins-label">announced, not heard by an observer</div></div>` : ''}
    </div>
    <p class="text-muted mm-ins-wholeline">Heard whole by an observer: ${wholeN.toLocaleString()} of ${s.n.toLocaleString()}${s.parity ? ` (${s.parity} with parity)` : ''}. The rest passed out of the observers' hearing, which says nothing about whether ${s.n - wholeN === 1 ? 'it' : 'they'} arrived.</p>`;
    const maxN = Math.max(1, ...s.byHops.map((b) => b.n));
    const bars = s.byHops.filter((b) => b.n).map((b) => `<div class="mm-ins-bar-row"><span>${b.hops}${b.hops === 5 ? '+' : ''} hop${b.hops === 1 ? '' : 's'}</span>
      <span class="mm-ins-bar" role="img" aria-label="${b.n} clip${b.n === 1 ? '' : 's'}"><i style="width:${Math.round(b.n / maxN * 100)}%"></i></span><span class="mm-ins-num">${b.n}</span></div>`).join('');
    const recent = clips.filter((c) => c.outcome !== 'none').slice(0, 8).map((c) => `<tr><td class="mm-ins-when">${whenHtml(c.at)}</td><td><button type="button" class="mm-fr-open" data-mm-clip="${esc(c.sid)}" title="Open its flight recorder: every piece, when and by which path">${esc(clipLabel(c))}</button></td><td>${esc(routeLabel(c, nameOf))}</td><td class="mm-ins-num">${c.hops}</td>
      <td>${piecesHtml(c)}</td><td class="mm-ins-outcome mm-ins-outcome--${esc(c.outcome)}">${esc(outcomeText(c))}</td><td class="${arrivalClass(c)}">${arrivalText(c) ? esc(arrivalText(c)) : '<span class="text-muted">—</span>'}</td></tr>`).join('');
    return head + tiles + `<div class="mm-ins-split">
      <div class="mm-ins-col"><h4>Clips heard, by hops</h4>${bars}</div>
      <div class="mm-ins-col mm-ins-wide"><h4>Recent clips</h4><div class="mm-ins-scroll"><table class="analytics-table mm-ins-table"><thead><tr><th scope="col">Sent</th><th scope="col">Clip</th><th scope="col">Route</th><th scope="col" class="mm-ins-num">Hops</th><th scope="col">Pieces heard</th><th scope="col">Far end heard</th><th scope="col">Recipient</th></tr></thead><tbody>${recent}</tbody></table></div>
      <p class="text-muted mm-ins-key">Pick a clip for its flight recorder. <span class="mm-pieces"><span></span></span> heard · <span class="mm-pieces"><span class="is-rebuilt"></span></span> rebuilt from parity or repair pieces · <span class="mm-pieces"><span class="is-missing"></span></span> not heard by an observer</p></div></div>`;
  }

  // ---- Speed ----------------------------------------------------------------

  /** Clips with a time and size to go on: kbit/s and seconds. Announced
   * clips that arrived whole, and clips sent privately (no announcement the
   * analyzer can read: whether whole isn't known, but the far end's pieces
   * still time the crossing). Newest first. The bytes timed are those sent
   * after the first piece (rateBytes): for a clip sent privately, the server
   * counts the pieces the observers missed from the pieces' numbers. */
  function speedRows(clips, unannounced) {
    return (clips || []).filter((c) => (c.outcome === 'whole' || c.outcome === 'parity') && c.durationS > 0 && c.bytes > 0)
      .concat((unannounced || []).filter((c) => c.durationS > 0 && c.bytes > 0 && c.heard >= 2))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .map((c) => {
        const b = c.rateBytes > 0 ? c.rateBytes : c.bytes;
        // while sending: pauses of over 15 s cut out (the server's sendingS)
        const sendS = c.sendingS > 0 && c.sendingS < c.durationS ? c.sendingS : c.durationS;
        return Object.assign({}, c, { kbps: (b * 8) / c.durationS / 1000, sendKbps: (b * 8) / sendS / 1000, paused: c.durationS - sendS });
      });
  }

  function speedSummary(clips, nameOf, unannounced) {
    const rows = speedRows(clips, unannounced);
    const byHops = [1, 2, 3, 4, 5].map((h) => {
      const r = rows.filter((c) => Math.min(5, Math.max(1, c.hops || 1)) === h);
      return { hops: h, n: r.length, kbps: median(r.map((c) => c.kbps)) };
    });
    const routes = {};
    rows.forEach((c) => { const k = routeLabel(c, nameOf); (routes[k] = routes[k] || []).push(c.kbps); });
    let fastest = null;
    Object.keys(routes).forEach((k) => {
      if (routes[k].length < 2) return;
      const m = median(routes[k]);
      if (!fastest || m > fastest.kbps) fastest = { route: k, kbps: m, n: routes[k].length };
    });
    const photo1 = median(rows.filter((c) => c.kind === 'photo' && c.hops <= 1).map((c) => c.durationS));
    const priv = rows.filter((c) => c.outcome === 'unannounced').length;
    return { n: rows.length, priv, kbps: median(rows.map((c) => c.kbps)), sendKbps: median(rows.map((c) => c.sendKbps)), byHops, fastest, photo1, rows };
  }

  const fmtK = (v) => (v == null ? '—' : v < 10 ? v.toFixed(1) : String(Math.round(v)));

  function speedHtml(clips, nameOf, days, unannounced) {
    const s = speedSummary(clips, nameOf, unannounced);
    const head = `<h3>How fast clips cross the mesh</h3><p class="text-muted mm-ins-sub">From the first piece the far end heard until it had enough to make the whole clip (its own pieces, and parity or repair pieces for those it missed; repair pieces sent later for other listeners don't count): announced clips the far end could make whole, and clips sent privately (in a direct message or on a private channel), timed from the pieces heard, with the pieces in between that no observer heard counted from their numbers. While sending leaves out the pauses: gaps of over 15 s in which far fewer pieces went than usual, as when the sending app waits on the far end. Last ${days} days.</p>`;
    if (!s.n) return head + '<p class="text-muted">No clips with more than one piece heard yet.</p>';
    const maxK = Math.max(...s.byHops.map((b) => b.kbps || 0), 0.1);
    const tiles = `<div class="mm-ins-tiles">
      <div class="mm-ins-tile"><div class="mm-ins-big">${fmtK(s.kbps)} kbit/s</div><div class="mm-ins-label">median speed end to end, ${s.n} clip${s.n === 1 ? '' : 's'}${s.priv ? `, ${s.priv} sent privately` : ''}</div></div>
      <div class="mm-ins-tile"><div class="mm-ins-big">${fmtK(s.sendKbps)} kbit/s</div><div class="mm-ins-label">median while sending, leaving out pauses of over 15 s</div></div>
      <div class="mm-ins-tile"><div class="mm-ins-big">${s.photo1 == null ? '—' : Math.round(s.photo1) + ' s'}</div><div class="mm-ins-label">a photo over one hop, typical</div></div>
      <div class="mm-ins-tile mm-ins-tile--wide"><div class="mm-ins-big mm-ins-accent mm-ins-route">${s.fastest ? esc(s.fastest.route) : '—'}</div><div class="mm-ins-label">${s.fastest ? `fastest route this period, ${fmtK(s.fastest.kbps)} kbit/s over ${s.fastest.n} clips` : 'fastest route: needs two clips on one route'}</div></div>
    </div>`;
    const bars = s.byHops.filter((b) => b.n).map((b) => `<div class="mm-ins-bar-row"><span>${b.hops}${b.hops === 5 ? '+' : ''} hop${b.hops === 1 ? '' : 's'}</span>
      <span class="mm-ins-bar"><i style="width:${Math.round(((b.kbps || 0) / maxK) * 100)}%"></i></span><span class="mm-ins-num">${fmtK(b.kbps)}</span><span class="text-muted mm-ins-n">${b.n}</span></div>`).join('');
    const rows = s.rows.slice(0, 8).map((c) => `<tr><td class="mm-ins-when">${whenHtml(c.at)}</td><td>${esc(routeLabel(c, nameOf))}</td><td class="mm-ins-num">${c.hops}</td><td>${esc(clipLabel(c))}, ${c.bytesEstimated ? '<span title="Worked out from the numbers of the first and last pieces heard">about ' : ''}${(c.bytes / 1000).toFixed(1)} kB${c.bytesEstimated ? '</span>' : ''}</td>
      <td class="mm-ins-num">${Math.round(c.durationS)} s${c.paused >= 1 ? `<span class="text-muted mm-ins-paused" title="Paused for this long in all: gaps of over 15 s with far fewer pieces than usual"> (${Math.round(c.paused)} s paused)</span>` : ''}</td><td class="mm-ins-num"><strong>${fmtK(c.kbps)}</strong></td><td class="mm-ins-num">${fmtK(c.sendKbps)}</td></tr>`).join('');
    return head + tiles + `<div class="mm-ins-split">
      <div class="mm-ins-col"><h4>kbit/s by hops (median)</h4>${bars}</div>
      <div class="mm-ins-col mm-ins-wide"><h4>Recent clips</h4><div class="mm-ins-scroll"><table class="analytics-table mm-ins-table"><thead><tr><th scope="col">Sent</th><th scope="col">Route</th><th scope="col" class="mm-ins-num">Hops</th><th scope="col">Clip</th><th scope="col" class="mm-ins-num">Took</th><th scope="col" class="mm-ins-num">kbit/s</th><th scope="col" class="mm-ins-num" title="Leaving out pauses of over 15 s">While sending</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
  }

  // ---- When it's busy -------------------------------------------------------

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /** Average per weekday and hour (local time), Monday first:
   * { grid[7][24] {packets, clips, partial}, weeks }. */
  function busyGrid(hours, from, to) {
    const grid = DAYS.map(() => Array.from({ length: 24 }, () => ({ packets: 0, clips: 0, partial: 0 })));
    (hours || []).forEach((h) => {
      const d = new Date(h.t);
      if (isNaN(d)) return;
      const cell = grid[(d.getDay() + 6) % 7][d.getHours()];
      cell.packets += h.packets || 0; cell.clips += h.clips || 0; cell.partial += h.partial || 0;
    });
    const span = (Date.parse(to) - Date.parse(from)) / (7 * 86400000);
    const weeks = span > 1 ? span : 1;
    grid.forEach((row) => row.forEach((c) => { c.packets /= weeks; c.clips /= weeks; c.partial /= weeks; }));
    return { grid, weeks };
  }

  const hourLabel = (h) => (h === 0 ? '12 am' : h < 12 ? h + ' am' : h === 12 ? '12 pm' : (h - 12) + ' pm');

  function busyHtml(b, metric, days) {
    metric = metric || 'packets';
    const label = { packets: 'packets', clips: 'clips', partial: 'clips heard in part' }[metric];
    let max = 0, best = null, quiet = null;
    b.grid.forEach((row, d) => row.forEach((c, h) => {
      if (c[metric] > max) { max = c[metric]; best = { d, h, v: c[metric] }; }
    }));
    // the quietest 3-hour stretch
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 22; h++) {
        const v = b.grid[d][h][metric] + b.grid[d][h + 1][metric] + b.grid[d][h + 2][metric];
        if (!quiet || v < quiet.v) quiet = { d, h, v };
      }
    }
    const head = `<div class="mm-ins-head"><div><h3>When MediaMesh is busy</h3><p class="text-muted mm-ins-sub">Photos, video and voice by weekday and hour, your time, averaged over the last ${days} days.</p></div>
      <div class="mm-ins-toggle" role="group" aria-label="What to count">${['packets', 'clips', 'partial'].map((m) => `<button type="button" class="tab-btn${m === metric ? ' active' : ''}" data-mm-busy="${m}" aria-pressed="${m === metric}">${{ packets: 'Packets', clips: 'Clips', partial: 'Heard in part' }[m]}</button>`).join('')}</div></div>`;
    if (!max) return head + `<p class="text-muted">Nothing to show yet: no ${label} in this period.</p>`;
    const cols = Array.from({ length: 24 }, (_, h) => `<th scope="col">${h % 3 === 0 ? hourLabel(h).replace(' ', '') : ''}</th>`).join('');
    const body = b.grid.map((row, d) => `<tr><th scope="row">${DAYS[d]}</th>${row.map((c, h) => {
      const v = c[metric], a = v ? Math.round(8 + (v / max) * 84) : 0;
      return `<td style="--a:${a}%"${best && best.d === d && best.h === h ? ' class="is-peak"' : ''} title="${DAYS[d]} ${hourLabel(h)}: ${v < 10 ? v.toFixed(1) : Math.round(v)} ${label} a week"></td>`;
    }).join('')}</tr>`).join('');
    const fmtV = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
    return head + `<div class="mm-ins-scroll"><table class="mm-ins-heat" aria-label="${esc(label)} by weekday and hour"><thead><tr><th></th>${cols}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="mm-ins-tiles mm-ins-tiles--3">
        <div class="mm-ins-tile"><div class="mm-ins-strong">Busiest: ${DAYS[best.d]}, ${hourLabel(best.h)}–${hourLabel((best.h + 1) % 24)}</div><div class="mm-ins-label">${fmtV(best.v)} ${label} in that hour, on average</div></div>
        <div class="mm-ins-tile"><div class="mm-ins-strong">Quietest: ${DAYS[quiet.d]}, ${hourLabel(quiet.h)}–${hourLabel((quiet.h + 3) % 24)}</div><div class="mm-ins-label">${metric === 'partial' ? 'fewest clips heard in part' : 'a good time for big transfers'}</div></div>
        <div class="mm-ins-tile"><div class="mm-ins-strong">${fmtV(b.grid.reduce((a, r) => a + r.reduce((x, c) => x + c[metric], 0), 0))} ${label}</div><div class="mm-ins-label">in a typical week</div></div>
      </div>`;
  }

  // ---- Weak spots in the backbone -------------------------------------------

  /** The backbone as a graph: { keys, names, pos, adj (Set per key), w (packets per edge key) }. */
  function backboneGraph(backbone) {
    const names = {}, pos = {}, adj = {}, w = {};
    (backbone || []).forEach((e) => {
      const a = String(e.a || '').toLowerCase(), b = String(e.b || '').toLowerCase();
      if (!a || !b || a === b) return;
      names[a] = e.a_name || names[a] || a.slice(0, 8); names[b] = e.b_name || names[b] || b.slice(0, 8);
      if (Number.isFinite(e.a_lat) && Number.isFinite(e.a_lon)) pos[a] = [e.a_lat, e.a_lon];
      if (Number.isFinite(e.b_lat) && Number.isFinite(e.b_lon)) pos[b] = [e.b_lat, e.b_lon];
      (adj[a] = adj[a] || new Set()).add(b); (adj[b] = adj[b] || new Set()).add(a);
      const k = a < b ? a + '|' + b : b + '|' + a;
      w[k] = (w[k] || 0) + (e.packets || 0);
    });
    return { keys: Object.keys(adj).sort(), names, pos, adj, w };
  }

  /** Components of the graph without `skip` (a node) or `cut` (an edge key). */
  function components(g, skip, cut) {
    const seen = new Set(), out = [];
    g.keys.forEach((k) => {
      if (k === skip || seen.has(k)) return;
      const comp = [], stack = [k];
      seen.add(k);
      while (stack.length) {
        const x = stack.pop();
        comp.push(x);
        g.adj[x].forEach((y) => {
          if (y === skip || seen.has(y)) return;
          if (cut && (x < y ? x + '|' + y : y + '|' + x) === cut) return;
          seen.add(y); stack.push(y);
        });
      }
      out.push(comp);
    });
    return out.sort((a, b) => b.length - a.length);
  }

  const pairs = (comps) => comps.reduce((a, c) => a + (c.length * (c.length - 1)) / 2, 0);

  /** 0..100: with each repeater in turn gone, the share of the other
   * repeaters' pairs still connected; half the average, half the worst case
   * (an average alone hides one repeater everything hangs on). */
  function resilienceScore(g) {
    const n = g.keys.length;
    if (n < 3) return null;
    const all = components(g), before = pairs(all);
    const compOf = {};
    all.forEach((c) => c.forEach((k) => { compOf[k] = c.length; }));
    let sum = 0, worst = 1;
    g.keys.forEach((k) => {
      // the pairs connected before, among the rest
      const was = before - (compOf[k] - 1);
      const f = was > 0 ? pairs(components(g, k)) / was : 1;
      sum += f;
      worst = Math.min(worst, f);
    });
    return Math.round(((sum / n + worst) / 2) * 100);
  }

  function withEdge(g, a, b) {
    const adj = {};
    g.keys.forEach((k) => { adj[k] = new Set(g.adj[k]); });
    adj[a].add(b); adj[b].add(a);
    return Object.assign({}, g, { adj });
  }

  function distKm(p, q) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (q[0] - p[0]) * toR, dLon = (q[1] - p[1]) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(p[0] * toR) * Math.cos(q[0] * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /**
   * Weak spots: { score, cuts [{ key, name, cutOff: [names] }], bridges
   * [{ a, b, aName, bName, cutOff }], hub { key, name, share }, fix { a, b,
   * aName, bName, km, score } }. A cut is a repeater whose loss splits the
   * backbone; cutOff are the repeaters that would be separated from the
   * largest part. The fix is the one new link (between repeaters within
   * maxKm) that raises the score most.
   */
  function weakSpots(backbone, maxKm) {
    const g = backboneGraph(backbone);
    const out = { n: g.keys.length, score: resilienceScore(g), cuts: [], bridges: [], hub: null, fix: null, graph: g };
    if (out.score === null) return out;
    // Only what was connected to it before counts as cut off: a separate
    // little backbone elsewhere was never reachable through it.
    const home = {};
    components(g).forEach((c) => { const set = new Set(c); c.forEach((k) => { home[k] = set; }); });
    const cutOffOf = (comps, k) => {
      const mine = comps.filter((c) => home[k].has(c[0]));
      return mine.length > 1 ? mine.slice(1).flat().sort((x, y) => g.names[x].localeCompare(g.names[y])) : [];
    };
    g.keys.forEach((k) => {
      const keys = cutOffOf(components(g, k), k);
      if (keys.length) out.cuts.push({ key: k, name: g.names[k], cutOff: keys.map((x) => g.names[x]), cutOffKeys: keys });
    });
    Object.keys(g.w).forEach((ek) => {
      const [a, b] = ek.split('|');
      if (g.adj[a].size < 2 || g.adj[b].size < 2) return; // a spur: its own end says it
      const keys = cutOffOf(components(g, null, ek), a);
      if (keys.length) out.bridges.push({ a, b, aName: g.names[a], bName: g.names[b], cutOff: keys.map((x) => g.names[x]), cutOffKeys: keys });
    });
    out.cuts.sort((x, y) => y.cutOff.length - x.cutOff.length || x.name.localeCompare(y.name));
    const total = Object.values(g.w).reduce((a, v) => a + v, 0);
    g.keys.forEach((k) => {
      let s = 0;
      g.adj[k].forEach((y) => { s += g.w[k < y ? k + '|' + y : y + '|' + k] || 0; });
      if (total && (!out.hub || s > out.hub.packets)) out.hub = { key: k, name: g.names[k], packets: s, share: Math.round((s / total) * 100) };
    });
    if (out.cuts.length || out.bridges.length) {
      const lim = maxKm || 10;
      g.keys.forEach((a) => g.keys.forEach((b) => {
        if (a >= b || g.adj[a].has(b) || !g.pos[a] || !g.pos[b]) return;
        const km = distKm(g.pos[a], g.pos[b]);
        if (km > lim) return;
        const sc = resilienceScore(withEdge(g, a, b));
        if (sc > out.score && (!out.fix || sc > out.fix.score || (sc === out.fix.score && km < out.fix.km))) {
          out.fix = { a, b, aName: g.names[a], bName: g.names[b], km, score: sc };
        }
      }));
    }
    return out;
  }

  function scoreWord(s) { return s >= 85 ? 'strong' : s >= 65 ? 'fair' : 'fragile'; }

  function weakHtml(ws) {
    const head = '<h3>Where one repeater going down would split MediaMesh</h3><p class="text-muted mm-ins-sub">From the week\'s backbone: repeaters and hops photos, video and voice have no way around.</p>';
    if (ws.score === null) return head + '<p class="text-muted">Needs a backbone of at least three repeaters this week.</p>';
    const ring = 2 * Math.PI * 50, frac = ws.score / 100;
    const gauge = `<svg class="mm-ins-gauge mm-ins-gauge--${scoreWord(ws.score)}" viewBox="0 0 120 120" role="img" aria-label="Resilience ${ws.score} of 100"><circle cx="60" cy="60" r="50" class="mm-ins-gauge-bg"/><circle cx="60" cy="60" r="50" class="mm-ins-gauge-fg" stroke-dasharray="${(frac * ring).toFixed(1)} ${ring.toFixed(1)}" transform="rotate(-90 60 60)"/><text x="60" y="66" text-anchor="middle" class="mm-ins-gauge-num">${ws.score}</text><text x="60" y="84" text-anchor="middle" class="mm-ins-gauge-of">of 100</text></svg>`;
    const list = (xs) => (xs.length > 3 ? xs.slice(0, 3).map(esc).join(', ') + ` and ${xs.length - 3} more` : xs.map(esc).join(xs.length === 2 ? ' and ' : ', ').replace(/, ([^,]*)$/, ' and $1'));
    const rows = ws.cuts.map((c) => `<tr><td><span class="mm-ins-dot mm-ins-dot--bad"></span><strong>${esc(c.name)}</strong></td><td>The only way to ${list(c.cutOff)}</td></tr>`)
      .concat(ws.bridges.map((b) => `<tr><td><span class="mm-ins-dot mm-ins-dot--bad"></span><strong>${esc(b.aName)} ↔ ${esc(b.bName)}</strong></td><td>The only hop to ${list(b.cutOff)}</td></tr>`));
    if (ws.hub && ws.hub.share >= 40) rows.push(`<tr><td><span class="mm-ins-dot mm-ins-dot--warn"></span><strong>${esc(ws.hub.name)}</strong></td><td>On ${ws.hub.share}% of the week's hops</td></tr>`);
    const summary = ws.cuts.length || ws.bridges.length
      ? `${ws.cuts.length} repeater${ws.cuts.length === 1 ? '' : 's'} and ${ws.bridges.length} hop${ws.bridges.length === 1 ? '' : 's'} are the only way through for part of the backbone.`
      : 'Every repeater on the backbone has a way around any one that goes down.';
    const fix = ws.fix ? `<div class="mm-ins-callout"><strong>Biggest fix</strong><div>A link between ${esc(ws.fix.aName)} and ${esc(ws.fix.bName)} (${ws.fix.km.toFixed(1)} km apart, if they can hear each other) would raise the score from ${ws.score} to ${ws.fix.score}.</div></div>` : '';
    return head + `<div class="mm-ins-split"><div class="mm-ins-col mm-ins-wide">
      <div class="mm-ins-score">${gauge}<div><div class="mm-ins-strong">Resilience: ${scoreWord(ws.score)}</div><div class="text-muted">${summary}</div></div></div>
      ${rows.length ? `<table class="analytics-table mm-ins-table"><tbody>${rows.join('')}</tbody></table>` : ''}${fix}
      <p class="text-muted mm-ins-key">The score: with each repeater in turn gone, the share of the others that can still reach each other; half the average, half the worst case. Only hops seen this week count: a link that exists but carried nothing isn't in it.</p>
    </div><div class="mm-ins-col mm-ins-wide"><div class="mm-ins-map" id="mmWeakMap" role="img" aria-label="The week's backbone, with weak spots marked"></div>
      <div class="mm-ins-map-actions"><button type="button" class="btn-secondary" data-mm-weak-png title="Save the map, with the score and what's marked, as a picture to share">Download map (PNG)</button></div></div></div>`;
  }

  function cssColor(name, fallback) {
    const v = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '';
    return /^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback;
  }

  function drawWeakMap(el, ws) {
    const L = root.L, box = el.querySelector('#mmWeakMap');
    if (!L || !box) return null;
    const g = ws.graph, pts = g.keys.filter((k) => g.pos[k]).map((k) => g.pos[k]);
    if (!pts.length) { box.hidden = true; return null; }
    const map = L.map(box, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
    const tileUrl = typeof root.getTileUrl === 'function' ? root.getTileUrl() : null;
    // fetched with CORS, so the map can be saved as a picture (mapPng)
    if (tileUrl) L.tileLayer(tileUrl, { maxZoom: 18, crossOrigin: 'anonymous' }).addTo(map);
    map.fitBounds(L.latLngBounds(pts).pad(0.15));
    const line = cssColor('--mediamesh-node-color', '#d946ef'), bad = cssColor('--status-red', '#dc2626'), warn = cssColor('--status-amber', '#d97706'), fixC = '#0891b2';
    const maxW = Math.max(1, ...Object.values(g.w));
    const isBridge = new Set(ws.bridges.map((b) => (b.a < b.b ? b.a + '|' + b.b : b.b + '|' + b.a)));
    Object.keys(g.w).forEach((ek) => {
      const [a, b] = ek.split('|');
      if (!g.pos[a] || !g.pos[b]) return;
      const br = isBridge.has(ek);
      L.polyline([g.pos[a], g.pos[b]], { color: br ? bad : line, weight: 2 + 4 * Math.log1p(g.w[ek]) / Math.log1p(maxW), opacity: 0.9, dashArray: br ? '8 5' : null })
        .bindTooltip(`${esc(g.names[a])} ↔ ${esc(g.names[b])}: ${g.w[ek]} packets this week${br ? ' (the only way through)' : ''}`, { sticky: true }).addTo(map);
    });
    const cut = new Set(ws.cuts.map((c) => c.key));
    g.keys.forEach((k) => {
      if (!g.pos[k]) return;
      L.circleMarker(g.pos[k], { radius: 5, weight: 2, color: '#ffffff', fillColor: line, fillOpacity: 1 }).bindTooltip(esc(g.names[k])).addTo(map);
      if (cut.has(k) || (ws.hub && ws.hub.key === k && ws.hub.share >= 40)) {
        L.circleMarker(g.pos[k], { radius: 12, weight: 3, color: cut.has(k) ? bad : warn, fill: false, interactive: false }).addTo(map);
      }
    });
    if (ws.fix && g.pos[ws.fix.a] && g.pos[ws.fix.b]) {
      L.polyline([g.pos[ws.fix.a], g.pos[ws.fix.b]], { color: fixC, weight: 3, dashArray: '2 7', opacity: 0.95 })
        .bindTooltip(`Suggested link: ${esc(ws.fix.aName)} ↔ ${esc(ws.fix.bName)}`, { sticky: true }).addTo(map);
    }
    return map;
  }

  // ---- Saving a map ------------------------------------------------------------

  /**
   * A Leaflet map as a PNG Blob: its tiles, its lines and circles (the SVG
   * overlay), a heading and footer lines, at twice the size for sharp text.
   * opts: { title, subtitle, legend: [[css colour, label]], footer }. Tiles
   * that can't be drawn (no CORS) are left out rather than failing.
   */
  async function mapPng(map, opts) {
    const o = opts || {};
    const box = map.getContainer(), rect = box.getBoundingClientRect();
    const W = Math.round(rect.width), H = Math.round(rect.height);
    const head = 64, foot = 40, k = 2;
    const cv = document.createElement('canvas');
    cv.width = W * k; cv.height = (H + head + foot) * k;
    const g = cv.getContext('2d');
    g.scale(k, k);
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches);
    const bg = dark ? '#0f172a' : '#ffffff', fg = dark ? '#e2e8f0' : '#0f172a', muted = dark ? '#94a3b8' : '#475569';
    g.fillStyle = bg; g.fillRect(0, 0, W, H + head + foot);
    g.fillStyle = getComputedStyle(box).backgroundColor || bg; g.fillRect(0, head, W, H);
    // tiles where they sit
    const tiles = [...box.querySelectorAll('img.leaflet-tile')].filter((im) => im.complete && im.naturalWidth);
    for (const im of tiles) {
      const r = im.getBoundingClientRect();
      try {
        g.save(); g.beginPath(); g.rect(0, head, W, H); g.clip();
        g.globalAlpha = Number(getComputedStyle(im).opacity) || 1;
        g.drawImage(im, r.left - rect.left, r.top - rect.top + head, r.width, r.height);
        g.restore();
      } catch (_) { g.restore(); }
    }
    // the overlay: Leaflet draws lines and circles as one SVG
    const svg = box.querySelector('.leaflet-overlay-pane svg');
    if (svg) {
      const r = svg.getBoundingClientRect();
      const copy = svg.cloneNode(true);
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      copy.setAttribute('width', String(r.width)); copy.setAttribute('height', String(r.height));
      copy.style.transform = '';
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
      await new Promise((res) => {
        const im = new Image();
        im.onload = () => {
          g.save(); g.beginPath(); g.rect(0, head, W, H); g.clip();
          g.drawImage(im, r.left - rect.left, r.top - rect.top + head, r.width, r.height);
          g.restore(); res();
        };
        im.onerror = res;
        im.src = url;
      });
    }
    // names of what's marked, beside their circles
    (o.labels || []).forEach(([lat, lon, text]) => {
      const p = map.latLngToContainerPoint([lat, lon]);
      g.font = '600 12px Inter, system-ui, sans-serif';
      g.lineWidth = 3; g.lineJoin = 'round'; g.strokeStyle = bg; g.fillStyle = fg;
      g.strokeText(text, p.x + 14, p.y + head + 4); g.fillText(text, p.x + 14, p.y + head + 4);
    });
    // the heading, smaller if it would run off a narrow map
    const fitText = (text, weight, size, min, y, colour) => {
      let px = size;
      do { g.font = `${weight} ${px}px Inter, system-ui, sans-serif`; } while (g.measureText(text).width > W - 28 && --px > min);
      g.fillStyle = colour; g.fillText(text, 14, y);
    };
    fitText(o.title || '', 600, 18, 12, 28, fg);
    fitText(o.subtitle || '', 400, 13, 9, 50, muted);
    let x = 14;
    (o.legend || []).forEach(([c, label]) => {
      g.fillStyle = c; g.fillRect(x, H + head + 15, 14, 4);
      g.fillStyle = muted; g.font = '12px Inter, system-ui, sans-serif';
      g.fillText(label, x + 20, H + head + 21);
      x += 30 + g.measureText(label).width;
    });
    g.textAlign = 'right';
    g.fillText(o.footer || '', W - 14, H + head + 21);
    return new Promise((res) => {
      try { cv.toBlob((b) => res(b), 'image/png'); } catch (_) { res(null); }
    });
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---- Wiring ---------------------------------------------------------------

  const DAYS_BACK = 7;
  let state = null;

  /** Fills the tab's insight cards: #mmDeliveryCard, #mmSpeedCard,
   * #mmBusyCard (from the clips endpoint) and #mmWeakCard (from mm.backbone). */
  async function init(el, mm, opts) {
    destroy();
    const nameOf = namer(mm && mm.repeaters);
    const me = state = { el, maps: [] };
    const weak = el.querySelector('#mmWeakCard');
    if (weak) {
      const ws = weakSpots(mm && mm.backbone, 10);
      weak.innerHTML = weakHtml(ws);
      const m = drawWeakMap(weak, ws);
      if (m) me.maps.push(m);
      const btn = weak.querySelector('[data-mm-weak-png]');
      if (btn && !m) btn.hidden = true;
      if (btn && m) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const g = ws.graph, day = new Date().toISOString().slice(0, 10);
          const labels = ws.cuts.map((c) => [...g.pos[c.key], c.name]).concat(ws.hub && ws.hub.share >= 40 && g.pos[ws.hub.key] ? [[...g.pos[ws.hub.key], ws.hub.name]] : [])
            .concat(ws.fix && g.pos[ws.fix.a] && g.pos[ws.fix.b] ? [[...g.pos[ws.fix.a], ws.fix.aName], [...g.pos[ws.fix.b], ws.fix.bName]] : []);
          const blob = await mapPng(m, {
            title: `MediaMesh backbone · resilience ${ws.score} of 100 (${scoreWord(ws.score)})`,
            subtitle: `Hops photos, video and voice took in the week to ${day}`,
            legend: [[cssColor('--mediamesh-node-color', '#d946ef'), 'hop this week'], [cssColor('--status-red', '#dc2626'), 'only way through'], [cssColor('--status-amber', '#d97706'), 'on most hops'], ['#0891b2', 'suggested link']],
            // the map's credits travel with the picture
            footer: [((m.getContainer().querySelector('.leaflet-control-attribution') || {}).textContent || '').replace(/^\W*Leaflet\s*\|?\s*/, '').trim(), (root.location && root.location.host) || ''].filter(Boolean).join(' · '),
            labels,
          });
          btn.disabled = false;
          if (blob) saveBlob(blob, `mediamesh-resilience-${day}.png`);
        });
      }
    }
    const fetcher = (opts && opts.api) || root.api;
    if (typeof fetcher !== 'function') return;
    let data;
    try {
      data = await fetcher('/analytics/mediamesh/clips?days=' + DAYS_BACK, { ttl: 60000 });
    } catch (_) {
      ['#mmDeliveryCard', '#mmSpeedCard', '#mmBusyCard'].forEach((s) => { const c = el.querySelector(s); if (c) c.innerHTML = '<p class="text-muted">Couldn\'t load the clips.</p>'; });
      return;
    }
    if (state !== me) return;
    const clips = (data && data.clips) || [];
    const days = Math.max(1, Math.round((Date.parse(data.to) - Date.parse(data.from)) / 86400000)) || DAYS_BACK;
    const put = (sel, html) => { const c = el.querySelector(sel); if (c) c.innerHTML = html; };
    const unannounced = (data && data.unannounced) || [];
    put('#mmDeliveryCard', deliveryHtml(clips, nameOf, days, unannounced));
    put('#mmSpeedCard', speedHtml(clips, nameOf, days, unannounced));
    const grid = busyGrid(data.hours, data.from, data.to);
    put('#mmBusyCard', busyHtml(grid, 'packets', days));
    const delivery = el.querySelector('#mmDeliveryCard');
    if (delivery) {
      me.onClip = (e) => {
        const b = e.target.closest('[data-mm-clip]');
        if (b && root.MediaMeshClipLog) root.MediaMeshClipLog.open(b.dataset.mmClip);
      };
      delivery.addEventListener('click', me.onClip);
    }
    // #/analytics?tab=mediamesh&clip={sid} opens that clip's flight recorder
    const want = /[?&]clip=([0-9a-f]{8})\b/i.exec((root.location && root.location.hash) || '');
    if (want && root.MediaMeshClipLog && !me.openedFromLink) { me.openedFromLink = true; root.MediaMeshClipLog.open(want[1]); }
    const busy = el.querySelector('#mmBusyCard');
    if (busy) {
      me.onBusy = (e) => {
        const b = e.target.closest('[data-mm-busy]');
        if (b) busy.innerHTML = busyHtml(grid, b.dataset.mmBusy, days);
      };
      busy.addEventListener('click', me.onBusy);
    }
  }

  function destroy() {
    if (!state) return;
    state.maps.forEach((m) => { try { m.remove(); } catch (_) { /* gone */ } });
    const busy = state.el.querySelector('#mmBusyCard');
    if (busy && state.onBusy) busy.removeEventListener('click', state.onBusy);
    const delivery = state.el.querySelector('#mmDeliveryCard');
    if (delivery && state.onClip) delivery.removeEventListener('click', state.onClip);
    state = null;
  }

  /** The tab's placeholders for these cards. */
  function cardsHtml() {
    const card = (id, title) => `<div class="analytics-row"><div class="analytics-card flex-1 mm-ins-card" id="${id}"><h3>${title}</h3><p class="text-muted">Loading…</p></div></div>`;
    return card('mmDeliveryCard', 'How much of each clip the observers heard') + card('mmSpeedCard', 'How fast clips cross the mesh')
      + card('mmWeakCard', 'Where one repeater going down would split MediaMesh') + card('mmBusyCard', 'When MediaMesh is busy');
  }

  root.MediaMeshInsights = {
    init, destroy, cardsHtml, namer, routeLabel, clipLabel, whenHtml, deliverySummary, deliveryHtml, arrivalSummary, arrivalText, speedRows, speedSummary, speedHtml,
    busyGrid, busyHtml, backboneGraph, components, resilienceScore, weakSpots, weakHtml, median, mapPng,
  };
})(typeof window !== 'undefined' ? window : globalThis);
