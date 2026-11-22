/* Unit tests for public/mediamesh-cascadia.js: MediaMesh across Cascadia. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-cascadia.js'));
const C = globalThis.MediaMeshCascadia;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

console.log('\n=== MediaMesh across Cascadia ===');

const seattle = { name: 'This analyzer', self: true, ok: true, link_km: 8, links: 12, media_clips_7d: 3, repeaters: [{ name: 'A', lat: 47.6, lon: -122.3 }, { name: 'B 🗻', lat: 47.3, lon: -122.4 }] };
const tacoma = { name: 'Tacoma', url: 'https://t.example', ok: true, links: 2, media_clips_7d: 0, repeaters: [{ name: 'T', lat: 47.0, lon: -122.4 }] };
const portland = { name: 'Portland', url: 'https://p.example', ok: true, links: 1, media_clips_7d: 0, repeaters: [{ name: 'P', lat: 45.5, lon: -122.7 }] };

test('hop length: this mesh\'s, held to 5–25 km, 10 when unknown', () => {
  assert.strictEqual(C.hopKm([seattle]), 8);
  assert.strictEqual(C.hopKm([Object.assign({}, seattle, { link_km: 2 })]), 5);
  assert.strictEqual(C.hopKm([Object.assign({}, seattle, { link_km: 90 })]), 25);
  assert.strictEqual(C.hopKm([tacoma]), 10);
});

test('gaps: the closest pair of repeaters per pair of regions, nearest first', () => {
  const g = C.gaps([seattle, tacoma, portland], 8);
  assert.strictEqual(g.length, 3);
  assert.strictEqual(g[0].from.name, 'B 🗻');
  assert.strictEqual(g[0].to.name, 'T');
  assert.ok(Math.abs(g[0].km - 33.4) < 0.5, String(g[0].km));
  assert.strictEqual(g[0].sites, Math.ceil(g[0].km / 8) - 1);
  assert.ok(g[1].km <= g[2].km);
  assert.deepStrictEqual(C.gaps([seattle, { name: 'Empty', ok: true, repeaters: [] }], 8), []);
});

test('two regions in reach of each other need no site', () => {
  const near = { name: 'Near', ok: true, repeaters: [{ name: 'N', lat: 47.62, lon: -122.3 }] };
  assert.strictEqual(C.gaps([seattle, near], 8)[0].sites, 0);
  assert.ok(C.gapsHtml(C.gaps([seattle, near], 8), [seattle, near], 8).includes('next to each other'));
});

test('regions table: keeps the emojis, escapes names, marks unreachable analyzers', () => {
  const h = C.regionsTableHtml([seattle, { name: '<x>', url: 'https://x', ok: false, repeaters: [] }]);
  assert.ok(h.includes('This one'));
  assert.ok(h.includes('&lt;x&gt;'));
  assert.ok(h.includes("couldn't be reached"));
  assert.ok(C.gapsHtml(C.gaps([seattle, tacoma], 8), [seattle, tacoma], 8).includes('B 🗻'));
  assert.ok(C.gapsHtml([], [seattle], 8).includes('Once another analyzer'));
});

test('wired in: script, page title and the MediaMesh tab link', () => {
  assert.ok(pub('index.html').includes('mediamesh-cascadia.js'));
  assert.ok(pub('app.js').includes("'mediamesh-cascadia': 'Cascadia'"));
  assert.ok(pub('analytics.js').includes('#/mediamesh-cascadia'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
