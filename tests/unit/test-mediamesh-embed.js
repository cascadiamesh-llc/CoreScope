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

test('the menu: MediaMesh between Analytics and Scope Audit, in fuchsia, lit on its tab', () => {
  const idx = pub('index.html');
  const a = idx.indexOf('data-route="analytics">Analytics'), m = idx.indexOf('href="#/analytics?tab=mediamesh" class="nav-link nav-link-mediamesh" data-route="mediamesh">MediaMesh</a>'), s = idx.indexOf('data-route="scope-audit"');
  assert.ok(a > 0 && m > a && s > m, 'order');
  assert.ok(/\.nav-link\.nav-link-mediamesh[^{]*\{ color: var\(--nav-mediamesh-text\); \}/.test(pub('style.css')) && pub('style.css').includes('--nav-mediamesh-text: #f0abfc'));
  const app = pub('app.js');
  const src = app.slice(app.indexOf('function navRouteFor'), app.indexOf('// Analytics switches tabs'));
  const navRouteFor = new Function(src + '; return navRouteFor;')();
  assert.strictEqual(navRouteFor('analytics', '#/analytics?tab=mediamesh&window=7d'), 'mediamesh');
  assert.strictEqual(navRouteFor('analytics', '#/analytics?tab=rf'), 'analytics');
  assert.strictEqual(navRouteFor('analytics', '#/analytics'), 'analytics');
  assert.strictEqual(navRouteFor('packets', '#/packets?tab=mediamesh'), 'packets');
  assert.ok(pub('analytics.js').includes('window.syncAnalyticsNavLinks()'), 'tab switches relight the menu');
});

test('Mapped by people: a layer off until ticked, and its km² card', () => {
  const an = pub('analytics.js');
  assert.ok(/<input type="checkbox" id="mmCovFieldToggle">/.test(an), 'off by default');
  assert.ok(an.includes('id="mmStatMappedCard" hidden') && an.includes('showMediaMeshMapped(el)'));
  const src = an.slice(an.indexOf('function mediaMeshMappedText'), an.indexOf('function showMediaMeshMapped'));
  const mmKm = (v) => (v < 100 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v).toLocaleString());
  const f = new Function('mmKm', src + '; return mediaMeshMappedText;')(mmKm);
  assert.strictEqual(f(null), null);
  assert.strictEqual(f({ points: 0 }), null, 'nobody has shared: no card');
  assert.deepStrictEqual(f({ points: 640, mapped_km2: 4.19, hexes_answered: 121, radios: 3, trips: 9 }), { value: '4.2', detail: '121 hexagons where radio2 reaches · 3 radios, 9 trips' });
  assert.deepStrictEqual(f({ points: 5, mapped_km2: 0.03, hexes_answered: 1, radios: 1, trips: 1 }), { value: '0.03', detail: '1 hexagon where radio2 reaches · 1 radio, 1 trip' });
});

test('#mediamesh: the intro links it to a QR code that adds the channel', () => {
  const an = pub('analytics.js');
  const secret = /MM_JOIN_SECRET = '([0-9a-f]{32})'/.exec(an)[1];
  const want = require('crypto').createHash('sha256').update('#mediamesh').digest('hex').slice(0, 32);
  assert.strictEqual(secret, want, 'a hashtag channel: the key is SHA-256 of its name');
  assert.ok(an.includes('Come test with us on the <a href="${esc(MM_JOIN_URL)}" class="mm-join-link" data-mm-join'));
  assert.ok(an.includes('<strong>#mediamesh</strong></a> channel.'));
  assert.ok(an.includes("window.ChannelQR.generate(MM_JOIN_NAME, MM_JOIN_SECRET") && an.includes('initMediaMeshJoin(el);'));
  require(path.join(__dirname, '../../public/channel-qr.js'));
  const url = 'meshcore://channel/add?name=' + encodeURIComponent('#mediamesh') + '&secret=' + want;
  assert.deepStrictEqual(globalThis.ChannelQR.parseChannelUrl(url), { name: '#mediamesh', secret: want });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
