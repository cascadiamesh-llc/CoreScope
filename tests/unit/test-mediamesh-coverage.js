/* Unit tests for public/mediamesh-coverage.js: the coverage maths, with
 * synthetic terrain (no network). */
'use strict';
const assert = require('assert');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-coverage.js'));
const M = globalThis.MediaMeshCoverage;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

function cellAt(cov, lat, lon) {
  const g = cov;
  const col = Math.floor((lon - g.bounds.west) / ((g.bounds.east - g.bounds.west) / g.width));
  const row = Math.floor((g.bounds.north - lat) / ((g.bounds.north - g.bounds.south) / g.height));
  return cov.margins[row * cov.width + col];
}

(async () => {
  console.log('\n=== MediaMesh coverage ===');
  const rep = [{ name: 'R', lat: 47.6, lon: -122.33 }];
  const kmLat = (km) => km / 111.32;

  await test('free-space loss at 911 MHz: ~91.6 dB at 1 km, +20 dB per decade', () => {
    assert.ok(Math.abs(M.fspl(1) - 91.63) < 0.05, String(M.fspl(1)));
    assert.ok(Math.abs(M.fspl(10) - M.fspl(1) - 20) < 1e-9);
  });

  await test('knife-edge loss: none well clear, 6 dB grazing, more when blocked', () => {
    assert.strictEqual(M.knifeEdgeLoss(-1), 0);
    assert.ok(Math.abs(M.knifeEdgeLoss(0) - 6.0) < 0.1, String(M.knifeEdgeLoss(0)));
    assert.ok(M.knifeEdgeLoss(2) > 15 && M.knifeEdgeLoss(2) < 20);
  });

  await test('margin uses the conservative budget (22 dBm, 10 dB fade, ground clutter)', () => {
    const g = M.CONFIG.modes.ground, r = M.CONFIG.modes.repeater;
    // 22 + 2 - 1 + 0 + 121 - 10 - 10 = 124 dB of path loss at 0 margin on the ground
    assert.strictEqual(M.marginFor(124, g), 0);
    assert.strictEqual(M.marginFor(124, r), 12);
  });

  await test('flat terrain: strong near the repeater, fading with distance, cut at the radius', async () => {
    const cov = await M.computeCoverage(rep, () => 0, 'ground');
    const near = cellAt(cov, 47.6 + kmLat(0.5), -122.33);
    const mid = cellAt(cov, 47.6 + kmLat(5), -122.33);
    assert.ok(near > mid, `near ${near} > mid ${mid}`);
    assert.strictEqual(M.band(near), 'strong');
    // beyond the 20 km radius nothing is drawn: the grid's corner is ~28 km out
    assert.ok(cov.margins[0] < -1e8 && cov.margins[cov.margins.length - 1] < -1e8);
  });

  await test('a ridge shadows the ground behind it, more for people than repeaters', async () => {
    // 120 m ridge 3 km north of the repeater, flat elsewhere
    const ridge = (lat) => (Math.abs(lat - (47.6 + kmLat(3))) < kmLat(0.15) ? 120 : 0);
    const flat = await M.computeCoverage(rep, () => 0, 'ground');
    const hilly = await M.computeCoverage(rep, (lat) => ridge(lat), 'ground');
    const behind = (c) => cellAt(c, 47.6 + kmLat(6), -122.33);
    const south = (c) => cellAt(c, 47.6 - kmLat(6), -122.33);
    assert.ok(behind(hilly) < behind(flat) - 15, `behind ridge ${behind(hilly)} vs flat ${behind(flat)}`);
    assert.ok(Math.abs(south(hilly) - south(flat)) < 0.01, 'the other side is unaffected');
    const rHilly = await M.computeCoverage(rep, (lat) => ridge(lat), 'repeater');
    assert.ok(behind(rHilly) > behind(hilly), 'a 10 m receiver sees more past the ridge than a 1.5 m one');
  });

  await test('no terrain data: nothing drawn, no crash', async () => {
    const cov = await M.computeCoverage(rep, () => NaN, 'ground');
    assert.ok(cov.margins.every((m) => m < -1e8));
  });

  await test('repeaters without a position are skipped; none placed gives null', async () => {
    assert.strictEqual(await M.computeCoverage([{ name: 'x' }], () => 0, 'ground'), null);
    const cov = await M.computeCoverage(rep.concat([{ name: 'x', lat: null, lon: null }]), () => 0, 'ground');
    assert.ok(cov && cov.width > 0);
  });

  await test('gradient: nothing below 0 dB, faint and pale at the edge, deeper up to 25 dB, capped at 45%', () => {
    const rgb = [217, 70, 239];
    assert.strictEqual(M.rampColor(-1, rgb), null);
    const edge = M.rampColor(0, rgb), mid = M.rampColor(10, rgb), top = M.rampColor(25, rgb), over = M.rampColor(60, rgb);
    assert.ok(edge[3] < mid[3] && mid[3] < top[3], 'alpha rises');
    assert.ok(edge[1] > top[1], 'paler at the edge (more white mixed in)');
    assert.deepStrictEqual(top, over, 'flat above 25 dB');
    assert.ok(top[3] <= 0.45 + 1e-9 && edge[3] >= 0.05);
    assert.deepStrictEqual(top.slice(0, 3), rgb);
  });

  await test('gaps between rays are filled; the edge of coverage is not grown', async () => {
    const cov = await M.computeCoverage(rep, () => 0, 'repeater');
    // count empty cells strictly inside the covered disc (well within 35 km)
    let holes = 0, inside = 0;
    const cx = cov.width / 2, cy = cov.height / 2, rCells = (35 / 40) * (cov.width / 2);
    for (let y = 0; y < cov.height; y++) for (let x = 0; x < cov.width; x++) {
      if (Math.hypot(x - cx, y - cy) > rCells) continue;
      inside++;
      if (!(cov.margins[y * cov.width + x] > -1e8)) holes++;
    }
    assert.ok(holes / inside < 0.001, `${holes} holes of ${inside}`);
    assert.ok(cov.margins[0] < -1e8, 'corner still empty');
  });

  await test('hover readout names the margin, band and serving repeater', async () => {
    const two = [{ name: 'North', lat: 47.62, lon: -122.33 }, { name: 'South', lat: 47.55, lon: -122.33 }];
    const cov = await M.computeCoverage(two, () => 0, 'ground');
    assert.ok(/dB to spare \(strong\), best from North$/.test(M.readout(cov, 47.625, -122.33)), M.readout(cov, 47.625, -122.33));
    assert.ok(/best from South$/.test(M.readout(cov, 47.545, -122.33)));
    assert.strictEqual(M.readout(cov, 10, 10), '');
  });

  await test('terrain tiles: terrarium decoding and the tiles requested for the bounds', async () => {
    const urls = [];
    // every pixel encodes 100 m: (R*256 + G + B/256) - 32768
    const px = new Uint8ClampedArray(256 * 256 * 4);
    const v = 100 + 32768;
    for (let i = 0; i < 256 * 256; i++) { px[i * 4] = Math.floor(v / 256); px[i * 4 + 1] = v % 256; px[i * 4 + 2] = 0; px[i * 4 + 3] = 255; }
    const t = await M.loadTerrain({ south: 47.5, north: 47.7, west: -122.4, east: -122.2 }, 11, (url) => { urls.push(url); return Promise.resolve(px); });
    assert.ok(urls.length >= 1 && urls.every((u) => /terrarium\/11\/\d+\/\d+\.png$/.test(u)), urls.join());
    assert.strictEqual(t.elevAt(47.6, -122.3), 100);
    assert.ok(Number.isNaN(t.elevAt(10, 10)), 'outside the loaded tiles is NaN');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
