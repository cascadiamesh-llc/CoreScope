/* === CoreScope — mediamesh-coverage.js ===
 * MediaMesh coverage estimate for the analytics MediaMesh tab: where photos
 * and voice on radio2 should get through, from each MediaMesh repeater's
 * position and the terrain. Conservative on purpose (see CONFIG).
 *
 * Model, per repeater:
 *  - Rays every quarter of a degree out to the mode's radius. Along each ray
 *    the terrain is sampled every stepM near the repeater and more sparsely
 *    further out; a sparse sample carries the highest ground of the stretch
 *    it stands for, so a narrow ridge is never stepped over.
 *  - Terrain from Mapzen terrarium elevation tiles fetched by the browser,
 *    bilinear between pixels: zoom 12 right around each repeater, zoom 11 in
 *    the wider neighbourhood, zoom 10 beyond.
 *  - The earth's curve at k = 4/3.
 *  - Free-space loss at the repeater's own radio2 frequency.
 *  - Diffraction by the cascaded knife-edge method of ITU-R P.526-11 §4.4.2
 *    (Deygout, up to three edges, with the recommendation's empirical
 *    correction). It also charges for terrain that only intrudes into the
 *    first Fresnel zone, so a path has to clear the ground by a margin, not
 *    just see over it.
 *  - Receiver sensitivity from the repeater's reported radio2 setting
 *    (bandwidth and spreading factor), the default preset when unknown.
 * Buildings and trees are not in the terrain data; ground mode adds the
 * city clutter loss of ITU-R P.2108 (by distance, not over open water) for
 * a radio held among them, with a handheld's antenna. Where you are (out of
 * doors, in a car, indoors) takes a little more off, and measured coverage
 * points (the apps' coverage recorders, sent to the analyzer) correct the
 * whole estimate and each repeater, up or down. Each map cell keeps the best
 * repeater's margin over the receiver's sensitivity.
 *
 * The heavy part (repRaster) runs in Web Workers when the browser allows, on
 * the page otherwise. No dependencies for the maths, so
 * tests/unit/test-mediamesh-coverage.js runs it in Node with synthetic terrain.
 */
'use strict';

(function (root) {
  const CONFIG = {
    // The default MediaMesh preset, used when a repeater's radio2 setting is
    // not known.
    freqMHz: 911.15,
    bwKHz: 250,
    sf: 7,
    txDbm: 22,           // conservative transmit power (SX1262 / LR1121 maximum)
    txGainDbi: 2,        // repeater antenna
    cableDb: 1,
    txHeightM: 10,       // every repeater's antenna, above ground
    // Receiver noise figure. 6.5 dB makes sensitivityDbm() match the SX1262
    // datasheet (DS.SX1261-2, Rx boosted gain) at SF7: -124 dBm at 125 kHz and
    // -121 dBm at 250 kHz, and stay within 1.5 dB of its other rows.
    noiseFigureDb: 6.5,
    fadeMarginDb: 10,    // safety margin
    kFactor: 4 / 3,      // effective earth radius for radio
    earthRadiusM: 6371000,
    bands: { strong: 15, fair: 5, marginal: 0 }, // dB to spare
    modes: {
      ground: {
        label: 'People on the ground',
        note: 'People on the ground: a companion or standalone radio held in the hand at 1.5 m, among buildings.',
        // A radio held in the hand: a short antenna next to the body
        // (about -4 dBi with the body's loss), among buildings and trees
        // (clutter: ITU-R P.2108 by distance, clutterLossDb).
        rxHeightM: 1.5, rxGainDbi: -4, clutterDb: 0, clutter: 'p2108',
        // The links heard on radio2 run between repeaters, mostly higher up
        // than the 10 m assumed, and only links strong enough to be heard
        // are in them: they can lower this estimate but never raise it.
        // Measured coverage points replace them for this view (CONFIG.field).
        calibrateUp: false,
        radiusKm: 30, stepM: 50, growth: 0.012, rays: 1440, cellM: 100,
      },
      repeater: {
        label: 'Repeater to repeater',
        note: 'Repeater to repeater: both antennas 10 m up.',
        rxHeightM: 10, rxGainDbi: 2, clutterDb: 0, calibrateUp: true,
        radiusKm: 60, stepM: 100, growth: 0.012, rays: 1440, cellM: 200,
      },
    },
    // Where you are, for people on the ground: more taken off every path.
    // A car body; an ordinary building (ITU-R P.2109, the median for a
    // traditional building at 0.9 GHz).
    places: [
      { key: 'outdoors', label: 'Outdoors', lossDb: 0 },
      { key: 'car', label: 'In a car', lossDb: 8 },
      { key: 'indoors', label: 'Indoors', lossDb: 14 },
    ],
    // Fitting the estimate for people on the ground to measured coverage
    // points (GET /api/mediamesh/coverage-points): at least minCells cells
    // where a repeater answered, a correction within +maxUpDb / -maxDownDb;
    // each repeater with repMinCells of its own gets its own, pulled towards
    // the overall one (repShrink cells' worth). A repeater within nearKm of
    // a cell that didn't answer there counts as below unheardDb (it would
    // have answered on the main mesh, 6 dB more sensitive, above that).
    field: { minCells: 15, maxUpDb: 10, maxDownDb: 25, repMinCells: 5, repShrink: 10, nearKm: 6, unheardDb: -6, maxPairs: 800, carMinCells: 10 },
    // A quicker, coarser version of `ground`, for screening many spots or
    // drawing hundreds of main-mesh repeaters.
    quick: { rays: 360, radiusKm: 20, stepM: 100, cellM: 200 },
    // The main mesh's preset (MeshCore's US recommended), for the comparison.
    mainRadio: '910.525,62.5,7,5',
    // Terrain detail: zoom 12 (about 26 m per pixel at Seattle's latitude)
    // within nearKm of a repeater, zoom 11 within midKm, zoom 10 to the radius.
    terrain: { nearZoom: 12, nearKm: 1.5, midZoom: 11, midKm: 15, farZoom: 10 },
    edgeFade: 0.15,      // the drawing fades out over this last share of the radius
    terrainUrl: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    terrainAttribution: 'Terrain: Mapzen terrain tiles (SRTM, USGS NED and others)',
  };

  // `quick`: people on the ground, coarser and shorter (see CONFIG.quick).
  CONFIG.modes.quick = Object.assign({}, CONFIG.modes.ground, CONFIG.quick, { label: 'People on the ground (quick)' });

  // Correction fitted to the links actually heard on radio2 (fitCalibration),
  // added to every link budget. 0 until there are enough links.
  let calibrationDb = 0;
  function setCalibration(db) { calibrationDb = Number.isFinite(db) ? db : 0; }
  function getCalibration() { return calibrationDb; }
  /** The correction one mode takes: all of it, or only a lowering. */
  function modeCalibration(mode) { return mode && mode.calibrateUp === false ? Math.min(0, calibrationDb) : calibrationDb; }

  /**
   * Clutter loss (dB) for a radio among city buildings and trees, dKm from
   * the other end: ITU-R P.2108-1 §3.2 (terrestrial, urban and suburban),
   * the median (50% of locations). About 18 dB at 250 m, 23 dB from 500 m.
   */
  function clutterLossDb(dKm, freqMHz) {
    const lf = Math.log10((freqMHz || 911.15) / 1000), d = Math.max(0.25, dKm);
    const ll = 23.5 + 9.6 * lf, ls = 32.98 + 23.9 * Math.log10(d) + 3 * lf;
    return -5 * Math.log10(Math.pow(10, -0.2 * ll) + Math.pow(10, -0.2 * ls));
  }

  // Correction from measured coverage points (fitField), for people on the
  // ground: { used, offsetDb, reps: { key8: dB }, carLossDb }. null: none.
  let field = null;
  function setField(f) { field = f && f.used ? f : null; }
  function getField() { return field; }
  const key8 = (rep) => String((rep && rep.public_key) || '').slice(0, 8).toLowerCase();
  /** What the measured points add to a path from rep in one mode (0 for
   * repeater to repeater): the correction, in place of the links'. */
  function fieldDbFor(modeKey, rep) {
    const mode = CONFIG.modes[modeKey];
    if (!field || !mode || !mode.clutter) return 0;
    return field.offsetDb + (field.reps[key8(rep)] || 0) - modeCalibration(mode);
  }
  /** dB more taken off for where you are (CONFIG.places key). */
  function placeLossDb(place) {
    const p = CONFIG.places.find((x) => x.key === place);
    if (!p) return 0;
    if (p.key === 'car' && field && Number.isFinite(field.carLossDb)) return field.carLossDb;
    return p.lossDb;
  }

  const NO_DATA = -1e9;
  const NO_DATA_I16 = -32768;
  const M_PER_DEG_LAT = 111320;

  // ---- Radio ----------------------------------------------------------------

  // The SNR a LoRa demodulator needs, by spreading factor (SX1262 datasheet).
  const SNR_LIMIT_DB = { 5: -2.5, 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

  /** Receiver sensitivity in dBm: thermal noise in the bandwidth, plus the
   * noise figure, plus the SNR the spreading factor needs. */
  function sensitivityDbm(bwKHz, sf) {
    const snr = SNR_LIMIT_DB[sf];
    if (snr === undefined || !(bwKHz > 0)) return sensitivityDbm(CONFIG.bwKHz, CONFIG.sf);
    return Math.round((-174 + 10 * Math.log10(bwKHz * 1000) + CONFIG.noiseFigureDb + snr) * 10) / 10;
  }

  /** "MHz,kHz,SF,CR" -> { freqMHz, bwKHz, sf }, or null when it isn't a
   * plausible sub-GHz LoRa setting. */
  function parseRadio(radio) {
    if (typeof radio !== 'string') return null;
    const p = radio.split(',');
    if (p.length < 3) return null;
    const freqMHz = parseFloat(p[0]), bwKHz = parseFloat(p[1]), sf = parseInt(p[2], 10);
    if (!(freqMHz >= 137 && freqMHz <= 1020) || !(bwKHz >= 7 && bwKHz <= 500) || SNR_LIMIT_DB[sf] === undefined) return null;
    return { freqMHz, bwKHz, sf };
  }

  /** The radio a repeater's coverage is worked out for: its reported radio2
   * setting, or the default preset. */
  function radioFor(rep) {
    const p = parseRadio(rep && rep.radio);
    const r = p || { freqMHz: CONFIG.freqMHz, bwKHz: CONFIG.bwKHz, sf: CONFIG.sf };
    return {
      freqMHz: r.freqMHz, bwKHz: r.bwKHz, sf: r.sf, reported: !!p,
      sensitivityDbm: sensitivityDbm(r.bwKHz, r.sf),
      lambdaM: 299.792458 / r.freqMHz,
    };
  }

  const DEFAULT_RADIO = radioFor(null);

  /** Antenna heights above the street that repeater owners have given, by
   * the start of the repeater's public key. Everything else gets
   * CONFIG.txHeightM. Feet as given, so the list is easy to check. */
  const FT = 0.3048;
  const KNOWN_HEIGHTS = [
    { key: '1ea5e195', name: 'First Hill', ft: 135 },
    { key: '1ffbd69a', name: 'First Hill Skyline', ft: 222 },
    { key: '5491c13d', name: 'Yesler Terrace', ft: 103 },
    { key: 'd011cafe', name: 'Kremwerk', ft: 29 },
  ];
  function knownHeightM(rep) {
    const pk = String((rep && rep.public_key) || '').toLowerCase();
    if (!pk) return null;
    const k = KNOWN_HEIGHTS.find((h) => pk.startsWith(h.key));
    return k ? Math.round(k.ft * FT * 10) / 10 : null;
  }

  /** A repeater's antenna height above the ground: its own (a planned one's),
   * the one its owner gave, or the default. */
  function antennaHeight(rep) {
    if (rep && rep.heightM > 0 && rep.heightM <= 300) return rep.heightM;
    const known = knownHeightM(rep);
    return known > 0 && known <= 300 ? known : CONFIG.txHeightM;
  }

  /** Free-space path loss in dB for a distance in km. */
  function fspl(dKm, freqMHz) {
    return 32.44 + 20 * Math.log10(Math.max(dKm, 0.001)) + 20 * Math.log10(freqMHz || CONFIG.freqMHz);
  }

  /** Single knife-edge diffraction loss J(v) in dB (ITU-R P.526 eq. 31). */
  function knifeEdgeLoss(v) {
    if (!(v > -0.78)) return 0;
    return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) * (v - 0.1) + 1) + v - 0.1);
  }

  /**
   * Plane-earth (two-ray) path loss in dB: the direct wave and the one
   * reflected off the ground beyond the first Fresnel zone cancel, so loss
   * grows 40 dB per decade of distance instead of free space's 20. dM in
   * metres; hT, hR: each antenna's height above the ground the path runs
   * over (effectiveHeights). The path loss is the larger of this and free
   * space plus diffraction: over open water or flat ground free space alone
   * is far too hopeful for an antenna 1.5 m up.
   */
  function planeEarthLoss(dM, hT, hR) {
    return 40 * Math.log10(Math.max(dM, 1)) - 20 * Math.log10(Math.max(hT, 1)) - 20 * Math.log10(Math.max(hR, 1));
  }

  /** Each end's height above the path's mean ground (between the ends),
   * never less than its own mast. */
  function effectiveHeights(meanGround, txAbs, txMast, rxAbs, rxMast) {
    return [Math.max(txMast, txAbs - meanGround), Math.max(rxMast, rxAbs - meanGround)];
  }

  /** The path loss that leaves exactly 0 dB to spare, in one mode. */
  function budgetDb(mode, radio) {
    const c = CONFIG;
    return c.txDbm + c.txGainDbi - c.cableDb + mode.rxGainDbi
      - (radio || DEFAULT_RADIO).sensitivityDbm - c.fadeMarginDb - mode.clutterDb + modeCalibration(mode);
  }

  /** dB to spare at the receiver for a path loss, in one mode. */
  function marginFor(pathLossDb, mode, radio) {
    return budgetDb(mode, radio) - pathLossDb;
  }

  function band(margin) {
    const b = CONFIG.bands;
    if (margin >= b.strong) return 'strong';
    if (margin >= b.fair) return 'fair';
    if (margin >= b.marginal) return 'marginal';
    return '';
  }

  // ---- Diffraction ----------------------------------------------------------

  /**
   * The edge with the largest diffraction parameter v between two ends
   * (ITU-R P.526-11 eq. 49). d: distances from the transmitter; h: heights
   * already lowered by the earth's curve (see curved()). Looks at samples
   * from..to-1; the ends are at (da, ha) and (db, hb). Returns [v, index], or
   * [-Infinity, -1] with nothing in between.
   */
  function worstEdge(d, h, from, to, da, ha, db, hb, lambda) {
    let best = -Infinity, at = -1;
    const slope = (hb - ha) / (db - da);
    for (let i = from; i < to; i++) {
      const d1 = d[i] - da, d2 = db - d[i];
      if (!(d1 > 0 && d2 > 0)) continue;
      const hh = h[i] - (ha + slope * d1);
      // v's sign and size, without the square root: v = hh * sqrt(2 D / (lambda d1 d2))
      const q = hh * Math.abs(hh) / (d1 * d2);
      if (q > best) { best = q; at = i; }
    }
    if (at < 0) return [-Infinity, -1];
    const v = Math.sign(best) * Math.sqrt(Math.abs(best) * 2 * (db - da) / lambda);
    return [v, at];
  }

  /**
   * Diffraction loss over a terrain profile by the cascaded knife-edge method
   * (ITU-R P.526-11 §4.4.2): the principal edge p over the whole path, then,
   * when it costs anything (v_p > -0.78), the worst edge on each side of it:
   *   L = J(v_p) + T (J(v_t) + J(v_r) + C),  T = 1 - exp(-J(v_p) / 6),
   *   C = 10 + 0.04 D  (D in km).
   * d, h: samples strictly between the ends (h lowered by the earth's curve),
   * n of them; the transmitter is at distance 0, height ht; the receiver at
   * D, height hr. Returns the loss and its parts.
   */
  function cascadedKnifeEdge(d, h, n, ht, D, hr, lambda) {
    const [vp, ip] = worstEdge(d, h, 0, n, 0, ht, D, hr, lambda);
    const jp = knifeEdgeLoss(vp);
    const out = { loss: 0, vp, ip, jp, vt: -Infinity, it: -1, jt: 0, vr: -Infinity, ir: -1, jr: 0, T: 0, C: 0 };
    if (!(vp > -0.78)) return out;
    const [vt, it] = worstEdge(d, h, 0, ip, 0, ht, d[ip], h[ip], lambda);
    const [vr, ir] = worstEdge(d, h, ip + 1, n, d[ip], h[ip], D, hr, lambda);
    out.vt = vt; out.it = it; out.jt = knifeEdgeLoss(vt);
    out.vr = vr; out.ir = ir; out.jr = knifeEdgeLoss(vr);
    out.T = 1 - Math.exp(-jp / 6);
    out.C = 10 + 0.04 * (D / 1000);
    out.loss = jp + out.T * (out.jt + out.jr + out.C);
    return out;
  }

  function effRadius() { return CONFIG.kFactor * CONFIG.earthRadiusM; }

  /** Distances of a ray's samples: every stepM near the repeater, then
   * growing by `growth` of the distance, out to the radius. */
  function sampleDistances(mode) {
    const out = [];
    const radiusM = mode.radiusKm * 1000;
    for (let d = mode.stepM; d <= radiusM; d += Math.max(mode.stepM, d * (mode.growth || 0))) out.push(d);
    return Float64Array.from(out);
  }

  // ---- Per-repeater raster ----------------------------------------------------

  /** The grid covering every repeater plus the mode's radius. */
  function gridFor(repeaters, mode) {
    let s = 90, n = -90, w = 180, e = -180;
    repeaters.forEach((r) => {
      s = Math.min(s, r.lat); n = Math.max(n, r.lat);
      w = Math.min(w, r.lon); e = Math.max(e, r.lon);
    });
    const midLat = (s + n) / 2;
    const mPerDegLat = M_PER_DEG_LAT;
    const mPerDegLon = mPerDegLat * Math.cos(midLat * Math.PI / 180);
    const padLat = mode.radiusKm * 1000 / mPerDegLat;
    const padLon = mode.radiusKm * 1000 / mPerDegLon;
    const bounds = { south: s - padLat, north: n + padLat, west: w - padLon, east: e + padLon };
    const cellLat = mode.cellM / mPerDegLat;
    const cellLon = mode.cellM / mPerDegLon;
    const width = Math.max(1, Math.ceil((bounds.east - bounds.west) / cellLon));
    const height = Math.max(1, Math.ceil((bounds.north - bounds.south) / cellLat));
    // The grid's own edges, so a cell's position is exact.
    bounds.east = bounds.west + width * cellLon;
    bounds.south = bounds.north - height * cellLat;
    return { bounds, cellLat, cellLon, width, height, mPerDegLat };
  }

  /**
   * The terrain a repeater's rays cross, ready for repRaster (which needs no
   * terrain of its own, so it can run in a worker). elev: the ground at each
   * sample; peak: the highest ground of the stretch the sample stands for.
   * NaN where there is no terrain data.
   */
  function buildJob(rep, radio, elevAt, mode, g) {
    const job = prepareJob(rep, radio, elevAt, mode, g);
    sampleRays(job, elevAt, 0, job.rays);
    return job;
  }

  /**
   * buildJob without the terrain along the rays (elev and peak are left
   * NaN for sampleRays to fill): everything the raster depends on besides
   * the terrain, so it also identifies a raster already worked out.
   */
  function prepareJob(rep, radio, elevAt, mode, g, bare) {
    const dist = sampleDistances(mode);
    const n = dist.length, rays = mode.rays;
    // bare: no room for the terrain yet (see withTerrainArrays)
    const elev = bare ? null : new Float32Array(rays * n).fill(NaN), peak = bare ? null : new Float32Array(rays * n).fill(NaN);
    const txGround = elevAt(rep.lat, rep.lon);
    const mPerDegLon = M_PER_DEG_LAT * Math.cos(rep.lat * Math.PI / 180);
    // The part of the grid within the radius of this repeater.
    const padLat = mode.radiusKm * 1000 / M_PER_DEG_LAT, padLon = mode.radiusKm * 1000 / mPerDegLon;
    const col0 = Math.max(0, Math.floor((rep.lon - padLon - g.bounds.west) / g.cellLon));
    const col1 = Math.min(g.width - 1, Math.floor((rep.lon + padLon - g.bounds.west) / g.cellLon));
    const row0 = Math.max(0, Math.floor((g.bounds.north - rep.lat - padLat) / g.cellLat));
    const row1 = Math.min(g.height - 1, Math.floor((g.bounds.north - rep.lat + padLat) / g.cellLat));
    return {
      rays, n, dist, elev, peak, txGround,
      txHeightM: antennaHeight(rep), rxHeightM: mode.rxHeightM,
      lambdaM: radio.lambdaM, freqMHz: radio.freqMHz, effR: effRadius(),
      budgetDb: budgetDb(mode, radio), radiusM: mode.radiusKm * 1000, clutter: mode.clutter || '',
      lat: rep.lat, lon: rep.lon, mPerDegLon,
      col0, row0, w: Math.max(0, col1 - col0 + 1), h: Math.max(0, row1 - row0 + 1),
      west: g.bounds.west, north: g.bounds.north, cellLat: g.cellLat, cellLon: g.cellLon, stepM: mode.stepM,
    };
  }

  function withTerrainArrays(job) {
    job.elev = new Float32Array(job.rays * job.n).fill(NaN);
    job.peak = new Float32Array(job.rays * job.n).fill(NaN);
    return job;
  }

  /**
   * Fills rays a0 to a1 (not included) of a prepared job with the terrain
   * they cross: elev, the ground at each sample, and peak, the highest
   * ground of the stretch the sample stands for. Left NaN past the end of
   * the terrain data, and everywhere without ground under the repeater.
   */
  function sampleRays(job, elevAt, a0, a1) {
    const { n, dist, elev, peak, rays, lat, lon, mPerDegLon, stepM } = job;
    if (!Number.isFinite(job.txGround)) return;
    // Where each sample's stretch starts and ends, and how many extra looks
    // it takes to cover it at stepM.
    let lo = job._lo, sub = job._sub, gap = job._gap;
    if (!lo) {
      lo = new Float64Array(n); sub = new Int32Array(n); gap = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const before = i ? (dist[i] - dist[i - 1]) / 2 : 0;
        const after = i < n - 1 ? (dist[i + 1] - dist[i]) / 2 : before;
        const k = Math.ceil((before + after) / stepM - 1e-9);
        lo[i] = dist[i] - before; sub[i] = k > 1 ? k : 0; gap[i] = k > 1 ? (before + after) / k : 0;
      }
      Object.defineProperty(job, '_lo', { value: lo, configurable: true });
      Object.defineProperty(job, '_sub', { value: sub, configurable: true });
      Object.defineProperty(job, '_gap', { value: gap, configurable: true });
    }
    for (let a = a0; a < a1; a++) {
      const az = (a / rays) * 2 * Math.PI;
      const kLat = Math.cos(az) / M_PER_DEG_LAT, kLon = Math.sin(az) / mPerDegLon;
      const off = a * n;
      for (let i = 0; i < n; i++) {
        const e = elevAt(lat + dist[i] * kLat, lon + dist[i] * kLon);
        if (!Number.isFinite(e)) break;
        let p = e;
        for (let m = 0; m < sub[i]; m++) {
          const dd = lo[i] + (m + 0.5) * gap[i];
          const e2 = elevAt(lat + dd * kLat, lon + dd * kLon);
          if (e2 > p) p = e2;
        }
        elev[off + i] = e; peak[off + i] = p;
      }
    }
  }

  /**
   * dB to spare at every sample of every ray of a job: Float32Array
   * rays * n, NaN where there is no terrain. The same sums as
   * cascadedKnifeEdge, written out for speed: this is the inner loop of the
   * whole estimate.
   */
  function polarMargins(job) {
    const { rays, n, dist, elev, peak, lambdaM, effR } = job;
    const out = new Float32Array(rays * n).fill(NaN);
    if (!Number.isFinite(job.txGround)) return out;
    const ht = job.txGround + job.txHeightM;
    const drop = new Float64Array(n), fs = new Float64Array(n), cl = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      drop[i] = dist[i] * dist[i] / (2 * effR);
      fs[i] = fspl(dist[i] / 1000, job.freqMHz);
      cl[i] = job.clutter === 'p2108' ? clutterLossDb(dist[i] / 1000, job.freqMHz) : 0;
    }
    const pc = new Float64Array(n); // peaks, lowered by the earth's curve
    const gsum = new Float64Array(n + 1); // ground x length, running, for the mean ground
    const seg = new Float64Array(n);
    for (let i = 0; i < n; i++) seg[i] = i ? dist[i] - dist[i - 1] : dist[0];
    const k2 = 2 / lambdaM;
    for (let a = 0; a < rays; a++) {
      const off = a * n;
      let valid = 0;
      while (valid < n && elev[off + valid] === elev[off + valid]) {
        pc[valid] = peak[off + valid] - drop[valid];
        gsum[valid + 1] = gsum[valid] + elev[off + valid] * seg[valid];
        valid++;
      }
      for (let j = 0; j < valid; j++) {
        const D = dist[j];
        const hr = elev[off + j] - drop[j] + job.rxHeightM;
        // ground between the ends (the samples before this one), on average
        const meanG = j > 0 ? gsum[j] / dist[j - 1] : job.txGround;
        const hT = Math.max(job.txHeightM, ht - meanG), hR = Math.max(job.rxHeightM, elev[off + j] + job.rxHeightM - meanG);
        const pe = planeEarthLoss(D, hT, hR);
        let loss = 0;
        if (j > 0) {
          // principal edge
          const slope = (hr - ht) / D;
          let best = -Infinity, ip = -1;
          for (let i = 0; i < j; i++) {
            const d1 = dist[i];
            const hh = pc[i] - (ht + slope * d1);
            const q = hh * (hh < 0 ? -hh : hh) / (d1 * (D - d1));
            if (q > best) { best = q; ip = i; }
          }
          const vp = (best < 0 ? -1 : 1) * Math.sqrt((best < 0 ? -best : best) * k2 * D);
          if (vp > -0.78) {
            const jp = knifeEdgeLoss(vp);
            const dp = dist[ip], hp = pc[ip];
            let jt = 0, jr = 0;
            if (ip > 0) {
              const s1 = (hp - ht) / dp;
              let b = -Infinity;
              for (let i = 0; i < ip; i++) {
                const d1 = dist[i];
                const hh = pc[i] - (ht + s1 * d1);
                const q = hh * (hh < 0 ? -hh : hh) / (d1 * (dp - d1));
                if (q > b) b = q;
              }
              jt = knifeEdgeLoss((b < 0 ? -1 : 1) * Math.sqrt((b < 0 ? -b : b) * k2 * dp));
            }
            if (ip < j - 1) {
              const s2 = (hr - hp) / (D - dp);
              let b = -Infinity;
              for (let i = ip + 1; i < j; i++) {
                const d1 = dist[i] - dp;
                const hh = pc[i] - (hp + s2 * d1);
                const q = hh * (hh < 0 ? -hh : hh) / (d1 * (D - dist[i]));
                if (q > b) b = q;
              }
              jr = knifeEdgeLoss((b < 0 ? -1 : 1) * Math.sqrt((b < 0 ? -b : b) * k2 * (D - dp)));
            }
            loss = jp + (1 - Math.exp(-jp / 6)) * (jt + jr + 10 + 0.04 * (D / 1000));
          }
        }
        const total = fs[j] + loss;
        // no buildings on open water (the sea, at 0.5 m or lower)
        out[off + j] = job.budgetDb - (pe > total ? pe : total) - (elev[off + j] > 0.5 ? cl[j] : 0);
      }
    }
    return out;
  }

  /**
   * One repeater's margins on its part of the grid: Int16Array w * h of
   * tenths of a dB (row 0 = north), NO_DATA_I16 where there is none. Each
   * cell is read off the rays by interpolating between the two nearest rays
   * and the two nearest samples, so there are no gaps between rays.
   */
  function repRaster(job) {
    const polar = polarMargins(job);
    const { rays, n, dist, w, h } = job;
    const data = new Int16Array(w * h).fill(NO_DATA_I16);
    if (!n || !w || !h) return data;
    // Sample position (fractional index) by distance, in steps of q metres.
    const q = dist[0] / 2;
    const table = new Float32Array(Math.ceil(job.radiusM / q) + 2);
    for (let k = 0, i = 0; k < table.length; k++) {
      const d = k * q;
      while (i < n - 1 && dist[i + 1] <= d) i++;
      table[k] = d <= dist[0] ? 0 : (i >= n - 1 ? n - 1 : i + (d - dist[i]) / (dist[i + 1] - dist[i]));
    }
    const perRad = rays / (2 * Math.PI);
    const maxD = Math.min(job.radiusM, dist[n - 1]);
    for (let y = 0; y < h; y++) {
      const lat = job.north - (job.row0 + y + 0.5) * job.cellLat;
      const dy = (lat - job.lat) * M_PER_DEG_LAT;
      for (let x = 0; x < w; x++) {
        const lon = job.west + (job.col0 + x + 0.5) * job.cellLon;
        const dx = (lon - job.lon) * job.mPerDegLon;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > maxD) continue;
        let az = Math.atan2(dx, dy);
        if (az < 0) az += 2 * Math.PI;
        const fr = az * perRad;
        const r0 = Math.floor(fr) % rays, r1 = (r0 + 1) % rays, wr = fr - Math.floor(fr);
        const fk = d / q, k0 = Math.floor(fk);
        const fsIdx = table[k0] + (table[k0 + 1] - table[k0]) * (fk - k0);
        const s0 = Math.floor(fsIdx), s1 = Math.min(n - 1, s0 + 1), ws = fsIdx - s0;
        let sum = 0, wsum = 0, v, wt;
        v = polar[r0 * n + s0]; wt = (1 - wr) * (1 - ws); if (v === v) { sum += v * wt; wsum += wt; }
        v = polar[r1 * n + s0]; wt = wr * (1 - ws); if (v === v) { sum += v * wt; wsum += wt; }
        v = polar[r0 * n + s1]; wt = (1 - wr) * ws; if (v === v) { sum += v * wt; wsum += wt; }
        v = polar[r1 * n + s1]; wt = wr * ws; if (v === v) { sum += v * wt; wsum += wt; }
        if (wsum < 0.5) continue;
        const t = Math.round((sum / wsum) * 10);
        data[y * w + x] = t > 32767 ? 32767 : (t < -32767 ? -32767 : t);
      }
    }
    return data;
  }

  /**
   * Fills cov.margins (Float32Array, row 0 = north, NO_DATA where no
   * repeater reaches) and cov.best (index into cov.reps of the repeater
   * giving each cell's margin, -1 none) from the repeaters' own rasters.
   * enabled: optional array of booleans by repeater; all when omitted.
   * A cell out of coverage keeps the best (negative) margin, so the readout
   * can say how far short it falls.
   */
  function merge(cov, enabled) {
    const margins = cov.margins || new Float32Array(cov.width * cov.height);
    const best = cov.best || new Int16Array(cov.width * cov.height);
    margins.fill(NO_DATA); best.fill(-1);
    cov.rasters.forEach((r, ri) => {
      if (!r || (enabled && !enabled[ri])) return;
      for (let y = 0; y < r.h; y++) {
        let i = (r.row0 + y) * cov.width + r.col0, k = y * r.w;
        for (let x = 0; x < r.w; x++, i++, k++) {
          const t = r.data[k];
          if (t === NO_DATA_I16) continue;
          const m = t / 10;
          if (m > margins[i]) { margins[i] = m; best[i] = ri; }
        }
      }
    });
    cov.margins = margins; cov.best = best; cov.enabled = enabled ? enabled.slice() : null;
    return cov;
  }

  /**
   * Coverage for one mode. elevAt(lat, lon) returns metres above sea level,
   * or NaN where there is no terrain data (those cells stay empty).
   * onProgress(done, total) is called after each repeater; the work yields
   * between repeaters so the page stays responsive. opts.run(job, rebuild)
   * may hand a job to a worker (see workerPool); it runs here otherwise.
   * Returns { margins, best, reps (the placed repeaters), radios, rasters,
   * width, height, bounds, modeKey }; see merge().
   */
  async function computeCoverage(repeaters, elevAt, modeKey, onProgress, opts) {
    const mode = CONFIG.modes[modeKey];
    const reps = repeaters.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    if (!reps.length) return null;
    const g = gridFor(reps, mode);
    const radios = reps.map(radioFor);
    const run = opts && opts.run;
    let done = 0;
    const pending = [];
    let slice = now();
    // Hands the page back every few milliseconds, so it stays responsive.
    const breathe = async () => {
      if (now() - slice < SLICE_MS) return;
      await new Promise((res) => setTimeout(res, 0));
      slice = now();
    };
    for (let ri = 0; ri < reps.length; ri++) {
      const make = () => buildJob(reps[ri], radios[ri], elevAt, mode, g);
      const job = prepareJob(reps[ri], radios[ri], elevAt, mode, g, true);
      const rect = { col0: job.col0, row0: job.row0, w: job.w, h: job.h };
      const key = rasterKey(job, modeKey);
      const saved = key && await rasterStore.get(key);
      let result;
      if (saved && saved.length === job.w * job.h) {
        result = Promise.resolve(saved);
      } else {
        withTerrainArrays(job);
        for (let a = 0; a < job.rays; a += RAYS_PER_STEP) {
          sampleRays(job, elevAt, a, Math.min(job.rays, a + RAYS_PER_STEP));
          await breathe();
        }
        result = (run ? run(job, make) : Promise.resolve(repRaster(job)))
          .then((data) => { if (key) rasterStore.put(key, data); return data; });
      }
      pending.push(result.then((data) => {
        if (onProgress) onProgress(++done, reps.length);
        return Object.assign(rect, { data });
      }));
      await breathe();
    }
    const rasters = await Promise.all(pending);
    return merge({ rasters, reps, radios, width: g.width, height: g.height, bounds: g.bounds, modeKey, water: waterMask(g, elevAt) });
  }

  const SLICE_MS = 12, RAYS_PER_STEP = 16;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /**
   * What identifies a repeater's raster besides the terrain, which is the
   * same tiles for the same place: the model (this file's version, from its
   * ?v= on the page) and every number the job carries. '' when the version
   * is unknown (tests, workers): nothing is kept then.
   */
  function rasterKey(job, modeKey) {
    const v = /[?&]v=([^&]+)/.exec(SCRIPT_URL);
    if (!v) return '';
    const parts = [v[1], modeKey, CONFIG.terrainUrl];
    for (const k of Object.keys(job).sort()) {
      const x = job[k];
      if (typeof x === 'number' || typeof x === 'string') parts.push(k + '=' + x);
    }
    return parts.join('|');
  }

  /**
   * Rasters already worked out, kept in the browser (IndexedDB) so the
   * estimate comes back at once on the next visit. Best effort: anything
   * that fails just means working it out again. Holds the most recent
   * RASTERS_KEPT.
   */
  const RASTERS_KEPT = 400;
  const rasterStore = (() => {
    let dbp = null;
    const open = () => {
      if (dbp) return dbp;
      dbp = new Promise((res) => {
        try {
          if (!root.indexedDB) return res(null);
          const rq = root.indexedDB.open('mm-coverage', 1);
          rq.onupgradeneeded = () => { const os = rq.result.createObjectStore('rasters'); os.createIndex('at', 'at'); };
          rq.onsuccess = () => res(rq.result);
          rq.onerror = () => res(null);
          rq.onblocked = () => res(null);
        } catch (_) { res(null); }
      });
      return dbp;
    };
    const tx = async (mode, fn) => {
      const db = await open();
      if (!db) return null;
      return new Promise((res) => {
        try {
          const t = db.transaction('rasters', mode);
          const out = fn(t.objectStore('rasters'));
          t.oncomplete = () => res(out && 'result' in out ? out.result : null);
          t.onerror = t.onabort = () => res(null);
        } catch (_) { res(null); }
      });
    };
    let puts = 0;
    return {
      async get(key) {
        const rec = await tx('readonly', (os) => os.get(key));
        return rec && rec.data instanceof Int16Array ? rec.data : null;
      },
      put(key, data) {
        tx('readwrite', (os) => { os.put({ at: Date.now(), data }, key); });
        // now and then, forget the oldest beyond RASTERS_KEPT
        if (++puts % 20 === 1) {
          tx('readwrite', (os) => {
            const count = os.count();
            count.onsuccess = () => {
              let extra = count.result - RASTERS_KEPT;
              if (extra <= 0) return;
              os.index('at').openCursor().onsuccess = (e) => {
                const c = e.target.result;
                if (!c || extra-- <= 0) return;
                c.delete(); c.continue();
              };
            };
          });
        }
      },
    };
  })();


  // ---- Workers ----------------------------------------------------------------

  const SCRIPT_URL = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';

  /**
   * A few workers running repRaster, each loaded from this same file.
   * Returns { run(job, rebuild), close() }; run falls back to working on
   * the page (with a job rebuilt by rebuild(), the first one's arrays having
   * gone to the worker) when a worker cannot start or fails. Null where
   * workers are not available.
   */
  function workerPool(size) {
    if (typeof root.Worker !== 'function' || !SCRIPT_URL) return null;
    const hc = (root.navigator && root.navigator.hardwareConcurrency) || 2;
    const count = size || Math.max(1, Math.min(6, hc - 1));
    const workers = [];
    let broken = false, seq = 0;
    function spawn() {
      const w = { worker: new root.Worker(SCRIPT_URL), jobs: new Map() };
      const fail = () => {
        broken = true;
        w.jobs.forEach((j) => j.reject(new Error('worker')));
        w.jobs.clear();
      };
      w.worker.onmessage = (e) => {
        const j = w.jobs.get(e.data.id);
        if (!j) return;
        w.jobs.delete(e.data.id);
        if (e.data.error) j.reject(new Error(e.data.error)); else j.resolve(e.data.data);
      };
      w.worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); fail(); };
      w.worker.onmessageerror = fail;
      return w;
    }
    function run(job, rebuild) {
      const local = () => new Promise((res) => setTimeout(() => res(repRaster(rebuild ? rebuild() : job)), 0));
      if (broken) return Promise.resolve(repRaster(job));
      let w;
      try {
        if (workers.length < count) { w = spawn(); workers.push(w); } else {
          w = workers.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a));
        }
      } catch (_) { broken = true; return Promise.resolve(repRaster(job)); }
      const id = ++seq;
      return new Promise((resolve, reject) => {
        w.jobs.set(id, { resolve, reject });
        try {
          w.worker.postMessage({ mmCoverageJob: job, id }, [job.elev.buffer, job.peak.buffer]);
        } catch (err) { w.jobs.delete(id); reject(err); }
      }).catch(local);
    }
    function close() { workers.forEach((w) => { try { w.worker.terminate(); } catch (_) { /* gone */ } }); workers.length = 0; }
    return { run, close };
  }

  // Inside a worker: answer jobs.
  if (typeof root.WorkerGlobalScope !== 'undefined' && typeof root.importScripts === 'function') {
    root.onmessage = (e) => {
      const job = e.data && e.data.mmCoverageJob;
      if (!job) return;
      try {
        const data = repRaster(job);
        root.postMessage({ id: e.data.id, data }, [data.buffer]);
      } catch (err) {
        root.postMessage({ id: e.data.id, error: String(err && err.message || err) });
      }
    };
  }

  // ---- Path profile -----------------------------------------------------------

  function distanceM(lat1, lon1, lat2, lon2) {
    const dy = (lat2 - lat1) * M_PER_DEG_LAT;
    const dx = (lon2 - lon1) * M_PER_DEG_LAT * Math.cos(lat1 * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * The path from a repeater to one point, worked out exactly (terrain every
   * 25 m or so) with every part of the loss kept: for the profile drawing
   * and its budget. Returns null without terrain at either end.
   * { distM, d[], terrain[] (metres above sea level, at d), txGround,
   *   rxGround, txHeightM, rxHeightM, lambdaM, effR, radio, fsplDb, diff
   *   (cascadedKnifeEdge's result), edges [{ d, elev, v, lossDb, principal }],
   *   lineOfSight, fresnelClear, clutterDb, pathLossDb, eirpDbm, rxDbm,
   *   sensitivityDbm, fadeMarginDb, marginDb, modeKey }
   */
  function pathProfile(rep, lat, lon, elevAt, modeKey, radio, popts) {
    const c = CONFIG, base = c.modes[modeKey];
    // popts.rxHeightM: the receiver's height instead of the mode's (an upstairs window)
    const mode = popts && popts.rxHeightM > 0 ? Object.assign({}, base, { rxHeightM: popts.rxHeightM }) : base;
    const r = radio || radioFor(rep);
    const D = distanceM(rep.lat, rep.lon, lat, lon);
    const txGround = elevAt(rep.lat, rep.lon), rxGround = elevAt(lat, lon);
    if (!Number.isFinite(txGround) || !Number.isFinite(rxGround) || !(D > 1)) return null;
    const n = Math.max(1, Math.min(1200, Math.round(D / 25)) - 1);
    const d = new Float64Array(n), terrain = new Float64Array(n), curved = new Float64Array(n);
    const effR = effRadius();
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / (n + 1);
      d[i] = D * t;
      const e = elevAt(rep.lat + (lat - rep.lat) * t, rep.lon + (lon - rep.lon) * t);
      if (!Number.isFinite(e)) return null;
      terrain[i] = e;
      curved[i] = e - d[i] * d[i] / (2 * effR);
    }
    const ht = txGround + antennaHeight(rep);
    const hr = rxGround - D * D / (2 * effR) + mode.rxHeightM;
    const diff = cascadedKnifeEdge(d, curved, n, ht, D, hr, r.lambdaM);
    const edges = [];
    const edge = (i, v, lossDb, principal) => { if (i >= 0 && lossDb > 0.05) edges.push({ d: d[i], elev: terrain[i], v, lossDb, principal }); };
    edge(diff.ip, diff.vp, diff.jp, true);
    edge(diff.it, diff.vt, diff.T * diff.jt, false);
    edge(diff.ir, diff.vr, diff.T * diff.jr, false);
    edges.sort((a, b) => a.d - b.d);
    const fsplDb = fspl(D / 1000, r.freqMHz);
    let gSum = 0;
    for (let i = 0; i < n; i++) gSum += terrain[i];
    const [hTe, hRe] = effectiveHeights(gSum / n, txGround + antennaHeight(rep), antennaHeight(rep), rxGround + mode.rxHeightM, mode.rxHeightM);
    const planeEarthDb = planeEarthLoss(D, hTe, hRe);
    // what the ground's reflection costs beyond free space and diffraction
    const groundDb = Math.max(0, planeEarthDb - (fsplDb + diff.loss));
    const pathLossDb = fsplDb + diff.loss + groundDb;
    const eirpDbm = c.txDbm + c.txGainDbi - c.cableDb;
    const cal = modeCalibration(mode);
    const clutterDb = mode.clutter === 'p2108' ? (rxGround > 0.5 ? clutterLossDb(D / 1000, r.freqMHz) : 0) : mode.clutterDb;
    // the measured points' correction (replacing cal's), and where you are
    const fieldUsed = !!(field && mode.clutter && !(popts && popts.noField));
    const fieldDb = fieldUsed ? fieldDbFor(modeKey, rep) : 0;
    const placeDb = (popts && popts.placeLossDb) || 0;
    const rxDbm = eirpDbm + mode.rxGainDbi - pathLossDb - clutterDb + cal + fieldDb - placeDb;
    return {
      distM: D, d, terrain, txGround, rxGround, txHeightM: antennaHeight(rep), rxHeightM: mode.rxHeightM,
      lambdaM: r.lambdaM, effR, radio: r, fsplDb, diff, edges, groundDb, planeEarthDb,
      lineOfSight: !(diff.vp > 0), fresnelClear: !(diff.vp > -0.78),
      clutterDb, clutterModel: mode.clutter || '', calibrationDb: cal, fieldDb, fieldUsed, placeLossDb: placeDb, place: (popts && popts.place) || '', pathLossDb, eirpDbm, rxDbm,
      sensitivityDbm: r.sensitivityDbm, fadeMarginDb: c.fadeMarginDb,
      marginDb: rxDbm - r.sensitivityDbm - c.fadeMarginDb, modeKey,
    };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function repName(rep) { return rep ? String(rep.name || (rep.public_key || '').slice(0, 8)) : ''; }

  function fmtKm(m) { return m < 950 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 9950 ? 1 : 0) + ' km'; }
  function fmtDb(v) {
    const r = Math.round(v * 10) / 10;
    return (r === 0 ? 0 : r).toFixed(1).replace(/\.0$/, '').replace('-', '−');
  }
  function fmtLoss(v) { const t = fmtDb(v); return (t === '0' ? '' : '−') + t + ' dB'; }

  /** One sentence on what stands between the two ends. */
  function profileVerdict(p) {
    if (p.fresnelClear) return 'Clear line of sight, with room to spare around it.';
    if (p.lineOfSight) return 'Line of sight, but the ground comes close enough to cost some signal.';
    return 'No line of sight: the signal has to bend over the ground in between.';
  }

  /**
   * The link budget as rows of [label, value, kind], top to bottom: what is
   * sent, what each part of the path takes, what arrives and what is to
   * spare. kind: 'gain' | 'loss' | 'sum' | 'result'.
   */
  function budgetRows(p) {
    const c = CONFIG, mode = c.modes[p.modeKey];
    const rows = [
      ['Sent: ' + c.txDbm + ' dBm, ' + c.txGainDbi + ' dBi antenna, ' + c.cableDb + ' dB cable', fmtDb(p.eirpDbm) + ' dBm', 'gain'],
      ['Free space over ' + fmtKm(p.distM), fmtLoss(p.fsplDb), 'loss'],
      ['Terrain (diffraction)', fmtLoss(p.diff.loss), 'loss'],
    ];
    if (p.groundDb > 0.05) rows.push(['Reflection off the ground', fmtLoss(p.groundDb), 'loss']);
    if (p.clutterModel === 'p2108') rows.push([p.clutterDb ? 'Buildings and trees (ITU-R P.2108, ' + fmtKm(p.distM) + ' away)' : 'Buildings and trees (none on open water)', fmtLoss(p.clutterDb), 'loss']);
    else if (p.clutterDb) rows.push(['Buildings and trees (flat allowance)', fmtLoss(p.clutterDb), 'loss']);
    if (mode.rxGainDbi) rows.push([mode.rxGainDbi < 0 ? 'Receiving antenna (handheld, next to the body)' : 'Receiving antenna', (mode.rxGainDbi > 0 ? '+' : '−') + fmtDb(Math.abs(mode.rxGainDbi)) + ' dB', mode.rxGainDbi > 0 ? 'gain' : 'loss']);
    if (p.placeLossDb) {
      const pl = CONFIG.places.find((x) => x.key === p.place);
      rows.push([(pl ? pl.label : 'Where you are') + (p.place === 'car' && field && Number.isFinite(field.carLossDb) ? ' (measured)' : ''), fmtLoss(p.placeLossDb), 'loss']);
    }
    // measured points replace the links' correction for people on the ground
    const fieldNet = p.fieldUsed ? p.fieldDb + p.calibrationDb : 0;
    if (p.fieldUsed && Math.abs(fieldNet) >= 0.05) {
      rows.push(['Correction from coverage measured on the ground', (fieldNet > 0 ? '+' : '−') + fmtDb(Math.abs(fieldNet)) + ' dB', fieldNet > 0 ? 'gain' : 'loss']);
    }
    if (p.calibrationDb && !p.fieldUsed) {
      rows.push(['Correction from links heard on radio2', (p.calibrationDb > 0 ? '+' : '−') + fmtDb(Math.abs(p.calibrationDb)) + ' dB',
        p.calibrationDb > 0 ? 'gain' : 'loss']);
    }
    rows.push(['Arrives at', fmtDb(p.rxDbm) + ' dBm', 'sum']);
    rows.push(['Receiver needs (SF' + p.radio.sf + ', ' + p.radio.bwKHz + ' kHz)', fmtDb(p.sensitivityDbm) + ' dBm', 'loss']);
    rows.push(['Safety margin', fmtLoss(p.fadeMarginDb), 'loss']);
    rows.push([p.marginDb >= 0 ? 'To spare' : 'Short by', fmtDb(Math.abs(p.marginDb)) + ' dB', 'result']);
    return rows;
  }

  /**
   * The profile as an SVG string: the ground with the earth's curve added
   * (so the line of sight is straight), the line of sight, the first Fresnel
   * zone around it, both antennas and the ridges the model charged for.
   */
  function profileSvg(p, opts) {
    const W = (opts && opts.width) || 640, H = (opts && opts.height) || 200;
    const padL = 40, padR = 10, padT = 10, padB = 22;
    const D = p.distM, n = p.d.length;
    const bulge = (x) => x * (D - x) / (2 * p.effR);
    const hTx = p.txGround + p.txHeightM, hRx = p.rxGround + p.rxHeightM;
    const los = (x) => hTx + (hRx - hTx) * (x / D);
    const fres = (x) => Math.sqrt(Math.max(0, p.lambdaM * x * (D - x) / D));
    // ground points, ends included
    const gx = [0], gy = [p.txGround];
    for (let i = 0; i < n; i++) { gx.push(p.d[i]); gy.push(p.terrain[i] + bulge(p.d[i])); }
    gx.push(D); gy.push(p.rxGround);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < gx.length; i++) {
      lo = Math.min(lo, gy[i], los(gx[i]) - fres(gx[i]));
      hi = Math.max(hi, gy[i], los(gx[i]) + fres(gx[i]));
    }
    const span = Math.max(20, hi - lo);
    lo -= span * 0.08; hi += span * 0.08;
    const X = (x) => padL + (x / D) * (W - padL - padR);
    const Y = (y) => padT + (1 - (y - lo) / (hi - lo)) * (H - padT - padB);
    const f = (v) => v.toFixed(1);
    // thin the ground to about two points per pixel column
    const stride = Math.max(1, Math.floor(gx.length / (W * 2)));
    let ground = `M${f(X(0))},${f(Y(lo))}`;
    for (let i = 0; i < gx.length; i += stride) ground += `L${f(X(gx[i]))},${f(Y(gy[i]))}`;
    ground += `L${f(X(D))},${f(Y(gy[gy.length - 1]))}L${f(X(D))},${f(Y(lo))}Z`;
    const steps = 48;
    let up = '', down = '';
    for (let k = 0; k <= steps; k++) {
      const x = (D * k) / steps;
      up += `${k ? 'L' : 'M'}${f(X(x))},${f(Y(los(x) + fres(x)))}`;
      down = `L${f(X(x))},${f(Y(los(x) - fres(x)))}` + down;
    }
    const zone = up + down + 'Z';
    const tickStep = (range, target) => {
      const raw = range / target, pow = Math.pow(10, Math.floor(Math.log10(raw)));
      const m = raw / pow;
      return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
    };
    let axes = '';
    const ys = tickStep(hi - lo, 4);
    for (let y = Math.ceil(lo / ys) * ys; y < hi; y += ys) {
      axes += `<line class="mm-cov-prof-grid" x1="${padL}" x2="${W - padR}" y1="${f(Y(y))}" y2="${f(Y(y))}"/>`
        + `<text class="mm-cov-prof-tick" x="${padL - 4}" y="${f(Y(y) + 3)}" text-anchor="end">${Math.round(y)} m</text>`;
    }
    const xs = tickStep(D / 1000, 6);
    for (let x = 0; x <= D / 1000 + 1e-9; x += xs) {
      const label = parseFloat(x.toFixed(2)) + (x + xs > D / 1000 + 1e-9 ? ' km' : '');
      axes += `<text class="mm-cov-prof-tick" x="${f(X(x * 1000))}" y="${H - 6}" text-anchor="${x === 0 ? 'start' : 'middle'}">${label}</text>`;
    }
    const mast = (x, g, top) => `<line class="mm-cov-prof-mast" x1="${f(X(x))}" x2="${f(X(x))}" y1="${f(Y(g))}" y2="${f(Y(top))}"/>`
      + `<circle class="mm-cov-prof-ant" cx="${f(X(x))}" cy="${f(Y(top))}" r="3"/>`;
    const edges = p.edges.map((e) => {
      const x = X(e.d), y = Y(e.elev + bulge(e.d));
      return `<path class="mm-cov-prof-edge${e.principal ? ' mm-cov-prof-edge--main' : ''}" d="M${f(x)},${f(y - 2)}l-4,-7h8z"><title>${esc(fmtDb(e.lossDb))} dB lost at ${esc(fmtKm(e.d))}</title></path>`;
    }).join('');
    const label = (opts && opts.label) || 'Terrain profile';
    return `<svg class="mm-cov-prof-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none">`
      + axes
      + `<path class="mm-cov-prof-zone" d="${zone}"/>`
      + `<path class="mm-cov-prof-ground" d="${ground}"/>`
      + `<line class="mm-cov-prof-los${p.lineOfSight ? '' : ' mm-cov-prof-los--blocked'}" x1="${f(X(0))}" y1="${f(Y(hTx))}" x2="${f(X(D))}" y2="${f(Y(hRx))}"/>`
      + mast(0, p.txGround, hTx) + mast(D, p.rxGround, hRx) + edges
      + '</svg>';
  }

  /** The profile panel: heading, verdict, drawing and budget. */
  function profileHtml(p, rep, chartWidth) {
    const mode = CONFIG.modes[p.modeKey];
    const who = p.modeKey === 'ground' ? 'a person at ' + mode.rxHeightM + ' m' : 'an antenna at ' + mode.rxHeightM + ' m';
    const title = `${repName(rep)} to ${who}, ${fmtKm(p.distM)}`;
    const rows = budgetRows(p).map((r) => `<tr class="mm-cov-budget--${r[2]}"><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('');
    const b = band(p.marginDb);
    return `<div class="mm-cov-prof-head"><strong>${esc(title)}</strong>`
      + `<button type="button" class="mm-cov-prof-close" data-mm-cov-close aria-label="Close the profile">×</button></div>`
      + `<p class="mm-cov-prof-verdict">${esc(profileVerdict(p))} `
      + `<span class="mm-cov-prof-result">${p.marginDb >= 0 ? '≈ ' + Math.round(p.marginDb) + ' dB to spare (' + b + ')' : 'About ' + Math.round(-p.marginDb) + ' dB short'}</span></p>`
      + `<div class="mm-cov-prof-body"><div class="mm-cov-prof-chart">${profileSvg(p, { label: 'Terrain profile: ' + title, width: chartWidth })}`
      + '<div class="mm-cov-prof-key"><span><i class="mm-cov-key mm-cov-key--los"></i>Line of sight</span>'
      + '<span><i class="mm-cov-key mm-cov-key--zone"></i>First Fresnel zone</span>'
      + '<span><i class="mm-cov-key mm-cov-key--edge"></i>Ridge the model charges for</span>'
      + '<span class="text-muted">Ground drawn with the earth\'s curve added</span></div></div>'
      + `<table class="mm-cov-budget"><tbody>${rows}</tbody></table></div>`;
  }

  // ---- Terrain (browser) ----------------------------------------------------

  function lonToTileX(lon, z) { return ((lon + 180) / 360) * Math.pow(2, z); }
  function latToTileY(lat, z) {
    const r = lat * Math.PI / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
  }

  function loadTile(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = img.width; cv.height = img.height;
          const ctx = cv.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          resolve(ctx.getImageData(0, 0, img.width, img.height).data);
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  /** Terrarium RGBA pixels -> metres, one Float32 per pixel. */
  function decodeTerrarium(rgba) {
    const out = new Float32Array(65536);
    if (!rgba || rgba.length < 65536 * 4) return null;
    for (let i = 0, k = 0; i < 65536; i++, k += 4) out[i] = rgba[k] * 256 + rgba[k + 1] + rgba[k + 2] / 256 - 32768;
    return out;
  }

  // Decoded tiles by URL, per loader, so a second view or a redraw of the tab
  // doesn't fetch them again.
  const tileCaches = new WeakMap();
  function cachedTile(get, url) {
    let cache = tileCaches.get(get);
    if (!cache) { cache = new Map(); tileCaches.set(get, cache); }
    let p = cache.get(url);
    if (!p) {
      p = Promise.resolve(get(url)).then(decodeTerrarium, () => null);
      cache.set(url, p);
      p.then((t) => { if (!t) cache.delete(url); });
    }
    return p;
  }

  /**
   * Which tiles a view needs: [{ z, boxes: [bounds] }], finest first; see
   * CONFIG.terrain.
   */
  function terrainPlan(placed, mode) {
    const t = CONFIG.terrain;
    const box = (lat0, lat1, lon0, lon1, km) => {
      const padLat = km * 1000 / M_PER_DEG_LAT;
      const padLon = km * 1000 / (M_PER_DEG_LAT * Math.cos(((lat0 + lat1) / 2) * Math.PI / 180));
      return { south: lat0 - padLat, north: lat1 + padLat, west: lon0 - padLon, east: lon1 + padLon };
    };
    let s = 90, n = -90, w = 180, e = -180;
    placed.forEach((r) => { s = Math.min(s, r.lat); n = Math.max(n, r.lat); w = Math.min(w, r.lon); e = Math.max(e, r.lon); });
    return [
      { z: t.nearZoom, boxes: placed.map((r) => box(r.lat, r.lat, r.lon, r.lon, t.nearKm)) },
      { z: t.midZoom, boxes: [box(s, n, w, e, Math.min(t.midKm, mode.radiusKm))] },
      { z: t.farZoom, boxes: [gridFor(placed, mode).bounds] },
    ];
  }

  /**
   * Fetches the elevation tiles of a plan (see terrainPlan) and returns
   * elevAt(lat, lon): bilinear between pixels, from the finest level that
   * has the place, NaN where none does. failed / total count the tiles of
   * the coarsest level: a missing finer tile only costs detail. loader(url)
   * may be swapped for tests.
   */
  async function loadTerrainLevels(levels, loader) {
    const get = loader || loadTile;
    const loaded = [];
    const jobs = [];
    let failed = 0, total = 0;
    levels.forEach((lv, li) => {
      const z = lv.z, tiles = new Map(), last = li === levels.length - 1;
      loaded.push({ z, scale: Math.pow(2, z) * 256, tiles });
      const want = new Set();
      lv.boxes.forEach((b) => {
        const x0 = Math.floor(lonToTileX(b.west, z)), x1 = Math.floor(lonToTileX(b.east, z));
        const y0 = Math.floor(latToTileY(b.north, z)), y1 = Math.floor(latToTileY(b.south, z));
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) want.add(x * 65536 + y);
      });
      want.forEach((key) => {
        const x = Math.floor(key / 65536), y = key % 65536;
        const url = CONFIG.terrainUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        if (last) total++;
        jobs.push(cachedTile(get, url).then((data) => { if (data) tiles.set(key, data); else if (last) failed++; }));
      });
    });
    await Promise.all(jobs);
    // elevAt is called about a million times per repeater, so it keeps the
    // last tile of each level at hand and avoids allocating.
    loaded.forEach((lv) => { lv.lastKey = -1; lv.last = null; });
    function tileOf(lv, key) {
      if (key === lv.lastKey) return lv.last;
      const t = lv.tiles.get(key) || null;
      lv.lastKey = key; lv.last = t;
      return t;
    }
    function pixel(lv, home, tx, ty, X, Y) {
      if ((X >> 8) === tx && (Y >> 8) === ty) return home[(Y & 255) * 256 + (X & 255)];
      const t = lv.tiles.get((X >> 8) * 65536 + (Y >> 8));
      // a neighbouring tile that is missing: stay on the home tile's edge
      if (!t) return home[Math.min(255, Math.max(0, Y - ty * 256)) * 256 + Math.min(255, Math.max(0, X - tx * 256))];
      return t[(Y & 255) * 256 + (X & 255)];
    }
    // Web Mercator's y needs asinh(tan(lat)), the slowest part of a lookup.
    // Near the middle of the area a fourth-order Taylor series is exact to
    // a few centimetres at worst and several times faster.
    let latLo = 90, latHi = -90;
    levels.forEach((lv) => lv.boxes.forEach((b) => { latLo = Math.min(latLo, b.south); latHi = Math.max(latHi, b.north); }));
    const phi0 = ((latLo + latHi) / 2) * Math.PI / 180;
    const sec = 1 / Math.cos(phi0), tan = Math.tan(phi0);
    const m0 = Math.asinh(tan), m1 = sec, m2 = sec * tan / 2, m3 = sec * (tan * tan + sec * sec) / 6,
      m4 = (sec * tan * tan * tan + 5 * sec * sec * sec * tan) / 24;
    function elevAt(lat, lon) {
      const u = (lon + 180) / 360;
      const dp = lat * Math.PI / 180 - phi0;
      const merc = (dp < 0.03 && dp > -0.03)
        ? m0 + dp * (m1 + dp * (m2 + dp * (m3 + dp * m4)))
        : Math.asinh(Math.tan(lat * Math.PI / 180));
      const v = (1 - merc / Math.PI) / 2;
      for (let li = 0; li < loaded.length; li++) {
        const lv = loaded[li];
        if (!lv.tiles.size) continue;
        const gx = u * lv.scale - 0.5, gy = v * lv.scale - 0.5;
        // the tile holding the nearest pixel decides whether this level has the place
        const tx = Math.round(gx) >> 8, ty = Math.round(gy) >> 8;
        const home = tileOf(lv, tx * 65536 + ty);
        if (!home) continue;
        const x0 = Math.floor(gx), y0 = Math.floor(gy), wx = gx - x0, wy = gy - y0;
        const ix = x0 - tx * 256, iy = y0 - ty * 256;
        let a, b, c2, d2;
        if (ix >= 0 && ix < 255 && iy >= 0 && iy < 255) {
          const k = iy * 256 + ix;
          a = home[k]; b = home[k + 1]; c2 = home[k + 256]; d2 = home[k + 257];
        } else {
          a = pixel(lv, home, tx, ty, x0, y0); b = pixel(lv, home, tx, ty, x0 + 1, y0);
          c2 = pixel(lv, home, tx, ty, x0, y0 + 1); d2 = pixel(lv, home, tx, ty, x0 + 1, y0 + 1);
        }
        return (a * (1 - wx) + b * wx) * (1 - wy) + (c2 * (1 - wx) + d2 * wx) * wy;
      }
      return NaN;
    }
    return { elevAt, failed, total };
  }

  /** One zoom level over one box; see loadTerrainLevels. */
  function loadTerrain(bounds, z, loader) {
    return loadTerrainLevels([{ z, boxes: [bounds] }], loader);
  }

  // ---- Map (browser) --------------------------------------------------------

  function cssColor(name, fallback) {
    const v = typeof getComputedStyle === 'function'
      ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '';
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  }

  function nodeColor() {
    const hex = cssColor('--mediamesh-node-color', '#d946ef').slice(1);
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  // The gradient: from a pale, faint tint at the edge of coverage (0 dB to
  // spare) to the full MediaMesh colour where it's strong (RAMP_DB and up).
  const RAMP_DB = 25;
  const ALPHA_MIN = 0.07, ALPHA_MAX = 0.45;

  /** [r, g, b, alpha 0-1] for a margin, or null below 0 dB. */
  function rampColor(margin, rgb) {
    if (!(margin >= 0)) return null;
    const t = Math.min(1, margin / RAMP_DB);
    const mix = 0.45 + 0.55 * t; // share of the MediaMesh colour; the rest white
    return [
      Math.round(255 + (rgb[0] - 255) * mix),
      Math.round(255 + (rgb[1] - 255) * mix),
      Math.round(255 + (rgb[2] - 255) * mix),
      ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * Math.sqrt(t),
    ];
  }

  /** 1 inside the radius, falling to 0 over its last CONFIG.edgeFade, so the
   * limit of the calculation doesn't draw as a hard edge of coverage. */
  function edgeFade(distM, radiusM) {
    const start = radiusM * (1 - CONFIG.edgeFade);
    if (distM <= start) return 1;
    return Math.max(0, (radiusM - distM) / (radiusM - start));
  }

  function cellCenter(cov, col, row) {
    const b = cov.bounds;
    return [b.north - (row + 0.5) * (b.north - b.south) / cov.height, b.west + (col + 0.5) * (b.east - b.west) / cov.width];
  }

  /** The coverage as an image for the map; rgb: another colour (the main
   * mesh's in the comparison); keep(i): only some cells. */
  function coverageImage(cov, rgbIn, keep) {
    return coverageCanvas(cov, rgbIn, keep).toDataURL();
  }

  /** coverageImage as a canvas, for canvasOverlay. */
  function coverageCanvas(cov, rgbIn, keep) {
    const cv = document.createElement('canvas');
    cv.width = cov.width; cv.height = cov.height;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cov.width, cov.height);
    const rgb = rgbIn || nodeColor();
    const radiusM = CONFIG.modes[cov.modeKey].radiusKm * 1000;
    for (let row = 0, i = 0; row < cov.height; row++) {
      for (let col = 0; col < cov.width; col++, i++) {
        const c = rampColor(cov.margins[i], rgb);
        if (!c || (keep && !keep(i))) continue;
        const rep = cov.reps[cov.best[i]];
        const ll = cellCenter(cov, col, row);
        const fade = rep ? edgeFade(distanceM(rep.lat, rep.lon, ll[0], ll[1]), radiusM) : 1;
        img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
        img.data[i * 4 + 3] = Math.round(c[3] * fade * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  /**
   * A Leaflet overlay of a canvas, placed on the map as it is: Leaflet's SVG
   * overlay positions whatever element it is given. Encoding the picture
   * instead (toDataURL) froze the page for a few hundred milliseconds on a
   * big estimate. An image overlay where that layer is missing.
   */
  function canvasOverlay(Lf, cv, latLngBounds, layerOpts) {
    if (typeof Lf.svgOverlay === 'function') return Lf.svgOverlay(cv, latLngBounds, layerOpts);
    return Lf.imageOverlay(cv.toDataURL(), latLngBounds, layerOpts);
  }

  /** The legend's gradient, matching rampColor. */
  function legendGradient() {
    const rgb = nodeColor();
    const stops = [0, 5, 10, 15, 20, 25].map((m) => {
      const c = rampColor(m, rgb);
      return `rgba(${c[0]},${c[1]},${c[2]},${c[3].toFixed(3)}) ${(m / RAMP_DB) * 100}%`;
    });
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }

  /** The cell at lat/lon: { margin, rep (index, -1 none) }, or null off the grid. */
  function cellAt(cov, lat, lon) {
    if (!cov) return null;
    const col = Math.floor(((lon - cov.bounds.west) / (cov.bounds.east - cov.bounds.west)) * cov.width);
    const row = Math.floor(((cov.bounds.north - lat) / (cov.bounds.north - cov.bounds.south)) * cov.height);
    if (col < 0 || col >= cov.width || row < 0 || row >= cov.height) return null;
    const i = row * cov.width + col;
    return { margin: cov.margins[i], rep: cov.best[i] };
  }

  // ---- Areas, planned repeaters ----------------------------------------------

  /**
   * Which grid cells are open water (1), so areas count land: the sea
   * (0.5 m or lower) and lakes, which elevation data holds dead flat (a
   * cell under 40 m whose four neighbours a cell away are within 0.2 m of
   * it). Uint8Array over the grid; null without terrain.
   */
  function waterMask(g, elevAt) {
    if (!elevAt) return null;
    const out = new Uint8Array(g.width * g.height);
    for (let row = 0, i = 0; row < g.height; row++) {
      const lat = g.bounds.north - (row + 0.5) * g.cellLat;
      for (let col = 0; col < g.width; col++, i++) {
        const lon = g.bounds.west + (col + 0.5) * g.cellLon;
        const e = elevAt(lat, lon);
        if (!Number.isFinite(e)) continue;
        if (e <= 0.5) { out[i] = 1; continue; }
        if (e >= 40) continue;
        let flat = true;
        for (const [dy, dx] of [[g.cellLat, 0], [-g.cellLat, 0], [0, g.cellLon], [0, -g.cellLon]]) {
          const n = elevAt(lat + dy, lon + dx);
          if (!(Math.abs(n - e) <= 0.2)) { flat = false; break; }
        }
        if (flat) out[i] = 1;
      }
    }
    return out;
  }

  const isLand = (cov, i) => !cov.water || !cov.water[i];

  /** The area of one grid cell in km², at the grid's middle latitude. */
  function cellAreaKm2(cov) {
    const b = cov.bounds;
    const midLat = (b.north + b.south) / 2;
    const hKm = ((b.north - b.south) / cov.height) * M_PER_DEG_LAT / 1000;
    const wKm = ((b.east - b.west) / cov.width) * M_PER_DEG_LAT * Math.cos(midLat * Math.PI / 180) / 1000;
    return hKm * wKm;
  }

  /** km² with something to spare, over the repeaters counted (cov.margins). */
  function coveredKm2(cov) {
    if (!cov || !cov.margins) return 0;
    let n = 0;
    for (let i = 0; i < cov.margins.length; i++) if (cov.margins[i] >= 0 && isLand(cov, i)) n++;
    return n * cellAreaKm2(cov);
  }

  /** km² covered by all the repeaters together (or those mask allows),
   * whatever is counted on the map: from the rasters, leaving cov.margins
   * alone. */
  function unionKm2(cov, mask) {
    if (!cov || !cov.rasters) return 0;
    // The same answer is asked for several times (the stats, the recap, the
    // 3D view, the comparison): worked out once per cov and mask.
    let memo = areaMemo.get(cov);
    if (!memo || memo.rasters !== cov.rasters || memo.water !== cov.water) {
      memo = { rasters: cov.rasters, water: cov.water, union: new Map(), each: null };
      areaMemo.set(cov, memo);
    }
    const mk = mask && !mask.every(Boolean) ? mask.map((m) => (m ? 1 : 0)).join('') : '*';
    if (memo.union.has(mk)) return memo.union.get(mk);
    const hit = new Uint8Array(cov.width * cov.height);
    const water = cov.water;
    let n = 0;
    cov.rasters.forEach((r, ri) => {
      if (!r || !r.data || (mk !== '*' && !mask[ri])) return;
      const data = r.data;
      for (let y = 0; y < r.h; y++) {
        let i = (r.row0 + y) * cov.width + r.col0, k = y * r.w;
        for (let x = 0; x < r.w; x++, i++, k++) {
          const t = data[k];
          if (t >= 0 && !hit[i] && !(water && water[i])) { hit[i] = 1; n++; }
        }
      }
    });
    const km2 = n * cellAreaKm2(cov);
    memo.union.set(mk, km2);
    return km2;
  }
  const areaMemo = new WeakMap();


  /** km² each repeater covers on its own, by index into cov.reps. */
  function repAreasKm2(cov) {
    if (!cov || !cov.rasters) return [];
    unionKm2(cov); // sets up the memo
    const memo = areaMemo.get(cov);
    if (memo.each) return memo.each.slice();
    const a = cellAreaKm2(cov), water = cov.water;
    memo.each = cov.rasters.map((r) => {
      if (!r || !r.data) return 0;
      const data = r.data;
      let n = 0;
      for (let y = 0; y < r.h; y++) {
        let i = (r.row0 + y) * cov.width + r.col0, k = y * r.w;
        for (let x = 0; x < r.w; x++, i++, k++) if (data[k] >= 0 && !(water && water[i])) n++;
      }
      return n * a;
    });
    return memo.each.slice();
  }

  /** km² on land that only this repeater reaches (no other repeater does),
   * by index into cov.reps. What a repeater adds that the rest don't: three
   * repeaters on neighbouring rooftops each reach a lot, but share almost all
   * of it. */
  function repOnlyKm2(cov) {
    if (!cov || !cov.rasters) return [];
    unionKm2(cov);
    const memo = areaMemo.get(cov);
    if (memo.only) return memo.only.slice();
    const a = cellAreaKm2(cov), water = cov.water;
    const hits = new Uint8Array(cov.width * cov.height);
    const each = (fn) => cov.rasters.forEach((r, ri) => {
      if (!r || !r.data) return;
      for (let y = 0; y < r.h; y++) {
        let i = (r.row0 + y) * cov.width + r.col0, k = y * r.w;
        for (let x = 0; x < r.w; x++, i++, k++) if (r.data[k] >= 0 && !(water && water[i])) fn(i, ri);
      }
    });
    each((i) => { if (hits[i] < 2) hits[i]++; });
    const n = cov.rasters.map(() => 0);
    each((i, ri) => { if (hits[i] === 1) n[ri]++; });
    memo.only = n.map((c) => c * a);
    return memo.only.slice();
  }

  // ---- The mesh: repeaters linked by what's been heard ------------------------

  /** Links heard this often or more are taken as solid; fewer are weaker
   * evidence, like a link only the model predicts. */
  const MESH_OFTEN = 5;

  /**
   * Repeaters that reach each other by the model (repeater to repeater over
   * the terrain, each antenna at its height): [{ a, b, marginDb }] by index
   * into reps, a < b. elevAt as for pathProfile.
   */
  function predictedLinks(reps, elevAt, maxKm) {
    const out = [];
    const lim = (maxKm || CONFIG.modes.repeater.radiusKm) * 1000;
    for (let a = 0; a < reps.length; a++) {
      for (let b = a + 1; b < reps.length; b++) {
        const A = reps[a], B = reps[b];
        if (distanceM(A.lat, A.lon, B.lat, B.lon) > lim) continue;
        const p = pathProfile(A, B.lat, B.lon, elevAt, 'repeater', null, { rxHeightM: antennaHeight(B) });
        if (p && p.marginDb >= 0) out.push({ a, b, marginDb: p.marginDb });
      }
    }
    return out;
  }

  /**
   * The mesh from the evidence. reps: the placed repeaters; backbone: the
   * hops media took ({ a, b, packets }, public keys); links: observers
   * hearing nodes straight off the air ({ from, observer_id, count });
   * predicted: predictedLinks. use: { rare, model } (count links heard 1-4
   * times, and those only the model predicts).
   *
   * Returns { tier, edges, links }: tier per repeater 'often' (in the mesh by
   * links heard MESH_OFTEN+ times), 'weak' (only by weaker evidence) or
   * 'none'; edges [{ a, b, packets, kind: 'often' | 'rare' | 'model',
   * marginDb }]; links: how many repeaters each was heard linking with.
   */
  function meshEvidence(reps, backbone, links, predicted, use) {
    const u = Object.assign({ rare: true, model: true }, use || {});
    const at = new Map();
    reps.forEach((r, i) => { const k = key8(r); if (k && !at.has(k)) at.set(k, i); });
    const ix = (k) => at.get(String(k || '').slice(0, 8).toLowerCase());
    const heard = new Map();
    const add = (a, b, n) => {
      if (a === undefined || b === undefined || a === b) return;
      const k = Math.min(a, b) + ':' + Math.max(a, b);
      heard.set(k, (heard.get(k) || 0) + (Number(n) || 0));
    };
    (backbone || []).forEach((e) => add(ix(e.a), ix(e.b), e.packets));
    (links || []).forEach((l) => add(ix(l.from), ix(l.observer_id), l.count));
    const edges = [];
    heard.forEach((n, k) => {
      const [a, b] = k.split(':').map(Number);
      edges.push({ a, b, packets: n, kind: n >= MESH_OFTEN ? 'often' : 'rare', marginDb: null });
    });
    (predicted || []).forEach((p) => {
      if (!heard.has(Math.min(p.a, p.b) + ':' + Math.max(p.a, p.b))) edges.push({ a: p.a, b: p.b, packets: 0, kind: 'model', marginDb: p.marginDb });
    });
    // Union-find over the edges of the kinds given: each repeater's group.
    const groupOf = (kinds) => {
      const up = reps.map((_, i) => i);
      const find = (x) => (up[x] === x ? x : (up[x] = find(up[x])));
      edges.forEach((e) => { if (kinds[e.kind]) up[find(e.a)] = find(e.b); });
      return reps.map((_, i) => find(i));
    };
    // The mesh: the biggest group by solid links (two repeaters at least),
    // or with none, the biggest by whatever evidence there is.
    const biggest = (g) => {
      const size = new Map();
      g.forEach((x) => size.set(x, (size.get(x) || 0) + 1));
      let main = -1, best = 1;
      size.forEach((n, x) => { if (n > best) { best = n; main = x; } });
      return main;
    };
    const solid = groupOf({ often: true });
    const wide = groupOf({ often: true, rare: u.rare, model: u.model });
    const sMain = biggest(solid);
    const wMain = sMain >= 0 ? wide[sMain] : biggest(wide);
    const tier = reps.map((_, i) => (sMain >= 0 && solid[i] === sMain ? 'often' : wMain >= 0 && wide[i] === wMain ? 'weak' : 'none'));
    const count = reps.map(() => new Set());
    edges.forEach((e) => { if (e.kind !== 'model') { count[e.a].add(e.b); count[e.b].add(e.a); } });
    return { tier, edges, links: count.map((s) => s.size) };
  }

  /**
   * Each land cell by what reaches it, for the mesh view (Uint8Array):
   * 0 nothing, 1 only repeaters not in the mesh, 2 only repeaters in it by
   * weaker evidence, 3 one repeater in the mesh, 4 two or more. Counts the
   * repeaters `counted` allows. Also the km² of each: { cells, km2: [..] }.
   */
  function meshCells(cov, tier, counted) {
    const n = cov.width * cov.height, water = cov.water;
    const linked = new Uint8Array(n), solid = new Uint8Array(n), out = new Uint8Array(n);
    const reached = new Uint8Array(n);
    (cov.rasters || []).forEach((r, ri) => {
      if (!r || !r.data || (counted && !counted[ri])) return;
      const t = tier[ri] || 'none';
      for (let y = 0; y < r.h; y++) {
        let i = (r.row0 + y) * cov.width + r.col0, k = y * r.w;
        for (let x = 0; x < r.w; x++, i++, k++) {
          if (!(r.data[k] >= 0) || (water && water[i])) continue;
          reached[i] = 1;
          if (t === 'none') continue;
          if (linked[i] < 2) linked[i]++;
          if (t === 'often') solid[i] = 1;
        }
      }
    });
    const km2 = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (!reached[i]) continue;
      const c = !linked[i] ? 1 : !solid[i] ? 2 : linked[i] >= 2 ? 4 : 3;
      out[i] = c; km2[c]++;
    }
    const a = cellAreaKm2(cov);
    return { cells: out, km2: km2.map((c) => c * a) };
  }

  /**
   * One row per repeater for "Best placed in the mesh": { index, rep, km2
   * (land in reach), onlyKm2 (land no other repeater in the mesh reaches;
   * null when it isn't in the mesh), links, tier }.
   */
  function meshRows(cov, tier, links, counted) {
    const n = cov.width * cov.height, water = cov.water, hits = new Uint8Array(n);
    const each = (fn) => (cov.rasters || []).forEach((r, ri) => {
      if (!r || !r.data || (counted && !counted[ri])) return;
      for (let y = 0; y < r.h; y++) {
        let i = (r.row0 + y) * cov.width + r.col0, k = y * r.w;
        for (let x = 0; x < r.w; x++, i++, k++) if (r.data[k] >= 0 && !(water && water[i])) fn(i, ri);
      }
    });
    each((i, ri) => { if (tier[ri] !== 'none' && hits[i] < 2) hits[i]++; });
    const land = (cov.rasters || []).map(() => 0), only = land.slice();
    each((i, ri) => { land[ri]++; if (tier[ri] !== 'none' && hits[i] === 1) only[ri]++; });
    const a = cellAreaKm2(cov);
    return cov.reps.map((rep, i) => ({
      index: i, rep, km2: land[i] * a, onlyKm2: tier[i] === 'none' ? null : only[i] * a, links: links[i] || 0, tier: tier[i] || 'none',
    })).filter((r) => !counted || counted[r.index]);
  }

  /** What each mesh cell is drawn as: [r, g, b, alpha 0-1], by meshCells code. */
  const MESH_RGB = { two: '#c026d3', one: '#f0abfc', weak: '#7c3aed', none: '#8b8ba3' };
  function meshPalette() {
    const rgb = (name, fb) => { const h = cssColor('--mm-mesh-' + name, fb).slice(1); return [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16)); };
    return [null, rgb('none', MESH_RGB.none).concat(0.6), rgb('weak', MESH_RGB.weak).concat(0.65),
      rgb('one', MESH_RGB.one).concat(0.6), rgb('two', MESH_RGB.two).concat(0.72)];
  }

  function meshCanvas(cov, mc) {
    const cv = document.createElement('canvas');
    cv.width = cov.width; cv.height = cov.height;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cov.width, cov.height);
    const pal = meshPalette();
    for (let i = 0; i < mc.cells.length; i++) {
      const c = pal[mc.cells[i]];
      if (!c) continue;
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = Math.round(c[3] * 255);
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  const MESH_NOTE = 'The mesh: the people-on-the-ground estimate, coloured by how many repeaters in the mesh reach each place. Repeaters are in the mesh when they have been heard reaching each other, or, as weaker evidence, when the model says they do.';
  const MESH_EVIDENCE = { often: 'heard often', weak: 'weaker evidence', none: 'no link heard or predicted' };

  /** The mesh view's figures, as tiles. mc: meshCells; ev: meshEvidence;
   * reps: the placed repeaters; unplaced: names of linked repeaters with no
   * position. */
  function meshStatsHtml(mc, ev, reps, unplaced) {
    const k = mc.km2;
    const n = ev.tier.filter((t) => t === 'often').length;
    const names = (t) => reps.filter((_, i) => ev.tier[i] === t).map((r) => esc(repName(r)));
    const weak = names('weak'), none = names('none');
    const list = (xs) => (xs.length > 3 ? xs.slice(0, 3).join(', ') + ` and ${xs.length - 3} more` : xs.join(', '));
    const tile = (big, label, cls) => `<div class="mm-mesh-tile"><div class="mm-mesh-big${cls ? ' ' + cls : ''}">${big}</div><div class="mm-mesh-label">${label}</div></div>`;
    return tile(`${fmtKm2(k[3] + k[4])} km²`, `reached by the mesh as heard: ${n} repeater${n === 1 ? '' : 's'} linked by links heard ${MESH_OFTEN}+ times`, 'mm-mesh-big--mesh')
      + tile(`+${fmtKm2(k[2])} km²`, weak.length ? `with weaker evidence (a link heard 1 to ${MESH_OFTEN - 1} times, or one the model predicts): ${list(weak)}` : 'with weaker evidence: none at the moment', 'mm-mesh-big--weak')
      + tile(`${fmtKm2(k[4])} km²`, 'reached by two or more repeaters in the mesh: stays covered if one goes down', 'mm-mesh-big--mesh')
      + tile(`${fmtKm2(k[1])} km²`, (none.length ? `reached only by repeaters with no link heard or predicted: ${list(none)}` : 'every repeater is linked to the mesh')
        + (unplaced && unplaced.length ? `. ${unplaced.length} more repeater${unplaced.length === 1 ? ' has' : 's have'} no position to draw` : ''));
  }

  /** "Best placed in the mesh": every repeater, sortable by reach, what
   * only it reaches, and links heard. sortKey: 'km2' | 'onlyKm2' | 'links'. */
  function meshTableHtml(rows, sortKey) {
    const key = sortKey || 'km2';
    const v = (r) => (r[key] == null ? -1 : r[key]);
    const sorted = rows.slice().sort((a, b) => (a.tier === 'none') - (b.tier === 'none') || v(b) - v(a) || b.km2 - a.km2);
    const th = (k, label, title) => `<th scope="col" class="mm-ins-num" aria-sort="${key === k ? 'descending' : 'none'}"><button type="button" class="mm-mesh-sort${key === k ? ' is-on' : ''}" data-mm-mesh-sort="${k}" title="${title}">${label}${key === k ? ' ▾' : ''}</button></th>`;
    const body = sorted.map((r) => {
      const ev = r.tier === 'often' ? MESH_EVIDENCE.often
        : r.tier === 'weak' ? (r.links ? `weaker: heard 1 to ${MESH_OFTEN - 1} times` : 'weaker: the model predicts it')
          : MESH_EVIDENCE.none;
      return `<tr class="mm-mesh-row mm-mesh-row--${r.tier}"><td><a href="#/nodes/${encodeURIComponent(r.rep.public_key || '')}">${esc(repName(r.rep))}</a></td>`
        + `<td class="mm-ins-num">${fmtKm2(r.km2)} km²</td><td class="mm-ins-num">${r.onlyKm2 == null ? '—' : fmtKm2(r.onlyKm2) + ' km²'}</td>`
        + `<td class="mm-ins-num">${r.links}</td><td class="mm-mesh-ev">${esc(ev)}</td></tr>`;
    }).join('');
    return `<div class="mm-ins-scroll"><table class="analytics-table mm-mesh-table"><thead><tr><th scope="col">Repeater</th>`
      + th('km2', 'Reach', 'Land it reaches; open water is not counted')
      + th('onlyKm2', 'Only it', 'Land no other repeater in the mesh reaches: what the mesh would lose without it')
      + th('links', 'Links heard', 'Repeaters it has been heard linking with')
      + `<th scope="col">Evidence</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function fmtKm2(v) { return v < 100 ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : Math.round(v).toLocaleString(); }


  /**
   * What a planned repeater adds: { newKm2 (covered by it and by nothing
   * counted before), overlapKm2, totalKm2, isNew (Uint8Array over planCov's
   * cells: 1 new, 2 already covered) }. planCov is computeCoverage for the
   * planned repeater alone; cov the existing coverage (may be null).
   */
  function planGain(planCov, cov) {
    const out = { newKm2: 0, overlapKm2: 0, totalKm2: 0, isNew: new Uint8Array(planCov ? planCov.margins.length : 0) };
    if (!planCov) return out;
    const a = cellAreaKm2(planCov);
    let fresh = 0, over = 0;
    for (let row = 0, i = 0; row < planCov.height; row++) {
      for (let col = 0; col < planCov.width; col++, i++) {
        if (!(planCov.margins[i] >= 0)) continue;
        const ll = cellCenter(planCov, col, row);
        const c = cellAt(cov, ll[0], ll[1]);
        // drawn over water too, counted on land only
        const land = isLand(planCov, i);
        if (c && c.margin >= 0) { if (land) over++; out.isNew[i] = 2; } else { if (land) fresh++; out.isNew[i] = 1; }
      }
    }
    out.newKm2 = fresh * a; out.overlapKm2 = over * a; out.totalKm2 = (fresh + over) * a;
    return out;
  }

  /**
   * The counted repeaters a planned one would link to, repeater to repeater
   * (both ways the same path), best first: [{ rep, index, distM, marginDb }]
   * with something to spare, within the repeater view's radius.
   */
  function planLinks(planned, reps, elevAt) {
    const radiusM = CONFIG.modes.repeater.radiusKm * 1000;
    const out = [];
    reps.forEach((r, index) => {
      const distM = distanceM(planned.lat, planned.lon, r.lat, r.lon);
      if (!(distM > 1) || distM > radiusM) return;
      const p = pathProfile(planned, r.lat, r.lon, elevAt, 'repeater', radioFor(r));
      if (p && p.marginDb >= 0) out.push({ rep: r, index, distM, marginDb: p.marginDb });
    });
    return out.sort((a, b) => b.marginDb - a.marginDb);
  }

  // ---- Backbone ----------------------------------------------------------------

  /** Line width for a backbone hop carrying packets, against the busiest. */
  function backboneWeight(packets, maxPackets) {
    if (!(packets > 0) || !(maxPackets > 0)) return 1.5;
    return 1.5 + 4.5 * Math.log1p(packets) / Math.log1p(Math.max(maxPackets, packets));
  }

  /** The tooltip for a backbone hop. */
  function backboneTip(e) {
    const a = e.a_name || String(e.a || '').slice(0, 8), b = e.b_name || String(e.b || '').slice(0, 8);
    return `${esc(a)} ↔ ${esc(b)}: ${Number(e.packets || 0).toLocaleString()} photo, video and voice packet${e.packets === 1 ? '' : 's'} this week`;
  }

  /**
   * Area covered at each step of the time-lapse: [{ t, count, km2 }]. cov
   * holds every repeater's raster (placed order = first's order).
   */
  function areaHistory(cov, first, steps) {
    if (!cov || !cov.rasters) return steps.map((st) => ({ t: st.t, count: st.count, km2: 0 }));
    // Repeaters only ever join as the days go on, so each step adds the
    // newcomers' cells to the last step's: one pass over every raster in all,
    // not one per day.
    const order = steps.map((st, k) => k).sort((x, y) => steps[x].t - steps[y].t);
    const hit = new Uint8Array(cov.width * cov.height), water = cov.water, added = new Uint8Array(cov.rasters.length);
    const a = cellAreaKm2(cov), out = new Array(steps.length);
    let n = 0;
    order.forEach((k) => {
      const here = presentAt(first, steps[k].t);
      cov.rasters.forEach((r, ri) => {
        if (added[ri] || !here[ri]) return;
        added[ri] = 1;
        if (!r || !r.data) return;
        const data = r.data;
        for (let y = 0; y < r.h; y++) {
          let i = (r.row0 + y) * cov.width + r.col0, j = y * r.w;
          for (let x = 0; x < r.w; x++, i++, j++) {
            if (data[j] >= 0 && !hit[i] && !(water && water[i])) { hit[i] = 1; n++; }
          }
        }
      });
      out[k] = { t: steps[k].t, count: steps[k].count, km2: n * a };
    });
    return out;
  }

  /**
   * One repeater's coverage on its own, for its page: { cov, km2 } in the
   * given view, or null without terrain. opts.loadTile as for init.
   */
  async function footprint(rep, modeKey, opts) {
    if (!rep || !Number.isFinite(rep.lat) || !Number.isFinite(rep.lon)) return null;
    const mode = CONFIG.modes[modeKey || 'ground'];
    const terrain = await loadTerrainLevels(terrainPlan([rep], mode), opts && opts.loadTile);
    if (terrain.total && terrain.failed === terrain.total) return null;
    const cov = await computeCoverage([rep], terrain.elevAt, modeKey || 'ground', null, null);
    return cov ? { cov, km2: unionKm2(cov) } : null;
  }

  // ---- What if: one repeater with another antenna, height or power ------------

  /**
   * The terrain under one repeater's rays, sampled once, so its coverage can
   * be worked out again for any antenna height, power or antenna gain
   * without touching the terrain: { rep, modeKey, job, g, water, elevAt }, or
   * null without terrain. opts.loadTile as for init.
   */
  async function whatIfBase(rep, modeKey, opts) {
    if (!rep || !Number.isFinite(rep.lat) || !Number.isFinite(rep.lon)) return null;
    const key = modeKey || 'ground', mode = CONFIG.modes[key];
    const terrain = await loadTerrainLevels(terrainPlan([rep], mode), opts && opts.loadTile);
    if (terrain.total && terrain.failed === terrain.total) return null;
    const g = gridFor([rep], mode);
    const job = withTerrainArrays(prepareJob(rep, radioFor(rep), terrain.elevAt, mode, g, true));
    for (let a = 0; a < job.rays; a += RAYS_PER_STEP) {
      sampleRays(job, terrain.elevAt, a, Math.min(job.rays, a + RAYS_PER_STEP));
      if (a % (RAYS_PER_STEP * 8) === 0) await new Promise((res) => setTimeout(res, 0));
    }
    return { rep, modeKey: key, job, g, water: waterMask(g, terrain.elevAt), elevAt: terrain.elevAt };
  }

  /** The settings a repeater is drawn with today: { heightM, txDbm, gainDbi }. */
  function whatIfDefaults(rep) {
    return { heightM: antennaHeight(rep), txDbm: CONFIG.txDbm, gainDbi: CONFIG.txGainDbi };
  }

  /**
   * The job for other settings: the same terrain, another antenna height
   * and as many dB more or less to spend as the power and antenna add.
   * copy: give it arrays of its own (a worker takes them away).
   */
  function whatIfJob(base, settings, copy) {
    const d = whatIfDefaults(base.rep);
    const job = Object.assign({}, base.job, {
      txHeightM: Math.max(1, Math.min(300, Number(settings.heightM) || d.heightM)),
      budgetDb: base.job.budgetDb + ((Number(settings.txDbm) || d.txDbm) - d.txDbm) + ((Number.isFinite(Number(settings.gainDbi)) ? Number(settings.gainDbi) : d.gainDbi) - d.gainDbi),
    });
    if (copy) { job.elev = base.job.elev.slice(); job.peak = base.job.peak.slice(); }
    return job;
  }

  /**
   * Coverage for other settings, as computeCoverage gives it (one
   * repeater). run(job) may hand the work to a worker (workerPool's run).
   */
  async function whatIfCoverage(base, settings, run) {
    const job = whatIfJob(base, settings, !!run);
    const data = run ? await run(job, () => whatIfJob(base, settings, false)) : repRaster(job);
    const g = base.g;
    return merge({ rasters: [{ col0: job.col0, row0: job.row0, w: job.w, h: job.h, data }], reps: [base.rep], radios: [radioFor(base.rep)],
      width: g.width, height: g.height, bounds: g.bounds, modeKey: base.modeKey, water: base.water });
  }

  /**
   * The comparison on the map: cells the new settings add (cyan), cells
   * they lose (red, faint) and those both reach (MediaMesh pink, faint).
   */
  function whatIfCanvas(before, after) {
    const cv = document.createElement('canvas');
    cv.width = after.width; cv.height = after.height;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(after.width, after.height);
    const pink = nodeColor(), lost = (() => { const h = cssColor('--status-red', '#ef4444').slice(1); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); })();
    for (let i = 0; i < after.margins.length; i++) {
      const a = before.margins[i] >= 0, b = after.margins[i] >= 0;
      if (!a && !b) continue;
      if (after.water && after.water[i]) continue;
      const c = b && !a ? rampColor(Math.max(8, after.margins[i]), PLAN_RGB) : a && !b ? [lost[0], lost[1], lost[2], 0.32] : rampColor(after.margins[i], pink);
      if (!c) continue;
      const alpha = b && !a ? Math.max(0.3, c[3] * 1.2) : a && !b ? c[3] : c[3] * 0.55;
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = Math.round(alpha * 255);
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  // ---- Growth time-lapse ------------------------------------------------------

  const DAY_MS = 86400000;
  const ICON = (id) => `<svg class="ph-icon" aria-hidden="true"><use href="/icons/phosphor-sprite.svg#${id}"/></svg>`;
  const PLAY_HTML = ICON('ph-play') + ' Play growth';
  const PAUSE_HTML = ICON('ph-pause') + ' Pause';

  /**
   * The days the time-lapse steps through: from the day the first repeater
   * appeared to today, each { t (end of that day, ms), count (repeaters by
   * then) }. first: each repeater's first-seen time (ISO; unknown counts from
   * the start). Empty with under two days of history.
   */
  function growthSteps(first, nowMs) {
    const ts = first.map((f) => Date.parse(f)).filter(Number.isFinite);
    if (!ts.length) return [];
    const start = Math.floor(Math.min(...ts) / DAY_MS) * DAY_MS;
    const end = Math.floor(nowMs / DAY_MS) * DAY_MS;
    if (end - start < 2 * DAY_MS) return [];
    const out = [];
    for (let d = start; d <= end; d += DAY_MS) {
      const t = d + DAY_MS - 1;
      out.push({ t, count: first.filter((f) => { const v = Date.parse(f); return !Number.isFinite(v) || v <= t; }).length });
    }
    return out;
  }

  /** Whether each repeater was there by time t (ms); unknown first-seen: yes. */
  function presentAt(first, t) {
    return first.map((f) => { const v = Date.parse(f); return !Number.isFinite(v) || v <= t; });
  }

  const PLAN_RGB = [6, 182, 212]; // cyan, apart from the MediaMesh pink

  /** The planned repeater's overlay: new coverage strong, overlap faint. */
  function planImage(planCov, gain) {
    const cv = document.createElement('canvas');
    cv.width = planCov.width; cv.height = planCov.height;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(planCov.width, planCov.height);
    const radiusM = CONFIG.modes[planCov.modeKey].radiusKm * 1000;
    const rep = planCov.reps[0];
    for (let row = 0, i = 0; row < planCov.height; row++) {
      for (let col = 0; col < planCov.width; col++, i++) {
        const kind = gain.isNew[i];
        if (!kind) continue;
        const c = rampColor(planCov.margins[i], PLAN_RGB);
        if (!c) continue;
        const ll = cellCenter(planCov, col, row);
        const fade = edgeFade(distanceM(rep.lat, rep.lon, ll[0], ll[1]), radiusM);
        img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
        img.data[i * 4 + 3] = Math.round((kind === 1 ? Math.max(0.22, c[3] * 1.3) : 0.08) * fade * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
  }

  /** The planned repeater's panel. */
  function planHtml(planned, gain, links, modeKey, busy) {
    const where = `${planned.lat.toFixed(4)}, ${planned.lon.toFixed(4)}`;
    const heights = [5, 10, 20, 30, 50].map((h) => `<option value="${h}"${h === antennaHeight(planned) ? ' selected' : ''}>${h} m</option>`).join('');
    const who = modeKey === 'ground' ? 'people on the ground' : 'other repeaters';
    let body;
    if (busy) {
      body = '<p class="text-muted mm-cov-note">Working it out…</p>';
    } else if (!gain) {
      body = '<p class="text-muted mm-cov-note">No terrain data there.</p>';
    } else {
      const km = (v) => (v < 100 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v).toLocaleString());
      const linkText = links.length
        ? links.slice(0, 6).map((l) => `${esc(repName(l.rep))} <span class="text-muted">(${fmtKm(l.distM)}, +${fmtDb(l.marginDb)} dB)</span>`).join(', ')
          + (links.length > 6 ? ` and ${links.length - 6} more` : '')
        : 'none of the repeaters counted: it would be on its own';
      body = `<p class="mm-cov-plan-big"><strong>+${km(gain.newKm2)} km²</strong> of new coverage for ${who}`
        + ` <span class="text-muted">(${km(gain.totalKm2)} km² in all, ${km(gain.overlapKm2)} km² already covered)</span></p>`
        + `<p class="mm-cov-note">Links to: ${linkText}</p>`;
    }
    return '<div class="mm-cov-plan-head"><strong>Planned repeater</strong>'
      + ` <span class="text-muted">${where}</span>`
      + ` <label class="mm-cov-plan-height">Antenna <select data-mm-cov-plan-height aria-label="Planned antenna height above ground">${heights}</select></label>`
      + ' <button type="button" class="mm-cov-chip mm-cov-chip--all" data-mm-cov-plan-remove>Remove</button></div>'
      + body
      + '<p class="text-muted mm-cov-note">Drag the cyan marker to try other spots. Same assumptions as the map: 22 dBm, 2 dBi, the radio2 preset.</p>';
  }

  /** "≈ 12 dB to spare (fair), 4.2 km from First Hill" for the cell at lat/lon. */
  function readout(cov, lat, lon) {
    const cell = cellAt(cov, lat, lon);
    if (!cell) return '';
    const rep = cov.reps[cell.rep];
    const from = rep ? `${fmtKm(distanceM(rep.lat, rep.lon, lat, lon))} from ${repName(rep)}` : '';
    if (!(cell.margin >= 0)) {
      const short = rep && cell.margin > NO_DATA / 2 ? ` (about ${Math.max(1, Math.round(-cell.margin))} dB short, ${from})` : '';
      return 'Out of estimated MediaMesh coverage here' + short;
    }
    return `≈ ${Math.round(cell.margin)} dB to spare (${band(cell.margin)})` + (from ? ', ' + from : '');
  }

  /** What sets a repeater apart, for its row in the picker. */
  function repNotes(r) {
    const radio = parseRadio(r.radio);
    const bits = [];
    if (r.mode === 'rx') bits.push('listens only');
    if (r.source === 'relayed') bits.push('relayed');
    if (radio && (radio.bwKHz !== CONFIG.bwKHz || radio.sf !== CONFIG.sf || Math.abs(radio.freqMHz - CONFIG.freqMHz) > 0.0005)) {
      bits.push(`${radio.freqMHz} MHz, ${radio.bwKHz} kHz SF${radio.sf}`);
    }
    return bits;
  }

  /** The area a repeater is grouped under: the first part of its Near label. */
  function repArea(r) {
    const near = String((r && r.near) || '').trim();
    return near ? near.split(',')[0].trim() : 'No area';
  }

  /**
   * Repeaters grouped by area: the busiest areas first, then by name, with
   * "No area" last. Each group holds indexes into reps.
   */
  function repGroups(reps) {
    const by = new Map();
    reps.forEach((r, i) => {
      const a = repArea(r);
      if (!by.has(a)) by.set(a, []);
      by.get(a).push(i);
    });
    const name = (i) => repName(reps[i]).toLowerCase();
    return [...by.entries()]
      .map(([area, idx]) => ({ area, idx: idx.sort((x, y) => name(x).localeCompare(name(y))) }))
      .sort((x, y) => (x.area === 'No area') - (y.area === 'No area') || y.idx.length - x.idx.length || x.area.localeCompare(y.area));
  }

  /** The line that opens the repeater picker. */
  function repSummaryHtml(reps, enabled, open) {
    if (!reps.length) return '';
    const count = enabled ? enabled.filter(Boolean).length : reps.length;
    const what = count === reps.length ? `all ${reps.length} repeaters` : `${count} of ${reps.length} repeaters`;
    return `<button type="button" class="mm-cov-reps-toggle" data-mm-cov-panel aria-expanded="${open ? 'true' : 'false'}" aria-controls="mmCovRepPanel">`
      + `Counting ${what} <span class="mm-cov-caret" aria-hidden="true">${open ? '▴' : '▾'}</span></button>`;
  }

  /**
   * The repeater picker: a search box, quick actions, and the repeaters
   * grouped by area, each group with a box that counts or drops it whole.
   * Small groups start open; searching opens the groups that match.
   */
  function repPanelHtml(reps) {
    if (!reps.length) return '';
    const groups = repGroups(reps).map((g, gi) => {
      const rows = g.idx.map((i) => {
        const r = reps[i];
        const notes = repNotes(r);
        const search = [repName(r), r.near || '', r.public_key || ''].join(' ').toLowerCase();
        return `<label class="mm-cov-rep${r.source === 'relayed' ? ' mm-cov-rep--relayed' : ''}" data-mm-cov-search="${esc(search)}">`
          + `<input type="checkbox" data-mm-cov-rep="${i}" checked> <span class="mm-cov-rep-name">${esc(repName(r))}</span>`
          + (notes.length ? ` <span class="mm-cov-rep-note">${esc(notes.join(' · '))}</span>` : '') + '</label>';
      }).join('');
      const open = g.idx.length <= 3;
      return `<div class="mm-cov-group" data-mm-cov-group="${gi}">`
        + '<div class="mm-cov-group-head">'
        + `<input type="checkbox" data-mm-cov-area="${esc(g.idx.join(','))}" aria-label="Count every repeater in ${esc(g.area)}" checked>`
        + `<button type="button" class="mm-cov-group-toggle" data-mm-cov-fold aria-expanded="${open}">`
        + `<span class="mm-cov-group-name">${esc(g.area)}</span> <span class="mm-cov-group-count" data-mm-cov-group-count></span>`
        + ` <span class="mm-cov-caret" aria-hidden="true">${open ? '▴' : '▾'}</span></button></div>`
        + `<div class="mm-cov-group-body"${open ? '' : ' hidden'}>${rows}</div></div>`;
    }).join('');
    return '<div class="mm-cov-panel-tools">'
      + '<input type="search" class="mm-cov-search" data-mm-cov-search-box placeholder="Find a repeater or area" aria-label="Find a repeater or area">'
      + '<span class="mm-cov-actions">'
      + '<button type="button" class="mm-cov-chip mm-cov-chip--all" data-mm-cov-act="all">All</button>'
      + '<button type="button" class="mm-cov-chip mm-cov-chip--all" data-mm-cov-act="none">None</button>'
      + '<button type="button" class="mm-cov-chip mm-cov-chip--all" data-mm-cov-act="view" title="Count only the repeaters on the map as it is now">Only those in view</button>'
      + '<button type="button" class="mm-cov-chip mm-cov-chip--all" data-mm-cov-act="reported" title="Count only repeaters that reported their MediaMesh setting themselves">Only self-reported</button>'
      + '<button type="button" class="mm-cov-chip mm-cov-chip--all" data-mm-cov-act="norelayed" title="Leave out repeaters known only from relaying">Leave out relayed-only</button>'
      + '</span></div>'
      + `<div class="mm-cov-groups">${groups}</div>`
      + '<p class="text-muted mm-cov-empty" data-mm-cov-empty hidden>No repeater or area matches.</p>';
  }

  /** Which repeaters a quick action counts; null for an unknown action. */
  function repAction(act, reps, inView) {
    switch (act) {
      case 'all': return reps.map(() => true);
      case 'none': return reps.map(() => false);
      case 'view': return reps.map((r) => !!(inView && inView(r)));
      case 'reported': return reps.map((r) => r.source === 'status');
      case 'norelayed': return reps.map((r) => r.source !== 'relayed');
      default: return null;
    }
  }

  /** What the estimate assumes, as list items, with the numbers in use. */
  function assumptionsHtml(modeKey, radios, cal, f, info) {
    const c = CONFIG, mode = c.modes[modeKey], t = c.terrain;
    const def = DEFAULT_RADIO;
    const reported = (radios || []).filter((r) => r.reported).length;
    const other = (radios || []).filter((r) => r.reported && r.sensitivityDbm !== def.sensitivityDbm).length;
    const items = [
      `<strong>Sending:</strong> ${c.txDbm} dBm into a ${c.txGainDbi} dBi antenna through ${c.cableDb} dB of cable, ${c.txHeightM} m above the ground at every repeater${KNOWN_HEIGHTS.length ? `, except where the owner gave its height: ${KNOWN_HEIGHTS.map((h) => `${h.name} ${Math.round(h.ft * FT)} m`).join(', ')}` : ''}.`,
      mode.clutter
        ? `<strong>Receiving:</strong> a companion or standalone radio held in the hand at ${mode.rxHeightM} m: ${fmtDb(mode.rxGainDbi)} dBi for a short antenna next to the body, and buildings and trees by distance from the repeater (ITU-R P.2108, the median: ${fmtDb(clutterLossDb(0.25))} dB at 250 m, ${fmtDb(clutterLossDb(1))} dB from about 500 m on), none over open water.`
          + ` <strong>Where you are:</strong> ${CONFIG.places.map((pl) => pl.lossDb ? `${pl.label.toLowerCase()}, ${fmtDb(placeLossDb(pl.key))} dB more${pl.key === 'car' && f && Number.isFinite(f.carLossDb) ? ' (measured on drives)' : pl.key === 'indoors' ? ' (ITU-R P.2109, a typical building)' : ''}` : pl.label.toLowerCase() + ' as drawn').join('; ')}.`
        : `<strong>Receiving:</strong> another repeater's ${mode.rxGainDbi} dBi antenna, ${mode.rxHeightM} m above the ground.`,
      `<strong>Radio:</strong> each repeater's reported radio2 setting where it has sent one (${reported} of ${(radios || []).length} here${other ? `, ${other} not on the default preset` : ''}), otherwise ${def.freqMHz} MHz, ${def.bwKHz} kHz, SF${def.sf}. That preset needs ${fmtDb(def.sensitivityDbm)} dBm at the receiver (SX1262 datasheet); the estimate asks for ${c.fadeMarginDb} dB more as a safety margin against fading.`,
      `<strong>Path:</strong> free-space loss, the earth's curve (k = 4/3), and diffraction over up to three ridges (ITU-R P.526-11, cascaded knife edges). Ground that only comes close to the line of sight costs signal too: a path has to clear its first Fresnel zone to count as clean. Over open water and flat ground the wave reflected off the surface cancels the direct one, so loss is at least the plane-earth (two-ray) loss for each antenna's height above the ground in between.`,
      `<strong>Terrain:</strong> Mapzen elevation tiles (SRTM, USGS), about ${t.nearZoom === 12 ? '25' : '50'} m per pixel next to a repeater and 50 to 100 m further out, worked out to ${mode.radiusKm} km from each repeater.`,
      mode.clutter ? `<strong>Measured on the ground:</strong> ${esc(fieldText(f, info))}${f && f.used ? ' This correction is used for people on the ground in place of the one from links between repeaters.' : ''}` : '',
      `<strong>Checked:</strong> ${esc(calibrationText(cal))}${cal && cal.used && cal.offsetDb ? (cal.offsetDb > 0
        ? ' The raise applies repeater to repeater only: those links run between antennas often higher than 10 m, and only links strong enough to be heard are in them, so they never raise the estimate for people on the ground.'
        : ' The correction is added to every path, for both views.') : ''}`,
      '<strong>Areas:</strong> km² count land only; open water (the Sound, lakes) is drawn but not counted.',
      '<strong>Not modelled:</strong> the actual buildings and trees in the way (the terrain data is bare ground; the allowance above is an average), interference and local noise, reflections, each site\'s real antenna, height and power. A street lined with tall buildings will be worse than drawn; a rooftop or a window facing the repeater can be better. Repeaters that only listen can hear you but won\'t send back.',
    ];
    return items.filter(Boolean).map((i) => `<li>${i}</li>`).join('');
  }

  /**
   * Links actually heard on radio2 (the analytics API's `links`), each with
   * what the model expects for the same path. elevAt may be null (no model
   * figures then). Returns rows sorted by packets heard:
   * { from, to, fromLat, fromLon, toLat, toLon, count, avgSnr, avgRssi,
   *   distM, modelRssi, delta (heard minus model, dB) }.
   * A repeater or room server is taken as 10 m up at both ends (or the
   * height its owner gave); anything else as a radio on the ground heard by
   * the observer's antenna.
   */
  function linkRows(links, elevAt) {
    const fixed = (role) => /repeater|room/i.test(role || '');
    return (links || []).filter((l) => [l.from_lat, l.from_lon, l.to_lat, l.to_lon].every(Number.isFinite)).map((l) => {
      const row = {
        from: l.from_name || (l.from || '').slice(0, 8), to: l.observer_name || (l.observer_id || '').slice(0, 8),
        fromLat: l.from_lat, fromLon: l.from_lon, toLat: l.to_lat, toLon: l.to_lon,
        count: l.count || 0, lastHeard: l.last_heard || '',
        avgSnr: Number.isFinite(l.avg_snr) ? l.avg_snr : null,
        avgRssi: Number.isFinite(l.avg_rssi) ? l.avg_rssi : null,
        distM: distanceM(l.from_lat, l.from_lon, l.to_lat, l.to_lon),
        modelRssi: null, delta: null, rawModelRssi: null, rawDelta: null,
      };
      if (elevAt) {
        const radio = radioFor({ radio: l.radio });
        // Loss is the same both ways, so a radio on the ground is worked out
        // from the fixed end towards it.
        // Each end at its real height where its owner gave one (a rooftop),
        // so a link off a tall building isn't mistaken for the model being low.
        const obsH = knownHeightM({ public_key: l.observer_id });
        const p = fixed(l.from_role)
          ? pathProfile({ lat: l.from_lat, lon: l.from_lon, public_key: l.from }, l.to_lat, l.to_lon, elevAt, 'repeater', radio,
            obsH ? { rxHeightM: obsH } : null)
          : pathProfile({ lat: l.to_lat, lon: l.to_lon, public_key: l.observer_id }, l.from_lat, l.from_lon, elevAt, 'ground', radio);
        if (p) {
          row.modelRssi = p.rxDbm;
          row.rawModelRssi = p.rxDbm - p.calibrationDb - p.fieldDb;
          if (row.avgRssi !== null) {
            row.delta = row.avgRssi - p.rxDbm;
            row.rawDelta = row.avgRssi - row.rawModelRssi;
          }
        }
      }
      return row;
    }).sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
  }

  // The fit: enough links, each heard often enough to trust its average,
  // and a correction kept within limits. Links that were heard at all are
  // the ones strong enough to get through, so the heard signal leans high;
  // the upward limit is the tighter one for that reason.
  const CAL = { minLinks: 3, minPackets: 5, maxUpDb: 6, maxDownDb: 12 };

  function median(xs) {
    const v = xs.slice().sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  /**
   * Fits the correction to the heard links (linkRows rows): the median of
   * heard minus model, before any correction, over links heard at least
   * CAL.minPackets times, limited to +CAL.maxUpDb / -CAL.maxDownDb.
   * Returns { n, offsetDb, fitDb (unlimited), spreadDb (median distance of
   * the corrected links from the model), used } — used false (offset 0)
   * below CAL.minLinks links.
   */
  function fitCalibration(rows) {
    const d = (rows || []).filter((r) => r.rawDelta !== null && r.rawDelta !== undefined && r.count >= CAL.minPackets)
      .map((r) => r.rawDelta);
    if (d.length < CAL.minLinks) return { n: d.length, offsetDb: 0, fitDb: null, spreadDb: null, used: false };
    const fitDb = median(d);
    const offsetDb = Math.round(Math.max(-CAL.maxDownDb, Math.min(CAL.maxUpDb, fitDb)) * 10) / 10;
    const spreadDb = Math.round(median(d.map((x) => Math.abs(x - offsetDb))) * 10) / 10;
    return { n: d.length, offsetDb, fitDb, spreadDb, used: true };
  }

  /** One line on how the model compares with what was heard. */
  function calibrationText(cal) {
    if (!cal || !cal.used) {
      return `Not yet checked against real links: it needs ${CAL.minLinks} links heard on radio2 at least ${CAL.minPackets} times each${cal && cal.n ? ` (${cal.n} so far)` : ''}.`;
    }
    const adj = cal.offsetDb === 0 ? 'no correction needed'
      : `${cal.offsetDb > 0 ? 'raised' : 'lowered'} by ${fmtDb(Math.abs(cal.offsetDb))} dB to match`;
    const limited = cal.fitDb !== null && Math.abs(cal.fitDb - cal.offsetDb) > 0.05 ? ` (the links suggest ${cal.fitDb > 0 ? '+' : '−'}${fmtDb(Math.abs(cal.fitDb))} dB; capped)` : '';
    return `Checked against ${cal.n} real links heard on radio2: ${adj}${limited}, and typically within ±${fmtDb(cal.spreadDb)} dB of them.`;
  }

  // ---- Measured coverage points ------------------------------------------------

  /** The correction (dB) that best fits pairs: { raw (the model's margin
   * before any correction), meas (measured, heard) or limit (not heard: the
   * margin was below it), w }. Least squares on the heard, and a penalty
   * where the corrected model says a repeater that didn't answer should have. */
  function fieldSolve(pairs) {
    const cost = (d) => {
      let s = 0;
      for (const q of pairs) {
        if (q.meas !== undefined) { const e = q.meas - q.raw - d; s += q.w * e * e; } else {
          const e = q.raw + d - q.limit;
          if (e > 0) s += q.w * e * e;
        }
      }
      return s;
    };
    let lo = -40, hi = 25;
    for (let k = 0; k < 60; k++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (cost(a) <= cost(b)) hi = b; else lo = a;
    }
    return (lo + hi) / 2;
  }

  /**
   * Fits the estimate for people on the ground to measured coverage points:
   * cells is GET /api/mediamesh/coverage-points' cells, reps the placed
   * repeaters, elevAt the terrain. Each cell and nearby repeater is a pair:
   * the margin measured (from the main mesh's SNR, as the apps estimate it)
   * or, where it didn't answer, a ceiling; against the model's margin with no
   * safety margin taken off. Walks fit the correction; drives, where there
   * are enough, what a car costs on top. Returns { used, n, cells, offsetDb,
   * fitDb, spreadDb, reps: { key8: dB }, carLossDb, carN }.
   */
  function fitField(cells, reps, elevAt) {
    const F = CONFIG.field;
    const none = { used: false, n: 0, cells: 0, offsetDb: 0, fitDb: null, spreadDb: null, reps: {}, carLossDb: null, carN: 0 };
    if (!elevAt || !Array.isArray(cells) || !cells.length) return none;
    const byKey = new Map();
    reps.forEach((r) => { if (Number.isFinite(r.lat) && Number.isFinite(r.lon) && key8(r)) byKey.set(key8(r), r); });
    if (!byKey.size) return none;
    const raw = (rep, cell) => {
      const p = pathProfile(rep, cell.lat, cell.lon, elevAt, 'ground', radioFor(rep), { noField: true });
      return p ? p.rxDbm - p.calibrationDb - p.sensitivityDbm : null;
    };
    const pairs = [];
    const sorted = cells.filter((c) => c && c.n > 0 && Number.isFinite(c.lat) && Number.isFinite(c.lon)).sort((a, b) => b.n - a.n);
    for (const c of sorted) {
      if (pairs.length >= F.maxPairs) break;
      const heard = new Map((c.reps || []).map((r) => [String(r.key || '').toLowerCase(), r]));
      byKey.forEach((rep, k) => {
        const h = heard.get(k);
        if (!h && distanceM(rep.lat, rep.lon, c.lat, c.lon) > F.nearKm * 1000) return;
        const m = raw(rep, c);
        if (m === null) return;
        if (h) pairs.push({ key: k, car: !!c.car, raw: m, meas: h.margin, w: Math.min(5, h.n || 1) });
        // didn't answer in any of the cell's samples
        else if (m > F.unheardDb - 15) pairs.push({ key: k, car: !!c.car, raw: m, limit: F.unheardDb, w: Math.min(5, c.n) });
      });
    }
    const walk = pairs.filter((q) => !q.car), heardWalk = walk.filter((q) => q.meas !== undefined);
    const out = Object.assign({}, none, { n: heardWalk.length, cells: sorted.length });
    if (heardWalk.length < F.minCells) return out;
    const fitDb = fieldSolve(walk);
    const offsetDb = Math.round(Math.max(-F.maxDownDb, Math.min(F.maxUpDb, fitDb)) * 10) / 10;
    const spreadDb = Math.round(median(heardWalk.map((q) => Math.abs(q.meas - q.raw - offsetDb))) * 10) / 10;
    const repAdj = {};
    byKey.forEach((_, k) => {
      const mine = walk.filter((q) => q.key === k), n = mine.filter((q) => q.meas !== undefined).length;
      if (n < F.repMinCells) return;
      const own = Math.max(-F.maxDownDb, Math.min(F.maxUpDb, fieldSolve(mine)));
      const adj = Math.round((own - offsetDb) * n / (n + F.repShrink) * 10) / 10;
      if (adj) repAdj[k] = adj;
    });
    const car = pairs.filter((q) => q.car), carN = car.filter((q) => q.meas !== undefined).length;
    let carLossDb = null;
    if (carN >= F.carMinCells) {
      // the walks' corrections, then what is left over is the car
      const left = car.map((q) => Object.assign({}, q, { raw: q.raw + offsetDb + (repAdj[q.key] || 0) }));
      carLossDb = Math.round(Math.max(0, Math.min(25, -fieldSolve(left))) * 10) / 10;
    }
    return Object.assign(out, { used: true, offsetDb, fitDb, spreadDb, reps: repAdj, carLossDb, carN });
  }

  /** One line on how the ground estimate compares with what was measured. */
  function fieldText(f, info) {
    const F = CONFIG.field;
    if (!f || !f.used) {
      return f && f.n
        ? `Not yet checked against coverage measured on the ground: it needs ${F.minCells} spots where a repeater answered (${f.n} so far).`
        : 'Not yet checked against coverage measured on the ground. Switch on Share coverage points in MeshCore Open TAK or a Wadamesh TAK standalone, then map MediaMesh coverage on a walk.';
    }
    const adj = f.offsetDb === 0 ? 'no correction needed' : `${f.offsetDb > 0 ? 'raised' : 'lowered'} by ${fmtDb(Math.abs(f.offsetDb))} dB to match`;
    const capped = f.fitDb !== null && Math.abs(f.fitDb - f.offsetDb) > 0.05 ? ` (they suggest ${f.fitDb > 0 ? '+' : '−'}${fmtDb(Math.abs(f.fitDb))} dB; capped)` : '';
    const nr = Object.keys(f.reps).length;
    const who = info && info.radios ? ` from ${info.radios} radio${info.radios === 1 ? '' : 's'}` : '';
    return `Checked against ${f.n} spots measured on the ground${who}: ${adj}${capped}, typically within ±${fmtDb(f.spreadDb)} dB.`
      + (nr ? ` ${nr} repeater${nr === 1 ? ' has' : 's have'} a correction of ${nr === 1 ? 'its' : 'their'} own.` : '')
      + (Number.isFinite(f.carLossDb) ? ` Drives put a car at ${fmtDb(f.carLossDb)} dB.` : '');
  }

  /** Measured cell colours, as the apps draw their coverage dots. */
  const FIELD_RGB = { good: '#16a34a', marginal: '#f59e0b', out: '#dc2626', none: '#6b7280' };
  function fieldBand(cell) {
    const best = (cell.reps || []).reduce((m, r) => Math.max(m, r.margin), -Infinity);
    if (best === -Infinity) return 'none';
    return best >= 5 ? 'good' : best >= 0 ? 'marginal' : 'out';
  }

  /**
   * The estimate with the measured correction and where you are applied:
   * a copy of cov whose rasters are shifted, repeater by repeater (cov
   * itself, untouched, when nothing applies). Repeater to repeater never.
   */
  function adjustCov(cov, place) {
    if (!cov || !CONFIG.modes[cov.modeKey] || !CONFIG.modes[cov.modeKey].clutter) return cov;
    const lossDb = placeLossDb(place);
    const shift = cov.reps.map((r) => fieldDbFor(cov.modeKey, r) - lossDb);
    if (shift.every((s) => Math.abs(s) < 0.05)) return cov;
    const rasters = cov.rasters.map((r, ri) => {
      if (!r || !r.data) return r;
      const d = Math.round(shift[ri] * 10), src = r.data, data = new Int16Array(src.length);
      for (let k = 0; k < src.length; k++) {
        const v = src[k];
        data[k] = v === NO_DATA_I16 ? v : Math.max(-32767, Math.min(32767, v + d));
      }
      return Object.assign({}, r, { data });
    });
    return Object.assign({}, cov, { rasters, margins: null, best: null, place, shiftDb: shift });
  }

  /** The heard-links table. */
  function linksTableHtml(rows) {
    if (!rows.length) return '';
    const num = (v, unit) => (v === null ? '—' : fmtDb(v) + unit);
    const body = rows.map((r) => {
      const delta = r.delta === null ? '—' : (r.delta >= 0 ? '+' : '') + fmtDb(r.delta) + ' dB';
      return `<tr><td>${esc(r.from)} → ${esc(r.to)}</td><td>${esc(fmtKm(r.distM))}</td><td>${r.count}</td>`
        + `<td>${num(r.avgSnr, ' dB')}</td><td>${num(r.avgRssi, ' dBm')}</td><td>${num(r.modelRssi, ' dBm')}</td><td>${delta}</td></tr>`;
    }).join('');
    return '<div class="mm-cov-links-scroll"><table class="data-table mm-cov-links-table"><thead><tr>'
      + '<th>Heard on radio2</th><th>Distance</th><th>Packets</th><th>SNR</th><th>RSSI</th><th>Model</th><th>Heard − model</th>'
      + `</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  const session = { key: '', loader: null, linksSig: '', modes: {}, cal: null, place: 'outdoors', fieldInfo: null, fieldFit: null };

  /** GET /api/mediamesh/coverage-points, or null. */
  async function loadFieldPoints(opts) {
    if (opts && opts.fieldPoints !== undefined) return opts.fieldPoints;
    if (typeof fetch !== 'function') return null;
    try {
      const res = await fetch('/api/mediamesh/coverage-points', { headers: { Accept: 'application/json' } });
      return res.ok ? await res.json() : null;
    } catch (_) { return null; }
  }

  // The points, fetched once for the map and the tab's "km² mapped by people"
  // card together, and again after FIELD_TTL_MS.
  const FIELD_TTL_MS = 5 * 60 * 1000;
  let fieldOnce = null, fieldOnceAt = 0;
  function fieldPoints(opts) {
    if (opts && opts.fieldPoints !== undefined) return Promise.resolve(opts.fieldPoints);
    if (!fieldOnce || Date.now() - fieldOnceAt > FIELD_TTL_MS) {
      fieldOnceAt = Date.now();
      fieldOnce = loadFieldPoints();
    }
    return fieldOnce;
  }

  /** The Mapped by people hexagon h (GET /api/mediamesh/coverage-points'
   * hexes: middle, corner radius in Web Mercator metres) as six [lat, lon]
   * corners, flat-topped, as the analyzer grids them. */
  function hexCorners(h) {
    const R = 6378137, d = 180 / Math.PI;
    const x = h.lon / d * R, y = R * Math.log(Math.tan(Math.PI / 4 + h.lat / d / 2));
    const out = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 3 * i;
      const cx = x + h.r * Math.cos(a), cy = y + h.r * Math.sin(a);
      out.push([(2 * Math.atan(Math.exp(cy / R)) - Math.PI / 2) * d, cx / R * d]);
    }
    return out;
  }

  /** The hexagon's colour: by its best repeater's margin, as the apps' dots. */
  function hexBand(h) {
    return h.best >= 5 ? 'good' : h.best >= 0 ? 'marginal' : 'out';
  }

  /**
   * Draws the coverage card's map in el (which holds #mmCovMap, the mode
   * buttons [data-mm-cov] and #mmCovStatus). repeaters: the MediaMesh tab's
   * list (with lat/lon where known). opts.links: the links heard on radio2.
   * Returns a destroy function.
   */
  function init(el, repeaters, opts) {
    const L = root.L;
    const mapEl = el.querySelector('#mmCovMap');
    const status = el.querySelector('#mmCovStatus');
    const noteEl = el.querySelector('#mmCovMode');
    if (!L || !mapEl) return () => {};
    const placed = repeaters.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    const map = L.map(mapEl, { zoomControl: true, attributionControl: true });
    const tileUrl = (opts && opts.tileUrl) || (typeof root.getTileUrl === 'function' ? root.getTileUrl() : null);
    if (tileUrl) L.tileLayer(tileUrl, { maxZoom: 18 }).addTo(map);
    map.attributionControl.addAttribution(CONFIG.terrainAttribution);
    map.createPane('mmCoverage').style.zIndex = 450;
    if (placed.length) {
      map.fitBounds(L.latLngBounds(placed.map((r) => [r.lat, r.lon])).pad(0.35));
    } else {
      map.setView([47.6, -122.33], 10);
    }
    const strong = cssColor('--mediamesh-node-color', '#d946ef');
    const weak = cssColor('--mediamesh-node-weak-color', '#bd70d2');
    const enabled = placed.map(() => true);
    const describe = (r) => {
      const radio = radioFor(r);
      return `<strong>${esc(repName(r))}</strong><br>${radio.freqMHz} MHz · ${radio.bwKHz} kHz SF${radio.sf}`
        + (radio.reported ? '' : ' (assumed)') + (r.mode === 'rx' ? '<br>Listens only' : '');
    };
    const markers = placed.map((r, i) => {
      const relayed = r.source === 'relayed';
      // placed from its name (it never sent a position): hollow and dashed
      const guessed = !!r.position_from_name;
      const m = L.circleMarker([r.lat, r.lon], {
        radius: 5, weight: 2,
        color: guessed ? strong : relayed ? weak : '#fff',
        fillColor: guessed ? '#fff' : relayed ? '#fff' : strong,
        dashArray: guessed ? '2 2' : null,
        fillOpacity: guessed ? 0.6 : 1, bubblingMouseEvents: false,
      }).bindTooltip(repName(r) + (guessed ? ` · position guessed from its name (${r.near || ''})` : '')).addTo(map);
      m.bindPopup(() => {
        const div = document.createElement('div');
        div.className = 'mm-cov-popup';
        const only = enabled[i] && enabled.filter(Boolean).length === 1;
        div.innerHTML = describe(r) + '<br>'
          + (only ? '<button type="button" class="mm-cov-chip" data-act="all">Show all repeaters</button>'
            : '<button type="button" class="mm-cov-chip" data-act="only">Only this repeater</button>')
          + (only ? '' : enabled[i] ? ' <button type="button" class="mm-cov-chip" data-act="drop">Leave this one out</button>'
            : ' <button type="button" class="mm-cov-chip" data-act="add">Count this one</button>');
        div.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', (ev) => {
          const act = ev.currentTarget.dataset.act;
          if (act === 'drop' || act === 'add') enabled[i] = act === 'add';
          else for (let k = 0; k < enabled.length; k++) enabled[k] = act === 'all' || k === i;
          m.closePopup();
          applyEnabled();
        }));
        return div;
      });
      return m;
    });

    // Finished estimates are kept for the session, so drawing the tab again
    // (a new time window, say) doesn't work them out again.
    const loader = opts && opts.loadTile;
    const key = JSON.stringify(placed.map((r) => [r.lat, r.lon, r.radio || '']));
    const linksSig = JSON.stringify(((opts && opts.links) || []).map((l) => [l.from, l.observer_id]).sort());
    if (session.key !== key || session.loader !== loader || session.linksSig !== linksSig) {
      session.key = key; session.loader = loader; session.linksSig = linksSig; session.modes = {}; session.cal = null;
      session.fieldInfo = null; session.fieldFit = null;
    }
    setField(session.fieldFit);
    const cache = session.modes;
    let overlay = null, current = null, destroyed = false, shown = null, shownTerrain = null;
    let meshView = !!(opts && opts.mode === 'mesh'), mesh = null;
    let opacity = 1;
    const readoutEl = el.querySelector('#mmCovReadout');
    const slider = el.querySelector('#mmCovOpacity');
    const legendBar = el.querySelector('#mmCovGradient');
    const repsEl = el.querySelector('#mmCovReps');
    const profEl = el.querySelector('#mmCovProfile');
    const howEl = el.querySelector('#mmCovHow');
    const linksEl = el.querySelector('#mmCovLinks');
    const linksToggle = el.querySelector('#mmCovLinksToggle');
    const linksKey = el.querySelector('#mmCovLinksKey');
    if (legendBar) legendBar.style.background = legendGradient();
    const onSlide = () => {
      opacity = Math.max(0, Math.min(1, Number(slider.value) / 100));
      if (overlay) overlay.setOpacity(opacity);
    };
    if (slider) slider.addEventListener('input', onSlide);
    const hint = 'Click the map for the terrain profile to that point.';
    map.on('mousemove', (e) => { if (readoutEl) readoutEl.textContent = readout(shown, e.latlng.lat, e.latlng.lng) || (shown ? hint : ''); });
    map.on('mouseout', () => { if (readoutEl) readoutEl.textContent = shown ? hint : ''; });

    // Links heard on radio2, over the estimate.
    const links = (opts && opts.links) || [];
    const linkLayer = L.layerGroup();
    const linkColor = cssColor('--text', '#1a1a2e');
    function drawLinks() {
      const rows = linkRows(links, shownTerrain);
      linkLayer.clearLayers();
      rows.forEach((r) => {
        const tip = `${esc(r.from)} → ${esc(r.to)}: heard ${r.count}×`
          + (r.avgSnr !== null ? `, SNR ${fmtDb(r.avgSnr)} dB` : '')
          + (r.avgRssi !== null ? `, ${fmtDb(r.avgRssi)} dBm` : '')
          + (r.modelRssi !== null ? ` (model ${fmtDb(r.modelRssi)} dBm)` : '');
        L.polyline([[r.fromLat, r.fromLon], [r.toLat, r.toLon]], {
          color: linkColor, weight: Math.min(4, 1.5 + Math.log10(Math.max(1, r.count))), opacity: 0.75, dashArray: '6 5',
        }).bindTooltip(tip, { sticky: true }).addTo(linkLayer);
        L.circleMarker([r.toLat, r.toLon], { radius: 4, weight: 2, color: linkColor, fillColor: '#fff', fillOpacity: 1 })
          .bindTooltip(esc(r.to) + ' (observer)').addTo(linkLayer);
      });
      if (linksEl) linksEl.innerHTML = linksTableHtml(rows);
      const any = rows.length > 0;
      if (linksKey) linksKey.hidden = !any || meshView;
      const wrap = el.querySelector('#mmCovLinksWrap');
      if (wrap) wrap.hidden = !any;
      if (any && (!linksToggle || linksToggle.checked) && !(meshView && mesh)) linkLayer.addTo(map); else map.removeLayer(linkLayer);
    }
    const onLinksToggle = () => drawLinks();

    // The week's backbone: the hops photos, video and voice actually took.
    const backbone = ((opts && opts.backbone) || []).filter((e) => [e.a_lat, e.a_lon, e.b_lat, e.b_lon].every(Number.isFinite));
    const backboneLayer = L.layerGroup();
    const backboneToggle = el.querySelector('#mmCovBackboneToggle');
    const backboneKey = el.querySelector('#mmCovBackboneKey');
    if (backbone.length) {
      const maxP = Math.max(...backbone.map((e) => e.packets || 0));
      const col = cssColor('--mediamesh-node-color', '#d946ef');
      // a pale casing under each hop, so it reads over the pink shading
      const casing = cssColor('--card-bg', '#ffffff');
      backbone.slice().sort((x, y) => (x.packets || 0) - (y.packets || 0)).forEach((e) => {
        const w = backboneWeight(e.packets, maxP), ll = [[e.a_lat, e.a_lon], [e.b_lat, e.b_lon]];
        L.polyline(ll, { color: casing, weight: w + 3, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(backboneLayer);
        L.polyline(ll, { color: col, weight: w, opacity: 0.95, lineCap: 'round' })
          .bindTooltip(backboneTip(e), { sticky: true }).addTo(backboneLayer);
      });
    }
    if (backboneKey) backboneKey.hidden = !backbone.length;
    function drawBackbone() {
      const on = backbone.length && (!backboneToggle || backboneToggle.checked) && !timeMask && !(meshView && mesh);
      if (on) backboneLayer.addTo(map); else map.removeLayer(backboneLayer);
    }
    const onBackboneToggle = () => drawBackbone();
    if (backboneToggle) backboneToggle.addEventListener('change', onBackboneToggle);
    const calEl = el.querySelector('#mmCovCal');
    function drawCalibration() {
      const onGround = current && CONFIG.modes[current].clutter;
      if (calEl) calEl.textContent = onGround && session.fieldInfo ? fieldText(session.fieldFit, session.fieldInfo) : session.cal ? calibrationText(session.cal) : '';
      if (howEl && current) howEl.innerHTML = assumptionsHtml(current, placed.map(radioFor), session.cal, session.fieldFit, session.fieldInfo);
    }
    if (session.cal) { setCalibration(session.cal.offsetDb); drawCalibration(); }
    if (linksToggle) linksToggle.addEventListener('change', onLinksToggle);

    // The clicked point and its profile.
    const pick = L.layerGroup().addTo(map);
    let picked = null;
    function clearProfile() {
      picked = null;
      pick.clearLayers();
      if (profEl) { profEl.innerHTML = ''; profEl.hidden = true; }
    }
    function drawProfile() {
      pick.clearLayers();
      if (!picked || !shown || !shownTerrain || !profEl) return;
      const cell = cellAt(shown, picked.lat, picked.lng);
      let ri = cell ? cell.rep : -1;
      if (ri < 0) {
        // nothing reaches the point: take the nearest repeater counted
        let bestD = Infinity;
        shown.reps.forEach((r, i) => {
          if (!enabled[i]) return;
          const d = distanceM(r.lat, r.lon, picked.lat, picked.lng);
          if (d < bestD) { bestD = d; ri = i; }
        });
      }
      const rep = shown.reps[ri];
      const onGround = CONFIG.modes[shown.modeKey].clutter;
      const p = rep ? pathProfile(rep, picked.lat, picked.lng, shownTerrain, shown.modeKey, shown.radios[ri],
        onGround ? { placeLossDb: placeLossDb(session.place), place: session.place } : null) : null;
      L.circleMarker(picked, { radius: 5, weight: 2, color: linkColor, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(pick);
      profEl.hidden = false;
      if (!p) { profEl.innerHTML = '<p class="text-muted mm-cov-note">No terrain data for that point.</p>'; return; }
      L.polyline([[rep.lat, rep.lon], picked], { color: linkColor, weight: 2, opacity: 0.8, interactive: false }).addTo(pick);
      profEl.innerHTML = profileHtml(p, rep);
      // drawn again at the width it actually got, so its labels aren't stretched
      const chart = profEl.querySelector('.mm-cov-prof-chart');
      const cw = chart ? Math.round(chart.clientWidth) : 0;
      if (cw > 100 && cw !== 640) profEl.innerHTML = profileHtml(p, rep, cw);
    }
    let pickHandler = null; // a plugin waiting for a point on the map
    map.on('click', (e) => {
      if (pickHandler) { const h = pickHandler; pickHandler = null; mapEl.classList.remove('mm-cov-map--plan'); h(e.latlng); return; }
      if (planArmed) { placePlan(e.latlng); return; }
      if (shown) { picked = e.latlng; drawProfile(); }
    });

    // ---- Plan a repeater: a hypothetical one, its new coverage in cyan ----
    const planBtn = el.querySelector('[data-mm-cov-plan]');
    const planEl = el.querySelector('#mmCovPlan');
    let planArmed = false, planned = null, planMarker = null, planOverlay = null, planToken = 0;
    function armPlan(on) {
      planArmed = on;
      if (planBtn) {
        planBtn.classList.toggle('active', on);
        planBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        planBtn.textContent = on ? 'Click the map to place it' : (planned ? 'Move the planned repeater' : '＋ Plan a repeater');
      }
      mapEl.classList.toggle('mm-cov-map--plan', on);
    }
    function clearPlan() {
      planToken++;
      planned = null;
      if (planMarker) { map.removeLayer(planMarker); planMarker = null; }
      if (planOverlay) { map.removeLayer(planOverlay); planOverlay = null; }
      if (planEl) { planEl.innerHTML = ''; planEl.hidden = true; }
      armPlan(false);
    }
    function placePlan(latlng) {
      const heightM = planned ? planned.heightM : CONFIG.txHeightM;
      planned = { name: 'Planned repeater', lat: latlng.lat, lon: latlng.lng, heightM, radio: '' };
      if (!planMarker) {
        planMarker = L.marker(latlng, {
          draggable: true, keyboard: true, title: 'Planned repeater (drag to move)',
          icon: L.divIcon({ className: 'mm-cov-plan-pin', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        }).addTo(map);
        planMarker.on('dragend', () => placePlan(planMarker.getLatLng()));
      } else {
        planMarker.setLatLng(latlng);
      }
      armPlan(false);
      computePlan();
    }
    async function computePlan() {
      if (!planned || !planEl) return;
      const token = ++planToken;
      planEl.hidden = false;
      planEl.innerHTML = planHtml(planned, null, [], current || 'ground', true);
      const modeKey = current || 'ground';
      try {
        const cover = await loadTerrainLevels(terrainPlan([planned], CONFIG.modes[modeKey]), loader);
        const reach = modeKey === 'repeater' ? cover
          : await loadTerrainLevels(terrainPlan([planned], CONFIG.modes.repeater), loader);
        if (token !== planToken || destroyed) return;
        const planCov = await computeCoverage([planned], cover.elevAt, modeKey, null, null);
        if (token !== planToken || destroyed) return;
        const planView = planCov ? adjustCov(planCov, session.place) : null;
        const gain = planView ? planGain(planView, shown) : null;
        const counted = placed.filter((_, i) => enabled[i]);
        const links = planLinks(planned, counted, reach.elevAt);
        if (planOverlay) { map.removeLayer(planOverlay); planOverlay = null; }
        if (planCov && gain) {
          const b = planView.bounds;
          planOverlay = L.imageOverlay(planImage(planView, gain), [[b.south, b.west], [b.north, b.east]],
            { pane: 'mmCoverage', opacity: Math.max(opacity, 0.35), className: 'mm-cov-overlay' }).addTo(map);
        }
        planEl.innerHTML = planHtml(planned, gain, links, modeKey, false);
      } catch (_) {
        if (token === planToken) planEl.innerHTML = planHtml(planned, null, [], modeKey, false);
      }
    }
    const onPlanChange = (e) => {
      if (e.target.matches('[data-mm-cov-plan-height]') && planned) {
        planned.heightM = Number(e.target.value) || CONFIG.txHeightM;
        computePlan();
      }
    };
    if (planEl) planEl.addEventListener('change', onPlanChange);

    // The repeater picker: drawn once, then kept in step with `enabled`, so
    // the search text and which groups are open survive every change.
    let panelOpen = false;
    const summaryEl = repsEl && repsEl.querySelector('#mmCovRepSummary');
    const panelEl = repsEl && repsEl.querySelector('#mmCovRepPanel');
    if (panelEl) panelEl.innerHTML = repPanelHtml(placed);
    function drawReps() {
      if (summaryEl) summaryEl.innerHTML = repSummaryHtml(placed, enabled, panelOpen);
      if (panelEl) {
        panelEl.hidden = !panelOpen;
        panelEl.querySelectorAll('[data-mm-cov-rep]').forEach((box) => { box.checked = !!enabled[Number(box.dataset.mmCovRep)]; });
        panelEl.querySelectorAll('[data-mm-cov-area]').forEach((box) => {
          const idx = box.dataset.mmCovArea.split(',').map(Number);
          const on = idx.filter((i) => enabled[i]).length;
          box.checked = on === idx.length;
          box.indeterminate = on > 0 && on < idx.length;
          const n = box.closest('.mm-cov-group-head').querySelector('[data-mm-cov-group-count]');
          if (n) n.textContent = on === idx.length ? `${idx.length}` : `${on} of ${idx.length}`;
        });
      }
      markers.forEach((m, i) => {
        const o = timeMask && !timeMask[i] ? 0 : (enabled[i] ? 1 : 0.35);
        m.setStyle({ opacity: o, fillOpacity: o });
      });
    }
    function setFold(g, open) {
      const t = g && g.querySelector('[data-mm-cov-fold]');
      if (!t) return;
      t.setAttribute('aria-expanded', open ? 'true' : 'false');
      t.querySelector('.mm-cov-caret').textContent = open ? '▴' : '▾';
      g.querySelector('.mm-cov-group-body').hidden = !open;
    }
    function filterPanel(q) {
      if (!panelEl) return;
      q = String(q || '').trim().toLowerCase();
      let any = false;
      panelEl.querySelectorAll('.mm-cov-group').forEach((g) => {
        const area = g.querySelector('.mm-cov-group-name').textContent.toLowerCase();
        const areaHit = q && area.includes(q);
        let shownRows = 0;
        g.querySelectorAll('[data-mm-cov-search]').forEach((row) => {
          const hit = !q || areaHit || row.dataset.mmCovSearch.includes(q);
          row.hidden = !hit;
          if (hit) shownRows++;
        });
        g.hidden = shownRows === 0;
        if (q && shownRows) setFold(g, true);
        if (shownRows) any = true;
      });
      const empty = panelEl.querySelector('[data-mm-cov-empty]');
      if (empty) empty.hidden = any;
    }
    const onSearch = (e) => { if (e.target.matches('[data-mm-cov-search-box]')) filterPanel(e.target.value); };
    const onPanelChange = (e) => {
      const box = e.target;
      if (box.matches('[data-mm-cov-rep]')) enabled[Number(box.dataset.mmCovRep)] = box.checked;
      else if (box.matches('[data-mm-cov-area]')) box.dataset.mmCovArea.split(',').forEach((i) => { enabled[Number(i)] = box.checked; });
      else return;
      applyEnabled();
    };
    if (panelEl) { panelEl.addEventListener('input', onSearch); panelEl.addEventListener('change', onPanelChange); }
    function drawOverlay() {
      if (overlay) { map.removeLayer(overlay); overlay = null; }
      if (!shown) return;
      const b = shown.bounds;
      const cv = meshView && mesh ? meshCanvas(shown, mesh.cells) : coverageCanvas(shown);
      overlay = canvasOverlay(L, cv, [[b.south, b.west], [b.north, b.east]],
        { pane: 'mmCoverage', opacity, className: 'mm-cov-overlay' }).addTo(map);
    }
    // The repeaters drawn: those counted in the picker, and during the
    // time-lapse only those already there.
    let timeMask = null;
    function counted() { return timeMask ? enabled.map((on, i) => on && timeMask[i]) : enabled; }
    function applyEnabled() {
      drawReps();
      if (!shown) return;
      merge(shown, counted());
      computeMesh();
      drawOverlay();
      drawMesh();
      drawProfile();
      if (planned && !timeMask) computePlan();
    }
    // The figures the tab shows around the map: area covered by everything,
    // and by each repeater on its own (for the leaderboard).
    function reportStats() {
      if (!shown || !(opts && typeof opts.onStats === 'function')) return;
      const areas = repAreasKm2(shown), only = repOnlyKm2(shown);
      try {
        opts.onStats({
          modeKey: shown.modeKey, areaKm2: unionKm2(shown),
          areaHistory: steps.length ? areaHistory(shown, firstSeen, steps) : [],
          repAreas: shown.reps.map((r, i) => ({ rep: r, km2: areas[i] || 0, onlyKm2: only[i] || 0 })),
          mesh: mesh ? mesh.rows : null,
          calibration: session.cal,
        });
      } catch (_) { /* the tab's business */ }
    }
    drawReps();

    // ---- Where you are (people on the ground) ----
    const placesEl = el.querySelector('#mmCovPlaces');
    function drawPlaces() {
      if (!placesEl) return;
      placesEl.hidden = !(current && CONFIG.modes[current].clutter);
      placesEl.querySelectorAll('[data-mm-cov-place]').forEach((b) => {
        const on = b.dataset.mmCovPlace === session.place;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        const loss = placeLossDb(b.dataset.mmCovPlace);
        b.title = loss ? `${fmtDb(loss)} dB more taken off every path` : 'As drawn';
      });
    }
    function setPlace(place) {
      if (!CONFIG.places.some((p) => p.key === place) || place === session.place) return;
      session.place = place;
      if (current) show(current);
    }

    // ---- Mapped by people: hexagons where a MediaMesh repeater answered the
    // apps' coverage recorders. A layer of its own, off until ticked, over
    // every view. ----
    const fieldLayer = L.layerGroup();
    const fieldToggle = el.querySelector('#mmCovFieldToggle');
    const fieldKey = el.querySelector('#mmCovFieldKey');
    const repByKey = new Map(placed.map((r) => [key8(r), r]));
    let fieldShown = null;
    function drawField() {
      fieldLayer.clearLayers();
      const hexes = ((session.fieldInfo || fieldShown || {}).hexes) || [];
      if (fieldKey) fieldKey.hidden = !hexes.length;
      if (!hexes.length || !fieldToggle || !fieldToggle.checked) { map.removeLayer(fieldLayer); return; }
      hexes.forEach((h) => {
        if (!(Number.isFinite(h.lat) && Number.isFinite(h.lon) && h.r > 0)) return;
        const bandKey = hexBand(h);
        const colour = cssColor('--mm-field-' + bandKey, FIELD_RGB[bandKey]);
        const names = (h.reps || []).slice(0, 4).map((r) => `${esc(repName(repByKey.get(r.key)) || r.key)} ${r.margin >= 0 ? '+' : '−'}${fmtDb(Math.abs(r.margin))} dB`);
        const tip = `Mapped by people · ${h.n} ping${h.n === 1 ? '' : 's'}${h.car ? ', from a vehicle' : ''}` + (names.length ? '<br>' + names.join('<br>') : '');
        L.polygon(hexCorners(h), {
          pane: 'mmCoverage', color: colour, weight: 1.2, fillColor: colour, fillOpacity: 0.5, bubblingMouseEvents: false,
        }).bindTooltip(tip, { sticky: true }).addTo(fieldLayer);
      });
      fieldLayer.addTo(map);
    }
    fieldPoints(opts).then((info) => {
      if (destroyed) return;
      fieldShown = info;
      drawField();
    });
    const onFieldToggle = () => drawField();
    if (fieldToggle) fieldToggle.addEventListener('change', onFieldToggle);

    // ---- The mesh: the ground view coloured by which repeaters reach each
    // place and how sure we are they're linked to each other. ----
    let meshSort = 'km2';
    const meshUse = { rare: true, model: true };
    const meshEl = el.querySelector('#mmCovMesh');
    const meshLayer = L.layerGroup();
    const scaleEl = el.querySelector('.mm-cov-scale');
    const rawBackbone = (opts && opts.backbone) || [];
    const heardKeys = new Set();
    rawBackbone.forEach((e) => { heardKeys.add(key8({ public_key: e.a })); heardKeys.add(key8({ public_key: e.b })); });
    links.forEach((l) => { heardKeys.add(key8({ public_key: l.from })); heardKeys.add(key8({ public_key: l.observer_id })); });
    const unplacedLinked = repeaters.filter((r) => !(Number.isFinite(r.lat) && Number.isFinite(r.lon)) && heardKeys.has(key8(r))).map(repName);
    function computeMesh() {
      mesh = null;
      if (!shown || !shownTerrain || !CONFIG.modes[shown.modeKey].clutter) return;
      // What the model predicts between repeaters: worked out once a session.
      if (!session.meshPred || session.meshPred.key !== session.key) {
        session.meshPred = { key: session.key, links: predictedLinks(placed, shownTerrain) };
      }
      const on = counted();
      const ev = meshEvidence(placed, rawBackbone, links, session.meshPred.links, meshUse);
      // repeaters left out of the count are left out of the mesh too
      ev.tier = ev.tier.map((t, i) => (on[i] ? t : 'none'));
      const mc = meshCells(shown, ev.tier, on);
      mesh = { ev, cells: mc, rows: meshRows(shown, ev.tier, ev.links, on) };
    }
    function drawMesh() {
      meshLayer.clearLayers();
      const on = meshView && mesh && !timeMask;
      if (meshEl) meshEl.hidden = !meshView;
      const bestEl = el.querySelector('#mmCovMeshBest');
      if (bestEl) bestEl.hidden = !(meshView && mesh);
      if (scaleEl) scaleEl.hidden = meshView;
      // the mesh draws its own links: the backbone and links-heard switches don't apply
      if (backboneKey) backboneKey.hidden = meshView || !backbone.length;
      if (linksKey) linksKey.hidden = meshView || !(links.length);
      if (!on) {
        map.removeLayer(meshLayer);
        if (meshEl && meshView) meshEl.querySelector('#mmCovMeshStats').innerHTML = '<p class="text-muted mm-cov-note">Working out the mesh…</p>';
        drawBackbone();
        if (!timeMask) drawLinks();
        return;
      }
      // the mesh's own links stand in for the backbone and links heard
      map.removeLayer(backboneLayer);
      map.removeLayer(linkLayer);
      const ink = cssColor('--text', '#1a1a2e'), casing = cssColor('--card-bg', '#ffffff');
      const weakInk = cssColor('--mm-mesh-weak', MESH_RGB.weak);
      const maxP = Math.max(1, ...mesh.ev.edges.map((e) => e.packets || 0));
      mesh.ev.edges.slice().sort((x, y) => (x.packets || 0) - (y.packets || 0)).forEach((e) => {
        if ((e.kind === 'rare' && !meshUse.rare) || (e.kind === 'model' && !meshUse.model)) return;
        const A = placed[e.a], B = placed[e.b], ll = [[A.lat, A.lon], [B.lat, B.lon]];
        const style = e.kind === 'often' ? { color: ink, weight: 1 + backboneWeight(e.packets, maxP) / 2, opacity: 0.7 }
          : e.kind === 'rare' ? { color: ink, weight: 2, opacity: 0.9, dashArray: '8 6' }
            : { color: weakInk, weight: 2.5, opacity: 0.95, dashArray: '2 6' };
        L.polyline(ll, { color: casing, weight: style.weight + 2, opacity: 0.5, interactive: false, dashArray: style.dashArray }).addTo(meshLayer);
        const tip = `${esc(repName(A))} ↔ ${esc(repName(B))}: ` + (e.kind === 'model'
          ? `never heard; the model says they reach, ${fmtDb(e.marginDb)} dB to spare`
          : `heard ${Number(e.packets).toLocaleString()} time${e.packets === 1 ? '' : 's'}`);
        L.polyline(ll, Object.assign({ lineCap: 'round' }, style)).bindTooltip(tip, { sticky: true }).addTo(meshLayer);
      });
      placed.forEach((r, i) => {
        const t = mesh.ev.tier[i];
        if (t === 'often' || !counted()[i]) return;
        L.circleMarker([r.lat, r.lon], {
          radius: 9, weight: 2.5, fill: false, color: t === 'weak' ? weakInk : ink, dashArray: t === 'weak' ? '3 3' : null, interactive: false,
        }).addTo(meshLayer);
      });
      meshLayer.addTo(map);
      if (meshEl) {
        meshEl.querySelector('#mmCovMeshStats').innerHTML = meshStatsHtml(mesh.cells, mesh.ev, placed, unplacedLinked);
        const tableEl = el.querySelector('#mmCovMeshTable');
        if (tableEl) tableEl.innerHTML = meshTableHtml(mesh.rows, meshSort);
      }
    }
    const onMeshChange = (e) => {
      const k = e.target && e.target.dataset && e.target.dataset.mmMeshUse;
      if (!k) return;
      meshUse[k] = e.target.checked;
      computeMesh();
      drawOverlay();
      drawMesh();
      reportStats();
    };
    if (meshEl) meshEl.addEventListener('change', onMeshChange);

    async function show(modeKey) {
      current = modeKey;
      el.querySelectorAll('[data-mm-cov]').forEach((b) => b.classList.toggle('active', b.dataset.mmCov === (meshView ? 'mesh' : modeKey)));
      if (noteEl) noteEl.textContent = meshView ? MESH_NOTE : CONFIG.modes[modeKey].note;
      mesh = null;
      drawMesh();
      if (howEl) howEl.innerHTML = assumptionsHtml(modeKey, placed.map(radioFor), session.cal, session.fieldFit, session.fieldInfo);
      drawPlaces();
      drawField();
      shown = null; shownTerrain = null;
      set3dReady();
      drawOverlay();
      pick.clearLayers();
      if (!placed.length) { if (status) status.textContent = 'No MediaMesh repeater has a saved position yet.'; return; }
      let entry = cache[modeKey];
      if (!entry) {
        entry = cache[modeKey] = (async () => {
          const mode = CONFIG.modes[modeKey];
          if (status) status.textContent = 'Loading terrain…';
          const terrain = await loadTerrainLevels(terrainPlan(placed, mode), loader);
          if (terrain.total && terrain.failed === terrain.total) throw new Error('terrain');
          // Check the model against the links heard on radio2 once, before
          // any correction, and use the fitted correction from then on.
          if (!session.cal) {
            setCalibration(0);
            session.cal = fitCalibration(linkRows(links, terrain.elevAt));
          }
          setCalibration(session.cal.offsetDb);
          drawCalibration();
          const pool = (opts && opts.workers === false) ? null : workerPool();
          try {
            const cov = await computeCoverage(placed, terrain.elevAt, modeKey, (done, total) => {
              if (status && current === modeKey && !destroyed) status.textContent = `Working out coverage… ${done} of ${total} repeaters`;
            }, pool ? { run: pool.run } : null);
            return { cov, elevAt: terrain.elevAt, failed: terrain.failed };
          } finally {
            if (pool) pool.close();
          }
        })();
      }
      try {
        const res = await entry;
        if (destroyed || current !== modeKey) return;
        // Measured coverage points: fetched and fitted once, with the
        // terrain the ground view loaded.
        if (CONFIG.modes[modeKey].clutter && !session.fieldInfo) {
          const info = await fieldPoints(opts);
          if (destroyed) return;
          session.fieldInfo = info || { cells: [] };
          session.fieldFit = fitField(session.fieldInfo.cells, placed, res.elevAt);
          setField(session.fieldFit);
          res.adj = null;
          drawField();
          drawPlaces();
          if (current !== modeKey) return;
        }
        // The entry may have been started by an earlier drawing of the card
        // (the tab re-renders): show the fit here too.
        drawCalibration();
        if (!res.adj) res.adj = {};
        if (!res.adj[session.place]) res.adj[session.place] = adjustCov(res.cov, session.place);
        shown = merge(res.adj[session.place], counted());
        shownTerrain = res.elevAt;
        computeMesh();
        set3dReady();
        drawOverlay();
        drawProfile();
        drawLinks();
        drawMesh();
        reportStats();
        shownListeners.forEach((f) => { try { f(shown, shownTerrain); } catch (_) { /* a plugin's business */ } });
        if (planned) computePlan();
        if (status) status.textContent = res.failed ? 'Some terrain could not be loaded; those areas are left blank.' : '';
        if (readoutEl && !readoutEl.textContent) readoutEl.textContent = hint;
      } catch (_) {
        delete cache[modeKey];
        if (status && !destroyed) status.textContent = 'Terrain data could not be loaded, so the coverage estimate is unavailable.';
      }
    }

    // ---- The same estimate in 3D, over the terrain ----
    const btn3d = el.querySelector('[data-mm-cov-3d]');
    function set3dReady() { if (btn3d) btn3d.disabled = !shown || !shownTerrain || !root.MediaMesh3D; }
    function open3d() {
      if (!shown || !shownTerrain || !root.MediaMesh3D) return;
      const on = counted();
      root.MediaMesh3D.open({
        cov: shown, elevAt: shownTerrain,
        reps: shown.reps.filter((_, i) => on[i]),
        backbone: timeMask ? [] : backbone,
        areaKm2: unionKm2(shown),
        modeLabel: shown.modeKey === 'repeater' ? 'Where repeaters should hear each other' : 'Where photos, video and voice reach people on the ground',
        onClose: () => { if (btn3d) btn3d.focus(); },
      });
    }

    // ---- Growth time-lapse: replay the network day by day ----
    const timeEl = el.querySelector('#mmCovTime');
    const timeRange = el.querySelector('#mmCovTimeRange');
    const timeLabel = el.querySelector('#mmCovTimeLabel');
    const playBtn = el.querySelector('[data-mm-cov-play]');
    const firstSeen = placed.map((r) => r.first_seen || '');
    const steps = growthSteps(firstSeen, (opts && opts.now) || Date.now());
    let playing = null;
    const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    function setTime(k) {
      if (!steps.length) return;
      k = Math.max(0, Math.min(steps.length - 1, k));
      const last = k === steps.length - 1;
      timeMask = last ? null : presentAt(firstSeen, steps[k].t);
      if (timeRange) timeRange.value = String(k);
      applyEnabled();
      // Today's heard links would give the past away: back at the end only.
      if (timeMask) map.removeLayer(linkLayer); else drawLinks();
      drawBackbone();
      if (timeLabel) {
        const area = shown ? coveredKm2(shown) : 0;
        timeLabel.textContent = `${last ? 'Today' : fmtDay(steps[k].t)} · ${steps[k].count} repeater${steps[k].count === 1 ? '' : 's'}`
          + (shown ? ` · ${Math.round(area).toLocaleString()} km² covered` : '');
      }
    }
    function stopPlay() {
      if (playing) { clearInterval(playing); playing = null; }
      if (playBtn) playBtn.innerHTML = PLAY_HTML;
    }
    function startPlay() {
      if (!steps.length) return;
      let k = Number(timeRange && timeRange.value) || 0;
      if (k >= steps.length - 1) k = 0;
      setTime(k);
      if (playBtn) playBtn.innerHTML = PAUSE_HTML;
      playing = setInterval(() => {
        if (destroyed) { stopPlay(); return; }
        k++;
        setTime(k);
        if (k >= steps.length - 1) stopPlay();
      }, Math.max(250, Math.min(700, 9000 / steps.length)));
    }
    const onTimeInput = () => { stopPlay(); setTime(Number(timeRange.value)); };
    if (timeEl) {
      timeEl.hidden = !steps.length;
      if (steps.length && timeRange) {
        timeRange.min = '0'; timeRange.max = String(steps.length - 1); timeRange.value = String(steps.length - 1);
        timeRange.addEventListener('input', onTimeInput);
        if (timeLabel) timeLabel.textContent = `${fmtDay(steps[0].t)} → today: ${steps[0].count} → ${steps[steps.length - 1].count} repeaters`;
      }
    }

    const onClick = (e) => {
      if (e.target.closest('[data-mm-cov-play]')) { if (playing) stopPlay(); else startPlay(); return; }
      const b = e.target.closest('[data-mm-cov]');
      if (b) { meshView = b.dataset.mmCov === 'mesh'; show(meshView ? 'ground' : b.dataset.mmCov); return; }
      const ms = e.target.closest('[data-mm-mesh-sort]');
      if (ms) { meshSort = ms.dataset.mmMeshSort; drawMesh(); return; }
      const pl = e.target.closest('[data-mm-cov-place]');
      if (pl) { setPlace(pl.dataset.mmCovPlace); return; }
      if (e.target.closest('[data-mm-cov-close]')) { clearProfile(); return; }
      if (e.target.closest('[data-mm-cov-panel]')) { panelOpen = !panelOpen; drawReps(); return; }
      if (e.target.closest('[data-mm-cov-plan]')) { armPlan(!planArmed); return; }
      if (e.target.closest('[data-mm-cov-3d]')) { open3d(); return; }
      if (e.target.closest('[data-mm-cov-plan-remove]')) { clearPlan(); return; }
      const fold = e.target.closest('[data-mm-cov-fold]');
      if (fold) { setFold(fold.closest('.mm-cov-group'), fold.getAttribute('aria-expanded') !== 'true'); return; }
      const act = e.target.closest('[data-mm-cov-act]');
      if (act) {
        const view = map.getBounds();
        const next = repAction(act.dataset.mmCovAct, placed, (r) => view.contains([r.lat, r.lon]));
        if (next) { next.forEach((v, i) => { enabled[i] = v; }); applyEnabled(); }
      }
    };

    el.addEventListener('click', onClick);
    // Add-ons on the same card (mediamesh-reach.js): the address check, the
    // best next spots, coverage in people and the main-mesh comparison.
    const shownListeners = [];
    let reach = null;
    if (root.MediaMeshReach && typeof root.MediaMeshReach.attach === 'function') {
      reach = root.MediaMeshReach.attach(el, {
        L, map, mapEl, placed, loader, backbone,
        shown: () => shown, terrain: () => shownTerrain, mode: () => current,
        counted: () => placed.filter((_, i) => counted()[i]),
        onShown: (f) => { shownListeners.push(f); if (shown) f(shown, shownTerrain); },
        pick: (f) => { pickHandler = f; mapEl.classList.toggle('mm-cov-map--plan', !!f); },
        plan: (lat, lon) => { if (L) placePlan(L.latLng(lat, lon)); },
        onStats: opts && opts.onPeople,
      });
    }
    drawLinks();
    drawBackbone();
    show(meshView ? 'ground' : (opts && opts.mode) || 'ground');
    return () => {
      destroyed = true;
      el.removeEventListener('click', onClick);
      if (meshEl) meshEl.removeEventListener('change', onMeshChange);
      if (slider) slider.removeEventListener('input', onSlide);
      if (panelEl) { panelEl.removeEventListener('input', onSearch); panelEl.removeEventListener('change', onPanelChange); }
      if (planEl) planEl.removeEventListener('change', onPlanChange);
      if (backboneToggle) backboneToggle.removeEventListener('change', onBackboneToggle);
      if (timeRange) timeRange.removeEventListener('input', onTimeInput);
      stopPlay();
      if (reach) { try { reach(); } catch (_) { /* gone */ } }
      if (root.MediaMesh3D && root.MediaMesh3D.isOpen()) root.MediaMesh3D.close();
      if (linksToggle) linksToggle.removeEventListener('change', onLinksToggle);
      if (fieldToggle) fieldToggle.removeEventListener('change', onFieldToggle);
      map.remove();
    };
  }

  root.MediaMeshCoverage = {
    CONFIG, fspl, knifeEdgeLoss, sensitivityDbm, parseRadio, radioFor, budgetDb, marginFor, band,
    worstEdge, cascadedKnifeEdge, planeEarthLoss, effectiveHeights, modeCalibration, waterMask, sampleDistances, gridFor, buildJob, polarMargins, repRaster, merge,
    computeCoverage, workerPool, pathProfile, profileVerdict, budgetRows, profileSvg, profileHtml,
    terrainPlan, loadTerrainLevels, loadTerrain, rampColor, edgeFade, cellAt, cellCenter, readout,
    fitCalibration, calibrationText, setCalibration, getCalibration, CAL,
    clutterLossDb, setField, getField, fieldDbFor, placeLossDb, fitField, fieldSolve, fieldText, fieldBand, adjustCov, FIELD_RGB, loadFieldPoints, fieldPoints, hexCorners, hexBand, session,
    backboneWeight, backboneTip, areaHistory, footprint, coverageImage, legendGradient,
    growthSteps, presentAt, antennaHeight, knownHeightM, KNOWN_HEIGHTS, coverageCanvas, canvasOverlay, whatIfBase, whatIfDefaults, whatIfJob, whatIfCoverage, whatIfCanvas, cellAreaKm2, coveredKm2, unionKm2, repAreasKm2, repOnlyKm2, predictedLinks, meshEvidence, meshCells, meshRows, meshStatsHtml, meshTableHtml, MESH_OFTEN, planGain, planLinks, planHtml, PLAN_RGB,
    repNotes, repArea, repGroups, repSummaryHtml, repPanelHtml, repAction, assumptionsHtml, linkRows, linksTableHtml, init,
  };
})(typeof window !== 'undefined' ? window : globalThis);
