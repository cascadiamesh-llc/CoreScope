/* MediaMesh (radio2) on Analytics and the Live feed.
 *
 * Analytics: an Overview card, the radio2 part of each payload type (Payload
 * Type Mix and Relay Airtime Share), and a MediaMesh tab with radio2 packets
 * per hour, the MediaMesh repeaters and the observers that hear radio2.
 * Live: a fuchsia badge on feed rows carried on radio2, and "MediaMesh only".
 * A mesh without MediaMesh data renders exactly as before.
 */
'use strict';
const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

const analytics = fs.readFileSync('public/analytics.js', 'utf8');
const live = fs.readFileSync('public/live.js', 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

// Pull named function declarations out of a source file.
function extract(src, names) {
  return names.map((n) => {
    const start = src.indexOf('function ' + n + '(');
    assert.ok(start >= 0, n + ' not found');
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1);
  }).join('\n');
}

const ctx = {
  window: {},
  esc: (s) => (s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''),
  sf: (v, d) => (v != null ? v.toFixed(d) : '–'),
  timeAgo: () => '5m ago',
  packetsPerHourCard: (pph) => ({ html: '<h3>Packets / Hour</h3><svg data-n="' + pph.length + '"></svg>' }),
};
ctx.escapeHtml = ctx.esc;
vm.createContext(ctx);
vm.runInContext(extract(analytics, ['renderPayloadPie', 'mediaMeshTypeShares', 'mediaMeshStatCard',
  'mediaMeshRadioText', 'mediaMeshTime', 'mediaMeshUnknownNearHtml', 'mediaMeshLinksByLength', 'mmKm', 'mediaMeshHeadlineHtml', 'mediaMeshLeaderboardHtml', 'mediaMeshOnCoverageStats', 'mediaMeshCoverageCardHtml', 'renderMediaMeshTabHtml', 'renderRelayAirtimeDumbbell']) +
  '\nthis.api = { renderPayloadPie, mediaMeshTypeShares, mediaMeshStatCard, renderMediaMeshTabHtml, renderRelayAirtimeDumbbell, mediaMeshLinksByLength, mediaMeshHeadlineHtml, mediaMeshLeaderboardHtml, mediaMeshOnCoverageStats };', ctx);
const A = ctx.api;

const MM = {
  total_transmissions: 1000, mediamesh_transmissions: 120, share_pct: 12,
  by_type: [{ name: 'GRP_TXT', count: 500, mediamesh: 100 }, { name: 'ADVERT', count: 100, mediamesh: 0 }, { name: 'GRP_DATA', count: 40, mediamesh: 20 }],
  per_hour: [{ hour: '2026-10-30T14', count: 50 }, { hour: '2026-10-30T15', count: 70 }],
  observers: [{ id: 'abc', name: 'First Hill <obs>', iata: 'SEA', mediamesh_observations: 120, total_observations: 900, share_pct: 13.3, last_heard: '2026-10-30T15:00:00Z' }],
  repeaters: [
    { public_key: 'aa11', name: 'Peak', role: 'repeater', mode: 'rxtx', radio: '911.15,250,7,5', source: 'status', last_seen: '2026-10-30T15:00:00Z' },
    { public_key: 'bb22', name: 'Valley', role: 'repeater', mode: 'rx', source: 'neighbor', last_seen: '2026-10-30T14:00:00Z' },
  ],
};
const TYPES = [{ name: 'GRP_TXT', count: 500 }, { name: 'ADVERT', count: 100 }, { name: 'GRP_DATA', count: 40 }];

console.log('\n=== Overview card ===');

test('shows radio2 transmissions, share and repeaters', () => {
  const h = A.mediaMeshStatCard(MM);
  assert.ok(h.includes('>120<'), h);
  assert.ok(h.includes('12.0% of transmissions'), h);
  assert.ok(h.includes('2 repeaters'), h);
  assert.ok(h.includes('href="#/analytics?tab=mediamesh"'));
});

test('absent on a mesh without MediaMesh', () => {
  assert.strictEqual(A.mediaMeshStatCard(null), '');
  assert.strictEqual(A.mediaMeshStatCard({ mediamesh_transmissions: 0, repeaters: [] }), '');
});

console.log('\n=== Payload Type Mix ===');

test('the radio2 part of each type is a fuchsia segment and a percentage', () => {
  const h = A.renderPayloadPie(TYPES, MM);
  assert.strictEqual((h.match(/mm-bar-segment/g) || []).length, 2, 'GRP_TXT and GRP_DATA only');
  assert.ok(h.includes('20% radio2'), 'GRP_TXT 100 of 500');
  assert.ok(h.includes('50% radio2'), 'GRP_DATA 20 of 40');
  assert.ok(h.includes('part carried on MediaMesh'), 'legend');
});

test('unchanged without MediaMesh data', () => {
  const before = A.renderPayloadPie(TYPES);
  assert.ok(!before.includes('mm-'));
  assert.strictEqual(A.renderPayloadPie(TYPES, { by_type: [] }), before);
});

console.log('\n=== Relay Airtime Share ===');

const AIR = { total_score: 1000, rows: [
  { payload_type: 'GRP_TXT', count: 10, count_pct: 50, airtime_pct: 60, score: 600, mediamesh_count: 3, mediamesh_airtime_pct: 18 },
  { payload_type: 'ADVERT', count: 10, count_pct: 50, airtime_pct: 40, score: 400 },
] };

test('rows with radio2 traffic get a hollow ring and an r2 value', () => {
  const h = A.renderRelayAirtimeDumbbell(AIR);
  assert.strictEqual((h.match(/dumbbell-dot-mediamesh/g) || []).length, 1);
  assert.ok(h.includes('left:18.000%'));
  assert.ok(h.includes('r2 18.0%'));
  assert.ok(h.includes('airtime on MediaMesh'), 'legend entry');
});

test('no ring, value or legend entry without radio2 traffic', () => {
  const h = A.renderRelayAirtimeDumbbell({ total_score: 1000, rows: [AIR.rows[1]] });
  assert.ok(!h.includes('dumbbell-dot-mediamesh') && !h.includes('r2 ') && !h.includes('airtime on MediaMesh'));
});

console.log('\n=== MediaMesh tab ===');

test('per hour, repeaters with mode/setting/last seen, observers; names escaped', () => {
  const h = A.renderMediaMeshTabHtml(MM, '');
  assert.ok(h.includes('radio2 packets /'), 'per-hour chart title');
  assert.ok(h.includes('data-n="2"'), 'both hours charted');
  assert.ok(h.includes('Peak') && h.includes('listens and sends') && h.includes('reported by the node'));
  assert.ok(h.includes('Valley') && h.includes('listens') && h.includes('reported by a neighbour'));
  assert.ok(h.includes('911.15,250,7,5') || h.includes('911.15 MHz'), 'radio2 setting');
  assert.ok(h.includes('First Hill &lt;obs&gt;') && !h.includes('<obs>'), 'observer name escaped');
  assert.ok(h.includes('13.3%') && h.includes('5m ago'));
});

test('a repeater only seen relaying gets a greyed row; others do not', () => {
  const withRelay = Object.assign({}, MM, { repeaters: MM.repeaters.concat([
    { public_key: 'cc33', name: 'Hilltop', role: 'repeater', mode: 'rxtx', source: 'relayed', last_seen: '2026-10-30T15:00:00Z' },
  ]) });
  const h = A.renderMediaMeshTabHtml(withRelay, '');
  assert.ok(h.includes('seen relaying MediaMesh packets'), 'relayed source label');
  const rows = h.split('<tr').filter(r => r.includes('#/nodes/'));
  const relayRow = rows.find(r => r.includes('Hilltop'));
  assert.ok(relayRow && relayRow.startsWith(' class="mm-row--relayed"'), relayRow);
  assert.ok(rows.filter(r => r.includes('mm-row--relayed')).length === 1, 'only the relayed row is greyed');
});

test('an observer running MediaMesh that has heard nothing yet is listed', () => {
  const withIdle = Object.assign({}, MM, { observers: MM.observers.concat([
    { id: 'd177', name: 'd1-rptr', iata: 'SEA', mediamesh_observations: 0, total_observations: 500, share_pct: 0, last_heard: '', runs_mediamesh: true },
  ]) });
  const h = A.renderMediaMeshTabHtml(withIdle, '');
  assert.ok(h.includes('MediaMesh observers'), 'section title');
  assert.ok(h.includes('d1-rptr') && h.includes('MediaMesh on, nothing heard yet'), 'idle observer row');
  assert.ok(h.includes('1 heard radio2'), 'stat detail counts only observers that heard radio2');
});

test('both lists have a Near column and sortable headers', () => {
  const withNear = Object.assign({}, MM, {
    repeaters: MM.repeaters.map((r, i) => Object.assign({}, r, i === 0 ? { near: 'First Hill, Seattle' } : {})),
    observers: MM.observers.map((o) => Object.assign({}, o, { near: 'Woodinville, WA' })),
  });
  const h = A.renderMediaMeshTabHtml(withNear, '');
  assert.ok(h.includes('id="mmRepeaterTable"') && h.includes('id="mmObserverTable"'), 'table ids for TableSort');
  assert.ok((h.match(/<th scope="col" data-sort-key="near">Near<\/th>/g) || []).length === 2, 'Near column in both');
  assert.ok(h.includes('First Hill, Seattle') && h.includes('Woodinville, WA'), 'near values shown');
  assert.ok(h.includes('data-sort-key="last_seen" data-type="date"') && h.includes('data-sort-key="mm" data-type="numeric"'));
  assert.ok(h.includes('data-value="2026-10-30T15:00:00.000Z"'), 'times sort by their ISO value');
  // A repeater without a position shows a dash.
  assert.ok(h.split('<tr').some((r) => r.includes('#/nodes/') && r.includes('<td>—</td>')));
});

test('repeaters known only by their hash are listed as unknown', () => {
  const withUnknown = Object.assign({}, MM, { unknown_repeaters: [
    { prefix: 'C267A0', source: 'heard', first_seen: '2026-10-30T14:00:00Z', last_seen: '2026-10-30T15:00:00Z', packets: 40 },
    { prefix: '9E3C', source: 'relayed', first_seen: '2026-10-30T14:00:00Z', last_seen: '2026-10-30T15:00:00Z', packets: 3 },
  ] });
  const h = A.renderMediaMeshTabHtml(withUnknown, '');
  assert.ok(h.includes('Unknown repeater <code>C267A0</code>') && h.includes('Unknown repeater <code>9E3C</code>'));
  assert.ok(h.includes('no advert heard yet (40 packets)'));
  assert.ok(h.includes('2 not yet identified'), 'stat card counts them');
  const rows = h.split('<tr').filter((r) => r.includes('Unknown repeater'));
  assert.ok(rows.some((r) => r.includes('mm-row--relayed') && r.includes('9E3C')), 'relayed unknown is greyed');
  assert.ok(!h.includes('href="#/nodes/c267'), 'no node link for an unknown hash');
});

test('an unknown repeater shows its likely area and the named nodes next to it', () => {
  const fh = '1ea5e1952c93' + '0'.repeat(52);
  const withUnknown = Object.assign({}, MM, { unknown_repeaters: [
    { prefix: '9E3C', source: 'relayed', first_seen: '2026-10-30T14:00:00Z', last_seen: '2026-10-30T15:00:00Z', packets: 64, next: [
      { public_key: 'ffff' + '1'.repeat(60), side: 'before', packets: 30 },
      { public_key: fh, name: 'First Hill <3', near: 'First Hill, Seattle', side: 'observer', packets: 12 },
      { public_key: 'abcd' + '2'.repeat(60), name: 'Yesler', near: 'Yesler Terrace, Seattle', side: 'after', packets: 1200 },
    ] },
    { prefix: '1B36', source: 'relayed', first_seen: '2026-10-30T14:00:00Z', last_seen: '2026-10-30T15:00:00Z', packets: 5 },
  ] });
  const h = A.renderMediaMeshTabHtml(withUnknown, '');
  const row = (id) => h.split('<tr').find((r) => r.includes('<code>' + id + '</code>'));
  const r = row('9E3C');
  // the first neighbour with a Near gives the area
  assert.ok(r.includes('Probably near First Hill, Seattle'), r);
  assert.ok(r.includes('from <a href="#/nodes/ffff1111">ffff1111</a>') || r.includes('from <a href="#/nodes/ffff' + '1'.repeat(60) + '">ffff1111</a>'), r);
  assert.ok(r.includes('heard by <a href="#/nodes/' + fh + '">First Hill &lt;3</a> <span class="text-muted">×12</span>'), r);
  assert.ok(r.includes('to <a href="#/nodes/abcd') && r.includes('×1,200'), r);
  assert.ok(row('1B36').includes('<td data-value="">—</td>'), 'no neighbours: a dash');
});

test('headline tiles: longest link heard, photo and voice packets, coverage filled in later', () => {
  const mm = Object.assign({}, MM, {
    media: { packets: 735, median_hops: 2.5, max_hops: 6 },
    links: [
      { from: 'a', from_name: 'Skyline', observer_name: 'Rainier View', count: 89, from_lat: 47.606423, from_lon: -122.326254, to_lat: 47.502494, to_lon: -122.254413 },
      { from: 'b', from_name: 'Near', observer_name: 'First Hill', count: 50, from_lat: 47.6, from_lon: -122.32, to_lat: 47.601, to_lon: -122.32 },
      { from: 'c', from_name: 'No place', observer_name: 'X', count: 5, from_lat: 47.6, from_lon: -122.32 },
    ],
  });
  const ls = A.mediaMeshLinksByLength(mm);
  assert.strictEqual(ls.length, 2, 'links without both ends placed are left out');
  assert.ok(ls[0].from === 'Skyline' && Math.abs(ls[0].km - 12.6) < 0.3, JSON.stringify(ls[0]));
  const h = A.mediaMeshHeadlineHtml(mm);
  assert.ok(/<div class="stat-value">12\.\d km<\/div><div class="stat-label">Longest link heard<\/div><div class="stat-detail">Skyline → Rainier View/.test(h), h);
  assert.ok(h.includes('<div class="stat-value">735</div><div class="stat-label">Photo &amp; voice packets</div><div class="stat-detail">median 2.5 hops, up to 6</div>'), h);
  assert.ok(h.includes('id="mmStatArea">…<'), 'coverage waits for the map');
  assert.ok(A.mediaMeshHeadlineHtml(MM).includes('none heard directly yet'));
});

test('leaderboard: most relayed, longest links, newest, best placed from the map', () => {
  const mm = Object.assign({}, MM, {
    repeaters: [
      { public_key: 'aa', name: 'Busy', media_relayed_7d: 300, first_seen: '2026-10-20T00:00:00Z' },
      { public_key: 'bb', name: 'Quiet', media_relayed_7d: 0, first_seen: '2026-11-16T00:00:00Z' },
      { public_key: 'cc', name: 'Middle <b>', media_relayed_7d: 40, first_seen: '2026-11-01T00:00:00Z' },
    ],
  });
  const h = A.mediaMeshLeaderboardHtml(mm);
  const relayed = h.split('<section>')[1];
  assert.ok(relayed.indexOf('Busy') < relayed.indexOf('Middle &lt;b&gt;') && !relayed.includes('Quiet'), relayed);
  const newest = h.split('<section>')[4];
  assert.ok(newest.indexOf('Quiet') < newest.indexOf('Middle') && newest.indexOf('Middle') < newest.indexOf('Busy'), newest);
  assert.strictEqual(A.mediaMeshLeaderboardHtml(Object.assign({}, MM, { repeaters: [] })), '');
  // the map's figures fill the coverage tile and the best-placed list (ground view only)
  const els = {};
  const fake = { querySelector: (sel) => (els[sel] = els[sel] || { textContent: '', innerHTML: '' }) };
  A.mediaMeshOnCoverageStats(fake, { modeKey: 'repeater', areaKm2: 999, repAreas: [] });
  assert.strictEqual(els['#mmStatArea'], undefined, 'the repeater view is ignored');
  A.mediaMeshOnCoverageStats(fake, { modeKey: 'ground', areaKm2: 412.4, calibration: { used: true, n: 12 },
    repAreas: [{ rep: { public_key: 'aa', name: 'Small' }, km2: 3.24 }, { rep: { public_key: 'bb', name: 'Big' }, km2: 41 }, { rep: { name: 'None' }, km2: 0 }] });
  assert.strictEqual(els['#mmStatArea'].textContent, '412');
  assert.ok(els['#mmStatAreaDetail'].textContent.includes('checked against 12 real links'));
  const placed = els['#mmLeaderPlaced'].innerHTML;
  assert.ok(placed.indexOf('Big') < placed.indexOf('Small') && placed.includes('41 km²') && placed.includes('3.2 km²') && !placed.includes('None'), placed);
});

test('empty state explains what is needed', () => {
  const h = A.renderMediaMeshTabHtml({ mediamesh_transmissions: 0, repeaters: [], observers: [], per_hour: [] }, '');
  assert.ok(h.includes('No MediaMesh traffic or repeaters'));
});

test('the coverage card has everything the map script fills in, and gets the heard links', () => {
  const html = A.renderMediaMeshTabHtml(MM, '');
  for (const id of ['mmCoverageCard', 'mmCovMap', 'mmCovReps', 'mmCovRepSummary', 'mmCovRepPanel', 'mmCovGradient', 'mmCovOpacity', 'mmCovReadout', 'mmCovStatus',
    'mmCovProfile', 'mmCovMode', 'mmCovCal', 'mmCovPlan', 'mmCovTime', 'mmCovTimeRange', 'mmCovTimeLabel', 'mmStatArea', 'mmLeaderPlaced', 'mmCovLinksKey', 'mmCovLinksToggle', 'mmCovLinksWrap', 'mmCovLinks', 'mmCovHow']) {
    assert.strictEqual(html.split('id="' + id + '"').length, 2, id);
  }
  assert.ok(html.includes('data-mm-cov="ground"') && html.includes('data-mm-cov="repeater"'));
  assert.ok(/<div class="mm-cov-profile" id="mmCovProfile" hidden>/.test(html), 'no profile until a point is clicked');
  assert.ok(/id="mmCovRepPanel" hidden>/.test(html), 'the repeater picker starts closed');
  assert.ok(/id="mmCovLinksKey" hidden/.test(html) && /id="mmCovLinksWrap" hidden/.test(html), 'nothing about heard links until there are some');
  assert.ok(html.includes('Estimate, not a measurement'));
  assert.ok(html.includes('Repeaters without a saved position (Peak, Valley)'));
  assert.ok(analytics.includes('initMediaMeshCoverage(el, Array.isArray(mm.repeaters) ? mm.repeaters : [], Array.isArray(mm.links) ? mm.links : [])'));
  assert.ok(analytics.includes('window.MediaMeshCoverage.init(card, reps, { links: links || [], onStats: (st) => mediaMeshOnCoverageStats(el, st) })'));
  const css = fs.readFileSync('public/style.css', 'utf8');
  for (const cls of ['.mm-cov-chip', '.mm-cov-profile', '.mm-cov-prof-zone', '.mm-cov-prof-los', '.mm-cov-budget', '.mm-cov-how', '.mm-cov-links-table']) {
    assert.ok(css.includes(cls + ' {'), cls);
  }
});

test('tab button, switch case and bulk load are wired', () => {
  assert.ok(analytics.includes('data-tab="mediamesh">MediaMesh</button>'));
  assert.ok(analytics.includes("case 'mediamesh': await renderMediaMeshTab(el); break;"));
  assert.ok(/api\('\/analytics\/mediamesh' \+ sepMM[^)]*\)\.catch\(\(\) => null\)/.test(analytics), 'Overview data never fails the page');
});

console.log('\n=== Live ===');

const lctx = {};
vm.createContext(lctx);
vm.runInContext(extract(live, ['mediaMeshFeedBadgeHtml', 'groupIsMediaMesh']) + '\nthis.api = { mediaMeshFeedBadgeHtml, groupIsMediaMesh };', lctx);

test('feed rows on radio2 get the MediaMesh badge, others none', () => {
  assert.ok(lctx.api.mediaMeshFeedBadgeHtml({ mediamesh: true }).includes('badge-mediamesh'));
  assert.strictEqual(lctx.api.mediaMeshFeedBadgeHtml({}), '');
  assert.strictEqual(lctx.api.mediaMeshFeedBadgeHtml({ mediamesh: 'true' }), '');
});

test('a group is MediaMesh when any observation was on radio2', () => {
  assert.ok(lctx.api.groupIsMediaMesh([{}, { mediamesh: true }]));
  assert.ok(!lctx.api.groupIsMediaMesh([{}, {}]));
  assert.ok(!lctx.api.groupIsMediaMesh(null));
});

test('"MediaMesh only" toggle is wired, remembered and filters the view', () => {
  assert.ok(live.includes('id="liveMediaMeshToggle"'));
  assert.ok(live.includes("localStorage.getItem('live-mediamesh-only') === 'true'"));
  assert.ok(live.includes('if (mediaMeshOnly && !groupIsMediaMesh(packets)) return;'), 'renderer');
  assert.ok(live.includes('if (mediaMeshOnly && !groupIsMediaMesh(group.packets)) continue;'), 'feed rebuild');
});

test('the badge is added when a later observation is on radio2', () => {
  assert.ok(live.includes("pkt.mediamesh === true && !entry.element.querySelector('.badge-mediamesh')"));
  assert.ok(/mediamesh: packets\.some\(function \(p\) \{ return p && p\.mediamesh === true; \}\)/.test(live), 'consolidated row');
});

test('colours come from --mediamesh-path-color', () => {
  const css = fs.readFileSync('public/style.css', 'utf8') + fs.readFileSync('public/live.css', 'utf8');
  for (const cls of ['.mm-bar-segment', '.dumbbell-dot-mediamesh', '.badge-mediamesh', '.stat-card-mediamesh']) {
    const i = css.indexOf(cls + ' {');
    assert.ok(i >= 0, cls);
    assert.ok(css.slice(i, css.indexOf('}', i)).includes('var(--mediamesh-path-color)'), cls);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
