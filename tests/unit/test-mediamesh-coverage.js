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

  await test('sensitivity follows the SX1262 datasheet: -121 dBm at SF7 / 250 kHz, within 1.5 dB elsewhere', () => {
    assert.strictEqual(M.sensitivityDbm(250, 7), -121);
    assert.strictEqual(M.sensitivityDbm(125, 7), -124);
    // DS.SX1261-2, Rx boosted gain
    [[10.4, 7, -134], [10.4, 12, -148], [125, 12, -137], [250, 12, -134], [500, 7, -117], [500, 12, -129]].forEach(([bw, sf, want]) => {
      assert.ok(Math.abs(M.sensitivityDbm(bw, sf) - want) <= 1.5, `${bw} kHz SF${sf}: ${M.sensitivityDbm(bw, sf)} vs ${want}`);
    });
    assert.ok(M.sensitivityDbm(250, 9) < M.sensitivityDbm(250, 7), 'a higher spreading factor hears weaker signals');
    assert.strictEqual(M.sensitivityDbm(250, 99), -121, 'nonsense falls back to the default preset');
  });

  await test('a repeater\'s reported radio2 setting is used; anything else gets the default preset', () => {
    assert.deepStrictEqual(M.parseRadio('911.15,250,7,5'), { freqMHz: 911.15, bwKHz: 250, sf: 7 });
    ['', null, undefined, '911.15', 'a,b,c', '911.15,250,99,5', '2400,812,7,5', '0,0,0'].forEach((r) => assert.strictEqual(M.parseRadio(r), null, String(r)));
    const def = M.radioFor({ radio: '' });
    assert.strictEqual(def.reported, false);
    assert.strictEqual(def.freqMHz, 911.15);
    assert.strictEqual(def.sensitivityDbm, -121);
    assert.ok(Math.abs(def.lambdaM - 0.329) < 0.001);
    const slow = M.radioFor({ radio: '910.525,62.5,9,5' });
    assert.strictEqual(slow.reported, true);
    assert.strictEqual(slow.sensitivityDbm, M.sensitivityDbm(62.5, 9));
    assert.ok(slow.sensitivityDbm < -130);
  });

  await test('margin uses the conservative budget (22 dBm, 10 dB fade, ground clutter)', () => {
    const g = M.CONFIG.modes.ground, r = M.CONFIG.modes.repeater;
    // 22 + 2 - 1 + 0 + 121 - 10 - 10 = 124 dB of path loss at 0 margin on the ground
    assert.strictEqual(M.marginFor(124, g), 0);
    assert.strictEqual(M.marginFor(124, r), 12);
    assert.strictEqual(M.budgetDb(g), 124);
    // a more sensitive setting has that much more to spend
    const slow = M.radioFor({ radio: '911.15,125,9,5' });
    assert.ok(Math.abs(M.marginFor(124, g, slow) - (-121 - slow.sensitivityDbm)) < 1e-9);
  });

  // A 10 km path between two 10 m antennas on flat ground at sea level
  // (earth's curve left out: heights are given already lowered).
  const lambda = 299.792458 / 911.15;
  function path(heights) {
    const n = 199, d = new Float64Array(n), h = new Float64Array(n);
    for (let i = 0; i < n; i++) { d[i] = (i + 1) * 50; h[i] = heights(d[i]); }
    return M.cascadedKnifeEdge(d, h, n, 10, 10000, 10, lambda);
  }

  await test('diffraction: nothing for a path well clear of the ground', () => {
    const r = path(() => -200);
    assert.strictEqual(r.loss, 0);
    assert.ok(r.vp < -0.78);
  });

  await test('diffraction: one knife edge matches ITU-R P.526-11 (J, T and C)', () => {
    // 30 m above the line of sight, midway: v = h sqrt(2 D / (lambda d1 d2))
    const r = path((d) => (d === 5000 ? 40 : -500));
    const v = 30 * Math.sqrt((2 * 10000) / (lambda * 5000 * 5000));
    assert.ok(Math.abs(r.vp - v) < 1e-9, `${r.vp} vs ${v}`);
    assert.ok(Math.abs(r.jp - M.knifeEdgeLoss(v)) < 1e-9);
    assert.ok(Math.abs(r.jp - 16.7) < 0.1, String(r.jp));
    assert.strictEqual(r.jt, 0); assert.strictEqual(r.jr, 0);
    assert.ok(Math.abs(r.T - (1 - Math.exp(-r.jp / 6))) < 1e-12);
    assert.ok(Math.abs(r.C - 10.4) < 1e-12, 'C = 10 + 0.04 D');
    assert.ok(Math.abs(r.loss - (r.jp + r.T * r.C)) < 1e-9);
  });

  await test('diffraction: ground that only reaches into the Fresnel zone already costs signal', () => {
    // first Fresnel radius midway on 10 km: sqrt(lambda * 2500) = 28.7 m
    const clear = path((d) => (d === 5000 ? 10 - 40 : -500));   // 40 m below the line: clear
    const close = path((d) => (d === 5000 ? 10 - 10 : -500));   // 10 m below: inside the zone
    const grazing = path((d) => (d === 5000 ? 10 : -500));      // touching the line
    assert.strictEqual(clear.loss, 0);
    assert.ok(close.loss > 1 && close.loss < grazing.loss, `close ${close.loss}, grazing ${grazing.loss}`);
    assert.ok(Math.abs(grazing.jp - 6.0) < 0.1, 'a grazing knife edge is 6 dB');
    assert.ok(grazing.loss > 6, 'plus the empirical correction');
  });

  await test('diffraction: a second and third ridge add to the first', () => {
    const one = path((d) => (d === 5000 ? 60 : -500));
    const three = path((d) => (d === 5000 ? 60 : (d === 2500 || d === 7500) ? 45 : -500));
    assert.strictEqual(three.ip, one.ip, 'same principal edge');
    assert.ok(three.jt > 0 && three.jr > 0, `secondary edges: ${three.jt}, ${three.jr}`);
    assert.ok(Math.abs(three.loss - (three.jp + three.T * (three.jt + three.jr + three.C))) < 1e-9);
    assert.ok(three.loss > one.loss + 5);
    // the old model saw only the highest obstacle
    assert.ok(three.loss > M.knifeEdgeLoss(three.vp) + 10);
  });

  await test('ray samples: every step near the repeater, sparser further out, inside the radius', () => {
    ['ground', 'repeater'].forEach((k) => {
      const mode = M.CONFIG.modes[k], d = M.sampleDistances(mode);
      assert.strictEqual(d[0], mode.stepM);
      assert.strictEqual(d[1] - d[0], mode.stepM);
      for (let i = 1; i < d.length; i++) assert.ok(d[i] > d[i - 1]);
      assert.ok(d[d.length - 1] <= mode.radiusKm * 1000 && d[d.length - 1] > mode.radiusKm * 1000 * 0.98);
      assert.ok(d[d.length - 1] - d[d.length - 2] > 3 * mode.stepM, 'sparse at the far end');
      assert.ok(d.length < 400, `${d.length} samples`);
    });
  });

  await test('the fast inner loop gives the same loss as the reference method', () => {
    const mode = M.CONFIG.modes.ground;
    const lumpy = (lat, lon) => 80 + 60 * Math.sin(lat * 700) * Math.cos(lon * 500) + 30 * Math.sin(lat * 2300 + lon * 1700);
    const g = M.gridFor(rep, mode);
    const radio = M.radioFor(rep[0]);
    const job = M.buildJob(rep[0], radio, lumpy, mode, g);
    const polar = M.polarMargins(job);
    const effR = M.CONFIG.kFactor * M.CONFIG.earthRadiusM;
    let checked = 0;
    [0, 100, 517, 1210].forEach((a) => {
      const off = a * job.n;
      const h = new Float64Array(job.n);
      for (let i = 0; i < job.n; i++) h[i] = job.peak[off + i] - job.dist[i] * job.dist[i] / (2 * effR);
      [0, 1, 5, 40, 120, 200, job.n - 1].forEach((j) => {
        const D = job.dist[j];
        const hr = job.elev[off + j] - D * D / (2 * effR) + mode.rxHeightM;
        const ref = M.cascadedKnifeEdge(job.dist, h, j, job.txGround + M.CONFIG.txHeightM, D, hr, radio.lambdaM);
        const want = M.budgetDb(mode, radio) - M.fspl(D / 1000, radio.freqMHz) - ref.loss;
        assert.ok(Math.abs(polar[off + j] - want) < 1e-3, `ray ${a} sample ${j}: ${polar[off + j]} vs ${want}`);
        checked++;
      });
    });
    assert.strictEqual(checked, 28);
  });

  await test('a sparse sample carries the highest ground of its stretch, so a narrow ridge still shadows', async () => {
    const mode = M.CONFIG.modes.ground;
    // a wall 40 m wide, 18 km north, where samples are over 200 m apart
    const wallLat = 47.6 + kmLat(18.11);
    const wall = (lat) => (Math.abs(lat - wallLat) < kmLat(0.02) ? 400 : 0);
    const job = M.buildJob(rep[0], M.radioFor(rep[0]), wall, mode, M.gridFor(rep, mode));
    let seen = 0;
    for (let i = 0; i < job.n; i++) { if (job.peak[i] > 300) seen++; assert.ok(job.peak[i] >= job.elev[i]); }
    assert.ok(seen >= 1, 'the wall is in the profile of the ray due north');
    const flat = await M.computeCoverage(rep, () => 0, 'ground');
    const walled = await M.computeCoverage(rep, wall, 'ground');
    const beyond = (c) => cellAt(c, 47.6 + kmLat(22), -122.33);
    assert.ok(beyond(walled) < beyond(flat) - 15, `${beyond(walled)} vs ${beyond(flat)}`);
  });

  await test('flat terrain: strong near the repeater, fading with distance, cut at the radius', async () => {
    const cov = await M.computeCoverage(rep, () => 0, 'ground');
    const near = cellAt(cov, 47.6 + kmLat(0.5), -122.33);
    const mid = cellAt(cov, 47.6 + kmLat(5), -122.33);
    assert.ok(near > mid, `near ${near} > mid ${mid}`);
    assert.strictEqual(M.band(near), 'strong');
    // beyond the radius nothing is drawn: the grid's corner is ~42 km out
    assert.ok(cov.margins[0] < -1e8 && cov.margins[cov.margins.length - 1] < -1e8);
    // the same in every direction
    const east = cellAt(cov, 47.6, -122.33 + 5 / (111.32 * Math.cos(47.6 * Math.PI / 180)));
    assert.ok(Math.abs(east - mid) < 0.5, `east ${east} vs north ${mid}`);
  });

  await test('a person on flat ground gets less than free space; a repeater on a hill gets it back', async () => {
    const mode = M.CONFIG.modes.ground;
    const freeSpace = M.marginFor(M.fspl(5), mode);
    const flat = await M.computeCoverage(rep, () => 0, 'ground');
    const onFlat = cellAt(flat, 47.6 + kmLat(5), -122.33);
    assert.ok(onFlat < freeSpace - 3 && onFlat > freeSpace - 25, `flat ${onFlat} vs free space ${freeSpace}`);
    // the repeater on a 150 m knoll: the path clears the ground until close to the person
    const knoll = (lat, lon) => (Math.hypot((lat - 47.6) * 111.32, (lon + 122.33) * 75) < 0.15 ? 150 : 0);
    const high = await M.computeCoverage(rep, knoll, 'ground');
    const fromKnoll = cellAt(high, 47.6 + kmLat(5), -122.33);
    assert.ok(Math.abs(fromKnoll - freeSpace) < 1, `from the knoll ${fromKnoll} vs free space ${freeSpace}`);
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

  await test('the drawing fades out towards the radius instead of ending in a hard edge', () => {
    assert.strictEqual(M.edgeFade(0, 30000), 1);
    assert.strictEqual(M.edgeFade(25000, 30000), 1);
    assert.ok(M.edgeFade(28000, 30000) > 0 && M.edgeFade(28000, 30000) < 1);
    assert.strictEqual(M.edgeFade(30000, 30000), 0);
    assert.strictEqual(M.edgeFade(31000, 30000), 0);
  });

  await test('no gaps between rays; the edge of coverage is not grown', async () => {
    const cov = await M.computeCoverage(rep, () => 0, 'repeater');
    // count empty cells strictly inside the disc (well within the radius)
    let holes = 0, inside = 0;
    const cx = cov.width / 2, cy = cov.height / 2, rCells = 0.95 * (cov.width / 2);
    for (let y = 0; y < cov.height; y++) for (let x = 0; x < cov.width; x++) {
      if (Math.hypot(x - cx, y - cy) > rCells) continue;
      inside++;
      if (!(cov.margins[y * cov.width + x] > -1e8)) holes++;
    }
    assert.strictEqual(holes, 0, `${holes} holes of ${inside}`);
    assert.ok(cov.margins[0] < -1e8, 'corner still empty');
  });

  const two = [{ name: 'North', lat: 47.62, lon: -122.33 }, { name: 'South', lat: 47.55, lon: -122.33 }];

  await test('hover readout names the margin, band, distance and serving repeater', async () => {
    const cov = await M.computeCoverage(two, () => 0, 'ground');
    assert.ok(/^≈ \d+ dB to spare \(strong\), 5\d0 m from North$/.test(M.readout(cov, 47.625, -122.33)), M.readout(cov, 47.625, -122.33));
    assert.ok(/from South$/.test(M.readout(cov, 47.545, -122.33)));
    assert.strictEqual(M.readout(cov, 10, 10), '');
    assert.strictEqual(M.readout(null, 47.6, -122.33), '');
    // out of coverage but within the radius: how far short, and of whom
    const far = M.readout(cov, 47.62 + kmLat(27), -122.33);
    assert.ok(/^Out of estimated MediaMesh coverage here \(about \d+ dB short, 27 km from North\)$/.test(far), far);
  });

  await test('repeaters can be left out: only the ones counted serve a cell', async () => {
    const cov = await M.computeCoverage(two, () => 0, 'ground');
    const at = (lat) => M.cellAt(cov, lat, -122.33);
    assert.strictEqual(at(47.625).rep, 0);
    const both = at(47.625).margin;
    M.merge(cov, [false, true]);
    assert.strictEqual(at(47.625).rep, 1, 'now served by South');
    assert.ok(at(47.625).margin < both - 10);
    M.merge(cov, [false, false]);
    assert.ok(cov.margins.every((m) => m < -1e8));
    assert.strictEqual(at(47.625).rep, -1);
    M.merge(cov);
    assert.strictEqual(at(47.625).margin, both);
    assert.strictEqual(M.cellAt(cov, 10, 10), null);
  });

  await test('a repeater on a more sensitive setting reaches further by exactly that much', async () => {
    const def = await M.computeCoverage(rep, () => 0, 'repeater');
    const slow = await M.computeCoverage([{ name: 'R', lat: 47.6, lon: -122.33, radio: '911.15,125,9,5' }], () => 0, 'repeater');
    const gain = -121 - M.sensitivityDbm(125, 9);
    assert.ok(gain > 7);
    const at = (c) => cellAt(c, 47.6 + kmLat(8), -122.33);
    assert.ok(Math.abs(at(slow) - at(def) - gain) < 0.11, `${at(slow)} vs ${at(def)} + ${gain}`);
    assert.strictEqual(slow.radios[0].sf, 9);
  });

  await test('work can be handed to a worker pool; no pool where there are no workers', async () => {
    assert.strictEqual(M.workerPool(), null);
    const jobs = [];
    const run = (job, rebuild) => { jobs.push(job); assert.strictEqual(typeof rebuild, 'function'); return Promise.resolve(M.repRaster(rebuild())); };
    const progress = [];
    const viaPool = await M.computeCoverage(two, () => 0, 'ground', (d, t) => progress.push(d + '/' + t), { run });
    const direct = await M.computeCoverage(two, () => 0, 'ground');
    assert.strictEqual(jobs.length, 2);
    assert.deepStrictEqual(progress, ['1/2', '2/2']);
    assert.deepStrictEqual(viaPool.margins, direct.margins);
    // a job is plain data, so it can be posted to a worker
    assert.ok(jobs[0].elev instanceof Float32Array && jobs[0].peak instanceof Float32Array);
    assert.ok(Object.values(jobs[0]).every((v) => typeof v === 'number' || ArrayBuffer.isView(v)));
  });

  // 120 m ridge 3 km north of the repeater, flat elsewhere
  const ridgeAt3 = (lat) => (Math.abs(lat - (47.6 + kmLat(3))) < kmLat(0.15) ? 120 : 0);

  await test('path profile: every part of the budget, and it agrees with the map', async () => {
    const cov = await M.computeCoverage(rep, ridgeAt3, 'ground');
    const lat = 47.6 + kmLat(6);
    const p = M.pathProfile(rep[0], lat, -122.33, ridgeAt3, 'ground');
    assert.ok(Math.abs(p.distM - 6000) < 5);
    assert.ok(Math.abs(p.fsplDb - M.fspl(6)) < 0.01);
    assert.strictEqual(p.lineOfSight, false);
    assert.ok(p.diff.loss > 20);
    assert.ok(p.edges.length >= 1 && p.edges.some((e) => e.principal && Math.abs(e.d - 3000) < 200), JSON.stringify(p.edges));
    assert.strictEqual(p.eirpDbm, 23);
    assert.ok(Math.abs(p.rxDbm - (23 + 0 - p.fsplDb - p.diff.loss - 10)) < 1e-9);
    assert.ok(Math.abs(p.marginDb - (p.rxDbm + 121 - 10)) < 1e-9);
    assert.ok(Math.abs(p.marginDb - cellAt(cov, lat, -122.33)) < 3, `profile ${p.marginDb} vs map ${cellAt(cov, lat, -122.33)}`);
    assert.ok(/^No line of sight/.test(M.profileVerdict(p)));
    // the other way there is no ridge: line of sight, but the ground is close
    const south = M.pathProfile(rep[0], 47.6 - kmLat(6), -122.33, ridgeAt3, 'ground');
    assert.strictEqual(south.lineOfSight, true);
    assert.strictEqual(south.fresnelClear, false);
    assert.ok(/^Line of sight, but/.test(M.profileVerdict(south)));
    // from a hilltop to a nearby one: clear
    const peaks = (lat) => (Math.abs(lat - 47.6) < kmLat(0.1) || Math.abs(lat - (47.6 + kmLat(2))) < kmLat(0.1) ? 200 : 0);
    const clear = M.pathProfile(rep[0], 47.6 + kmLat(2), -122.33, peaks, 'repeater');
    assert.strictEqual(clear.fresnelClear, true);
    assert.strictEqual(clear.diff.loss, 0);
    assert.ok(/^Clear line of sight/.test(M.profileVerdict(clear)));
    assert.strictEqual(M.pathProfile(rep[0], lat, -122.33, () => NaN, 'ground'), null);
  });

  await test('path profile: budget rows read top to bottom and end in the margin', () => {
    const p = M.pathProfile(rep[0], 47.6 + kmLat(6), -122.33, ridgeAt3, 'ground');
    const rows = M.budgetRows(p);
    assert.deepStrictEqual(rows[0], ['Sent: 22 dBm, 2 dBi antenna, 1 dB cable', '23 dBm', 'gain']);
    assert.ok(/^Free space over 6\.0 km$/.test(rows[1][0]) && /^−107\.\d dB$/.test(rows[1][1]), rows[1].join('|'));
    assert.ok(rows.some((r) => /Buildings and trees/.test(r[0]) && r[1] === '−10 dB'));
    assert.ok(rows.some((r) => r[0] === 'Receiver needs (SF7, 250 kHz)' && r[1] === '−121 dBm'));
    const last = rows[rows.length - 1];
    assert.strictEqual(last[0], 'Short by');
    assert.strictEqual(last[2], 'result');
    // repeater view: no clutter row, a receiving antenna instead, and no "-0 dB"
    const peaks = (lat) => (Math.abs(lat - 47.6) < kmLat(0.1) || Math.abs(lat - (47.6 + kmLat(2))) < kmLat(0.1) ? 200 : 0);
    const r2 = M.budgetRows(M.pathProfile(rep[0], 47.6 + kmLat(2), -122.33, peaks, 'repeater'));
    assert.ok(!r2.some((r) => /Buildings/.test(r[0])));
    assert.ok(r2.some((r) => r[0] === 'Receiving antenna' && r[1] === '+2 dB'));
    assert.ok(r2.some((r) => r[0] === 'Terrain (diffraction)' && r[1] === '0 dB'));
    assert.strictEqual(r2[r2.length - 1][0], 'To spare');
  });

  await test('path profile: the drawing and the panel', () => {
    const p = M.pathProfile({ name: '<b>Hill</b>', lat: 47.6, lon: -122.33 }, 47.6 + kmLat(6), -122.33, ridgeAt3, 'ground');
    const svg = M.profileSvg(p, { label: 'x "y"' });
    assert.ok(/^<svg class="mm-cov-prof-svg" viewBox="0 0 640 200" role="img" aria-label="x &quot;y&quot;"/.test(svg));
    ['mm-cov-prof-ground', 'mm-cov-prof-zone', 'mm-cov-prof-los mm-cov-prof-los--blocked', 'mm-cov-prof-edge mm-cov-prof-edge--main', 'mm-cov-prof-ant'].forEach((c) => assert.ok(svg.includes(c), c));
    assert.ok(!/NaN|undefined|Infinity/.test(svg));
    assert.ok(/>\d+ m</.test(svg) && / km</.test(svg), 'axes are labelled');
    const html = M.profileHtml(p, { name: '<b>Hill</b>' });
    assert.ok(html.includes('&lt;b&gt;Hill&lt;/b&gt; to a person at 1.5 m, 6.0 km'));
    assert.ok(!html.includes('<b>Hill'));
    assert.ok(/About \d+ dB short/.test(html));
    assert.ok(html.includes('data-mm-cov-close') && html.includes('First Fresnel zone'));
    const ok = M.pathProfile(rep[0], 47.6 + kmLat(1), -122.33, () => 0, 'repeater');
    assert.ok(/≈ \d+ dB to spare \(strong\)/.test(M.profileHtml(ok, rep[0])));
    assert.ok(M.profileHtml(ok, rep[0]).includes('R to an antenna at 10 m, 1.0 km'));
  });

  await test('repeater picker: a summary line, groups by area, and a box per repeater', () => {
    const reps = [
      { name: 'A & B', lat: 1, lon: 1, radio: '911.15,250,7,5', mode: 'rxtx', near: 'First Hill, Seattle', source: 'status' },
      { name: 'Slow', lat: 1, lon: 1, radio: '911.15,125,9,5', mode: 'rx', near: 'Woodinville, WA', source: 'heard' },
      { public_key: 'aabbccddeeff', lat: 1, lon: 1, source: 'relayed' },
      { name: 'Alpha', lat: 1, lon: 1, near: 'First Hill, Seattle', source: 'heard' },
    ];
    assert.strictEqual(M.repArea(reps[0]), 'First Hill');
    assert.strictEqual(M.repArea(reps[2]), 'No area');
    assert.deepStrictEqual(M.repNotes(reps[1]), ['listens only', '911.15 MHz, 125 kHz SF9']);
    assert.deepStrictEqual(M.repNotes(reps[2]), ['relayed']);
    // biggest area first, names sorted inside it, "No area" last
    assert.deepStrictEqual(M.repGroups(reps), [
      { area: 'First Hill', idx: [0, 3] }, { area: 'Woodinville', idx: [1] }, { area: 'No area', idx: [2] },
    ]);
    assert.ok(M.repSummaryHtml(reps, [true, false, true, true], false).includes('Counting 3 of 4 repeaters'));
    assert.ok(M.repSummaryHtml(reps, null, true).includes('Counting all 4 repeaters'));
    assert.ok(M.repSummaryHtml(reps, null, true).includes('aria-expanded="true"'));
    assert.strictEqual(M.repSummaryHtml([]), '');
    const html = M.repPanelHtml(reps);
    assert.ok(html.includes('data-mm-cov-area="0,3"') && html.includes('Count every repeater in First Hill'));
    assert.ok(/data-mm-cov-search="a &amp; b first hill, seattle "><input type="checkbox" data-mm-cov-rep="0" checked>/.test(html), html);
    assert.ok(html.includes('<span class="mm-cov-rep-note">listens only · 911.15 MHz, 125 kHz SF9</span>'));
    assert.ok(html.includes('mm-cov-rep mm-cov-rep--relayed'));
    for (const act of ['all', 'none', 'view', 'reported', 'norelayed']) assert.ok(html.includes(`data-mm-cov-act="${act}"`), act);
    assert.strictEqual(M.repPanelHtml([]), '');
  });

  await test('repeater picker quick actions', () => {
    const reps = [{ source: 'status', lat: 1 }, { source: 'heard', lat: 2 }, { source: 'relayed', lat: 3 }];
    assert.deepStrictEqual(M.repAction('all', reps), [true, true, true]);
    assert.deepStrictEqual(M.repAction('none', reps), [false, false, false]);
    assert.deepStrictEqual(M.repAction('reported', reps), [true, false, false]);
    assert.deepStrictEqual(M.repAction('norelayed', reps), [true, true, false]);
    assert.deepStrictEqual(M.repAction('view', reps, (r) => r.lat > 1), [false, true, true]);
    assert.strictEqual(M.repAction('bogus', reps), null);
  });

  await test('areas: per cell, covered, union and per repeater', () => {
    // a 10 x 10 grid of 100 m cells near the equator: 0.01 km² each
    const cov = { width: 10, height: 10, bounds: { north: 0.0045, south: -0.0045, west: -0.0045, east: 0.0045 },
      margins: new Float32Array(100).fill(-1e9) };
    const a = M.cellAreaKm2(cov);
    assert.ok(Math.abs(a - 0.01) < 0.0005, String(a));
    for (let i = 0; i < 30; i++) cov.margins[i] = 3;
    assert.ok(Math.abs(M.coveredKm2(cov) - 30 * a) < 1e-9);
    // two rasters overlapping by one row: union counts each cell once
    const r = (row0, v) => ({ col0: 0, row0, w: 10, h: 2, data: new Int16Array(20).fill(v) });
    cov.rasters = [r(0, 50), r(1, 20), r(5, -40)];
    assert.ok(Math.abs(M.unionKm2(cov) - 30 * a) < 1e-9);
    const per = M.repAreasKm2(cov);
    assert.ok(Math.abs(per[0] - 20 * a) < 1e-9 && Math.abs(per[1] - 20 * a) < 1e-9 && per[2] === 0, JSON.stringify(per));
  });

  await test('planned repeater: new against already-covered area, and the repeaters it links to', async () => {
    const elev = () => 0;
    const planned = { lat: 47.6, lon: -122.33 };
    const planCov = await M.computeCoverage([planned], elev, 'repeater');
    // nothing there before: all new
    let g = M.planGain(planCov, null);
    assert.ok(g.newKm2 > 100 && g.overlapKm2 === 0 && Math.abs(g.totalKm2 - g.newKm2) < 1e-9, JSON.stringify({ n: g.newKm2, o: g.overlapKm2 }));
    // the same repeater already counted: all overlap
    const same = await M.computeCoverage([{ lat: 47.6, lon: -122.33 }], elev, 'repeater');
    g = M.planGain(planCov, same);
    assert.ok(g.newKm2 === 0 && g.overlapKm2 > 100, JSON.stringify({ n: g.newKm2, o: g.overlapKm2 }));
    // links: within reach on flat ground, best first; out of the radius left out
    const reps = [{ name: 'Far', lat: 48.4, lon: -122.33 }, { name: 'Mid', lat: 47.75, lon: -122.33 }, { name: 'Close', lat: 47.62, lon: -122.33 }];
    const links = M.planLinks(planned, reps, elev);
    assert.deepStrictEqual(links.map((l) => l.rep.name), ['Close', 'Mid']);
    assert.ok(links[0].marginDb > links[1].marginDb && links[1].index === 1);
    // a higher antenna gets further
    assert.strictEqual(M.antennaHeight({}), 10);
    assert.strictEqual(M.antennaHeight({ heightM: 30 }), 30);
    const hill = (lat) => (lat > 47.605 && lat < 47.607 ? 60 : 0);
    const low = M.pathProfile(planned, 47.62, -122.33, hill, 'repeater');
    const high = M.pathProfile(Object.assign({ heightM: 50 }, planned), 47.62, -122.33, hill, 'repeater');
    assert.ok(high.marginDb > low.marginDb + 3, `${low.marginDb} -> ${high.marginDb}`);
    // the panel
    const html = M.planHtml(Object.assign({ heightM: 20 }, planned), { newKm2: 14.23, overlapKm2: 3, totalKm2: 17.23 }, links, 'ground', false);
    assert.ok(html.includes('<strong>+14.2 km²</strong> of new coverage for people on the ground'), html);
    assert.ok(html.includes('<option value="20" selected>20 m</option>'));
    assert.ok(html.includes('Links to: Close') && html.includes('data-mm-cov-plan-remove'));
    assert.ok(M.planHtml(planned, { newKm2: 0, overlapKm2: 0, totalKm2: 0 }, [], 'repeater', false).includes('it would be on its own'));
    assert.ok(M.planHtml(planned, null, [], 'ground', true).includes('Working it out'));
  });

  await test('backbone: line weight by traffic, tooltip, and area as the network grew', () => {
    assert.strictEqual(M.backboneWeight(0, 100), 1.5);
    assert.ok(Math.abs(M.backboneWeight(100, 100) - 6) < 1e-9);
    const w1 = M.backboneWeight(1, 100), w10 = M.backboneWeight(10, 100);
    assert.ok(w1 > 1.5 && w10 > w1 && w10 < 6, `${w1} ${w10}`);
    assert.strictEqual(M.backboneTip({ a_name: 'A & B', b: 'ccddeeff00', packets: 1 }), 'A &amp; B ↔ ccddeeff: 1 photo, video and voice packet this week');
    assert.ok(M.backboneTip({ a_name: 'A', b_name: 'B', packets: 1200 }).includes('1,200 photo, video and voice packets'));
    // area history from rasters and first-seen times
    const cov = { width: 10, height: 10, bounds: { north: 0.0045, south: -0.0045, west: -0.0045, east: 0.0045 } };
    const r = (row0, v) => ({ col0: 0, row0, w: 10, h: 2, data: new Int16Array(20).fill(v) });
    cov.rasters = [r(0, 50), r(4, 20)];
    const a = M.cellAreaKm2(cov);
    assert.ok(Math.abs(M.unionKm2(cov, [true, false]) - 20 * a) < 1e-9, 'a mask leaves repeaters out');
    const steps = [{ t: 1000, count: 1 }, { t: 2000, count: 2 }];
    const h = M.areaHistory(cov, ['1970-01-01T00:00:00.500Z', '1970-01-01T00:00:01.500Z'], steps);
    assert.strictEqual(h.length, 2);
    assert.ok(Math.abs(h[0].km2 - 20 * a) < 1e-9 && Math.abs(h[1].km2 - 40 * a) < 1e-9, JSON.stringify(h));
  });

  await test('growth time-lapse: one step per day, counting the repeaters there by then', () => {
    const now = Date.parse('2026-11-17T18:00:00Z');
    const first = ['2026-11-10T09:00:00Z', '2026-11-12T23:30:00Z', '', '2026-11-17T08:00:00Z'];
    const steps = M.growthSteps(first, now);
    assert.strictEqual(steps.length, 8);
    assert.deepStrictEqual(steps.map((s) => s.count), [2, 2, 3, 3, 3, 3, 3, 4]);
    assert.deepStrictEqual(M.presentAt(first, steps[2].t), [true, true, true, false]);
    // under two days of history: no time-lapse
    assert.deepStrictEqual(M.growthSteps(['2026-11-17T01:00:00Z'], now), []);
    assert.deepStrictEqual(M.growthSteps(['', 'junk'], now), []);
  });

  await test('calibration: fitted to links heard often enough, limited, and applied to every budget', () => {
    const row = (rawDelta, count) => ({ rawDelta, count });
    // too few links: nothing applied
    assert.deepStrictEqual(M.fitCalibration([row(5, 10), row(3, 10)]), { n: 2, offsetDb: 0, fitDb: null, spreadDb: null, used: false });
    // links heard fewer than 5 times don't count
    assert.strictEqual(M.fitCalibration([row(5, 10), row(3, 10), row(40, 2)]).n, 2);
    // the median, and how far the links sit from it
    let c = M.fitCalibration([row(-4, 10), row(-6, 10), row(-2, 10), row(-10, 50)]);
    assert.ok(c.used && c.offsetDb === -5 && c.fitDb === -5 && c.spreadDb === 2, JSON.stringify(c));
    assert.ok(M.calibrationText(c).includes('Checked against 4 real links heard on radio2: lowered by 5 dB to match, and typically within ±2 dB'), M.calibrationText(c));
    // limited upwards to +6 (heard links flatter the model), downwards to -12
    c = M.fitCalibration([row(20, 10), row(18, 10), row(22, 10)]);
    assert.strictEqual(c.offsetDb, 6);
    assert.ok(M.calibrationText(c).includes('raised by 6 dB to match (the links suggest +20 dB; capped)'), M.calibrationText(c));
    assert.strictEqual(M.fitCalibration([row(-30, 10), row(-30, 10), row(-30, 10)]).offsetDb, -12);
    assert.ok(M.calibrationText({ used: false, n: 1 }).includes('(1 so far)'));
    // applied: the budget, the profile and the link model all move with it
    const mode = M.CONFIG.modes.repeater;
    const before = M.budgetDb(mode);
    const rep = { lat: 47.6, lon: -122.33 };
    const p0 = M.pathProfile(rep, 47.61, -122.33, () => 0, 'repeater');
    M.setCalibration(-5);
    try {
      assert.strictEqual(M.budgetDb(mode), before - 5);
      const p1 = M.pathProfile(rep, 47.61, -122.33, () => 0, 'repeater');
      assert.ok(Math.abs(p1.rxDbm - (p0.rxDbm - 5)) < 1e-9 && p1.calibrationDb === -5);
      assert.ok(M.budgetRows(p1).some((r) => r[0] === 'Correction from links heard on radio2' && r[1] === '−5 dB'));
      const rows = M.linkRows([{ from_name: 'A', from_role: 'repeater', observer_name: 'B', from_lat: 47.6, from_lon: -122.33,
        to_lat: 47.61, to_lon: -122.33, count: 9, avg_rssi: -80 }], () => 0);
      // the raw figures are before the correction, the shown ones after
      assert.ok(Math.abs(rows[0].rawModelRssi - p0.rxDbm) < 1e-9 && Math.abs(rows[0].modelRssi - (p0.rxDbm - 5)) < 1e-9);
      assert.ok(Math.abs(rows[0].rawDelta - (rows[0].delta - 5)) < 1e-9);
    } finally {
      M.setCalibration(0);
    }
    assert.strictEqual(M.budgetDb(mode), before);
  });

  await test('the assumptions list states the numbers in use, and the limits', () => {
    const radios = [M.radioFor({ radio: '911.15,250,7,5' }), M.radioFor({ radio: '911.15,125,9,5' }), M.radioFor({})];
    const g = M.assumptionsHtml('ground', radios), r = M.assumptionsHtml('repeater', radios);
    assert.ok(g.includes('22 dBm into a 2 dBi antenna through 1 dB of cable, 10 m above the ground'));
    assert.ok(g.includes('held at 1.5 m') && g.includes('10 dB taken off for nearby buildings and trees'));
    assert.ok(r.includes('another repeater') && !r.includes('held at'));
    assert.ok(g.includes('2 of 3 here, 1 not on the default preset'));
    assert.ok(g.includes('911.15 MHz, 250 kHz, SF7') && g.includes('−121 dBm') && g.includes('10 dB more as a safety margin'));
    assert.ok(g.includes('ITU-R P.526-11') && g.includes('k = 4/3') && g.includes('Fresnel'));
    assert.ok(g.includes('30 km from each repeater') && r.includes('60 km from each repeater'));
    assert.ok(/Not modelled:<\/strong> buildings and trees/.test(g) && g.includes('interference'));
    assert.strictEqual((g.match(/<li>/g) || []).length, 7);
    assert.ok(g.includes('<strong>Checked:</strong> Not yet checked against real links'));
  });

  await test('heard links: paired with the model\'s figure for the same path', () => {
    const links = [
      { from: 'aa', from_name: 'Rep <1>', from_role: 'repeater', from_lat: 47.6, from_lon: -122.33, observer_id: 'o1', observer_name: 'Obs', to_lat: 47.6 + kmLat(4), to_lon: -122.33, count: 3, avg_snr: 5.5, avg_rssi: -90.25 },
      { from: 'bb', from_name: 'Deck', from_role: 'companion', from_lat: 47.6 + kmLat(1), from_lon: -122.33, observer_id: 'o1', observer_name: 'Obs', to_lat: 47.6 + kmLat(4), to_lon: -122.33, count: 40, avg_snr: null, avg_rssi: null },
      { from: 'cc', from_name: 'Nowhere', observer_id: 'o1', count: 9 },
    ];
    const hill = (lat) => (Math.abs(lat - 47.6) < kmLat(0.1) || Math.abs(lat - (47.6 + kmLat(4))) < kmLat(0.1) ? 300 : 0);
    const rows = M.linkRows(links, hill);
    assert.strictEqual(rows.length, 2, 'a link without both positions is left out');
    assert.strictEqual(rows[0].from, 'Deck', 'most packets first');
    const r = rows[1];
    assert.ok(Math.abs(r.distM - 4000) < 5);
    // hilltop to hilltop, both 10 m up: free space and both antennas
    const want = 23 + 2 - M.fspl(4);
    assert.ok(Math.abs(r.modelRssi - want) < 0.05, `${r.modelRssi} vs ${want}`);
    assert.ok(Math.abs(r.delta - (-90.25 - want)) < 0.05);
    // a companion: worked out as a person on the ground, heard by a 10 m antenna
    const deck = M.pathProfile({ lat: 47.6 + kmLat(4), lon: -122.33 }, 47.6 + kmLat(1), -122.33, hill, 'ground');
    assert.ok(Math.abs(rows[0].modelRssi - deck.rxDbm) < 1e-9);
    assert.strictEqual(rows[0].delta, null);
    const noModel = M.linkRows(links, null);
    assert.strictEqual(noModel[1].modelRssi, null);
    const html = M.linksTableHtml(rows);
    assert.ok(html.includes('Rep &lt;1&gt; → Obs') && !html.includes('<1>'));
    assert.ok(html.includes('<td>4.0 km</td><td>3</td><td>5.5 dB</td><td>−90.3 dBm</td>') || html.includes('<td>4.0 km</td><td>3</td><td>5.5 dB</td><td>−90.2 dBm</td>'), html);
    assert.ok(/<td>40<\/td><td>—<\/td><td>—<\/td><td>−[\d.]+ dBm<\/td><td>—<\/td>/.test(html), html);
    assert.strictEqual(M.linksTableHtml([]), '');
    assert.deepStrictEqual(M.linkRows(undefined, null), []);
  });

  // every pixel of a tile encodes one height: (R*256 + G + B/256) - 32768
  function flatTile(m) {
    const px = new Uint8ClampedArray(256 * 256 * 4);
    const v = m + 32768;
    for (let i = 0; i < 256 * 256; i++) { px[i * 4] = Math.floor(v / 256); px[i * 4 + 1] = Math.floor(v % 256); px[i * 4 + 2] = Math.round((v % 1) * 256); px[i * 4 + 3] = 255; }
    return px;
  }

  await test('terrain tiles: terrarium decoding and the tiles requested for the bounds', async () => {
    const urls = [];
    const t = await M.loadTerrain({ south: 47.5, north: 47.7, west: -122.4, east: -122.2 }, 11, (url) => { urls.push(url); return Promise.resolve(flatTile(100.5)); });
    assert.ok(urls.length >= 1 && urls.every((u) => /terrarium\/11\/\d+\/\d+\.png$/.test(u)), urls.join());
    assert.strictEqual(new Set(urls).size, urls.length);
    assert.strictEqual(t.elevAt(47.6, -122.3), 100.5);
    assert.ok(Number.isNaN(t.elevAt(10, 10)), 'outside the loaded tiles is NaN');
    assert.strictEqual(t.failed, 0);
    assert.strictEqual(t.total, urls.length);
  });

  await test('terrain tiles: heights are interpolated between pixels, across tile edges too', async () => {
    // height = global pixel column at zoom 11, so it rises steadily eastwards
    const sloped = (url) => {
      const x = Number(/\/11\/(\d+)\//.exec(url)[1]);
      const px = new Uint8ClampedArray(256 * 256 * 4);
      for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
        const v = (x - 327) * 256 + i + 32768, k = (j * 256 + i) * 4;
        px[k] = Math.floor(v / 256); px[k + 1] = v % 256; px[k + 3] = 255;
      }
      return Promise.resolve(px);
    };
    const t = await M.loadTerrain({ south: 47.5, north: 47.7, west: -122.5, east: -122.1 }, 11, sloped);
    const colOf = (lon) => ((lon + 180) / 360) * 2048 * 256 - 0.5 - 327 * 256;
    [-122.4567, -122.3333, -122.3437, -122.2, -122.16796].forEach((lon) => {
      assert.ok(Math.abs(t.elevAt(47.6, lon) - colOf(lon)) < 1e-3, `${lon}: ${t.elevAt(47.6, lon)} vs ${colOf(lon)}`);
    });
    // exactly on a tile edge (x = 328.0): halfway between the two tiles' edge pixels
    const edgeLon = (328 / 2048) * 360 - 180;
    assert.ok(Math.abs(t.elevAt(47.6, edgeLon) - 255.5) < 1e-3, String(t.elevAt(47.6, edgeLon)));
  });

  await test('terrain tiles: the finest level that has a place wins; a missing fine tile only costs detail', async () => {
    const byZoom = (url) => Promise.resolve(flatTile(Number(/terrarium\/(\d+)\//.exec(url)[1])));
    const near = { south: 47.59, north: 47.61, west: -122.34, east: -122.32 };
    const wide = { south: 47.3, north: 47.9, west: -122.8, east: -121.9 };
    const t = await M.loadTerrainLevels([{ z: 12, boxes: [near] }, { z: 10, boxes: [wide] }], byZoom);
    assert.strictEqual(t.elevAt(47.6, -122.33), 12);
    assert.strictEqual(t.elevAt(47.4, -122.0), 10);
    assert.ok(Number.isNaN(t.elevAt(40, -100)));
    // far from the middle of the area the exact Mercator formula takes over
    const far = await M.loadTerrainLevels([{ z: 6, boxes: [{ south: 30, north: 60, west: -130, east: -100 }] }], byZoom);
    assert.strictEqual(far.elevAt(31, -120), 6);
    assert.strictEqual(far.elevAt(59, -120), 6);
    const noFine = (url) => (/\/12\//.test(url) ? Promise.resolve(null) : byZoom(url));
    const t2 = await M.loadTerrainLevels([{ z: 12, boxes: [near] }, { z: 10, boxes: [wide] }], noFine);
    assert.strictEqual(t2.elevAt(47.6, -122.33), 10);
    assert.strictEqual(t2.failed, 0, 'only the coarsest level counts as failed');
    const none = await M.loadTerrainLevels([{ z: 12, boxes: [near] }, { z: 10, boxes: [wide] }], () => Promise.reject(new Error('offline')));
    assert.ok(none.total > 0 && none.failed === none.total);
    assert.ok(Number.isNaN(none.elevAt(47.6, -122.33)));
  });

  await test('terrain tiles: fetched once per session, failures retried', async () => {
    let calls = 0, fail = true;
    const loader = () => { calls++; return Promise.resolve(fail ? null : flatTile(5)); };
    const box = { south: 47.59, north: 47.61, west: -122.34, east: -122.32 };
    await M.loadTerrain(box, 12, loader);
    const first = calls;
    fail = false;
    const t = await M.loadTerrain(box, 12, loader);
    assert.strictEqual(calls, first * 2, 'failed tiles are asked for again');
    assert.strictEqual(t.elevAt(47.6, -122.33), 5);
    await M.loadTerrain(box, 12, loader);
    assert.strictEqual(calls, first * 2, 'loaded tiles are not');
  });

  await test('terrain plan: zoom 12 at each repeater, zoom 11 around them, zoom 10 to the radius', () => {
    const plan = M.terrainPlan(two, M.CONFIG.modes.repeater);
    assert.deepStrictEqual(plan.map((l) => l.z), [12, 11, 10]);
    assert.strictEqual(plan[0].boxes.length, 2);
    const km = (b) => (b.north - b.south) * 111.32;
    assert.ok(Math.abs(km(plan[0].boxes[0]) - 3) < 0.01, 'a 1.5 km margin');
    assert.ok(Math.abs(km(plan[1].boxes[0]) - (30 + (47.62 - 47.55) * 111.32)) < 0.01);
    assert.ok(Math.abs(km(plan[2].boxes[0]) - (120 + (47.62 - 47.55) * 111.32)) < 0.3);
    // the ground view's detail tiles are the same ones, so they are reused
    assert.deepStrictEqual(M.terrainPlan(two, M.CONFIG.modes.ground).slice(0, 2), plan.slice(0, 2));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
