/* === CoreScope — mediamesh-coverage.js ===
 * MediaMesh coverage estimate for the analytics MediaMesh tab: where photos
 * and voice on radio2 should get through, from each MediaMesh repeater's
 * position and the terrain. Conservative on purpose (see CONFIG).
 *
 * Model, per repeater: rays every few tenths of a degree out to a radius;
 * along each ray, terrain from elevation tiles (Mapzen terrarium, fetched by
 * the browser), the earth's curve at k = 4/3, free-space loss at 911.15 MHz,
 * and a single knife-edge loss (ITU-R P.526) behind the highest obstacle so
 * far. Buildings and trees are not modelled; ground mode adds a flat clutter
 * loss for them instead. Each map cell keeps the best repeater's margin over
 * the receiver's sensitivity.
 *
 * No dependencies for the maths (computeCoverage, fspl, knifeEdgeLoss), so
 * tests/unit/test-mediamesh-coverage.js runs it in Node with synthetic terrain.
 */
'use strict';

(function (root) {
  const CONFIG = {
    freqMHz: 911.15,
    txDbm: 22,           // conservative transmit power
    txGainDbi: 2,        // repeater antenna
    cableDb: 1,
    txHeightM: 10,       // every repeater's antenna, above ground
    sensitivityDbm: -121, // SX126x, SF7 / 250 kHz
    fadeMarginDb: 10,    // safety margin
    kFactor: 4 / 3,      // effective earth radius for radio
    earthRadiusM: 6371000,
    bands: { strong: 15, fair: 5, marginal: 0 }, // dB to spare
    modes: {
      ground: {
        label: 'People on the ground',
        note: 'People on the ground: a companion or standalone radio at 1.5 m.',
        rxHeightM: 1.5, rxGainDbi: 0, clutterDb: 10,
        radiusKm: 20, stepM: 60, rays: 1800, cellM: 100, zoom: 11,
      },
      repeater: {
        label: 'Repeater to repeater',
        note: 'Repeater to repeater: both antennas 10 m up.',
        rxHeightM: 10, rxGainDbi: 2, clutterDb: 0,
        radiusKm: 40, stepM: 100, rays: 2880, cellM: 200, zoom: 10,
      },
    },
    terrainUrl: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    terrainAttribution: 'Terrain: Mapzen terrain tiles (SRTM, USGS NED and others)',
  };

  const NO_DATA = -1e9;

  /** Free-space path loss in dB for a distance in km. */
  function fspl(dKm, freqMHz) {
    return 32.44 + 20 * Math.log10(Math.max(dKm, 0.001)) + 20 * Math.log10(freqMHz || CONFIG.freqMHz);
  }

  /** Single knife-edge diffraction loss (ITU-R P.526) for parameter v. */
  function knifeEdgeLoss(v) {
    if (!(v > -0.78)) return 0;
    return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) * (v - 0.1) + 1) + v - 0.1);
  }

  /** dB to spare at the receiver for a path loss, in one mode. */
  function marginFor(pathLossDb, mode) {
    const c = CONFIG;
    return c.txDbm + c.txGainDbi - c.cableDb + mode.rxGainDbi - pathLossDb
      - c.sensitivityDbm - c.fadeMarginDb - mode.clutterDb;
  }

  function band(margin) {
    const b = CONFIG.bands;
    if (margin >= b.strong) return 'strong';
    if (margin >= b.fair) return 'fair';
    if (margin >= b.marginal) return 'marginal';
    return '';
  }

  /** The grid covering every repeater plus the mode's radius. */
  function gridFor(repeaters, mode) {
    let s = 90, n = -90, w = 180, e = -180;
    repeaters.forEach((r) => {
      s = Math.min(s, r.lat); n = Math.max(n, r.lat);
      w = Math.min(w, r.lon); e = Math.max(e, r.lon);
    });
    const midLat = (s + n) / 2;
    const mPerDegLat = 111320;
    const mPerDegLon = mPerDegLat * Math.cos(midLat * Math.PI / 180);
    const padLat = mode.radiusKm * 1000 / mPerDegLat;
    const padLon = mode.radiusKm * 1000 / mPerDegLon;
    const bounds = { south: s - padLat, north: n + padLat, west: w - padLon, east: e + padLon };
    const cellLat = mode.cellM / mPerDegLat;
    const cellLon = mode.cellM / mPerDegLon;
    const width = Math.max(1, Math.ceil((bounds.east - bounds.west) / cellLon));
    const height = Math.max(1, Math.ceil((bounds.north - bounds.south) / cellLat));
    return { bounds, cellLat, cellLon, width, height, mPerDegLat };
  }

  /**
   * Coverage for one mode. elevAt(lat, lon) returns metres above sea level,
   * or NaN where there is no terrain data (those cells stay empty).
   * onProgress(done, total) is called after each repeater; the work yields
   * between repeaters so the page stays responsive.
   * Returns { margins: Float32Array (row 0 = north), best: Int16Array (index
   * into the placed repeaters of the one giving each cell's margin, -1 none),
   * reps (the placed repeaters), width, height, bounds }. Small gaps between
   * rays far from a repeater are filled from their neighbours.
   */
  async function computeCoverage(repeaters, elevAt, modeKey, onProgress) {
    const c = CONFIG;
    const mode = c.modes[modeKey];
    const reps = repeaters.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    if (!reps.length) return null;
    const g = gridFor(reps, mode);
    const margins = new Float32Array(g.width * g.height).fill(NO_DATA);
    const best = new Int16Array(g.width * g.height).fill(-1);
    const lambda = 299.792458 / c.freqMHz;
    const effR = c.kFactor * c.earthRadiusM;
    const radiusM = mode.radiusKm * 1000;

    for (let ri = 0; ri < reps.length; ri++) {
      const r = reps[ri];
      const groundTx = elevAt(r.lat, r.lon);
      if (Number.isFinite(groundTx)) {
        const ht = groundTx + c.txHeightM;
        const mPerDegLon = g.mPerDegLat * Math.cos(r.lat * Math.PI / 180);
        for (let a = 0; a < mode.rays; a++) {
          const az = (a / mode.rays) * 2 * Math.PI;
          const sinAz = Math.sin(az), cosAz = Math.cos(az);
          let maxSlope = -Infinity, obsD = 0;
          for (let d = mode.stepM; d <= radiusM; d += mode.stepM) {
            const lat = r.lat + (d * cosAz) / g.mPerDegLat;
            const lon = r.lon + (d * sinAz) / mPerDegLon;
            const e = elevAt(lat, lon);
            if (!Number.isFinite(e)) break;
            const he = e - (d * d) / (2 * effR); // terrain with the earth's curve
            const slopeRx = (he + mode.rxHeightM - ht) / d;
            let diff = 0;
            if (slopeRx < maxSlope) {
              const h = (maxSlope - slopeRx) * obsD; // obstacle above the line of sight
              const d2 = d - obsD;
              const v = h * Math.sqrt((2 * d) / (lambda * obsD * d2));
              diff = knifeEdgeLoss(v);
            }
            const margin = marginFor(fspl(d / 1000, c.freqMHz) + diff, mode);
            const col = Math.floor((lon - g.bounds.west) / g.cellLon);
            const row = Math.floor((g.bounds.north - lat) / g.cellLat);
            if (col >= 0 && col < g.width && row >= 0 && row < g.height) {
              const i = row * g.width + col;
              if (margin > margins[i]) { margins[i] = margin; best[i] = ri; }
            }
            const slope = (he - ht) / d;
            if (slope > maxSlope) { maxSlope = slope; obsD = d; }
          }
        }
      }
      if (onProgress) onProgress(ri + 1, reps.length);
      await new Promise((res) => setTimeout(res, 0));
    }
    fillGaps(margins, best, g.width, g.height);
    return { margins, best, reps, width: g.width, height: g.height, bounds: g.bounds };
  }

  /** Fills empty cells that have covered neighbours on both sides (gaps
   * between rays), with the mean of their covered neighbours. */
  function fillGaps(margins, best, w, h) {
    const src = margins.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (src[i] > NO_DATA) continue;
        let sum = 0, n = 0, top = -1, topM = NO_DATA;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = (y + dy) * w + (x + dx);
            if (src[j] > NO_DATA) { sum += src[j]; n++; if (src[j] > topM) { topM = src[j]; top = best[j]; } }
          }
        }
        // Opposite neighbours covered: a hole, not the edge of coverage.
        const across = (src[i - 1] > NO_DATA && src[i + 1] > NO_DATA) || (src[i - w] > NO_DATA && src[i + w] > NO_DATA);
        if (n >= 4 && across) { margins[i] = sum / n; best[i] = top; }
      }
    }
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
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          resolve(ctx.getImageData(0, 0, img.width, img.height).data);
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  /**
   * Fetches the elevation tiles covering bounds at zoom z and returns
   * elevAt(lat, lon) (NaN outside them or where a tile failed), and how many
   * tiles failed. loader(url) may be swapped for tests.
   */
  async function loadTerrain(bounds, z, loader) {
    const get = loader || loadTile;
    const x0 = Math.floor(lonToTileX(bounds.west, z)), x1 = Math.floor(lonToTileX(bounds.east, z));
    const y0 = Math.floor(latToTileY(bounds.north, z)), y1 = Math.floor(latToTileY(bounds.south, z));
    const tiles = new Map();
    const jobs = [];
    let failed = 0;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const url = CONFIG.terrainUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        jobs.push(get(url).then((data) => { if (data) tiles.set(x + '/' + y, data); else failed++; }));
      }
    }
    await Promise.all(jobs);
    function elevAt(lat, lon) {
      const fx = lonToTileX(lon, z), fy = latToTileY(lat, z);
      const tx = Math.floor(fx), ty = Math.floor(fy);
      const data = tiles.get(tx + '/' + ty);
      if (!data) return NaN;
      const px = Math.min(255, Math.floor((fx - tx) * 256));
      const py = Math.min(255, Math.floor((fy - ty) * 256));
      const i = (py * 256 + px) * 4;
      return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
    }
    return { elevAt, failed, total: jobs.length };
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

  function coverageImage(cov) {
    const cv = document.createElement('canvas');
    cv.width = cov.width; cv.height = cov.height;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cov.width, cov.height);
    const rgb = nodeColor();
    for (let i = 0; i < cov.margins.length; i++) {
      const c = rampColor(cov.margins[i], rgb);
      if (!c) continue;
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = Math.round(c[3] * 255);
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
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

  /** "≈ 12 dB to spare, best from First Hill" for the cell at lat/lon. */
  function readout(cov, lat, lon) {
    if (!cov) return '';
    const col = Math.floor(((lon - cov.bounds.west) / (cov.bounds.east - cov.bounds.west)) * cov.width);
    const row = Math.floor(((cov.bounds.north - lat) / (cov.bounds.north - cov.bounds.south)) * cov.height);
    if (col < 0 || col >= cov.width || row < 0 || row >= cov.height) return '';
    const i = row * cov.width + col;
    const m = cov.margins[i];
    if (!(m >= 0)) return 'Out of estimated MediaMesh coverage here';
    const rep = cov.reps[cov.best[i]];
    const name = rep ? String(rep.name || (rep.public_key || '').slice(0, 8)) : '';
    return `≈ ${Math.round(m)} dB to spare (${band(m)})` + (name ? `, best from ${name}` : '');
  }

  /**
   * Draws the coverage card's map in el (which holds #mmCovMap, the mode
   * buttons [data-mm-cov] and #mmCovStatus). repeaters: the MediaMesh tab's
   * list (with lat/lon where known). Returns a destroy function.
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
    placed.forEach((r) => {
      const relayed = r.source === 'relayed';
      L.circleMarker([r.lat, r.lon], {
        radius: 5, weight: 2,
        color: relayed ? weak : '#fff',
        fillColor: relayed ? '#fff' : strong,
        fillOpacity: 1,
      }).bindTooltip(String(r.name || (r.public_key || '').slice(0, 8))).addTo(map);
    });

    const cache = {};
    let overlay = null, current = null, destroyed = false, shown = null;
    let opacity = 1;
    const readoutEl = el.querySelector('#mmCovReadout');
    const slider = el.querySelector('#mmCovOpacity');
    const legendBar = el.querySelector('#mmCovGradient');
    if (legendBar) legendBar.style.background = legendGradient();
    const onSlide = () => {
      opacity = Math.max(0, Math.min(1, Number(slider.value) / 100));
      if (overlay) overlay.setOpacity(opacity);
    };
    if (slider) slider.addEventListener('input', onSlide);
    map.on('mousemove', (e) => { if (readoutEl) readoutEl.textContent = readout(shown, e.latlng.lat, e.latlng.lng); });
    map.on('mouseout', () => { if (readoutEl) readoutEl.textContent = ''; });
    const loader = opts && opts.loadTile;

    async function show(modeKey) {
      current = modeKey;
      el.querySelectorAll('[data-mm-cov]').forEach((b) => b.classList.toggle('active', b.dataset.mmCov === modeKey));
      if (noteEl) noteEl.textContent = CONFIG.modes[modeKey].note;
      if (overlay) { map.removeLayer(overlay); overlay = null; }
      shown = null;
      if (!placed.length) { if (status) status.textContent = 'No MediaMesh repeater has a saved position yet.'; return; }
      let entry = cache[modeKey];
      if (!entry) {
        entry = cache[modeKey] = (async () => {
          const mode = CONFIG.modes[modeKey];
          if (status) status.textContent = 'Loading terrain…';
          const grid = gridFor(placed, mode);
          const terrain = await loadTerrain(grid.bounds, mode.zoom, loader);
          if (terrain.failed === terrain.total) throw new Error('terrain');
          const cov = await computeCoverage(placed, terrain.elevAt, modeKey, (done, total) => {
            if (status && current === modeKey && !destroyed) status.textContent = `Working out coverage… ${done} of ${total} repeaters`;
          });
          return { cov, url: coverageImage(cov), failed: terrain.failed };
        })();
      }
      try {
        const res = await entry;
        if (destroyed || current !== modeKey) return;
        const b = res.cov.bounds;
        overlay = L.imageOverlay(res.url, [[b.south, b.west], [b.north, b.east]],
          { pane: 'mmCoverage', opacity, className: 'mm-cov-overlay' }).addTo(map);
        shown = res.cov;
        if (status) status.textContent = res.failed ? 'Some terrain could not be loaded; those areas are left blank.' : '';
      } catch (_) {
        delete cache[modeKey];
        if (status && !destroyed) status.textContent = 'Terrain data could not be loaded, so the coverage estimate is unavailable.';
      }
    }

    const onClick = (e) => {
      const b = e.target.closest('[data-mm-cov]');
      if (b) show(b.dataset.mmCov);
    };
    el.addEventListener('click', onClick);
    show((opts && opts.mode) || 'ground');
    return () => {
      destroyed = true;
      el.removeEventListener('click', onClick);
      if (slider) slider.removeEventListener('input', onSlide);
      map.remove();
    };
  }

  root.MediaMeshCoverage = {
    CONFIG, fspl, knifeEdgeLoss, marginFor, band, gridFor, computeCoverage, loadTerrain,
    rampColor, readout, init,
  };
})(typeof window !== 'undefined' ? window : globalThis);
