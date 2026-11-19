/* Unit tests for public/mediamesh-observer.js: MediaMesh on an observer's page. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-observer.js'));
const O = globalThis.MediaMeshObserver;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

console.log('\n=== MediaMesh on an observer\'s page ===');
const ID = '1EA5E1952C937A55151D6FC48BC8C1FD5604FB045CB184DF71477B4E257D8AE1';
const data = {
  observers: [
    { id: ID.toLowerCase(), name: 'First Hill', mediamesh_observations: 2644, total_observations: 27258, share_pct: 9.7, last_heard: '2026-11-19T19:00:00Z', runs_mediamesh: true },
    { id: 'aa', name: 'Other', mediamesh_observations: 0, total_observations: 5, share_pct: 0, last_heard: '' },
  ],
  repeaters: [{ public_key: ID.toLowerCase(), name: 'First Hill', lat: 47.60992, lon: -122.32489, radio: '911.15,250,7,5' }],
  links: [
    { from: 'fbfbfbfbc1f0', from_name: 'Rainier <View>', from_role: 'repeater', from_lat: 47.502494, from_lon: -122.254413, observer_id: ID.toLowerCase(), count: 40, avg_snr: 3.25, avg_rssi: -101.4, last_heard: '2026-11-19T18:50:00Z' },
    { from: 'fba9fe1285ad', from_name: 'N1TJT', from_lat: 47.6238, from_lon: -122.3165, observer_id: ID.toLowerCase(), count: 120, avg_snr: -4.5, avg_rssi: -118, last_heard: '2026-11-19T18:59:00Z' },
    { from: 'zz', observer_id: 'someone-else', count: 999 },
  ],
};
const obs = { id: ID, radio_history: [{ radio: '910.525,62.5,7,7', last_seen: '2026-11-19' }, { radio: '911.15,250,7,5', radio_id: 'radio2', last_seen: '2026-11-19' }] };

test('the view: its row, its own links busiest first, its repeater and radio2', () => {
  const v = O.viewOf(data, obs, ID);
  assert.strictEqual(v.row.name, 'First Hill');
  assert.deepStrictEqual(v.links.map((l) => l.from), ['fba9fe1285ad', 'fbfbfbfbc1f0']);
  assert.strictEqual(v.rep.name, 'First Hill');
  assert.strictEqual(v.radio2, '911.15,250,7,5');
  assert.strictEqual(O.radioText(v.radio2), '911.150 MHz · SF7 · BW 250 kHz');
  assert.strictEqual(O.radioText(''), '');
});

test('nothing to do with MediaMesh: no section', () => {
  assert.strictEqual(O.viewOf(data, { id: 'aa' }, 'aa'), null);
  assert.strictEqual(O.viewOf(data, { id: 'nobody' }, 'nobody'), null);
  assert.strictEqual(O.viewOf({}, {}, ''), null);
  // radio2 in its history is enough
  assert.ok(O.viewOf({}, { id: 'bb', radio_history: [{ radio: '911.15,250,7,5', radio_id: 'radio2' }] }, 'bb'));
});

test('the section: what it listens on, the numbers, who it hears, escaped', () => {
  const html = O.sectionHtml(O.viewOf(data, obs, ID), { now: Date.parse('2026-11-19T19:05:00Z'), rangeLabel: 'in the last 7 days' });
  assert.ok(html.includes('MediaMesh observer') && html.includes('911.150 MHz · SF7 · BW 250 kHz'));
  assert.ok(html.includes('2,644') && html.includes('9.7%') && html.includes('of 27,258 packets') && html.includes('5 min ago'));
  assert.ok(html.includes('Rainier &lt;View&gt;') && !html.includes('Rainier <View>'));
  assert.ok(html.includes('−4.5 dB') && html.includes('−118 dBm') && html.includes('#/nodes/fba9fe1285ad'));
  assert.ok(/12\.\d km|13 km/.test(html), 'distance to Rainier View');
  assert.ok(html.includes('id="mmObsMap"') && html.includes('id="mmObsRepeater"'));
  // not listening itself, nothing heard straight: says so, no map
  const quiet = O.sectionHtml({ row: { mediamesh_observations: 3, total_observations: 10, share_pct: 30 }, links: [], rep: null, radio2: '' }, { rangeLabel: 'in the last 24 hours' });
  assert.ok(quiet.includes('Hears MediaMesh') && quiet.includes("Doesn't report radio2 on") && !quiet.includes('mmObsMap'));
  assert.ok(quiet.includes('Nothing heard straight on radio2 in the last 24 hours.'));
});

test('wiring and readable colours', () => {
  assert.ok(pub('index.html').includes('<script src="mediamesh-observer.js?v=__BUST__"></script>'));
  const d = pub('observer-detail.js');
  assert.ok(d.includes('<div id="obsMediaMesh" class="mm-obs-wrap" hidden></div>') && d.includes('MediaMeshObserver.load('));
  const css = pub('style.css').match(/\.mm-obs-[^{]*\{[^}]*\}/g) || [];
  assert.ok(css.length > 10);
  for (const r of css) assert.ok(!/(^|[;{\s])(color|background):\s*#/i.test(r), 'a fixed colour: ' + r.slice(0, 60));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
