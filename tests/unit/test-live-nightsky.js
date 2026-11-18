/* Unit tests for public/live-nightsky.js (the Live night sky) and its wiring in live.js. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/live-nightsky.js'));
const S = globalThis.LiveNightSky;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}
console.log('\n=== Live night sky ===');

const pts = [{ lat: 47.50, lon: -122.40 }, { lat: 47.70, lon: -122.20 }, { lat: 47.60, lon: -122.30 }];

test('projection fits every point inside the margins, north up', () => {
  const pr = S.projection(pts, 1000, 800, 50);
  for (const p of pts) {
    const [x, y] = pr.P(p.lat, p.lon);
    assert.ok(x >= 49.9 && x <= 950.1 && y >= 49.9 && y <= 750.1, `${x},${y}`);
  }
  assert.ok(pr.P(47.70, -122.3)[1] < pr.P(47.50, -122.3)[1], 'north is up');
  assert.ok(pr.P(47.6, -122.20)[0] > pr.P(47.6, -122.40)[0], 'east is right');
});

test('projection keeps clear of a taller HUD at the top and bottom', () => {
  const pr = S.projection(pts, 400, 800, { top: 150, bottom: 160, left: 20, right: 20 });
  for (const p of pts) {
    const [x, y] = pr.P(p.lat, p.lon);
    assert.ok(y >= 149.9 && y <= 640.1 && x >= 19.9 && x <= 380.1, `${x},${y}`);
  }
});

test('projection: one point is not a full screen, and junk positions are ignored', () => {
  const pr = S.projection([{ lat: 47.6, lon: -122.3 }, { lat: 0, lon: 0 }, { lat: NaN, lon: 1 }], 800, 800, 0);
  assert.ok(pr.bounds.n - pr.bounds.s >= 0.055 - 1e-9);
  const [x, y] = pr.P(47.6, -122.3);
  assert.ok(Math.abs(x - 400) < 1 && Math.abs(y - 400) < 1, 'centred');
});

test('transfer labels: kind, length when known, the two ends', () => {
  const hops = [{ name: 'First Hill' }, { name: 'SoDo' }, { name: 'Rainier View' }];
  assert.strictEqual(S.transferLabel('video', hops, 9), 'Video, 9 s · First Hill → Rainier View');
  assert.strictEqual(S.transferLabel('photo', hops, 9), 'Photo · First Hill → Rainier View');
  assert.strictEqual(S.transferLabel('nope', [{ name: 'A' }], 0), 'Media clip');
  assert.strictEqual(S.kindOf('voice'), 'voice');
  assert.strictEqual(S.kindOf(undefined), 'clip');
});

test('night sky text stays light on its own dark background', () => {
  const css = pub('live.css');
  const rules = css.match(/\.nightsky[^{]*\{[^}]*\}/g) || [];
  assert.ok(rules.length > 8);
  const lum = (hex) => {
    const c = hex.replace('#', ''), f = c.length === 3 ? c.split('').map((d) => d + d).join('') : c;
    return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const bg = lum('#03050b');
  for (const r of rules) {
    for (const m of r.matchAll(/(?:^|[;{\s])color:\s*(#[0-9a-f]{3,6})/gi)) {
      const ratio = (lum(m[1]) + 0.05) / (bg + 0.05);
      assert.ok(ratio >= 4.5, `${m[1]} in ${r.slice(0, 40)} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.ok(/\.nightsky \{[^}]*background: #03050b/.test(css), 'the sky has its own background');
});

test('the transfer card keeps its height in a full feed', () => {
  // the feed is a flex column of clipped rows: a card that may shrink gets squashed unreadable
  assert.ok(/\.live-feed-item\.live-mm-transfer \{ flex-shrink: 0;/.test(pub('live.css')));
});

test('live.js wiring: button, feed while open, the replay endpoint', () => {
  const js = pub('live.js');
  assert.ok(js.includes('id="liveNightSkyBtn"') && js.includes('#ph-moon-stars'));
  assert.ok(/LiveNightSky\.isOpen\(\)\) feedNightSky\(/.test(js), 'packets feed the sky only while it is open');
  assert.ok(js.includes("/analytics/mediamesh/replay?hours=24"));
  assert.ok(pub('index.html').includes('<script src="live-nightsky.js?v=__BUST__"></script>'));
  assert.ok(pub('icons/phosphor-sprite.svg').includes('id="ph-moon-stars"'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
