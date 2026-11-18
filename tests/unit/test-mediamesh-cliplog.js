/* The MediaMesh flight recorder (public/mediamesh-cliplog.js): who heard
 * which piece when, the account of what happened, and the waterfall. */
'use strict';
const assert = require('assert');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-cliplog.js'));
const R = globalThis.MediaMeshClipLog;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}
console.log('\n=== MediaMesh flight recorder ===');

const t0 = Date.parse('2026-11-18T12:00:00Z');
const at = (s) => new Date(t0 + s * 1000).toISOString();
const near = (s) => ({ observer: 'n', name: 'Near <1>', at: at(s), path: ['aa11'] });
const far = (s) => ({ observer: 'f', name: 'Far', at: at(s), path: ['aa11', 'bb22'] });
// 6 pieces: Near hears all; Far misses 2 (rebuilt) and 4 (lost), waits 5 min before piece 5
const log = {
  sid: '1a2b3c4d',
  announcement: { at: at(0), text: 'Jade: VV1:abc:15:6:9 Ferry at sunset', channel: '#seattle', heard: [] },
  clip: { sid: '1a2b3c4d', kind: 'video', total: 6, seconds: 9, outcome: 'partial', observer: 'f', observerName: 'Far', hops: 2, missing: [4], rebuilt: [2], bytes: 1200, durationS: 330 },
  pieces: [
    { index: 0, heard: [near(3), far(4)] },
    { index: 1, heard: [near(5), far(6)] },
    { index: 2, heard: [near(7)] },
    { index: 3, heard: [near(9), far(10)] },
    { index: 4, heard: [near(11)] },
    { index: 5, heard: [near(13), far(334)] },
    { parity: true, index: -1, block: 0, j: 0, heard: [far(12)] },
  ],
  hops: { aa11: { name: 'First Hill' }, bb22: { name: 'Rainier View' } },
};

test('observers: the far end first, with its hops, pieces and times', () => {
  const o = R.observersOf(log);
  assert.deepStrictEqual(o.map((x) => x.id), ['f', 'n']);
  assert.strictEqual(o[0].hops, 2);
  assert.deepStrictEqual([...o[0].data].sort(), [0, 1, 3, 5]);
  assert.strictEqual(o[0].parity, 1);
  assert.strictEqual(o[1].data.size, 6);
  assert.strictEqual(o[0].last - o[0].first, 330000);
});

test('stalls: the far end waiting far longer than usual', () => {
  const s = R.stalls(log, 'f');
  assert.strictEqual(s.length, 1);
  assert.strictEqual((s[0].to - s[0].from) / 1000, 322);
  assert.strictEqual(R.stalls(log, 'n').length, 0, 'steady arrivals: no stall');
});

test('story: outcome, wait, stall, where pieces were lost, speed', () => {
  const s = R.story(log);
  assert.ok(s.includes('Arrived incomplete at <strong>Far</strong>, 2 hops away: 5 of 6 pieces. Piece 5 never got there'), s);
  assert.ok(s.includes('first piece reached Far 4 s after the announcement'), s);
  assert.ok(s.includes('stalled for <strong>5 min 22 s</strong> after a parity piece'), s);
  assert.ok(s.includes('Near &lt;1&gt;, 1 hop out, heard 6; pieces 3 and 5 were lost after it, on the way to Far (3 rebuilt from parity there).'), s);
  assert.ok(s.includes('about 0.03 kbit/s'), s);
  assert.ok(!s.includes('<1>'), 'names are escaped');
  const whole = R.story(Object.assign({}, log, { clip: Object.assign({}, log.clip, { outcome: 'whole', missing: [], rebuilt: [] }) }));
  assert.ok(whole.includes('Arrived whole at <strong>Far</strong>, 2 hops away, 5 min 34 s after it was announced.'), whole);
  assert.ok(R.story({ sid: 'x', clip: { total: 4, outcome: 'none' }, pieces: [] }).includes('no observer heard any of its 4 pieces'));
});

test('waterfall: a dot per hearing, marked rows, a shaded stall, named hops', () => {
  const svg = R.waterfallSvg(log);
  assert.strictEqual((svg.match(/<circle /g) || []).length, 11);
  assert.strictEqual((svg.match(/mm-fr-row is-missing/g) || []).length, 1);
  assert.strictEqual((svg.match(/mm-fr-row is-rebuilt/g) || []).length, 1);
  assert.strictEqual((svg.match(/class="mm-fr-stall"/g) || []).length, 1);
  assert.ok(svg.includes('via First Hill › Rainier View'), 'hops by name');
  assert.ok(svg.includes('>parity<'));
  assert.ok(svg.includes('mm-fr-o0') && svg.includes('mm-fr-o1'), 'a colour per observer');
  assert.ok(!/fill="#|style="fill/.test(svg), 'colours come from the theme');
});

test('view: caption without the announcement code, badge, observers table', () => {
  const h = R.viewHtml(log);
  assert.ok(h.includes('Flight recorder: Video, 9 s · 6 pieces'), h.slice(0, 300));
  assert.ok(h.includes('“Jade: Ferry at sunset”') && h.includes('#seattle'), h.slice(0, 600));
  assert.ok(h.includes('mm-ins-outcome--partial') && h.includes('Incomplete'));
  assert.ok(h.includes('far end') && h.includes('First Hill › Rainier View'));
  assert.strictEqual(R.dur(5), '5 s');
  assert.strictEqual(R.dur(3725), '1 h 2 min');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
