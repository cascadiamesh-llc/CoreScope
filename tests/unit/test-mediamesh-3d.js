/* Unit tests for public/mediamesh-3d.js: the coverage in 3D. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-3d.js'));
const D = globalThis.MediaMesh3D;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}
console.log('\n=== MediaMesh coverage in 3D ===');

const cov = { bounds: { north: 47.7, south: 47.5, west: -122.45, east: -122.2 }, width: 10, height: 8, margins: new Float32Array(80).fill(-Infinity) };
cov.margins[0] = 20; cov.margins[79] = -3;

test('terrain grid: capped size, keeps the aspect, samples terrain and coverage', () => {
  const g = D.terrainGrid(cov, (lat, lon) => (lat > 47.69 && lon < -122.44 ? 100 : (lat < 47.51 ? NaN : 0)), 50);
  assert.strictEqual(Math.max(g.nx, g.ny), 50);
  assert.ok(Math.abs(g.nx / g.ny - g.widthM / g.depthM) < 0.1, 'about square cells');
  assert.strictEqual(g.elev[0], 100);
  assert.ok(Number.isNaN(g.elev[g.elev.length - 1]), 'no data stays no data');
  assert.strictEqual(g.margin[0], 20);
  assert.ok(Number.isNaN(g.margin[g.margin.length - 1]), 'below 0 dB is not coverage');
});

test('height exaggeration: flat cities lifted, mountains kept in bounds', () => {
  const g = { widthM: 20000, depthM: 20000, elev: new Float32Array([0, 50]) };
  assert.strictEqual(D.exaggeration(g), 8);
  g.elev[1] = 4000;
  assert.strictEqual(D.exaggeration(g), 1.5);
});

test('colours: water, land and coverage', () => {
  assert.deepStrictEqual(D.vertexColor(0, 0, NaN), D.PALETTE.water);
  assert.deepStrictEqual(D.vertexColor(NaN, 0, 20), D.PALETTE.water);
  const land = D.vertexColor(50, 0, NaN), covered = D.vertexColor(50, 0, 25);
  assert.ok(covered[0] > land[0] && covered[2] > land[2], 'coverage tints toward pink');
});

test('labels: busiest on the backbone first, at most n, named only', () => {
  const reps = [{ name: 'A', public_key: 'a' }, { name: '', public_key: 'x' }, { name: 'B', public_key: 'b' }, { name: 'C', public_key: 'c' }];
  const out = D.labelled(reps, [{ a: 'c', b: 'x', packets: 50 }, { a: 'b', b: 'c', packets: 5 }], 2);
  assert.deepStrictEqual(out.map((r) => r.name), ['C', 'B']);
  assert.deepStrictEqual(D.labelled(reps, [], 5).map((r) => r.name), ['A', 'B', 'C']);
});

test('wiring: button on the card, script on the page, three.js vendored and loaded only on demand', () => {
  assert.ok(pub('analytics.js').includes('data-mm-cov-3d disabled'));
  assert.ok(pub('mediamesh-coverage.js').includes('root.MediaMesh3D.open('));
  const html = pub('index.html');
  assert.ok(html.includes('<script src="mediamesh-3d.js?v=__BUST__"></script>'));
  assert.ok(!html.includes('three-0.149.0'), 'not loaded with the page');
  assert.ok(fs.existsSync(path.join(__dirname, '../../public', D.THREE_SRC)));
});

test('3D view text stays light on its own dark scene', () => {
  const css = pub('style.css');
  const rules = css.match(/\.mm3d[^{]*\{[^}]*\}/g) || [];
  assert.ok(rules.length > 10);
  for (const r of rules) {
    for (const m of r.matchAll(/(?:^|[;{\s])color:\s*(#[0-9a-f]{6})/gi)) {
      const v = parseInt(m[1].slice(1), 16), lum = ((v >> 16) * 0.299 + ((v >> 8) & 255) * 0.587 + (v & 255) * 0.114);
      assert.ok(lum > 160, `${m[1]} in ${r.slice(0, 30)}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
