/* Unit tests for public/mediamesh-live.js: live packets on the MediaMesh map. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-live.js'));
const M = globalThis.MediaMeshLive;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

console.log('\n=== MediaMesh live packets ===');

const reps = [
  { public_key: 'AA11bb', name: 'Myrtle Reservoir 🌊', lat: 47.53, lon: -122.29 },
  { public_key: 'aa22cc', name: 'First Hill 🏙️', lat: 47.61, lon: -122.32 },
  { public_key: 'bb33dd', name: 'Kremwerk', lat: 47.615, lon: -122.33 },
  { public_key: 'cc44ee', name: 'No position' },
];
const links = [{ observer_id: 'FF99', observer_name: 'Rainier View', to_lat: 47.51, to_lon: -122.26 }];
const idx = M.buildIndex(reps, links);

test('colours: hex and rgb() both read', () => {
  assert.deepStrictEqual(M.rgbOf('#7cd991'), [124, 217, 145]);
  assert.deepStrictEqual(M.rgbOf(' #fff'), [255, 255, 255]);
  assert.deepStrictEqual(M.rgbOf('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.strictEqual(M.rgbOf('nope'), null);
});

test('index: placed repeaters by key, observers from the links', () => {
  assert.strictEqual(idx.reps.length, 3);
  assert.ok(idx.byKey.has('aa11bb'));
  assert.strictEqual(idx.byKey.get('ff99').name, 'Rainier View');
});

test('a path: resolved keys first, unique prefixes, then the observer', () => {
  const p = M.placePath(['bb', 'AA11'], [null, null], 'ff99', idx);
  assert.deepStrictEqual(p.map((x) => x.name), ['Kremwerk', 'Myrtle Reservoir 🌊', 'Rainier View']);
  const q = M.placePath(['zz', 'aa'], ['aa22cc', null], '', idx);
  assert.deepStrictEqual(q.map((x) => x.name), ['First Hill 🏙️']);
});

test('an observer already on the path is not added again', () => {
  const p = M.placePath(['aa11', 'bb'], null, 'aa11bb', idx);
  assert.deepStrictEqual(p.map((x) => x.name), ['Myrtle Reservoir 🌊', 'Kremwerk']);
});

test('an ambiguous prefix takes the repeater nearest the hop before', () => {
  const p = M.placePath(['bb', 'aa'], null, '', idx);
  assert.deepStrictEqual(p.map((x) => x.name), ['Kremwerk', 'First Hill 🏙️']);
  // with nothing before it, an ambiguous first hop is left out
  assert.deepStrictEqual(M.placePath(['aa'], null, '', idx), []);
});

test('route text shortens long routes and keeps the emojis', () => {
  const pts = ['A 🌊', 'B', 'C', 'D 🏙️'].map((name) => ({ name, lat: 0, lon: 0 }));
  assert.strictEqual(M.routeText(pts.slice(0, 3)), 'A 🌊 → B → C');
  assert.strictEqual(M.routeText(pts), 'A 🌊 → … → D 🏙️');
});

const pts3 = [{ name: 'A', lat: 47.5, lon: -122.3 }, { name: 'B', lat: 47.55, lon: -122.3 }, { name: 'C', lat: 47.6, lon: -122.3 }];

test('tracker: one transfer per key, judged once quiet, whole when every piece heard', () => {
  const T = M.createTracker();
  const day = new Date(2026, 10, 22, 12).getTime();
  const m1 = T.note({ key: 'sid|1', kind: 'photo', pts: pts3, hash: 'h1', index: 0, total: 2 }, day);
  assert.strictEqual(m1[0].title, 'First photo of the day');
  T.note({ key: 'sid|1', kind: 'photo', pts: pts3, hash: 'h2', index: 1, total: 2 }, day + 500);
  assert.strictEqual(T.count(day + 1000), 2);
  assert.strictEqual(T.judge(day + 2000).length, 0);
  const done = T.judge(day + 9000);
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].outcome.outcome, 'whole');
  const h = M.transferHtml(done[0], day + 9000);
  assert.ok(h.includes('heard whole at C'), h);
  // a second photo that day is no longer the first
  assert.strictEqual(T.note({ key: 'sid|2', kind: 'photo', pts: pts3, hash: 'h3', index: 0, total: 1 }, day + 20000).length, 0);
});

test('tracker: parity pieces make up for lost ones', () => {
  const T = M.createTracker();
  const t = Date.now();
  T.note({ key: 'k', kind: 'video', pts: pts3, hash: 'a', index: 0, total: 3, seconds: 4 }, t);
  T.note({ key: 'k', kind: 'video', pts: pts3, hash: 'b', index: 2, total: 3 }, t + 10);
  T.note({ key: 'k', kind: 'video', pts: pts3, hash: 'c', index: 0, parity: true, total: 3 }, t + 20);
  const o = T.judge(t + 9000)[0];
  assert.strictEqual(o.outcome.outcome, 'parity');
  assert.ok(M.transferHtml(o, t + 9000).includes('rebuilt from parity'));
  assert.ok(M.transferHtml(o, t + 9000).startsWith('<li class="mmlive-item mmlive-item--done">'));
});

test('tracker: the longest route today, once beaten', () => {
  const T = M.createTracker();
  const t = new Date(2026, 10, 22, 9).getTime();
  T.note({ key: 'a', kind: 'voice', pts: pts3, hash: 'x' }, t);
  const far = pts3.concat([{ name: 'D', lat: 47.7, lon: -122.3 }]);
  const m = T.note({ key: 'b', kind: 'voice', pts: far, hash: 'y' }, t + 60000);
  assert.ok(m.some((x) => x.title === 'Longest route today' && x.sub.includes('3 hops')), JSON.stringify(m));
});

test('unannounced clips and names are escaped in the list', () => {
  const T = M.createTracker();
  T.note({ key: 'z', kind: 'clip', pts: [{ name: '<b>', lat: 0, lon: 0 }, { name: 'Y', lat: 1, lon: 1 }], hash: 'q' }, Date.now());
  const h = M.transferHtml(T.list(1)[0], Date.now());
  assert.ok(h.includes('Media · &lt;b&gt; → Y'), h);
  assert.ok(h.includes('mmlive-dot--clip'));
});

test('clipFor uses live.js\'s parsing and learns the kind from announcements', () => {
  globalThis._liveMediaMesh = {
    clipOf: (t, p) => (t === 'RAW_CUSTOM' ? { sid: p.raw.slice(2, 10), talk: false, index: 3 } : null),
    transferKey: (sid) => 'sid|' + sid,
    paritySid: (sid) => (sid === '22222222' ? '11111111' : 'ffffffff'),
  };
  const ann = new Map([['11111111', { sid: '11111111', kind: 'photo', total: 9, seconds: 0 }]]);
  const c = M.clipFor('RAW_CUSTOM', { raw: '561111111103' }, [], 'h', 0, ann, false);
  assert.deepStrictEqual(c, { key: 'sid|11111111', kind: 'photo', seconds: 0, index: 3, parity: false, total: 9 });
  const p = M.clipFor('RAW_CUSTOM', { raw: '562222222203' }, [], 'h', 0, ann, false);
  assert.strictEqual(p.parity, true);
  assert.strictEqual(p.key, 'sid|11111111');
  assert.strictEqual(M.clipFor('TXT_MSG', {}, [], 'h', 0, ann, false), null);
  delete globalThis._liveMediaMesh;
});

test('reading a WebSocket packet', () => {
  const r = M.readPacket({ decoded: { header: { payloadTypeName: 'GRP_DATA' }, payload: { text: 'hi' }, path: { hops: ['AA'] } }, observer_id: 'ff', hash: 'h', mediamesh: true });
  assert.deepStrictEqual([r.typeName, r.hops, r.observer, r.mediamesh, r.text], ['GRP_DATA', ['AA'], 'ff', true, 'hi']);
});

test('wired in: script, the legend toggle, the coverage map, live.js exports and theme colours', () => {
  assert.ok(pub('index.html').includes('mediamesh-live.js'));
  assert.ok(pub('analytics.js').includes('id="mmCovLiveToggle"'));
  assert.ok(pub('mediamesh-coverage.js').includes('MediaMeshLive.attach'));
  assert.ok(/liveClip:.*mediaMeshLiveClip/.test(pub('live.js')));
  assert.ok(/paritySid:.*mediaMeshParitySid/.test(pub('live.js')));
  const css = pub('style.css');
  assert.strictEqual((css.match(/--mmlive-video:/g) || []).length, 3, 'light and both dark themes');
  const rules = css.split('}').filter((r) => /\.mmlive-[\w-]*[^{]*\{/.test(r));
  for (const r of rules) assert.ok(!/(^|[;{\s])(color|background|fill|border|box-shadow)[\w-]*:\s*[^;]*(#[0-9a-f]{3,6}|rgba?\()/i.test(r.split('{')[1] || ''), 'a fixed colour: ' + r.slice(0, 80));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
