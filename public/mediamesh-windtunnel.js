/* === CoreScope — mediamesh-windtunnel.js ===
 * The wind tunnel, in MediaMeshLab: the last 30 days' real clips sent again
 * through the mesh as changed there (repeaters down, one added) and with a
 * different radio2 preset or repair setting, to see before anyone climbs a
 * roof or ships an app update how many would arrive whole, how long they'd
 * take and how much radio2 airtime they'd use.
 *
 * A model, and a rough one:
 * - each piece crosses each hop with one chance, p, worked out from how much
 *   of each clip its far-end observer heard over how many hops;
 * - a preset's extra margin (about 2.5 dB a spreading factor, 3 dB each
 *   halving of the bandwidth) moves p along a logistic curve;
 * - Fast MediaMesh sends a tenth of the pieces again as repair pieces up
 *   front, then the receiver asks for what's missing, and each repair piece
 *   makes up for any one lost piece (VoxFountain); plain resends ask for the
 *   missing pieces themselves;
 * - airtime is LoRa's time on air for each piece, once per repeater on the
 *   way; time is the pieces at the fast gap (2.4 airtimes, at least 150 ms)
 *   plus a second a hop for each ask.
 * Each clip is sent 200 times, with the same seeded dice either side, so a
 * change shows its own effect and not chance.
 */
'use strict';

(function (root) {
  const RUNS = 200;
  const PIECE_BYTES = 172;      // a 163-byte piece and MeshCore's header and path
  const ASK_BYTES = 24;
  const PREAMBLE = 16;
  const K_PER_DB = 0.3;         // logit change per dB of margin

  const PRESETS = [
    { id: '250-7', label: '250 kHz, SF7 (now)', bwKHz: 250, sf: 7 },
    { id: '250-8', label: '250 kHz, SF8', bwKHz: 250, sf: 8 },
    { id: '125-7', label: '125 kHz, SF7', bwKHz: 125, sf: 7 },
    { id: '125-8', label: '125 kHz, SF8', bwKHz: 125, sf: 8 },
    { id: '62-7', label: '62.5 kHz, SF7', bwKHz: 62.5, sf: 7 },
  ];
  const REPAIRS = [
    { id: 'fast', label: 'Fast MediaMesh, a tenth up front (now)', fountain: true, upFront: (n) => (n < 2 ? 0 : Math.ceil(n / 10) + 1) },
    { id: 'fast0', label: 'Fast MediaMesh, nothing up front', fountain: true, upFront: () => 0 },
    { id: 'fast25', label: 'Fast MediaMesh, a quarter up front', fountain: true, upFront: (n) => (n < 2 ? 0 : Math.ceil(n / 4) + 1) },
    { id: 'plain', label: 'Plain resends of what\'s missing', fountain: false, upFront: () => 0 },
  ];

  /** LoRa time on air, seconds: explicit header, CRC, coding rate 4/5. */
  function airtimeS(bytes, sf, bwKHz) {
    const tSym = Math.pow(2, sf) / (bwKHz * 1000);
    const de = tSym > 0.016 ? 1 : 0;
    const n = 8 + Math.max(Math.ceil((8 * bytes - 4 * sf + 28 + 16) / (4 * (sf - 2 * de))) * 5, 0);
    return (PREAMBLE + 4.25) * tSym + n * tSym;
  }

  /** Margin over 250 kHz SF7, dB. */
  function marginDb(preset) {
    return 2.5 * (preset.sf - 7) + 10 * Math.log10(250 / preset.bwKHz);
  }

  const logit = (p) => Math.log(p / (1 - p));
  const expit = (x) => 1 / (1 + Math.exp(-x));

  /** A hop's chance with `db` more margin than now. */
  function shiftP(p, db) {
    const q = Math.min(0.995, Math.max(0.05, p));
    return expit(logit(q) + K_PER_DB * db);
  }

  /** The chance a piece crosses a hop, from the clips' far ends: for each
   * clip heard over h hops, (pieces heard / pieces)^(1/h); the upper
   * quartile, since a far-end observer off the clip's way hears less than
   * arrives. 0.85 when no clip says. */
  function hopChance(clips) {
    const est = (clips || [])
      .filter((c) => c.total > 0 && c.heard > 0 && c.hops > 0)
      .map((c) => Math.pow(Math.min(1, c.heard / c.total), 1 / c.hops))
      .sort((a, b) => a - b);
    if (!est.length) return 0.85;
    const q = est[Math.min(est.length - 1, Math.floor(est.length * 0.75))];
    return Math.min(0.99, Math.max(0.5, q));
  }

  /** A seeded random source (mulberry32). */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const count = (k, p, r) => { let n = 0; for (let i = 0; i < k; i++) if (r() < p) n++; return n; };

  /**
   * One clip sent: { whole, sent (pieces), rounds, seconds }. total pieces,
   * pe the chance a piece gets end to end, pa an ask's, repair (REPAIRS),
   * rounds most asks, toa a piece's airtime (s), hops.
   */
  function sendOnce(total, pe, pa, repair, maxRounds, toa, hops, r) {
    const gap = Math.max(2.4 * toa, 0.15);
    const first = repair.upFront(total);
    let sent = total + first;
    let have = repair.fountain ? Math.min(total, count(total, pe, r) + count(first, pe, r)) : count(total, pe, r);
    let seconds = sent * gap, rounds = 0;
    while (have < total && rounds < maxRounds) {
      rounds++;
      seconds += hops * 1 + toa;           // the ask, there
      if (r() >= pa) continue;             // the ask was lost: wait and ask again
      const m = total - have;
      const k = repair.fountain ? m + Math.ceil(m * 0.15) + 1 : m;
      sent += k;
      seconds += k * gap;
      have = Math.min(total, have + count(k, pe, r));
    }
    return { whole: have >= total, sent, rounds, seconds };
  }

  /**
   * The clips, sent RUNS times each: { n, whole (share), medianS (time to
   * whole, of those whole), airtimeS (expected, all clips), lost (no way) }.
   * items: [{ total, hops (null: no way through) }].
   */
  function runAll(items, p, opts) {
    const preset = opts.preset, repair = opts.repair;
    const toa = airtimeS(PIECE_BYTES, preset.sf, preset.bwKHz), toaAsk = airtimeS(ASK_BYTES, preset.sf, preset.bwKHz);
    const ph = shiftP(p, marginDb(preset));
    let wholeRuns = 0, runs = 0, air = 0, lost = 0;
    const times = [];
    items.forEach((it, i) => {
      if (it.hops == null) { lost++; return; }
      const h = Math.max(1, it.hops);
      const pe = Math.pow(ph, h), pa = Math.pow(ph, h);
      const r = rng(1000 + i);
      let clipAir = 0;
      for (let k = 0; k < RUNS; k++) {
        const s = sendOnce(it.total, pe, pa, repair, opts.rounds, toa, h, r);
        runs++;
        if (s.whole) { wholeRuns++; times.push(s.seconds); }
        clipAir += s.sent * toa * (h + 1) + s.rounds * toaAsk * (h + 1);
      }
      air += clipAir / RUNS;
    });
    times.sort((a, b) => a - b);
    const sent = items.length - lost;
    return {
      n: items.length, lost,
      whole: runs ? (wholeRuns / runs) * (sent / Math.max(1, items.length)) : 0,
      medianS: times.length ? times[times.length >> 1] : null,
      airtimeS: air,
      hopChance: ph,
    };
  }

  const pct = (v) => `${Math.round(v * 100)}%`;
  const dur = (s) => (s == null ? '—' : s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

  function controlsHtml() {
    const opts = (list) => list.map((o, i) => `<option value="${o.id}"${i === 0 ? ' selected' : ''}>${o.label}</option>`).join('');
    return `<div class="mmw-controls">
      <label>radio2 preset <select id="mmwPreset">${opts(PRESETS)}</select></label>
      <label>Repair <select id="mmwRepair">${opts(REPAIRS)}</select></label>
      <label>Asks for what's missing, at most <select id="mmwRounds"><option value="1">1</option><option value="3" selected>3 (now)</option><option value="5">5</option></select></label>
    </div>
    <div class="mml-tiles mmw-tiles" id="mmwTiles"></div>
    <p class="text-muted mmw-note" id="mmwNote"></p>`;
  }

  function tilesHtml(a, b) {
    const tile = (label, x, y, better) => `<div class="mml-tile"><div class="mml-label">${label}</div><div class="mml-big">${x} <span class="mml-arrow" aria-label="becomes">→</span> <span class="${better == null ? '' : better ? 'mms-good' : 'mms-bad'}">${y}</span></div></div>`;
    const cmp = (x, y, higherBetter) => (Math.abs(x - y) < 1e-9 ? null : higherBetter ? y > x : y < x);
    return tile('Arrive whole', pct(a.whole), pct(b.whole), cmp(Math.round(a.whole * 100), Math.round(b.whole * 100), true))
      + tile('Typical time to whole', dur(a.medianS), dur(b.medianS), a.medianS == null || b.medianS == null ? null : cmp(Math.round(a.medianS), Math.round(b.medianS), false))
      + tile('radio2 airtime for these clips', dur(a.airtimeS), dur(b.airtimeS), cmp(Math.round(a.airtimeS), Math.round(b.airtimeS), false))
      + tile('Lost for want of a way through', String(a.lost), String(b.lost), cmp(a.lost, b.lost, false));
  }

  /** The clips to send: announced ones whose pieces are known. */
  function itemsFrom(clips, hopsOf) {
    return (clips || []).filter((c) => c.total > 0 && Array.isArray(c.path) && c.path.length).map((c) => ({ total: c.total, hops: hopsOf(c) }));
  }

  root.MediaMeshWindTunnel = { PRESETS, REPAIRS, airtimeS, marginDb, shiftP, hopChance, rng, sendOnce, runAll, controlsHtml, tilesHtml, itemsFrom };
})(typeof window !== 'undefined' ? window : globalThis);
