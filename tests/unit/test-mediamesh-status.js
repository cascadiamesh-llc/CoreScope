/* Unit tests for public/mediamesh-status.js: "Is MediaMesh up?". */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-status.js'));
const S = globalThis.MediaMeshStatus;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

console.log('\n=== Is MediaMesh up? ===');

test('quiet: four of its usual gaps, between 30 minutes and 6 hours', () => {
  assert.strictEqual(S.quietAfterMin(1440), 30, 'a packet a minute: 30 minutes');
  assert.strictEqual(S.quietAfterMin(24), 240, 'one an hour: 4 hours');
  assert.strictEqual(S.quietAfterMin(2), 360, 'rare: at most 6 hours');
  assert.strictEqual(S.quietAfterMin(0), 360);
  const now = Date.parse('2026-11-22T12:00:00Z');
  assert.strictEqual(S.quietState({ last_heard: '2026-11-22T11:50:00Z', relay_count_24h: 700 }, now).quiet, false);
  const q = S.quietState({ last_heard: '2026-11-22T11:00:00Z', relay_count_24h: 700 }, now);
  assert.ok(q.quiet && q.age === 60 && q.since === Date.parse('2026-11-22T11:00:00Z'));
  assert.strictEqual(S.quietState({ last_heard: '2026-11-22T11:00:00Z', relay_count_24h: 10 }, now).quiet, false, 'a quiet repeater by nature');
  assert.strictEqual(S.quietState(null, now), null, 'no record: left out');
  assert.strictEqual(S.quietState({}, now), null);
});

test('pieces and the repeaters whose loss alone would split them', () => {
  // 0-1-2 a chain, 2-3-4 a triangle, 5 unlinked
  const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [2, 4]];
  const all = [true, true, true, true, true, true];
  assert.deepStrictEqual(S.pieces(6, edges, all), [[0, 1, 2, 3, 4]], 'an unlinked repeater is no piece');
  assert.deepStrictEqual(S.singlePoints(6, edges, all), [1, 2]);
  const no2 = [true, true, false, true, true, true];
  assert.deepStrictEqual(S.pieces(6, edges, no2).map((p) => p.length), [2, 2]);
  assert.deepStrictEqual(S.singlePoints(6, [[0, 1], [1, 2], [2, 0]], all), [], 'a ring has none');
});

test('links heard: backbone hops and observers, once a pair, by key prefix', () => {
  const placed = [{ public_key: 'aaaaaaaa11' }, { public_key: 'bbbbbbbb22' }, { public_key: 'cccccccc33' }];
  const e = S.heardEdges(placed, [{ a: 'aaaaaaaa99', b: 'BBBBBBBB00' }, { a: 'bbbbbbbb', b: 'aaaaaaaa' }], [{ from: 'cccccccc', observer_id: 'aaaaaaaaFF' }, { from: 'dddddddd', observer_id: 'aaaaaaaa' }]);
  assert.deepStrictEqual(e, [[0, 1], [0, 2]]);
});

test('places: two up, one up, or cut off with the nearest that still works', () => {
  const cov = { width: 4, height: 1, bounds: { north: 47.61, south: 47.6, west: -122.4, east: -122.36 }, rasters: [
    { row0: 0, col0: 0, w: 2, h: 1, data: new Int16Array([50, 50]) },
    { row0: 0, col0: 0, w: 1, h: 1, data: new Int16Array([30]) },
    { row0: 0, col0: 3, w: 1, h: 1, data: new Int16Array([40]) },
  ] };
  const placed = [
    { name: 'A', near: 'First Hill, Seattle', lat: 47.605, lon: -122.395 },
    { name: 'B', near: 'Capitol Hill, Seattle', lat: 47.605, lon: -122.385 },
    { name: 'C', near: 'Georgetown, Seattle', lat: 47.605, lon: -122.365 },
  ];
  const up = [true, true, false];
  const list = S.placeStatus(cov, placed, up, S.reachCounts(cov, up));
  const by = Object.fromEntries(list.map((p) => [p.area, p]));
  assert.strictEqual(by['First Hill'].state, 'up');
  assert.strictEqual(by['Capitol Hill'].state, 'weak');
  assert.strictEqual(by.Georgetown.state, 'down');
  assert.strictEqual(by.Georgetown.nearest.index, 1, 'the nearest repeater that is up');
  assert.strictEqual(list[0].area, 'Georgetown', 'cut off first');
  const html = S.placesHtml(list, placed);
  assert.ok(html.includes('Cut off') && html.includes('Nearest that still works: B') && html.includes('Through A, B'), html);
});

test('the banner and the tiles', () => {
  const now = Date.parse('2026-11-22T18:30:00Z');
  assert.ok(S.bannerHtml([], [], now).includes('Waiting'));
  assert.ok(S.bannerHtml([{}], [{ quiet: false, since: now }], now).includes('All 1 MediaMesh repeaters heard recently'));
  const b = S.bannerHtml([{}, {}], [{ quiet: true, since: now - 3600000 }, { quiet: false, since: now }], now);
  assert.ok(b.includes('role="alert"') && b.includes('1 of 2 MediaMesh repeaters has gone quiet'), b);
  const t = S.tilesHtml({ upCount: 19, known: 22, pieces: [[0, 1]], spof: [1], placed: [{ name: 'A' }, { name: 'Sky <1>' }], km2Now: 231, km2All: 273 });
  assert.ok(t.includes('19 of 22') && t.includes('One piece') && t.includes('231 km²') && t.includes('of 273') && t.includes('Sky &lt;1&gt;'), t);
});

test('wiring: the page, the script, the link from the MediaMesh tab, colours from variables', () => {
  assert.ok(pub('index.html').includes('<script src="mediamesh-status.js?v=__BUST__"></script>'));
  assert.ok(pub('app.js').includes("'mediamesh-status': 'Is MediaMesh up?'"));
  assert.ok(pub('analytics.js').includes('href="#/mediamesh-status"'));
  const css = pub('style.css').match(/\.mms-[^{]*\{[^}]*\}/g) || [];
  assert.ok(css.length > 15);
  for (const r of css) assert.ok(!/(^|[;{\s])(color|background):\s*#/i.test(r), 'a fixed colour: ' + r.slice(0, 60));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
