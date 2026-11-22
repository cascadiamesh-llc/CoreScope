/* Unit tests for public/mediamesh-grow.js: Grow the mesh. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-grow.js'));
const G = globalThis.MediaMeshGrow;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

console.log('\n=== Grow the mesh ===');

// a grid of 10 cells: 0-3 reached once today, 4 twice, 5-9 not; 8-9 water
const base = { count: Uint8Array.from([1, 1, 1, 1, 2, 0, 0, 0, 0, 0]), water: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]), cellKm2: 1 };
const c = (lat, cells, people, bridges) => ({ lat, lon: -122.3, cells: Int32Array.from(cells), people, links: [], bridges: new Set(bridges || []) });

test('one move after another, each against the mesh with the ones before', () => {
  const cands = [
    c(47.50, [5, 6, 7], [{ cell: 5, n: 1000 }, { cell: 6, n: 500 }]),
    c(47.60, [5, 6], [{ cell: 5, n: 1000 }, { cell: 6, n: 500 }]), // the same people: worth nothing after the first
    c(47.70, [0, 1, 2, 3], [], ['Skyline']),
    c(47.80, [8, 9], [{ cell: 9, n: 200 }]),
  ];
  const people = G.greedy(base, cands, 'people', 5, new Set(['Skyline']));
  assert.deepStrictEqual(people.map((p) => p.index), [0, 3], 'a move that adds nothing is no move');
  assert.deepStrictEqual(people[0].gain, { people: 1500, km2: 3, twice: 0, water: 0, closes: [] });
  assert.strictEqual(G.greedy(base, cands, 'twice', 1)[0].index, 2, 'covered twice: four cells reached once');
  assert.strictEqual(G.greedy(base, cands, 'water', 1)[0].index, 3);
  const spof = G.greedy(base, cands, 'spof', 1, new Set(['Skyline']));
  assert.deepStrictEqual([spof[0].index, spof[0].gain.closes], [2, ['Skyline']]);
});

test('never two moves within 3 km', () => {
  const near = [c(47.60, [5], [{ cell: 5, n: 9 }]), c(47.601, [6], [{ cell: 6, n: 8 }]), c(47.70, [7], [{ cell: 7, n: 1 }])];
  assert.deepStrictEqual(G.greedy(base, near, 'people', 3).map((p) => p.index), [0, 2]);
});

test('main-mesh repeaters that could turn radio2 on', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const box = { south: 47.4, north: 47.8, west: -122.5, east: -122.1 };
  const nodes = [
    { public_key: 'AA', role: 'repeater', lat: 47.6, lon: -122.3, last_heard: '2026-11-22T11:00:00Z', relay_count_24h: 10 },
    { public_key: 'BB', role: 'repeater', lat: 47.65, lon: -122.3, last_heard: '2026-11-22T11:00:00Z', relay_count_24h: 900 },
    { public_key: 'CC', role: 'repeater', lat: 47.65, lon: -122.3, last_heard: '2026-11-10T11:00:00Z', relay_count_24h: 900 },
    { public_key: 'DD', role: 'repeater', lat: 48.5, lon: -122.3, last_heard: '2026-11-22T11:00:00Z' },
    { public_key: 'EE', role: 'repeater', lat: 47.5, lon: -122.3, last_heard: '2026-11-22T11:00:00Z' },
    { public_key: 'FF', role: 'repeater', lat: 47.7001, lon: -122.3, last_heard: '2026-11-22T11:00:00Z' },
  ];
  const got = G.upgradeCandidates(nodes, new Set(['ee']), box, now, { near: [{ lat: 47.7, lon: -122.3 }] });
  assert.deepStrictEqual(got.map((n) => n.public_key), ['BB', 'AA'], 'busiest first; not stale, outside, on MediaMesh already, or next to one');
});

test('a move, and wiring', () => {
  const html = G.moveHtml({ gain: { people: 1234, km2: 5.5, twice: 2, water: 1, closes: ['Sky <1>'] } }, 0,
    { node: { public_key: 'abc', name: 'Beacon <Hill>' }, links: [{ rep: { name: 'SoDo' } }], lat: 47.6, lon: -122.3 }, 'people');
  assert.ok(html.includes('Beacon &lt;Hill&gt;') && html.includes('Already up: turn radio2 on') && html.includes('+1,234') && html.includes('goes round Sky &lt;1&gt;') && html.includes('href="#/nodes/abc"'), html);
  const spot = G.moveHtml({ gain: { people: 0, km2: 1, twice: 0, water: 0, closes: [] } }, 1, { links: [], lat: 47.61234, lon: -122.31234, e: 120, place: 'Beacon Hill, Seattle' }, 'water');
  assert.ok(spot.includes('New repeater') && spot.includes('#/mediamesh-lab?lat=47.61234&amp;lon=-122.31234') && spot.includes('stand on its own'), spot);
  assert.ok(pub('index.html').includes('<script src="mediamesh-grow.js?v=__BUST__"></script>'));
  assert.ok(pub('app.js').includes("'mediamesh-grow': 'Grow the mesh'"));
  assert.ok(pub('analytics.js').includes('href="#/mediamesh-grow"'));
  assert.ok(pub('mediamesh-lab.js').includes("q.get('lat')"), 'the lab starts from a spot');
  const css = pub('style.css').match(/\.mmg-[^{]*\{[^}]*\}/g) || [];
  assert.ok(css.length > 15);
  for (const r of css) assert.ok(!/(^|[;{\s])(color|background):\s*#/i.test(r), 'a fixed colour: ' + r.slice(0, 60));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
