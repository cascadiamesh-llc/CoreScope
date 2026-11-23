/* Unit tests for public/mediamesh-windtunnel.js: the wind tunnel in MediaMeshLab. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-windtunnel.js'));
const W = globalThis.MediaMeshWindTunnel;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

console.log('\n=== Wind tunnel ===');

test('LoRa airtime: a 172-byte piece at 250 kHz SF7, slower at narrower or higher SF', () => {
  const a = W.airtimeS(172, 7, 250);
  assert.ok(a > 0.13 && a < 0.17, String(a));
  assert.ok(Math.abs(W.airtimeS(172, 7, 125) - 2 * a) < 1e-9, 'half the bandwidth, twice the time');
  assert.ok(W.airtimeS(172, 8, 250) > 1.7 * a);
});

test('margin and the chance a hop crosses', () => {
  assert.strictEqual(W.marginDb(W.PRESETS[0]), 0);
  assert.ok(Math.abs(W.marginDb({ sf: 8, bwKHz: 125 }) - (2.5 + 3.0103)) < 0.01);
  assert.ok(W.shiftP(0.8, 5) > 0.8 && W.shiftP(0.8, -5) < 0.8);
  assert.ok(Math.abs(W.shiftP(0.8, 0) - 0.8) < 1e-9);
});

test('hop chance from the far ends: upper quartile, held between 0.5 and 0.99', () => {
  const clips = [{ total: 18, heard: 14, hops: 5 }, { total: 18, heard: 4, hops: 5 }, { total: 3, heard: 3, hops: 2 }, { total: 10, heard: 1, hops: 6 }];
  const p = W.hopChance(clips);
  assert.ok(p > 0.9 && p <= 0.99, String(p));
  assert.strictEqual(W.hopChance([]), 0.85);
});

test('repair pieces make a clip whole more often than plain resends with no up-front repair', () => {
  const r1 = W.rng(7), r2 = W.rng(7);
  let fast = 0, plain = 0;
  for (let i = 0; i < 400; i++) {
    if (W.sendOnce(18, 0.6, 0.6, W.REPAIRS[0], 1, 0.15, 3, r1).whole) fast++;
    if (W.sendOnce(18, 0.6, 0.6, W.REPAIRS[3], 1, 0.15, 3, r2).whole) plain++;
  }
  assert.ok(fast > plain, `${fast} vs ${plain}`);
});

test('a sure link: everything whole, no asks, airtime as counted', () => {
  const s = W.sendOnce(5, 1, 1, W.REPAIRS[1], 3, 0.15, 2, W.rng(1));
  assert.deepStrictEqual([s.whole, s.sent, s.rounds], [true, 5, 0]);
  assert.ok(Math.abs(s.seconds - 5 * Math.max(2.4 * 0.15, 0.15)) < 1e-9);
});

test('runAll: same dice either side, lost clips counted, a slower preset costs airtime', () => {
  const items = [{ total: 18, hops: 3 }, { total: 3, hops: 2 }, { total: 10, hops: null }];
  const now = { preset: W.PRESETS[0], repair: W.REPAIRS[0], rounds: 3 };
  const a = W.runAll(items, 0.9, now), a2 = W.runAll(items, 0.9, now);
  assert.deepStrictEqual(a, a2, 'seeded');
  assert.strictEqual(a.lost, 1);
  assert.ok(a.whole <= 2 / 3 + 1e-9);
  const slow = W.runAll(items, 0.9, { preset: W.PRESETS[3], repair: W.REPAIRS[0], rounds: 3 });
  assert.ok(slow.airtimeS > a.airtimeS * 1.5, `${slow.airtimeS} vs ${a.airtimeS}`);
  assert.ok(slow.hopChance > a.hopChance);
});

test('the page: tiles compare, and the lab and index carry it', () => {
  const h = W.tilesHtml({ whole: 0.5, medianS: 40, airtimeS: 300, lost: 0 }, { whole: 0.75, medianS: 30, airtimeS: 600, lost: 1 });
  assert.ok(h.includes('50%') && h.includes('75%') && h.includes('mms-good') && h.includes('mms-bad'));
  assert.ok(W.controlsHtml().includes('id="mmwPreset"'));
  assert.ok(pub('index.html').indexOf('mediamesh-windtunnel.js') < pub('index.html').indexOf('mediamesh-lab.js'));
  assert.ok(pub('mediamesh-lab.js').includes('MediaMeshWindTunnel'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
