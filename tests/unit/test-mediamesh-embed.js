/* Unit tests for public/mediamesh-embed.js and public/embed/badge.html: MediaMesh on other websites. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-embed.js'));
const E = globalThis.MediaMeshEmbed;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

console.log('\n=== MediaMesh embeds ===');

test('which embed: from ?embed= or the hash, and only the known ones', () => {
  assert.strictEqual(E.kindOf('?embed=sky', ''), 'sky');
  assert.strictEqual(E.kindOf('?theme=light&embed=coverage', ''), 'coverage');
  assert.strictEqual(E.kindOf('', '#/live?nightsky=1&embed=sky'), 'sky');
  assert.strictEqual(E.kindOf('?embed=evil', ''), null);
  assert.strictEqual(E.kindOf('', '#/packets'), null);
});

test('each embed lands on its page, and stays there', () => {
  assert.strictEqual(E.routeFor('sky', ''), '#/live?nightsky=1&embed=sky');
  assert.strictEqual(E.routeFor('sky', '#/live?nightsky=1&embed=sky'), null);
  assert.strictEqual(E.routeFor('coverage', '#/packets'), '#/analytics?tab=mediamesh&embed=coverage');
  assert.strictEqual(E.routeFor('coverage', '#/analytics?tab=mediamesh&embed=coverage'), null);
  assert.strictEqual(E.routeFor(null, '#/x'), null);
});

test('coverage only: everything but the card is hidden', () => {
  const mk = (id, kids = []) => {
    const n = { id, hidden: false, style: {}, children: kids, parentElement: null };
    kids.forEach((k) => { k.parentElement = n; });
    n.contains = (x) => x === n || kids.some((k) => k.contains(x));
    n.querySelector = (sel) => (sel === '#mmCoverageCard' ? find(n) : null);
    return n;
  };
  const find = (n) => (n.id === 'mmCoverageCard' ? n : n.children.map(find).find(Boolean) || null);
  const card = mk('mmCoverageCard'), sib = mk('people'), row = mk('row', [card, sib]), other = mk('insights'), el = mk('tab', [mk('summary'), row, other]);
  E.coverageOnly(el);
  assert.ok(!row.hidden && !card.hidden);
  assert.ok(other.hidden && el.children[0].hidden && sib.hidden);
  assert.strictEqual(other.style.display, 'none', 'even where the CSS sets display');
  assert.strictEqual(card.style.display, undefined);
});

test('the snippets: the three iframes at this analyzer, escaped for a textarea', () => {
  const s = E.snippets('https://analyzer.cascadiamesh.org/');
  assert.deepStrictEqual(s.map((x) => x.name), ['Night sky', 'Coverage map', 'Live badge']);
  assert.ok(s[0].code.includes('src="https://analyzer.cascadiamesh.org/?embed=sky"'));
  assert.ok(s[1].code.includes('?embed=coverage') && s[2].code.includes('/embed/badge.html'));
  const html = E.snippetsHtml('https://analyzer.cascadiamesh.org/#/analytics');
  assert.ok(html.includes('&lt;iframe src=&quot;https://analyzer.cascadiamesh.org/?embed=sky&quot;') && !html.includes('<iframe'));
});

test('wiring: loaded first, the sky opens from the URL, the badge stands alone', () => {
  const idx = pub('index.html');
  assert.ok(idx.indexOf('mediamesh-embed.js?v=__BUST__') > 0 && idx.indexOf('mediamesh-embed.js') < idx.indexOf('app.js?v='), 'before the router');
  const live = pub('live.js');
  assert.ok(live.includes("getHashParams().get('nightsky') === '1'") && live.includes('fullscreen: !kiosk'));
  assert.ok(pub('analytics.js').includes("window.MediaMeshEmbed.kind() === 'coverage'"));
  const b = pub('embed/badge.html');
  assert.ok(b.includes("fetch('/api/analytics/mediamesh?window=7d'") && b.includes('setInterval(load, 60000)'));
  assert.ok(b.includes('target="_blank"') && b.includes('badge.css') && pub('embed/badge.css').includes(':root[data-theme="light"]'));
  assert.ok(/html\.mm-embed \.top-nav/.test(pub('style.css')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
