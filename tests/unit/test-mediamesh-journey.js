/* Unit tests for public/mediamesh-journey.js (how clips cross radio2) and
 * public/mediamesh-replay.js (replaying a clip's path). */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-journey.js'));
require(path.join(__dirname, '../../public/mediamesh-replay.js'));
require(path.join(__dirname, '../../public/mediamesh-insights.js'));
const J = globalThis.MediaMeshJourney;
const R = globalThis.MediaMeshReplay;
const I = globalThis.MediaMeshInsights;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}
console.log('\n=== MediaMesh: how clips cross radio2, and replays ===');

const clip = (o) => Object.assign({ sid: 'aaaa0001', kind: 'photo', total: 10, heard: 10, at: '2026-11-25T10:00:00Z', outcome: 'whole', path: ['aa11', 'bb22'], hops: 2, observerName: 'Obs' }, o);
const nameOf = (h) => ({ aa11: 'First Hill', bb22: 'SoDo' }[String(h).toLowerCase()] || String(h).toUpperCase());

test('durations read the way people say them', () => {
  assert.deepStrictEqual([J.fmtDur(45), J.fmtDur(100), J.fmtDur(120), J.fmtDur(720), J.fmtDur(3900), J.fmtDur(null)], ['45 s', '1 min 40 s', '2 min', '12 min', '1 h 5 min', '—']);
  assert.strictEqual(J.quantile([10, 20, 30, 40], 0.5), 20);
  assert.strictEqual(J.quantile([10, 20, 30, 40], 0.9), 40);
});

test('observers against receipts: one dot per delivery, the side tiles count the surprises', () => {
  const clips = [clip({ heard: 2, outcome: 'partial', delivery: { recipients: 3, whole: 2 } }), clip({ heard: 10, delivery: { recipients: 1, whole: 0 } }), clip({})];
  const dots = J.receiptDots(clips);
  assert.strictEqual(dots.length, 4);
  assert.deepStrictEqual(dots.map((d) => [d.x, d.whole]), [[0.2, true], [0.2, true], [0.2, false], [1, false]]);
  const h = J.vsReceiptsHtml(clips, []);
  assert.ok(h.includes('>2 of 3</div>') && h.includes('>1</div><div class="mm-ins-label">deliveries of clips heard whole by an observer'), h);
  assert.strictEqual((h.match(/class="mmj-dot"/g) || []).length, 2);
  assert.ok(J.vsReceiptsHtml([clip({})], []).includes('No receipts yet'));
});

test('time to whole: from the receipts, by kind or hops, half and nine in ten', () => {
  const d = (s) => ({ recipients: s.length, whole: s.length, wholeAfterS: s });
  const clips = [clip({ delivery: d([60, 100]) }), clip({ delivery: d([200]), hops: 6 }), clip({ kind: 'voice', delivery: d([30]) })];
  const un = [clip({ outcome: 'unannounced', kind: 'unknown', delivery: Object.assign(d([400]), { kind: 'photo' }) })];
  const t = J.wholeTimes(clips, un);
  assert.strictEqual(t.length, 5);
  assert.deepStrictEqual(t.filter((x) => x.kind === 'photo').map((x) => x.s), [60, 100, 200, 400]);
  assert.deepStrictEqual(t.find((x) => x.s === 200).hops, '5+ hops');
  const h = J.timeToWholeHtml(clips, un, 'photo');
  assert.ok(h.includes('>1 min 40 s</div><div class="mm-ins-label">half of photos') && h.includes('>6 min 40 s</div>'), h);
  assert.ok(h.includes('data-mmj-wait="hops" aria-pressed="false"') && h.includes('data-mmj-wait="photo" aria-pressed="true"'));
  assert.ok(h.includes('Only 4 so far'));
  assert.ok(J.timeToWholeHtml(clips, un, 'hops').includes('5+ hops (1)'));
  assert.ok(J.timeToWholeHtml([], [], 'photo').includes('No receipts with a whole clip yet'));
});

test('relays: the histogram, the median line, where clips entered, week by week', () => {
  const r = { pieces: 50, medianRelays: 24, airPerPieceS: 3.31, preset: '250 kHz, SF7, CR 4/5',
    bins: [{ label: '1–5', pieces: 2 }, { label: '6–10', pieces: 5 }, { label: '11–15', pieces: 11 }, { label: '16–20', pieces: 24 }, { label: '21–25', pieces: 38 }, { label: '26–30', pieces: 21 }, { label: '31+', pieces: 9 }],
    byStart: [{ hash: 'AA11', name: 'First Hill', median: 31 }, { hash: 'BB22', name: '', median: 18 }],
    weeks: [{ week: '2026-11-16', median: 22, pieces: 300 }, { week: '2026-11-23', median: 24, pieces: 10 }] };
  const h = J.relaysHtml(r, 'week', nameOf);
  assert.ok(h.includes('>24</div><div class="mm-ins-label">repeaters relay') && h.includes('3.3 s</div>') && h.includes('median 24'), h);
  assert.ok(h.includes('<span>First Hill</span>') && h.includes('<span>SoDo</span>'), 'unnamed starts named from the path hash');
  const w = J.relaysHtml(r, 'weeks', nameOf);
  assert.ok(w.includes('11-16') && w.includes('class="mmj-bar mmj-faded"'), 'a week with few pieces is faded');
  assert.ok(J.relaysHtml({ pieces: 0 }, 'week', nameOf).includes('No relayed pieces'));
});

test('airtime: typical and busiest per repeater, the line', () => {
  const h = J.airtimeHtml({ busyLinePct: 60, repeaters: [{ name: 'First <Hill>', typicalPct: 41, busiestPct: 72 }, { name: 'SoDo', typicalPct: 9, busiestPct: 26 }] });
  assert.ok(h.includes('First &lt;Hill&gt;') && h.includes('mm-ins-num mmj-over">72%') && h.includes('left:60.0%') && h.includes('>26%</span>') && !h.includes('mmj-over">26%'), h);
});

test('hop by hop: the share heard at each hop over the clips that got that far, the biggest drop', () => {
  const clips = [
    clip({ heardByHop: [10, 8, 6, 3], hops: 4 }), clip({ heardByHop: [10, 9, 6, 2], hops: 4 }), clip({ heardByHop: [10, 7, 6, 4], hops: 4 }),
    clip({ heardByHop: [10], hops: 1, path: ['cc33'], observerName: 'Far' }), clip({ heardByHop: [], hops: 0 }),
  ];
  const f = J.hopFunnel(clips, '', nameOf);
  assert.strictEqual(f.clips, 4);
  assert.deepStrictEqual(f.rows.map((r) => [r.hop, r.n, Math.round(r.share * 100)]), [[1, 4, 100], [2, 3, 80], [3, 3, 60], [4, 3, 30]]);
  assert.ok(f.rows[3].biggest && !f.rows[1].biggest);
  assert.deepStrictEqual(J.topRoutes(clips, nameOf), ['First Hill → Obs']);
  const h = J.hopsHtml(clips, nameOf, '');
  assert.ok(h.includes('−30 biggest') && h.includes('The hop to 4 loses the most') && h.includes('data-mmj-route="First Hill → Obs"'), h);
  assert.strictEqual(J.hopFunnel(clips, 'First Hill → Obs', nameOf).clips, 3);
});

test('which pieces go missing: missed or rebuilt counts, bunched at the start or spread', () => {
  const bunched = Array.from({ length: 6 }, (_, i) => clip({ sid: 's' + i, total: 20, outcome: 'parity', rebuilt: [0, 1], missing: i === 0 ? [10] : [] }));
  const s = J.missingSummary(bunched, 'all', []);
  assert.strictEqual(s.clips, 6);
  assert.strictEqual(s.buckets[0].share, 1);
  assert.ok(s.ratio > 1.5);
  const h = J.missingHtml(bunched, 'all', []);
  assert.ok(h.includes('Bunched at the start') && h.includes('data-mmj-missing="busy"'), h);
  const even = Array.from({ length: 6 }, (_, i) => clip({ sid: 'e' + i, total: 20, outcome: 'partial', missing: [i, i + 6, i + 12] }));
  assert.ok(J.missingHtml(even, 'all', []).includes('Spread evenly'));
  assert.ok(J.missingHtml(bunched, 'voice', []).includes('No announced clips here yet'));
  const hours = [{ t: '2026-11-25T10:00:00Z', packets: 100 }, { t: '2026-11-25T11:00:00Z', packets: 5 }, { t: '2026-11-25T12:00:00Z', packets: 6 }, { t: '2026-11-25T13:00:00Z', packets: 7 }];
  assert.deepStrictEqual([...J.busyHours(hours)], ['2026-11-25T10:00:00Z']);
  assert.strictEqual(J.missingSummary(bunched.concat(clip({ at: '2026-11-25T11:30:00Z', total: 20 })), 'busy', hours).clips, 6);
});

test('the cards sit in the tab in order, the section says it positively', () => {
  const c = I.cardsHtml();
  const order = ['mmDeliveryCard', 'mmjVsCard', 'mmSpeedCard', 'mmjWaitCard', 'How clips cross radio2', 'mmjRelaysCard', 'mmjAirCard', 'mmjHopsCard', 'mmjMissingCard', 'mmWeakCard', 'mmBusyCard'].map((k) => c.indexOf(k));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), JSON.stringify(order));
  assert.ok(!/slow/i.test(J.sectionHtml()));
  const html = pub('index.html');
  assert.ok(html.indexOf('mediamesh-journey.js?v=__BUST__') < html.indexOf('mediamesh-insights.js?v=__BUST__') && html.includes('<script src="mediamesh-replay.js?v=__BUST__"></script>'));
});

test('recent clips: a map button beside each route, greyed when nothing is kept to replay', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const h = I.deliveryHtml([clip({ replay: true }), clip({ sid: 'aaaa0002', at: '2026-11-25T09:00:00Z' })], nameOf, 7,
    [], [clip({ sid: 'pe66925f2e0', outcome: 'private', kind: 'unknown', total: 0, heard: 11, channel: 'xx', replay: true, at: '2026-11-25T11:00:00Z' })], now);
  assert.ok(h.includes('data-mm-replay="aaaa0001"') && h.includes('data-mm-replay="pe66925f2e0"'), h);
  assert.ok(h.includes('class="mm-replay-btn" disabled'), 'no replay for the second');
  assert.ok(h.includes('on a private channel</span>') && !h.includes('(XX)'), 'an unknown channel isn\'t shown as XX');
  assert.ok(h.includes('to replay its path on a map'));
});

test('replay: events from the flight recorder, places, what\'s relaying when', () => {
  const log = {
    announcement: { at: '2026-11-25T19:38:42Z' },
    clip: { total: 17, outcome: 'parity', lastAt: '2026-11-25T19:41:04Z', observerName: 'First Hill' },
    pieces: [
      { index: 5, heard: [{ at: '2026-11-25T19:38:45Z', path: ['FBA9', '1FFB'], name: 'Rainier View' }, { at: '2026-11-25T19:38:47Z', path: ['FBA9', '1FFB', '5491', '1EA5'], name: 'First Hill' }] },
      { index: -1, parity: true, heard: [{ at: '2026-11-25T19:39:30Z', path: ['D011'], name: 'First Hill' }] },
    ],
    hops: { fba9: { name: 'N1TJT', lat: 47.62, lon: -122.31 }, '1ffb': { name: 'Skyline', lat: 47.60, lon: -122.32 }, d011: { name: 'Kremwerk' } },
  };
  const { events, end, t0 } = R.replayEvents(log);
  assert.deepStrictEqual(events.map((e) => [e.t, e.parity, e.path.length]), [[3, false, 2], [5, false, 4], [48, true, 1]]);
  assert.strictEqual(end, 48);
  assert.deepStrictEqual(Object.keys(R.hopPlaces(log)).sort(), ['1ffb', 'fba9'], 'hops without a place are left off the map');
  assert.deepStrictEqual(R.activeAt(events, 4).map((e) => e.t), [3]);
  assert.deepStrictEqual(R.activeAt(events, 6).map((e) => e.t), [5]);
  assert.deepStrictEqual(R.along([[0, 0], [0, 10], [10, 10]], 0.75), [5, 10]);
  assert.strictEqual(R.nextT(events, 8, 0.4, end), 47.5, 'a quiet stretch is skipped');
  assert.strictEqual(R.nextT(events, 4, 0.4, end), 4.4);
  assert.strictEqual(R.nextT(events, 51, 0.4, end), 0, 'loops at the end');
  const h = R.heardBy(events, 10);
  assert.deepStrictEqual([h.data, h.parity, h.relays], [1, 0, 2]);
  assert.strictEqual(R.wholeAtS(log, t0), 142);
  assert.strictEqual(R.wholeAtS(Object.assign({}, log, { private: true }), t0), null);
  assert.strictEqual(R.fmtClock(142), '2:22');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
