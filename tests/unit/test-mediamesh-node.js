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
  assert.ok(h.includes(`href="#/nodes/${other}">Yesler</a> <span class="text-muted">88</span>`), 'the partner, not itself');
  assert.ok(h.includes('id="mmNodeMap"') && h.includes('id="mmNodeArea">…<'));
  assert.ok(h.includes('First &lt;Hill&gt;') && !h.includes('First <Hill>'), 'names escaped');
  h = N.cardHtml({ lat: NaN, lon: NaN }, Object.assign({}, report, { rank: 0, backbone: [] }), now);
  assert.ok(!h.includes('id="mmNodeMap"') && h.includes('no saved position') && h.includes('none this week') && h.includes('None with a placed neighbour yet'), h);
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
