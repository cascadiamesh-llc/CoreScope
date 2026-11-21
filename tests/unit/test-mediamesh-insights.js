/* Unit tests for public/mediamesh-insights.js: delivery, speed, busy times
 * and weak spots in the backbone. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-insights.js'));
const I = globalThis.MediaMeshInsights;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}
console.log('\n=== MediaMesh insights ===');

const reps = [{ public_key: 'aa11' + '0'.repeat(60), name: 'First <Hill>' }, { public_key: 'bb22' + '0'.repeat(60), name: 'SoDo' }, { public_key: 'aa99' + '0'.repeat(60), name: 'Other' }];
const nameOf = I.namer(reps);
const clip = (o) => Object.assign({ sid: '1', kind: 'photo', total: 4, at: '2026-11-18T12:00:00Z', outcome: 'whole', path: ['aa11', 'bb22'], hops: 2, observerName: 'Obs', durationS: 40, bytes: 1000 }, o);

test('names: a hash matching one repeater gets its name; ambiguous or unknown stays a hash', () => {
  assert.strictEqual(nameOf('aa11'), 'First <Hill>');
  assert.strictEqual(nameOf('aa'), 'AA');
  assert.strictEqual(nameOf('cc'), 'CC');
  assert.strictEqual(I.routeLabel(clip({}), nameOf), 'First <Hill> → SoDo → Obs');
  assert.strictEqual(I.routeLabel(clip({ observerName: 'SoDo' }), nameOf), 'First <Hill> → SoDo', 'the observer is the last repeater');
  assert.strictEqual(I.routeLabel(clip({ path: ['aa11', 'cc', 'dd', 'bb22'] }), nameOf), 'First <Hill> → … → SoDo → Obs');
  assert.strictEqual(I.clipLabel(clip({ kind: 'video', seconds: 9 })), 'Video, 9 s');
});

test('delivery: whole, by parity, incomplete, unheard; by hops', () => {
  const clips = [clip({}), clip({ outcome: 'parity', rebuilt: [1] }), clip({ outcome: 'partial', missing: [2], hops: 6 }), clip({ outcome: 'none', hops: 0 })];
  const s = I.deliverySummary(clips);
  assert.deepStrictEqual([s.n, s.whole, s.parity, s.partial, s.unheard], [3, 1, 1, 1, 1]);
  assert.deepStrictEqual(s.byHops.find((b) => b.hops === 5), { hops: 5, n: 1, ok: 0 });
  assert.deepStrictEqual(s.byHops.find((b) => b.hops === 2), { hops: 2, n: 2, ok: 2 });
  const h = I.deliveryHtml(clips, nameOf, 7);
  assert.ok(h.includes('Heard whole by an observer: 2 of 3 (1 with parity). The rest passed out of the observers\' hearing'), h);
  assert.ok(h.includes('>3</div><div class="mm-ins-label">announced clips heard by observers, up to 6 hops') && !/\d+%/.test(h.split('<h4>')[0].split('</p>').slice(1).join('')), 'counts, no percentages');
  assert.ok(h.includes('<h4>Clips heard, by hops</h4>'));
  assert.ok(!/arrived incomplete|Did it get through/.test(h), 'what the observers heard, not whether it arrived');
  assert.ok(h.includes('the receiving app rebuilds or asks again'));
  assert.ok(h.includes('First &lt;Hill&gt;') && !h.includes('First <Hill>'), 'escaped');
  assert.ok(h.includes('class="is-missing"') && h.includes('class="is-rebuilt"') && h.includes('3 of 4'));
  assert.ok(I.deliveryHtml([], nameOf, 7).includes('No announced clips'));
});

test('speed: kbit/s from bytes over time, by hops, the fastest route needs two clips', () => {
  const clips = [clip({ hops: 1, path: ['aa11'], observerName: 'SoDo', durationS: 8, bytes: 2000 }), clip({ hops: 1, path: ['aa11'], observerName: 'SoDo', durationS: 16, bytes: 2000 }),
    clip({ hops: 3, durationS: 100, bytes: 2500 }), clip({ outcome: 'partial', durationS: 1, bytes: 9999 }), clip({ durationS: 0 })];
  const s = I.speedSummary(clips, nameOf);
  assert.strictEqual(s.n, 3);
  assert.ok(Math.abs(s.byHops[0].kbps - 1.5) < 1e-9, 'median of 2 and 1 kbit/s');
  assert.strictEqual(s.fastest.route, 'First <Hill> → SoDo');
  assert.strictEqual(s.photo1, 12);
  assert.ok(I.speedHtml(clips, nameOf, 7).includes('fastest route this period, 1.5 kbit/s over 2 clips'));
});

test('clips sent privately: timed in the speed card, counted in the delivery card, never judged', () => {
  const priv = [clip({ outcome: 'unannounced', kind: 'unknown', total: 0, heard: 6, hops: 2, durationS: 20, bytes: 1000, at: '2026-11-20T01:00:00Z' }),
    clip({ outcome: 'unannounced', kind: 'unknown', total: 0, heard: 1, durationS: 5, bytes: 150 })];
  const s = I.speedSummary([], nameOf, priv);
  assert.deepStrictEqual([s.n, s.priv], [1, 1], 'two pieces at least');
  assert.ok(Math.abs(s.kbps - 0.4) < 1e-9);
  const h = I.speedHtml([], nameOf, 7, priv);
  assert.ok(h.includes('median speed, 1 clip, 1 sent privately') && h.includes('Sent privately, 1.0 kB'), h);
  const d = I.deliveryHtml([], nameOf, 7, priv);
  assert.ok(d.includes('No announced clips') && d.includes('2 clips sent privately were heard') && d.includes('direct message'));
  const both = I.deliveryHtml([clip({ outcome: 'partial', missing: [1, 2] })], nameOf, 7, priv);
  assert.ok(both.includes('>2</div><div class="mm-ins-label">more sent privately') && both.includes('Heard whole by an observer: 0 of 1.'), both);
  assert.strictEqual(I.deliverySummary([]).n, 0, 'not judged');
  assert.ok(I.speedHtml([], nameOf, 7).includes('No clips with more than one piece heard yet'));
});

test('did it arrive: receipts from the receiving apps, per clip and overall', () => {
  const clips = [clip({ outcome: 'partial', missing: [1, 2], delivery: { recipients: 1, whole: 1, asked: 1, rebuilt: 0 } }),
    clip({ delivery: { recipients: 3, whole: 2, asked: 0, rebuilt: 1 } }), clip({})];
  const priv = [clip({ outcome: 'unannounced', kind: 'unknown', total: 0, delivery: { recipients: 1, whole: 1, asked: 0, rebuilt: 0 } })];
  assert.deepStrictEqual(I.arrivalSummary(clips, priv), { clips: 3, recipients: 5, whole: 4, asked: 1, rebuilt: 1 });
  assert.strictEqual(I.arrivalText(clips[0]), 'whole, after asking again');
  assert.strictEqual(I.arrivalText(clips[1]), 'whole for 2 of 3');
  assert.strictEqual(I.arrivalText(clip({ delivery: { recipients: 2, whole: 2 } })), 'whole for all 2');
  assert.strictEqual(I.arrivalText(clip({ delivery: { recipients: 1, whole: 0 } })), 'arrived in part');
  assert.strictEqual(I.arrivalText(clips[2]), '');
  const h = I.deliveryHtml(clips, nameOf, 7, priv);
  assert.ok(h.indexOf('<h3>Did it arrive?</h3>') === 0 && h.includes('80%</div><div class="mm-ins-label">arrived whole: 4 of 5 deliveries of 3 clips'), h);
  assert.ok(h.includes('<th scope="col">Recipient</th>') && h.includes('class="mm-ins-arrived">whole, after asking again') && h.includes('Never what was in it'));
  assert.ok(I.deliveryHtml([clip({})], nameOf, 7).includes('None shared yet.'), 'says how to get them');
});

test('busy: bins by local weekday and hour, per week; the toggle and peak', () => {
  const mon9 = new Date(2026, 10, 16, 21, 0, 0); // Monday 9 pm local
  const hours = [{ t: mon9.toISOString(), packets: 40, clips: 2, partial: 1 }, { t: new Date(2026, 10, 9, 21).toISOString(), packets: 20, clips: 0, partial: 0 }];
  const b = I.busyGrid(hours, new Date(2026, 10, 4).toISOString(), new Date(2026, 10, 18).toISOString());
  assert.strictEqual(b.weeks, 2);
  assert.strictEqual(b.grid[0][21].packets, 30);
  const h = I.busyHtml(b, 'packets', 14);
  assert.ok(h.includes('Busiest: Mon, 9 pm–10 pm') && h.includes('class="is-peak"'));
  assert.ok(h.includes('data-mm-busy="clips"') && h.includes('aria-pressed="true"'));
  assert.ok(I.busyHtml(I.busyGrid([], new Date().toISOString(), new Date().toISOString()), 'partial', 7).includes('Nothing to show yet'));
});

test('weak spots: cut repeaters and hops, the hub, the best new link', () => {
  const P = { a: [47.61, -122.32], b: [47.62, -122.32], c: [47.6, -122.33], d: [47.5, -122.25], e: [47.52, -122.26], f: [47.51, -122.27], x: [48, -122], y: [48.01, -122] };
  const E = (a, b, n) => ({ a, b, a_name: a.toUpperCase(), b_name: b.toUpperCase(), packets: n, a_lat: P[a][0], a_lon: P[a][1], b_lat: P[b][0], b_lon: P[b][1] });
  // a triangle up north (a b c), a bridge c-d, a triangle down south (d e f), and an island x-y
  const ws = I.weakSpots([E('a', 'b', 50), E('b', 'c', 40), E('a', 'c', 30), E('c', 'd', 20), E('d', 'e', 10), E('e', 'f', 5), E('d', 'f', 5), E('x', 'y', 3)], 20);
  assert.deepStrictEqual(ws.cuts.map((c) => c.name).sort(), ['C', 'D']);
  assert.deepStrictEqual(ws.cuts.find((c) => c.name === 'C').cutOff, ['A', 'B'], 'the smaller side, and not the island');
  assert.deepStrictEqual(ws.bridges.map((b) => b.aName + '-' + b.bName), ['C-D']);
  assert.ok(ws.score > 0 && ws.score < 85, String(ws.score));
  assert.ok(ws.fix && ws.fix.score > ws.score && ['a', 'b', 'c'].includes(ws.fix.a) !== ['a', 'b', 'c'].includes(ws.fix.b), JSON.stringify(ws.fix));
  const h = I.weakHtml(ws);
  assert.ok(h.includes('Biggest fix') && h.includes('id="mmWeakMap"') && h.includes('The only hop to'));
  // a ring has no weak spot
  const ring = I.weakSpots([E('a', 'b', 1), E('b', 'c', 1), E('a', 'c', 1)]);
  assert.strictEqual(ring.score, 100);
  assert.ok(I.weakHtml(ring).includes('Every repeater on the backbone has a way around'));
  assert.ok(I.weakHtml(I.weakSpots([E('a', 'b', 1)])).includes('at least three repeaters'));
});

test('wiring and readable colours', () => {
  const a = pub('analytics.js');
  assert.ok(a.includes('window.MediaMeshInsights.cardsHtml()') && a.includes('window.MediaMeshInsights.init(el, mm)'));
  assert.ok(pub('index.html').includes('<script src="mediamesh-insights.js?v=__BUST__"></script>'));
  const css = pub('style.css').match(/\.mm-ins[^{]*\{[^}]*\}|\.mm-pieces[^{]*\{[^}]*\}/g) || [];
  assert.ok(css.length > 20);
  for (const r of css) assert.ok(!/(^|[;{\s])color:\s*#/i.test(r), 'a fixed text colour: ' + r.slice(0, 60));
});

test('recent clips: when each was sent, in the viewer\'s time', () => {
  const now = Date.parse('2026-11-21T20:00:00Z');
  const h = I.whenHtml('2026-11-21T19:05:00Z', now);
  assert.ok(h.startsWith('<time datetime="2026-11-21T19:05:00.000Z"') && !h.includes('2026</time>'), h);
  assert.ok(I.whenHtml('2025-03-01T10:00:00Z', now).includes('2025'), 'another year shows the year');
  assert.ok(I.whenHtml('nope', now).includes('—'));
  const html = I.deliveryHtml([clip({})], (k) => k, 7, []) + I.speedHtml([clip({})], (k) => k, 7, []);
  assert.strictEqual((html.match(/<th scope="col">Sent<\/th>/g) || []).length, 2, 'both tables');
  assert.ok(html.includes('>Took</th>'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
