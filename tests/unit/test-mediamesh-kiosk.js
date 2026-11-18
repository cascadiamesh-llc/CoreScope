/* Unit tests for kiosk mode, the weekly recap picture and the embeddable widget. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/kiosk.js'));
require(path.join(__dirname, '../../public/mediamesh-recap.js'));
const K = globalThis.MediaMeshKiosk, R = globalThis.MediaMeshRecap;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}
console.log('\n=== Kiosk, recap, widget ===');

test('kiosk: slides join the cycle when ready', () => {
  assert.deepStrictEqual(K.slideList({}), ['board', 'week', 'join']);
  assert.deepStrictEqual(K.slideList({ sky: true, cov: true }), ['sky', '3d', 'board', 'week', 'join']);
});

test('kiosk: hops resolve only when one placed node matches, the same node from two lists once', () => {
  const nodes = [{ public_key: 'AABB01', lat: 47.6, lon: -122.3, name: 'A' }, { public_key: 'aabb01', lat: 47.6, lon: -122.3, name: 'A' }, { public_key: 'aacc', lat: 47.5, lon: -122.2, name: 'C' }, { public_key: 'dd', lat: 0, lon: 0 }];
  const r = K.hopResolver(nodes);
  assert.strictEqual(r('aabb').name, 'A');
  assert.strictEqual(r('aa'), null, 'two nodes');
  assert.strictEqual(r('dd'), null, 'no position');
  const sid = (0x1a2b3c4d).toString(36);
  const ev = K.skyEvents({ announcements: [{ text: 'J: VV1:' + sid + ':1:8:9' }], events: [
    { ts: '2026-11-18T10:00:00Z', path: ['aabb', 'aacc'], raw: '561a2b3c4d00' },
    { ts: '2026-11-18T10:00:01Z', path: ['aabb', 'aacc'], raw: '56' + ((0x1a2b3c4d ^ 0xFEC0FEC0) >>> 0).toString(16) + '00' },
    { ts: '2026-11-18T10:00:02Z', path: ['aabb'], raw: '561a2b3c4d01' },
  ] }, r);
  assert.strictEqual(ev.length, 2, 'one hop is no comet');
  assert.deepStrictEqual(ev.map((e) => [e.kind, e.key, e.seconds]), [['video', 'sid|1a2b3c4d', 9], ['video', 'sid|1a2b3c4d', 9]], 'parity counts as its clip');
});

test('kiosk: board and join slides', () => {
  const b = K.boardHtml({ repeaters: [{ name: 'A <b>', media_relayed_7d: 5 }, { name: 'B', media_relayed_7d: 50 }, { name: 'C', media_relayed_7d: 0 }] });
  assert.ok(b.indexOf('>B<') < b.indexOf('A &lt;b&gt;') && !b.includes('>C<'));
  assert.ok(K.boardHtml({}).includes('No photos'));
  assert.ok(K.joinHtml('https://x/#/a', '<img>').includes('<img>') && K.joinHtml('https://x/#/a', '').includes('https://x/#/a'));
  assert.ok(pub('index.html').includes('<script src="kiosk.js?v=__BUST__"'));
  assert.ok(pub('mediamesh-recap.js').includes('href="#/kiosk"'));
});

test('recap: the week in figures, headline and dates', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const mm = { repeaters: [{ near: 'First Hill, Seattle', first_seen: '2026-11-15T00:00:00Z', lat: 47.6, lon: -122.3 }, { near: 'SoDo, Seattle', first_seen: '2026-10-01T00:00:00Z', lat: 47.5, lon: -122.3 }], backbone: [{ a_lat: 47.6, a_lon: -122.3, b_lat: 47.5, b_lon: -122.3, packets: 4 }] };
  const clip = (kind, at, hops) => ({ kind, at, hops, outcome: 'whole' });
  const d = R.recapData(mm, [clip('photo', '2026-11-17T00:00:00Z', 3), clip('photo', '2026-11-16T00:00:00Z', 6), clip('video', '2026-11-16T00:00:00Z', 2), clip('voice', '2026-11-01T00:00:00Z', 9)], 1275.4, now);
  assert.deepStrictEqual([d.photos, d.videos, d.voice, d.newRepeaters, d.repeaters, d.longestHops, d.where], [2, 1, 0, 1, 2, 6, 'Seattle']);
  assert.strictEqual(R.headline(d), '2 photos crossed Seattle by radio');
  assert.deepStrictEqual(R.figures(d).map((f) => f[1]), ['videos', 'new repeater', 'km² covered', 'repeaters', 'hops, longest']);
  assert.ok(R.figures(d).some((f) => f[0] === '1,275'));
  assert.strictEqual(R.dateRange(Date.parse('2026-11-11T12:00:00Z'), now), 'Nov 11–18, 2026');
  assert.ok(R.headline(R.recapData({ repeaters: [] }, [], 0, now)).includes('Photos, video and voice'));
});

test('widget: a page of its own, same-origin API, light text on its dark design', () => {
  const w = pub('mediamesh-widget.html');
  assert.ok(w.includes("fetch('/api/analytics/mediamesh')") && w.includes('/api/analytics/mediamesh/clips?days=1'));
  assert.ok(w.includes('prefers-reduced-motion') && w.includes('target="_blank" rel="noopener"'));
  assert.ok(!/isFinite\((?!.*Number)/.test(w.replace(/Number\.isFinite/g, '')), 'Number.isFinite only: null is not a position');
  for (const m of w.matchAll(/(?:^|[;{\s])color:\s*(#[0-9a-f]{6})/gi)) {
    const v = parseInt(m[1].slice(1), 16), lum = ((v >> 16) * 0.299 + ((v >> 8) & 255) * 0.587 + (v & 255) * 0.114);
    assert.ok(lum > 150, m[1]);
  }
  assert.ok(pub('mediamesh-recap.js').includes('/mediamesh-widget.html'), 'the embed code points at it');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
