/* Unit tests for public/mediamesh-node.js: the MediaMesh card on a node's page. */
'use strict';
const assert = require('assert');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-node.js'));
const N = globalThis.MediaMeshNode;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}
console.log('\n=== MediaMesh node card ===');

const days = Array.from({ length: 14 }, (_, i) => ({ day: '2026-11-' + String(4 + i).padStart(2, '0'), packets: i === 13 ? 40 : i % 3 }));

test('per-day chart: a bar per day scaled to the busiest, zero days greyed, dated ends', () => {
  const svg = N.dailySvg(days, { width: 280, height: 56 });
  assert.strictEqual((svg.match(/<rect /g) || []).length, 14);
  assert.strictEqual((svg.match(/mm-node-bar--zero/g) || []).length, days.filter((d) => !d.packets).length);
  assert.ok(svg.includes('<title>2026-11-17: 40</title>'), svg);
  assert.ok(/height="42" rx/.test(svg), 'the busiest day fills the chart');
  assert.ok(svg.includes('>today</text>'));
  assert.strictEqual(N.dailySvg([]), '');
});

test('card: since when, relayed with rank, hops with partners, map only with a position', () => {
  const me = 'aa'.repeat(32), other = 'bb'.repeat(32);
  const report = {
    public_key: me, rank: 2, rank_of: 14, daily: days,
    repeater: { name: 'First <Hill>', first_seen: '2026-10-20T00:00:00Z', media_relayed_7d: 412 },
    backbone: [{ a: me, b: other, a_name: 'First <Hill>', b_name: 'Yesler', packets: 88, a_lat: 1, a_lon: 1, b_lat: 2, b_lon: 2 }],
  };
  const now = Date.parse('2026-11-17T12:00:00Z');
  let h = N.cardHtml({ lat: 47.6, lon: -122.3 }, report, now);
  assert.ok(h.includes('On MediaMesh since') && h.includes('(28 days ago)'), h);
  assert.ok(h.includes('412 <span class="text-muted">#2 of 14 repeaters</span>'), h);
  assert.ok(h.includes('Media packets relayed this week'), 'packets, not whole photos');
  assert.ok(N.cardHtml({ lat: 1, lon: 1 }, Object.assign({}, report, { repeater: Object.assign({}, report.repeater, { media_clips_7d: 30, media_clips_estimated_7d: 2 }) }), now).includes('about 30 whole clips (photos, video, voice)'));
  assert.ok(h.includes(`href="#/nodes/${other}">Yesler</a> <span class="text-muted">88</span>`), 'the partner, not itself');
  assert.ok(h.includes('id="mmNodeMap"') && h.includes('id="mmNodeArea">…<'));
  assert.ok(h.includes('First &lt;Hill&gt;') && !h.includes('First <Hill>'), 'names escaped');
  h = N.cardHtml({ lat: NaN, lon: NaN }, Object.assign({}, report, { rank: 0, backbone: [] }), now);
  assert.ok(!h.includes('id="mmNodeMap"') && h.includes('no saved position') && h.includes('none this week') && h.includes('None with a placed neighbour yet'), h);
});

test('what if: sliders at today\'s settings, the change in area and people, the legal limit', () => {
  const h = N.whatIfHtml({ lat: 47.6, lon: -122.3 });
  assert.ok(h.includes('data-wi="heightM"') && h.includes('value="10"') && h.includes('value="22"') && h.includes('value="2"'), h);
  assert.ok(h.includes('<details') && !h.includes(' open'), 'closed until asked for');
  const r = N.whatIfResultHtml({ km2: 352.4, people: 96123 }, { km2: 311.6, people: 84090 });
  assert.ok(r.includes('<strong>352 km²</strong>') && r.includes('(+40 km²)'), r);
  assert.ok(r.includes('96,100 people') && r.includes('(+12,000 people)'), r);
  const down = N.whatIfResultHtml({ km2: 50, people: 900 }, { km2: 60.25, people: 1200 });
  assert.ok(down.includes('mm-wi-down') && down.includes('(−10.3 km²)'), down);
  assert.ok(!N.whatIfResultHtml({ km2: 10, people: 5 }, { km2: 10, people: 5 }).includes('('), 'no change: no bracket');
  assert.ok(N.eirpText({ txDbm: 22, gainDbi: 2 }).startsWith('Radiated: 23 dBm EIRP') && !N.eirpText({ txDbm: 22, gainDbi: 2 }).includes('FCC'));
  assert.ok(N.eirpText({ txDbm: 30, gainDbi: 9 }).includes('above the 36 dBm the FCC allows'));
});

test('MediaMesh styles never fix a text colour: text follows the theme', () => {
  // Dark text on a dark popup slipped through once (#1a1a2e). Any MediaMesh
  // rule that sets a text colour must take it from a theme variable.
  const fs = require('fs');
  const bad = [];
  for (const file of ['public/style.css', 'public/live.css']) {
    const css = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const sel = m[1].trim();
      if (!/mm-|mediamesh/i.test(sel)) continue;
      for (const decl of m[2].split(';')) {
        const d = /^\s*(color|fill)\s*:\s*(.+)$/i.exec(decl);
        if (!d) continue;
        const v = d[2].trim();
        // a theme variable, or inheriting, is fine; a literal colour is not
        if (/^var\(--/.test(v) || /^(inherit|currentColor|transparent|none)$/i.test(v) || /^color-mix\(.*var\(--/.test(v)) continue;
        bad.push(`${file}: ${sel} { ${d[1]}: ${v} }`);
      }
    }
  }
  assert.deepStrictEqual(bad, [], 'fixed text colours:\n' + bad.join('\n'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
