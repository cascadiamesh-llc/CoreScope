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
  const sky = lum('#060a14');
  for (const r of rules) {
    // against the rule's own solid background where it has one (a hovered button)
    const own = /background:\s*(#[0-9a-f]{6})/i.exec(r);
    const bg = own ? lum(own[1]) : sky;
    for (const m of r.matchAll(/(?:^|[;{\s])color:\s*(#[0-9a-f]{3,6})/gi)) {
      const ratio = (Math.max(lum(m[1]), bg) + 0.05) / (Math.min(lum(m[1]), bg) + 0.05);
      assert.ok(ratio >= 4.5, `${m[1]} in ${r.slice(0, 40)} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.ok(/\.nightsky \{[^}]*background: #060a14/.test(css), 'the sky has its own background');
  // the CascadiaMesh website's faces, self-hosted
  for (const f of ['orbitron-latin-400', 'orbitron-latin-600', 'exo2-latin-300', 'exo2-latin-400', 'exo2-latin-600']) {
    assert.ok(pub('style.css').includes(`url('/fonts/${f}.woff2')`), f);
    assert.ok(fs.existsSync(path.join(__dirname, '../../public/fonts', f + '.woff2')), f + ' is there');
  }
});

test('a feed rebuild keeps MediaMesh transfers as cards, starting them again', () => {
  const js = pub('live.js');
  const rb = js.slice(js.indexOf('function rebuildFeedList()'), js.indexOf('function applyFavoritesFilter()'));
  assert.ok(rb.includes('mmTransfers = [];'), 'old cards are dropped with the rows');
  assert.ok(rb.includes('mediaMeshTransferFor(') && rb.includes('transfer: t'), 'clips are grouped into cards again');
});

test('the transfer card keeps its height in a full feed', () => {
  // the feed is a flex column of clipped rows: a card that may shrink gets squashed unreadable
  assert.ok(/\.live-feed-item\.live-mm-transfer \{ flex-shrink: 0;/.test(pub('live.css')));
});

test('camera: in on the routes crossing, out to every repeater when quiet, eased', () => {
  const base = S.boundsOf([{ lat: 47.5, lon: -122.4 }, { lat: 47.75, lon: -122.1 }]);
  assert.strictEqual(S.cameraTarget(base, null), base, 'quiet: the whole network');
  const t = S.cameraTarget(base, [{ lat: 47.60, lon: -122.33 }, { lat: 47.62, lon: -122.31 }]);
  assert.ok(t.n - t.s >= 0.055 - 1e-9 && t.n - t.s < 0.1, 'a few km round a short route');
  assert.ok(t.s < 47.60 && t.n > 47.62 && t.w < -122.33 && t.e > -122.31, 'the route inside');
  const half = S.easeBounds(base, t, 0.5);
  assert.ok(Math.abs(half.s - (base.s + t.s) / 2) < 1e-12);
  const f = S.fit(base, 1000, 800, 50), xy = f.P(47.6, -122.3), back = f.inv(xy[0], xy[1]);
  assert.ok(Math.abs(back[0] - 47.6) < 1e-9 && Math.abs(back[1] + 122.3) < 1e-9, 'inv undoes P');
  assert.ok(Math.abs(S.routeKm([{ lat: 47.6, lon: -122.3 }, { lat: 47.7, lon: -122.3 }]) - 11.132) < 0.01);
});

test('names: busiest first, none covering another or the HUD, each once', () => {
  const items = [
    { text: 'First Hill', x: 500, y: 400, pri: 5, width: 60 },
    { text: 'First Hill Skyline', x: 503, y: 401, pri: 9, width: 110 },
    { text: 'Yesler', x: 506, y: 402, pri: 1, width: 40 },
    { text: 'Far', x: 900, y: 100, pri: 3, width: 30 },
    { text: 'First Hill', x: 700, y: 400, pri: 2, width: 60 },
  ];
  const out = S.placeLabels(items, 1000, 800, [[850, 60, 1000, 140]]);
  const names = out.map((l) => l.text);
  assert.strictEqual(names[0], 'First Hill Skyline', 'the busiest is placed first');
  assert.strictEqual(names.filter((n) => n === 'First Hill').length, 1, 'a name once');
  assert.ok(!names.includes('Far'), 'kept clear of the HUD');
  const box = (l) => (l.align === 'left' ? [l.tx, l.ty - 7, l.tx + l.width, l.ty + 7] : l.align === 'right' ? [l.tx - l.width, l.ty - 7, l.tx, l.ty + 7] : [l.tx - l.width / 2, l.ty - 7, l.tx + l.width / 2, l.ty + 7]);
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = box(out[i]), b = box(out[j]);
    assert.ok(!(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]), `${out[i].text} covers ${out[j].text}`);
  }
});

test('outcomes: whole, made whole by parity, pieces lost, or no claim without a total', () => {
  const tr = (total, got, parity) => ({ total, idx: new Set(got), parity: parity || {} });
  const all = (n) => Array.from({ length: n }, (_, i) => i);
  assert.deepStrictEqual(S.outcomeOf(tr(18, all(18))), { outcome: 'whole', missing: 0, rebuilt: 0 });
  assert.deepStrictEqual(S.outcomeOf(tr(18, all(18).filter((i) => i !== 3), { 0: 1 })), { outcome: 'parity', missing: 0, rebuilt: 1 });
  // block 0 loses 2 with 1 parity piece; block 1 (20..24) whole
  assert.deepStrictEqual(S.outcomeOf(tr(25, all(25).filter((i) => i !== 3 && i !== 4), { 0: 1 })), { outcome: 'lost', missing: 2, rebuilt: 0 });
  assert.strictEqual(S.outcomeOf(tr(0, [0, 1])).outcome, null, 'no announcement: no claim');
  assert.strictEqual(S.outcomeText({ outcome: 'lost', missing: 1 }), 'passed out of the observers\' hearing', 'never a claim it was lost');
});

test('the land: sea and lakes left dark, the shore traced, a flat field still land', () => {
  let img = null;
  const doc = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData(i) { img = i; } }) }) };
  try {
    const elev = (lat, lon) => {
      if (lon < -122.4) return -5;                                                    // the sound
      if (((lon + 122.25) / 0.03) ** 2 + ((lat - 47.62) / 0.12) ** 2 < 1) return 6;   // a lake
      if (Math.abs(lat - 47.5) < 0.0015 && Math.abs(lon + 122.3) < 0.0015) return 12; // a flat field, a few pixels
      return 30 + 60 * Math.abs(Math.sin(lat * 140) * Math.cos(lon * 95));
    };
    const b = { s: 47.45, n: 47.8, w: -122.5, e: -122.15 };
    S.landCanvas(b, elev, 300, 300);
    const a = (lat, lon) => img.data[(Math.floor((b.n - lat) / (b.n - b.s) * 300) * 300 + Math.floor((lon - b.w) / (b.e - b.w) * 300)) * 4 + 3];
    const blue = (lat, lon) => { const i = (Math.floor((b.n - lat) / (b.n - b.s) * 300) * 300 + Math.floor((lon - b.w) / (b.e - b.w) * 300)) * 4; return img.data[i + 2] > img.data[i] + 100 && img.data[i + 3] > 0; };
    assert.ok(blue(47.62, -122.45), 'the sound is blue');
    assert.ok(blue(47.62, -122.25), 'the lake is blue');
    assert.ok(a(47.5, -122.3) > 0 && !blue(47.5, -122.3), 'a flat field is land, dark');
    assert.ok(a(47.62, -122.33) > 0 && !blue(47.62, -122.33), 'land is dark');
    let coast = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 239 && img.data[i + 2] === 242 && img.data[i + 3] === 120) coast++;
    assert.ok(coast > 200, 'the shore is traced: ' + coast);
  } finally { globalThis.document = doc; }
});

test('counters: clips of unknown kind shown, relays counted once per packet', () => {
  const ns = pub('live-nightsky.js'), js = pub('live.js');
  assert.ok(ns.includes('data-ns-count="unknown"') && ns.includes('kind unknown'), 'unreadable clips get their own count');
  assert.ok(ns.includes('data-ns-count="relays"') && !ns.includes('hops crossed'));
  assert.ok(/st\.relayed\.get\(p\.hash\)/.test(ns), 'a packet heard over several paths counts its longest once');
  assert.ok(/feedNightSky\(allPaths, typeName, payload, first\.hash\)/.test(js) && /hash: ev\.hash, relays: \(ev\.path \|\| \[\]\)\.length/.test(js), 'live and replay pass the hash and the whole path');
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
