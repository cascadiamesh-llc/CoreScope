/* Unit tests for public/mediamesh-reach.js: the coverage card's address
 * check, best spots, people and comparison. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-coverage.js'));
require(path.join(__dirname, '../../public/mediamesh-reach.js'));
const M = globalThis.MediaMeshCoverage, R = globalThis.MediaMeshReach;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

(async () => {
  console.log('\n=== MediaMesh reach ===');
  M.setCalibration(0);
  // low land with a little relief; a 60 m ridge across at 47.63
  const land = (lat, lon) => 20 + 0.5 * Math.sin(lat * 3000) + 0.5 * Math.cos(lon * 3000) + (lat > 47.628 && lat < 47.632 ? 60 : 0);
  const reps = [{ name: 'Near', lat: 47.6, lon: -122.33 }, { name: 'Far', lat: 47.66, lon: -122.33 }];

  await test('can I join: repeaters best first, a verdict, and a height that would work', () => {
    const rows = R.reachFrom(47.61, -122.33, 1.5, reps, land);
    assert.strictEqual(rows[0].rep.name, 'Near');
    assert.ok(rows[0].margin > rows[1].margin);
    const v = R.verdict(rows, 1.5);
    assert.strictEqual(v.kind, 'yes', JSON.stringify(v));
    assert.ok(/Near with/.test(v.text));
    // behind the ridge, 6 km out at street level: short; higher up helps
    const far = R.reachFrom(47.64, -122.33, 1.5, [reps[0]], land);
    assert.ok(far[0].margin < 0, String(far[0].margin));
    assert.strictEqual(R.verdict(far, 1.5).kind, 'no');
    const fix = R.heightThatWorks(far, 1.5, land, 47.64, -122.33);
    assert.ok(!fix || fix.h > 1.5);
    // a receiver higher up gets more
    const up = R.reachFrom(47.64, -122.33, 20, [reps[0]], land);
    assert.ok(up[0].margin > far[0].margin);
    assert.strictEqual(R.verdict(null, 1.5).kind, 'none');
    assert.strictEqual(R.reachFrom(47.6, -122.33, 1.5, reps, () => NaN), null, 'no terrain there');
    const html = R.joinResultHtml('Capitol <Hill>', 12, rows, v, null);
    assert.ok(html.includes('Capitol &lt;Hill&gt;') && html.includes('4th-floor window') && html.includes('mm-reach-verdict--yes'));
  });

  await test('people: counted in covered cells, by city and Seattle neighbourhood', async () => {
    const cov = await M.computeCoverage([reps[0]], land, 'ground');
    const pts = [[47.601, -122.331, 1000, 'First Hill, Seattle'], [47.602, -122.329, 500, 'Yesler Terrace, Seattle'], [47.9, -122.33, 800, 'Everett, WA'], [47.70, -122.33, 300, 'Northgate, Seattle']];
    const p = R.peopleIn(cov, pts);
    assert.strictEqual(p.reached, 1500);
    const s = R.peopleSummary(p);
    assert.strictEqual(s.cities[0].city, 'Seattle');
    assert.deepStrictEqual([s.cities[0].reached, s.cities[0].total], [1500, 1800]);
    assert.ok(!s.cities.some((c) => c.city === 'Everett'), 'outside the estimate');
    assert.deepStrictEqual(R.splitPlace('Bellevue, WA'), { city: 'Bellevue' });
    assert.deepStrictEqual(R.splitPlace('Capitol Hill, Seattle'), { city: 'Seattle', hood: 'Capitol Hill' });
    assert.deepStrictEqual(R.splitPlace('12 km from Sequim, WA'), { city: '' });
    assert.strictEqual(R.peopleWith(cov, pts, [true]), 1500);
    assert.strictEqual(R.peopleWith(cov, pts, [false]), 0, 'masked out (the past, before it was there)');
    const h = R.peopleHtml(s, 1200);
    assert.ok(h.includes('83%') && h.includes('+300') && h.includes('id="mmPeopleMap"'), h.slice(0, 400));
  });

  await test('best spots: prominent dry high ground, spread out; gain counts only what is new', async () => {
    const hill = (lat, lon) => (lat < 47.5 ? -2 : 20 + 80 * Math.exp(-(((lat - 47.62) * 111) ** 2 + ((lon + 122.25) * 75) ** 2) / 2));
    const spots = R.candidateSpots({ south: 47.45, north: 47.7, west: -122.4, east: -122.15 }, hill, { max: 5 });
    assert.ok(spots.length >= 1);
    assert.ok(Math.abs(spots[0].lat - 47.62) < 0.02 && Math.abs(spots[0].lon + 122.25) < 0.03, JSON.stringify(spots[0]));
    assert.ok(spots.every((s) => s.lat >= 47.5), 'no spots on water');
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
      const d = Math.hypot((spots[i].lat - spots[j].lat) * 111, (spots[i].lon - spots[j].lon) * 75);
      assert.ok(d >= 1.4, 'spread out');
    }
    const shown = await M.computeCoverage([reps[0]], land, 'ground');
    const same = await M.computeCoverage([reps[0]], land, 'quick');
    const g = R.spotGain(same, shown, [[47.601, -122.331, 1000]]);
    assert.ok(g.km2 < 5 && g.people === 0, JSON.stringify(g));
  });

  await test('wiring and readable colours', () => {
    const c = pub('mediamesh-coverage.js');
    assert.ok(c.includes('root.MediaMeshReach.attach(el, {') && c.includes('shownListeners.forEach'));
    assert.ok(pub('index.html').includes('<script src="mediamesh-reach.js?v=__BUST__"></script>'));
    assert.ok(pub('analytics.js').includes('id="mmPeopleCard" hidden'));
    assert.ok(/mainRadio: '910\.525,62\.5,7,5'/.test(c));
    const css = pub('style.css').match(/\.mm-reach[^{]*\{[^}]*\}/g) || [];
    assert.ok(css.length > 20);
    for (const r of css) assert.ok(!/(^|[;{\s])color:\s*#/i.test(r), 'a fixed text colour: ' + r.slice(0, 60));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
