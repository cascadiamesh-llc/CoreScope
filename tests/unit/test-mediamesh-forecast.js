/* Unit tests for public/mediamesh-forecast.js: Forecast. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/mediamesh-forecast.js'));
const F = globalThis.MediaMeshForecast;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

console.log('\n=== Forecast ===');

test('weather by hour: inversion as 850 hPa minus 2 m', () => {
  const w = F.weatherByHour({ hourly: { time: ['2026-11-22T00:00', '2026-11-22T01:00', 'bad'], temperature_2m: [5, 6, 1], temperature_850hPa: [3, -4, 1], precipitation: [0, 1.5, 0], wind_speed_10m: [10, 20, 0] } });
  assert.deepStrictEqual(w.get(Date.parse('2026-11-22T00:00:00Z')), { stab: -2, rain: 0, wind: 10 });
  assert.strictEqual(w.get(Date.parse('2026-11-22T01:00:00Z')).stab, -10);
  assert.strictEqual(w.size, 2);
});

test('a link that follows the inversion: fitted, and forecast from it', () => {
  // SNR = 4 + 1.5 per degree of inversion (around -6), a little noise
  let s = 3;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return (s >> 8) / 8388608 - 0.5; };
  const rows = Array.from({ length: 120 }, () => { const stab = -12 + r() * 16 + 6; return { stab, rain: Math.max(0, r()), wind: 10 + r() * 10, snr: 4 + 1.5 * (stab + 6) + r() * 0.5, n: 3 }; });
  const f = F.fitLink(rows);
  assert.ok(Math.abs(f.b[1] - 1.5) < 0.15, String(f.b[1]));
  assert.strictEqual(f.hours, 120);
  const d = F.delta(f, { stab: f.means.stab + 4, rain: f.means.rain, wind: f.means.wind });
  assert.ok(Math.abs(d - 6) < 0.7, String(d));
  assert.strictEqual(F.why(f, { stab: f.means.stab + 4, rain: f.means.rain, wind: f.means.wind }), 'the inversion lifts it');
  assert.strictEqual(F.why(f, { stab: f.means.stab, rain: f.means.rain, wind: f.means.wind }), 'barely moves with the weather');
  assert.strictEqual(F.fitLink(rows.slice(0, F.MIN_HOURS - 1)), null, 'too few hours');
  assert.deepStrictEqual(F.solve([[2, 0], [0, 4]], [2, 8]), [1, 2]);
  assert.strictEqual(F.solve([[1, 1], [1, 1]], [1, 1]), null);
});

test('the days ahead, and their weather in words', () => {
  const base = new Date(2026, 10, 22, 14, 0, 0).getTime();
  const w = new Map();
  for (let h = 0; h < 80; h++) w.set(base + h * 3600000, { stab: h < 30 ? 0 : -10, rain: h >= 20 && h < 30 ? 1 : 0, wind: h >= 40 ? 50 : 5 });
  const days = F.daysAhead(base, w);
  assert.strictEqual(days[0].label, 'Tonight');
  assert.ok(days[0].hours.length === 6 && days[0].hours.every((ms) => new Date(ms).getHours() >= 18), 'tonight: from 6 PM');
  assert.strictEqual(days[1].label, 'Tomorrow');
  assert.strictEqual(F.dayWeather(days[0].hours, w).head, 'Temperature inversion');
  assert.ok(F.dayWeather(days[1].hours, w).head.startsWith('Rain'));
  assert.ok(F.dayWeather(days[2].hours, w).head.startsWith('Windy'));
});

test('wiring', () => {
  assert.ok(pub('index.html').includes('<script src="mediamesh-forecast.js?v=__BUST__"></script>'));
  assert.ok(pub('app.js').includes("'mediamesh-forecast': 'Forecast'"));
  assert.ok(pub('analytics.js').includes('href="#/mediamesh-forecast"'));
  const css = pub('style.css').match(/\.mmf-[^{]*\{[^}]*\}/g) || [];
  assert.ok(css.length > 15);
  for (const r of css) assert.ok(!/(^|[;{\s])(color|background|fill):\s*#/i.test(r), 'a fixed colour: ' + r.slice(0, 60));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
