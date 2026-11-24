/* Unit tests for public/mediamesh-nav.js: the MediaMesh bar. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-nav.js'));
const N = globalThis.MediaMeshNav;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

test('every MediaMesh page, Overview first, the way back to the tab', () => {
  assert.deepStrictEqual(N.PAGES.map((p) => p.id), ['overview', 'status', 'lab', 'timemachine', 'grow', 'forecast', 'nightsky']);
  assert.strictEqual(N.PAGES.find((p) => p.id === 'nightsky').href, '#/live?nightsky=1', 'opens the night sky over Live');
  assert.strictEqual(N.PAGES[0].href, '#/analytics?tab=mediamesh');
});

test('the page you are on is lit, and only that one', () => {
  const h = N.html('timemachine');
  assert.strictEqual((h.match(/aria-current="page"/g) || []).length, 1);
  assert.ok(/mmnav-item--on" href="#\/mediamesh-timemachine" aria-current="page"/.test(h));
  assert.strictEqual((h.match(/<a /g) || []).length, 7);
});

test('short names for phones keep the full name for screen readers', () => {
  const h = N.html('overview');
  assert.ok(h.includes('aria-label="MediaMeshLab"') && h.includes('<span class="mmnav-short" aria-hidden="true">Lab</span>'));
  assert.ok(h.includes('aria-label="Grow the mesh"'));
});

test('wiring: loaded, on the tab and on every tool page, colours from variables', () => {
  assert.ok(pub('index.html').includes('<script src="mediamesh-nav.js?v=__BUST__"></script>'));
  assert.ok(pub('analytics.js').includes("MediaMeshNav.html('overview')"));
  for (const [f, id] of [['status', 'status'], ['lab', 'lab'], ['timemachine', 'timemachine'], ['grow', 'grow'], ['forecast', 'forecast']]) {
    assert.ok(pub(`mediamesh-${f}.js`).includes(`MediaMeshNav.html('${id}')`), f);
  }
  const css = pub('style.css').match(/\.mmnav[^{]*\{[^}]*\}/g) || [];
  assert.ok(css.length >= 8);
  for (const r of css) assert.ok(!/(^|[;{\s])(color|background|border-color):\s*#/i.test(r), 'a fixed colour: ' + r.slice(0, 60));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
