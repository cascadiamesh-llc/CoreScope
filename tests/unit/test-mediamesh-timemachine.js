/* Unit tests for public/mediamesh-timemachine.js: the time machine. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-timemachine.js'));
const T = globalThis.MediaMeshTimeMachine;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

const reps = [
  { public_key: 'aa', name: 'First Hill', lat: 47.6, lon: -122.3, first_seen: '2026-09-01T10:00:00Z' },
  { public_key: 'bb', name: 'Beacon', lat: 47.55, lon: -122.3, first_seen: '2026-10-15 08:00:00' },
  { public_key: 'cc', name: 'Guess', lat: 47.5, lon: -122.2, first_seen: '2026-09-02T00:00:00Z', position_from_name: true },
];
const kept = [
  { day: '2026-11-20', repeaters: [{ k: 'aa', n: 'First Hill', lat: 47.6, lon: -122.3 }], links: [], backbone: [], transmissions: 10, media_packets: 4 },
  { day: '2026-11-18', repeaters: [{ k: 'aa', n: 'First Hill', lat: 47.6, lon: -122.3 }, { k: 'bb', n: 'Beacon', lat: 47.55, lon: -122.3 }], links: [], backbone: [{ a: 'aa', b: 'bb', a_lat: 1, a_lon: 1, b_lat: 2, b_lon: 2, packets: 5 }], transmissions: 20, media_packets: 9 },
];

test('dayOf reads ISO and SQLite times', () => {
  assert.strictEqual(T.dayOf('2026-10-15 08:00:00'), '2026-10-15');
  assert.strictEqual(T.dayOf('2026-09-01T23:30:00Z'), '2026-09-01');
  assert.strictEqual(T.dayOf(''), '');
  assert.strictEqual(T.dayOf('nope'), '');
});

test('dayList runs from the first repeater seen to today', () => {
  const l = T.dayList(kept, reps, '2026-11-22');
  assert.strictEqual(l[0], '2026-09-01');
  assert.strictEqual(l[l.length - 1], '2026-11-22');
  assert.strictEqual(l.length, 83);
  assert.deepStrictEqual(T.dayList([], [], '2026-11-22'), ['2026-11-22']);
});

test('stateOn: kept days as kept, missed days carried, earlier days rebuilt', () => {
  const k = T.stateOn('2026-11-18', kept, reps);
  assert.strictEqual(k.how, 'kept');
  assert.strictEqual(k.repeaters.length, 2);
  const c = T.stateOn('2026-11-19', kept, reps);
  assert.strictEqual(c.how, 'carried');
  assert.strictEqual(c.day, '2026-11-19');
  assert.strictEqual(c.media_packets, 9);
  const r = T.stateOn('2026-10-01', kept, reps);
  assert.strictEqual(r.how, 'rebuilt');
  assert.deepStrictEqual(r.repeaters.map((x) => x.k), ['aa'], 'a guessed position and one not yet seen are left out');
  assert.strictEqual(r.backbone.length, 0);
  assert.strictEqual(T.stateOn('2026-10-15', kept, reps).repeaters.length, 2);
});

test('diff names repeaters added and gone', () => {
  const d = T.diff(T.stateOn('2026-11-18', kept, reps), T.stateOn('2026-11-20', kept, reps));
  assert.deepStrictEqual(d.gone.map((x) => x.k), ['bb']);
  assert.strictEqual(d.added.length, 0);
  assert.deepStrictEqual(d.repeaters, [2, 1]);
  assert.deepStrictEqual(d.backbone, [1, 0]);
});

test('chartSvg marks both days and escapes', () => {
  const s = T.chartSvg(['2026-11-01', '2026-11-02', '2026-11-03'], [1, 2, 3], 0, 2);
  assert.ok(s.includes('<polyline') && s.includes('mmt-chart-a') && s.includes('mmt-chart-b'));
  assert.ok(s.includes('from 2026-11-01 (1) to 2026-11-03 (3)'));
});

test('wiring: the page, the script, the link from the MediaMesh tab, colours from variables', () => {
  assert.ok(pub('index.html').includes('<script src="mediamesh-timemachine.js?v=__BUST__"></script>'));
  assert.ok(pub('app.js').includes("'mediamesh-timemachine': 'Time machine'"));
  assert.ok(pub('analytics.js').includes('href="#/mediamesh-timemachine"'));
  const css = pub('style.css').match(/\.mmt-[^{]*\{[^}]*\}/g) || [];
  assert.ok(css.length > 10);
  for (const r of css) assert.ok(!/(^|[;{\s])(color|background|fill|stroke):\s*#/i.test(r), 'a fixed colour: ' + r.slice(0, 60));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
