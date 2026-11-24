/* Unit tests for public/mediamesh-lab.js: MediaMeshLab. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-lab.js'));
const L = globalThis.MediaMeshLab;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

console.log('\n=== MediaMeshLab ===');

// a ring 0-1-2-3-0 with a tail 3-4
const adj = L.adjacency(5, [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [1, 1]]);
const all = [true, true, true, true, true];

test('hops and routes between repeaters', () => {
  assert.deepStrictEqual(L.hopsFrom(adj, all, 0), [0, 1, 2, 1, 2]);
  assert.deepStrictEqual(L.hopsFrom(adj, [true, true, true, false, true], 0), [0, 1, 2, -1, -1]);
  const r = L.routes(adj, all, all);
  assert.deepStrictEqual(r, { pairs: 10, ok: 10, medianHops: 2 });
  const cut = L.routes(adj, [true, true, true, false, true], [true, true, true, false, true]);
  assert.strictEqual(cut.pairs, 6);
  assert.strictEqual(cut.ok, 3, 'the tail is cut off');
});

test('path hashes: a repeater only when exactly one starts so', () => {
  const placed = [{ public_key: '1ea5e195aa' }, { public_key: '1ffbd69abb' }, { public_key: 'fc1ce02acc' }];
  assert.strictEqual(L.hopIndex(placed, '1EA5'), 0);
  assert.strictEqual(L.hopIndex(placed, '1F'), 1);
  assert.strictEqual(L.hopIndex(placed, '1'), -1, 'more than one');
  assert.strictEqual(L.hopIndex(placed, 'abcd'), -1);
});

test('a clip replayed: as it went, the other way round, or lost and why', () => {
  const placed = ['aa', 'bb', 'cc', 'dd', 'ee'].map((k) => ({ public_key: k + '000000', name: k.toUpperCase() }));
  const clip = { path: ['AA', 'BB', 'CC'], hops: 3 };
  assert.deepStrictEqual(L.replayClip(clip, placed, adj, all), { ok: true, hops: 3, way: [0, 1, 2], reason: '' });
  const round = L.replayClip(clip, placed, adj, [true, false, true, true, true]);
  assert.deepStrictEqual(round, { ok: true, hops: 3, way: [0, 3, 2], reason: 'rerouted' });
  assert.ok(L.reasonText(round, placed, clip).includes('AA → DD → CC'));
  assert.strictEqual(L.replayClip(clip, placed, adj, [false, true, true, true, true]).reason, 'first-down');
  assert.strictEqual(L.replayClip(clip, placed, adj, [true, true, false, true, true]).reason, 'last-down');
  assert.strictEqual(L.replayClip({ path: ['AA', 'DD', 'EE'] }, placed, adj, [true, true, true, false, true]).reason, 'no-way');
  const unk = L.replayClip({ path: ['AA', 'ZZ'], hops: 2 }, placed, adj, all);
  assert.strictEqual(unk.ok, null);
  assert.ok(L.reasonText(unk, placed, { path: ['AA', 'ZZ'] }).includes("can't tell"));
});

test('repeaters that could join: not on MediaMesh, repeaters only, by name, those without a position marked', () => {
  const nodes = [
    { public_key: 'BB22aa', name: 'Zed Hill', role: 'repeater', lat: 47.6, lon: -122.3 },
    { public_key: 'aa11ff', name: 'On MediaMesh', role: 'repeater', lat: 47.5, lon: -122.2 },
    { public_key: 'cc33', name: 'Alpha <Ridge>', role: 'repeater', lat: null, lon: null },
    { public_key: 'dd44', name: 'Somebody', role: 'companion', lat: 47.6, lon: -122.3 },
    { public_key: 'ee55', name: 'Null Island', role: 'repeater', lat: 0, lon: 0 },
  ];
  const c = L.candidates(nodes, ['AA11FF']);
  assert.deepStrictEqual(c.map((r) => [r.name, r.placed]), [['Alpha <Ridge>', false], ['Null Island', false], ['Zed Hill', true]]);
  const h = L.candidatesHtml(c, 'a');
  assert.strictEqual((h.match(/data-mml-add=/g) || []).length, 1, 'only one with a position can be picked');
  assert.ok(h.includes('data-mml-add="BB22aa"') && h.includes('Alpha &lt;Ridge&gt;') && !h.includes('<Ridge>') && h.includes('no position'));
  assert.ok(L.candidatesHtml([], '<x>').includes('&lt;x&gt;'), 'the query is escaped');
  assert.deepStrictEqual(L.candidates(null, []), []);
});

test('the page finds repeaters by name and adds one at its own position', () => {
  const src = pub('mediamesh-lab.js');
  assert.ok(src.includes("'/api/nodes?role=repeater&limit=25&search='"));
  assert.ok(src.includes('id="mmlFind"') && src.includes('placePlan(r.lat, r.lon, { name: r.name, public_key: r.public_key })'));
  assert.ok(src.includes('placePlan(planned.lat, planned.lon, planned.as)'), 'a new height keeps it');
});

test('wiring: the page, the script, the link from the MediaMesh tab, colours from variables', () => {
  assert.ok(pub('index.html').includes('<script src="mediamesh-lab.js?v=__BUST__"></script>'));
  assert.ok(pub('app.js').includes("'mediamesh-lab': 'MediaMeshLab'"));
  assert.ok(pub('analytics.js').includes('href="#/mediamesh-lab"'));
  const css = pub('style.css').match(/\.mml-[^{]*\{[^}]*\}/g) || [];
  assert.ok(css.length > 15);
  for (const r of css) assert.ok(!/(^|[;{\s])(color|background):\s*#/i.test(r), 'a fixed colour: ' + r.slice(0, 60));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
