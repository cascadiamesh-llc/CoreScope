/* === CoreScope — mediamesh-cliplog.js ===
 * The flight recorder of one photo, video or voice clip: every piece every
 * observer heard on radio2, when and by which path, drawn as a waterfall, with
 * a plain account of what happened (how long it took, where pieces were lost,
 * where it stalled, what parity saved). From /api/analytics/mediamesh/clips/{sid}.
 *
 * Open it with MediaMeshClipLog.open(sid); the Insights "Recent clips" rows,
 * the Live feed's transfer cards and #/analytics?tab=mediamesh&clip={sid} do.
 * The pure parts (story, waterfallSvg, observersOf, stalls) are tested in
 * tests/unit/test-mediamesh-cliplog.js.
 */
'use strict';

(function (root) {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const KIND = { photo: 'Photo', video: 'Video', voice: 'Voice message' };
  const OBS_COLOURS = 6; // .mm-fr-o0 … .mm-fr-o5

  /** "42 s", "8 min 10 s", "1 h 4 min". */
  function dur(s) {
    if (!Number.isFinite(s)) return '';
    s = Math.max(0, s);
    if (s < 10) return `${s.toFixed(1).replace(/\.0$/, '')} s`;
    if (s < 60) return `${Math.round(s)} s`;
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  }

  function list(nums) {
    const xs = nums.map((n) => String(n + 1)); // pieces are numbered from 1 for people
    if (xs.length <= 1) return xs.join('');
    if (xs.length > 6) return xs.slice(0, 5).join(', ') + ` and ${xs.length - 5} more`;
    return xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  }

  const t = (iso) => Date.parse(iso);

  /** The time everything is measured from: the announcement, else the first piece heard. */
  function startOf(log) {
    const a = log.announcement && t(log.announcement.at);
    if (Number.isFinite(a)) return a;
    let first = Infinity;
    (log.pieces || []).forEach((p) => (p.heard || []).forEach((h) => { first = Math.min(first, t(h.at)); }));
    return Number.isFinite(first) ? first : 0;
  }

  /**
   * Each observer that heard pieces: { id, name, hops (most), data (Set of
   * indexes), parity, first, last (ms) }, the far end (the clip's observer)
   * first, then by hops, most first.
   */
  function observersOf(log) {
    const by = new Map();
    (log.pieces || []).forEach((p) => (p.heard || []).forEach((h) => {
      const k = h.observer || h.name;
      let o = by.get(k);
      if (!o) { o = { id: k, name: h.name || k, hops: 0, data: new Set(), parity: 0, first: Infinity, last: -Infinity }; by.set(k, o); }
      o.hops = Math.max(o.hops, (h.path || []).length);
      if (p.parity) o.parity++; else o.data.add(p.index);
      const at = t(h.at);
      if (at < o.first) o.first = at;
      if (at > o.last) o.last = at;
    }));
    const far = log.clip && log.clip.observer;
    return [...by.values()].sort((a, b) => (b.id === far) - (a.id === far) || b.hops - a.hops || b.data.size - a.data.size || (a.name < b.name ? -1 : 1));
  }

  /**
   * Where the far end waited: gaps between pieces arriving longer than
   * 20 s and four times the usual gap. [{ from, to (ms), after (piece
   * index heard before the gap) }], longest first.
   */
  function stalls(log, farId) {
    const arr = [];
    (log.pieces || []).forEach((p) => (p.heard || []).forEach((h) => {
      if ((h.observer || h.name) === farId) arr.push({ at: t(h.at), p });
    }));
    arr.sort((a, b) => a.at - b.at);
    if (arr.length < 3) return [];
    const gaps = [];
    for (let i = 1; i < arr.length; i++) gaps.push(arr[i].at - arr[i - 1].at);
    const sorted = gaps.slice().sort((a, b) => a - b);
    const usual = sorted[Math.floor(sorted.length / 2)];
    const out = [];
    gaps.forEach((g, i) => {
      if (g > 20000 && g > usual * 4) out.push({ from: arr[i].at, to: arr[i + 1].at, after: arr[i].p });
    });
    return out.sort((a, b) => (b.to - b.from) - (a.to - a.from));
  }

  const hopName = (log, h) => {
    const x = log.hops && log.hops[String(h).toLowerCase()];
    return (x && x.name) || String(h).toUpperCase();
  };

  /** What happened, in a few sentences (HTML). */
  function story(log) {
    const c = log.clip;
    const total = c ? c.total : 0;
    const t0 = startOf(log);
    const obs = observersOf(log);
    const far = obs[0];
    const out = [];
    if (!far) {
      out.push(c ? `Announced, but no observer heard any of its ${total} pieces on MediaMesh.` : 'Nothing of this clip was heard.');
      return out.map((s) => `<p>${s}</p>`).join('');
    }
    const farName = `<strong>${esc(far.name)}</strong>`;
    const hops = `${far.hops} hop${far.hops === 1 ? '' : 's'}`;
    const took = dur((far.last - Math.min(t0, far.first)) / 1000);
    if (c && c.outcome === 'whole') out.push(`${farName}, ${hops} away, heard all of it, ${took} after it was announced.`);
    else if (c && c.outcome === 'parity') out.push(`${farName}, ${hops} away, heard all of it in ${took}: piece${(c.rebuilt || []).length === 1 ? '' : 's'} ${list(c.rebuilt || [])} didn't reach it, and ${(c.rebuilt || []).length === 1 ? 'was' : 'were'} rebuilt from the parity pieces.`);
    else if (c && c.outcome === 'partial') out.push(`${farName}, ${hops} away, heard ${total - (c.missing || []).length} of ${total} pieces; piece${(c.missing || []).length === 1 ? '' : 's'} ${list(c.missing || [])} didn't reach it. That's what this observer heard, not what the recipient got: observers miss pieces that pass out of their hearing or while they listen to the main mesh, and the receiving app rebuilds or asks again for what it missed.`);
    // delivery receipts from the receiving apps: what actually arrived
    const d = c && c.delivery;
    if (d && d.recipients > 0) {
      const how = [d.asked ? `${d.asked} after asking again for a missing piece` : '', d.rebuilt ? `${d.rebuilt} with parity` : ''].filter(Boolean).join(', ');
      out.push(d.recipients === 1
        ? (d.whole ? `The receiving app reported it whole${how ? ` (${how})` : ''}.` : 'The receiving app reported it arrived in part.')
        : `${d.whole} of ${d.recipients} receiving apps reported it whole${how ? ` (${how})` : ''}.`);
    }
    else out.push(`${farName} heard ${far.data.size} piece${far.data.size === 1 ? '' : 's'} over ${hops}${c ? '' : ' (no announcement heard, so the total is unknown)'}.`);
    if (Number.isFinite(t0) && log.announcement) {
      const wait = (far.first - t0) / 1000;
      if (wait > 1) out.push(`The first piece reached ${esc(far.name)} ${dur(wait)} after the announcement.`);
    }
    const st = stalls(log, far.id)[0];
    if (st) {
      const p = st.after;
      const what = p.repair ? 'a repair piece' : p.parity ? 'a parity piece' : `piece ${p.index + 1}`;
      out.push(`It stalled for <strong>${dur((st.to - st.from) / 1000)}</strong> after ${what}, at +${dur((st.from - t0) / 1000)}, before the next piece reached ${esc(far.name)}.`);
    }
    // loss along the way: an observer nearer the sender that heard more than the far end
    const nearer = obs.filter((o) => o !== far && o.hops < far.hops && o.data.size > far.data.size).sort((a, b) => b.hops - a.hops)[0];
    if (nearer) {
      const lost = [...nearer.data].filter((i) => !far.data.has(i)).sort((a, b) => a - b);
      const fixed = lost.filter((i) => (c && c.rebuilt || []).includes(i));
      out.push(`${esc(nearer.name)}, ${nearer.hops} hop${nearer.hops === 1 ? '' : 's'} out, heard ${nearer.data.size}; piece${lost.length === 1 ? '' : 's'} ${list(lost)} ${lost.length === 1 ? 'was' : 'were'} heard there but not at ${esc(far.name)}`
        + (fixed.length && fixed.length < lost.length ? ` (${list(fixed)} rebuilt from parity there).` : fixed.length ? ', and rebuilt from parity there.' : '.'));
    }
    if (c && c.bytes && c.durationS > 0) out.push(`${(c.bytes / 1024).toFixed(1)} KB over ${dur(c.durationS)} from first piece to last: about ${((c.bytes * 8) / c.durationS / 1000).toFixed(2)} kbit/s.`);
    if (obs.length > 1) out.push(`${obs.length} observers heard it on MediaMesh.`);
    return out.map((s) => `<p>${s}</p>`).join('');
  }

  /**
   * The waterfall: a row per piece (data, then parity), time across, a dot
   * for each observer hearing it. Missing and rebuilt pieces are marked on
   * their rows, and the far end's stalls shaded.
   */
  function waterfallSvg(log, opts) {
    const obs = observersOf(log);
    const colour = new Map(obs.map((o, i) => [o.id, i % OBS_COLOURS]));
    const c = log.clip;
    const data = (log.pieces || []).filter((p) => !p.parity), parity = (log.pieces || []).filter((p) => p.parity);
    const total = Math.max(c ? c.total : 0, data.reduce((m, p) => Math.max(m, p.index + 1), 0));
    const rows = total + (parity.length ? parity.length + 1 : 0);
    const t0 = startOf(log);
    let tMax = t0 + 1000;
    (log.pieces || []).forEach((p) => (p.heard || []).forEach((h) => { tMax = Math.max(tMax, t(h.at)); }));
    const W = (opts && opts.width) || 760, left = 64, right = 14, top = 22;
    const rowH = rows > 120 ? 3 : rows > 60 ? 6 : rows > 30 ? 10 : 14;
    const H = top + rows * rowH + 24;
    const x = (ms) => left + ((ms - t0) / (tMax - t0)) * (W - left - right);
    const y = (r) => top + r * rowH + rowH / 2;
    const r = Math.max(1.5, Math.min(4.5, rowH / 2.6));
    let svg = '';
    // shaded stalls
    if (obs[0]) {
      stalls(log, obs[0].id).forEach((s) => {
        svg += `<rect class="mm-fr-stall" x="${x(s.from).toFixed(1)}" y="${top - 4}" width="${Math.max(1, x(s.to) - x(s.from)).toFixed(1)}" height="${rows * rowH + 8}"><title>Stalled ${dur((s.to - s.from) / 1000)}</title></rect>`;
        svg += `<text class="mm-fr-axis" x="${((x(s.from) + x(s.to)) / 2).toFixed(1)}" y="${top - 8}" text-anchor="middle">stalled ${esc(dur((s.to - s.from) / 1000))}</text>`;
      });
    }
    // gridlines and the time axis: about six ticks at round steps
    const span = (tMax - t0) / 1000;
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => span / s <= 6) || 7200;
    for (let s = 0; s <= span; s += step) {
      const gx = x(t0 + s * 1000).toFixed(1);
      svg += `<line class="mm-fr-grid" x1="${gx}" x2="${gx}" y1="${top - 2}" y2="${top + rows * rowH}"/>`;
      svg += `<text class="mm-fr-axis" x="${gx}" y="${H - 6}" text-anchor="middle">${s ? '+' + esc(dur(s)) : (log.announcement ? 'announced' : 'first heard')}</text>`;
    }
    const missing = new Set(c ? c.missing || [] : []), rebuilt = new Set(c ? c.rebuilt || [] : []);
    const label = (row, text, cls) => `<text class="mm-fr-label${cls ? ' ' + cls : ''}" x="${left - 6}" y="${(y(row) + 3).toFixed(1)}" text-anchor="end">${esc(text)}</text>`;
    const every = rowH >= 10 ? 1 : rowH >= 6 ? 5 : 20;
    for (let i = 0; i < total; i++) {
      const cls = missing.has(i) ? 'is-missing' : rebuilt.has(i) ? 'is-rebuilt' : '';
      if (cls) svg += `<rect class="mm-fr-row ${cls}" x="${left}" y="${(top + i * rowH).toFixed(1)}" width="${W - left - right}" height="${rowH}"><title>Piece ${i + 1}: ${missing.has(i) ? 'not heard at the far end' : 'rebuilt from parity or repair pieces at the far end'}</title></rect>`;
      if (cls || i % every === 0 || i === total - 1) svg += label(i, (missing.has(i) ? '× ' : rebuilt.has(i) ? 'rebuilt ' : '') + (i + 1), cls);
    }
    if (parity.length) svg += label(total, parity.some((p) => p.repair) ? 'repair' : 'parity', 'mm-fr-label--head');
    const rowOf = (p) => (p.parity ? total + 1 + parity.indexOf(p) : p.index);
    (log.pieces || []).forEach((p) => {
      const row = rowOf(p);
      (p.heard || []).forEach((h) => {
        const k = colour.get(h.observer || h.name) || 0;
        const at = t(h.at);
        const route = (h.path || []).map((hop) => hopName(log, hop)).join(' › ');
        const what = p.repair ? `Repair piece (mix ${p.seed + 1})` : p.parity ? `Parity piece (block ${p.block + 1})` : `Piece ${p.index + 1}`;
        svg += `<circle class="mm-fr-dot mm-fr-o${k}" cx="${x(at).toFixed(1)}" cy="${y(row).toFixed(1)}" r="${r.toFixed(1)}"><title>${esc(what)} · ${esc(h.name || h.observer)} · +${esc(dur((at - t0) / 1000))}${route ? ' · via ' + esc(route) : ''}</title></circle>`;
      });
    });
    return `<svg class="mm-fr-wf" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Every piece of the clip, when each observer heard it">${svg}</svg>`;
  }

  /** The observers, with their colour, hops, pieces and time. */
  function observersHtml(log) {
    const t0 = startOf(log), c = log.clip;
    const rows = observersOf(log).map((o, i) => {
      const via = (() => {
        // the longest path it heard a piece by
        let best = [];
        (log.pieces || []).forEach((p) => (p.heard || []).forEach((h) => { if ((h.observer || h.name) === o.id && (h.path || []).length > best.length) best = h.path; }));
        return best.map((hop) => esc(hopName(log, hop))).join(' › ');
      })();
      const far = c && c.observer === o.id ? ' <span class="mm-fr-far">far end</span>' : '';
      return `<tr><td><span class="mm-fr-key mm-fr-o${i % OBS_COLOURS}" aria-hidden="true"></span>${esc(o.name)}${far}</td><td class="mm-ins-num">${o.hops}</td>
        <td class="mm-ins-num">${o.data.size}${c ? ' / ' + c.total : ''}${o.parity ? ` <span class="text-muted" title="Parity and Fast MediaMesh repair pieces">+${o.parity} repair</span>` : ''}</td>
        <td class="mm-ins-num">+${esc(dur((o.first - t0) / 1000))}</td><td class="mm-ins-num">+${esc(dur((o.last - t0) / 1000))}</td><td class="mm-fr-via">${via || '<span class="text-muted">direct</span>'}</td></tr>`;
    }).join('');
    return `<table class="analytics-table mm-ins-table mm-fr-obs"><thead><tr><th scope="col">Observer</th><th scope="col" class="mm-ins-num">Hops</th><th scope="col" class="mm-ins-num">Pieces</th><th scope="col" class="mm-ins-num">First</th><th scope="col" class="mm-ins-num">Last</th><th scope="col">Route</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  /** The whole view's HTML. */
  function viewHtml(log) {
    const c = log.clip;
    const kind = c ? (KIND[c.kind] || 'Clip') + (c.kind !== 'photo' && c.seconds ? `, ${c.seconds} s` : '') : 'Clip';
    const outcome = c ? { whole: 'Heard whole', parity: 'Heard whole, with parity', partial: 'Heard in part', none: 'Not heard' }[c.outcome] || '' : '';
    const ann = log.announcement;
    const caption = ann ? ann.text.replace(/(^|[\s:])(VI1|VV1|VE3|VM1):[0-9a-z:]+\s*/i, '$1').trim() : '';
    const when = ann ? new Date(ann.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="mm-fr-head">
        <div><h3 id="mmFrTitle">Flight recorder: ${esc(kind)}${c ? ` · ${c.total} pieces` : ''}</h3>
        <p class="text-muted mm-fr-sub">${caption ? `“${esc(caption)}”` : ''}${caption && ann.channel ? ' · ' : ''}${ann && ann.channel ? esc(ann.channel) : ''}${when ? ` · announced ${esc(when)}` : ''} · <code>${esc(log.sid)}</code></p></div>
        ${outcome ? `<span class="mm-ins-outcome mm-ins-outcome--${esc(c.outcome)} mm-fr-badge">${esc(outcome)}</span>` : ''}
        <button type="button" class="mm-fr-close" data-mm-fr-close aria-label="Close"><svg class="ph-icon" aria-hidden="true"><use href="/icons/phosphor-sprite.svg#ph-x"/></svg></button>
      </div>
      <div class="mm-fr-story">${story(log)}</div>
      <div class="mm-fr-scroll">${waterfallSvg(log)}</div>
      <p class="text-muted mm-fr-key-line">Each dot is one observer hearing one piece; hover for when and by which path. <span class="mm-fr-row-key is-missing"></span> not heard at the far end · <span class="mm-fr-row-key is-rebuilt"></span> rebuilt from parity · shaded: the far end waiting.</p>
      <div class="mm-ins-scroll">${observersHtml(log)}</div>`;
  }

  let openState = null;

  function close() {
    if (!openState) return;
    const s = openState;
    openState = null;
    document.removeEventListener('keydown', s.onKey);
    s.el.remove();
    if (s.back && s.back.focus) s.back.focus();
  }

  /** Opens the flight recorder of clip sid over the page. */
  async function open(sid, opts) {
    close();
    const back = document.activeElement;
    const el = document.createElement('div');
    el.className = 'mm-fr-overlay';
    el.innerHTML = '<div class="mm-fr-panel" role="dialog" aria-modal="true" aria-labelledby="mmFrTitle"><div class="mm-fr-head"><h3 id="mmFrTitle">Flight recorder</h3><button type="button" class="mm-fr-close" data-mm-fr-close aria-label="Close"><svg class="ph-icon" aria-hidden="true"><use href="/icons/phosphor-sprite.svg#ph-x"/></svg></button></div><p class="text-muted">Loading…</p></div>';
    document.body.appendChild(el);
    const me = openState = { el, back };
    me.onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', me.onKey);
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-mm-fr-close]')) close(); });
    el.querySelector('[data-mm-fr-close]').focus();
    const panel = el.querySelector('.mm-fr-panel');
    let log = null;
    try {
      const api = (opts && opts.api) || root.api;
      log = typeof api === 'function'
        ? await api('/analytics/mediamesh/clips/' + encodeURIComponent(String(sid).toLowerCase()), { ttl: 30000 })
        : await (await CSApi.fetch('/api/analytics/mediamesh/clips/' + encodeURIComponent(String(sid).toLowerCase()))).json();
    } catch (_) { log = null; }
    if (openState !== me) return;
    if (!log || !log.sid) {
      panel.innerHTML = '<div class="mm-fr-head"><h3 id="mmFrTitle">Flight recorder</h3><button type="button" class="mm-fr-close" data-mm-fr-close aria-label="Close"><svg class="ph-icon" aria-hidden="true"><use href="/icons/phosphor-sprite.svg#ph-x"/></svg></button></div><p class="text-muted">Nothing of this clip has been heard on MediaMesh in the last four weeks, or it is still on its way: try again in a minute.</p>';
    } else {
      panel.innerHTML = viewHtml(log);
    }
    const btn = panel.querySelector('[data-mm-fr-close]');
    if (btn) btn.focus();
  }

  root.MediaMeshClipLog = { open, close, story, waterfallSvg, observersOf, stalls, viewHtml, dur };
})(typeof window !== 'undefined' ? window : globalThis);
