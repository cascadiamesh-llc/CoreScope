/* === CoreScope — mediamesh-forecast.js ===
 * Forecast (#/mediamesh-forecast): how radio2's links should do over the
 * next days, from the weather ahead and how each link has done in weather
 * like it. Each link heard on radio2 has an hourly SNR history
 * (/api/mediamesh/link-history); the weather is Open-Meteo's, through the
 * analyzer (/api/mediamesh/weather). Per link, SNR is fitted to the
 * temperature inversion (850 hPa minus 2 m: the higher, the more stable the
 * air, and over water the further radio carries), rain and wind; the
 * forecast is the fit at the weather to come, against the link's usual.
 */
'use strict';

(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtDb = (v) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0).replace(/\.0$/, ''));
  const MIN_HOURS = 24;

  /** Weather by hour (ms → { stab, rain, wind }) from Open-Meteo's hourly. */
  function weatherByHour(w) {
    const h = (w && w.hourly) || {}, out = new Map();
    (h.time || []).forEach((t, i) => {
      const ms = Date.parse(/Z$/.test(t) ? t : t + 'Z');
      const t2 = h.temperature_2m && h.temperature_2m[i], t850 = h.temperature_850hPa && h.temperature_850hPa[i];
      if (!Number.isFinite(ms) || !Number.isFinite(t2) || !Number.isFinite(t850)) return;
      out.set(ms, { stab: t850 - t2, rain: Number(h.precipitation && h.precipitation[i]) || 0, wind: Number(h.wind_speed_10m && h.wind_speed_10m[i]) || 0 });
    });
    return out;
  }

  /** Solves A x = b (small, by elimination); null when singular. */
  function solve(A, b) {
    const n = b.length, M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-9) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  /**
   * One link's fit: SNR ≈ b0 + b1·stab + b2·rain + b3·wind, gently held
   * toward no effect (so a link heard in one kind of weather only isn't
   * over-read). rows: [{ snr, n, stab, rain, wind }]. Returns { b, mean
   * (its usual SNR), means (of the weather), hours } or null.
   */
  function fitLink(rows) {
    const use = rows.filter((r) => Number.isFinite(r.snr));
    if (use.length < MIN_HOURS) return null;
    const keys = ['stab', 'rain', 'wind'];
    const means = {};
    keys.forEach((k) => { means[k] = use.reduce((a, r) => a + r[k], 0) / use.length; });
    const X = use.map((r) => [1].concat(keys.map((k) => r[k] - means[k])));
    const w = use.map((r) => Math.min(5, r.n || 1));
    const A = [0, 1, 2, 3].map(() => [0, 0, 0, 0]), bb = [0, 0, 0, 0];
    X.forEach((x, i) => {
      for (let p = 0; p < 4; p++) {
        bb[p] += w[i] * x[p] * use[i].snr;
        for (let q = 0; q < 4; q++) A[p][q] += w[i] * x[p] * x[q];
      }
    });
    const W = w.reduce((a, v) => a + v, 0);
    // ridge: a fifth of an hour's weight per unit squared, scaled to the data
    for (let p = 1; p < 4; p++) A[p][p] += 0.2 * W * (p === 1 ? 1 : p === 2 ? 0.25 : 0.01);
    const b = solve(A, bb);
    if (!b) return null;
    return { b, mean: b[0], means, hours: use.length };
  }

  /** The fit's change from usual (dB) for a weather hour. */
  function delta(fit, wx) {
    return fit.b[1] * (wx.stab - fit.means.stab) + fit.b[2] * (wx.rain - fit.means.rain) + fit.b[3] * (wx.wind - fit.means.wind);
  }

  /** What moves the link most, in words. */
  function why(fit, wx) {
    const parts = [['inversion', fit.b[1] * (wx.stab - fit.means.stab)], ['rain', fit.b[2] * (wx.rain - fit.means.rain)], ['wind', fit.b[3] * (wx.wind - fit.means.wind)]];
    parts.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (Math.abs(parts[0][1]) < 1) return 'barely moves with the weather';
    return parts[0][0] === 'inversion' ? (parts[0][1] > 0 ? 'the inversion lifts it' : 'no inversion to help')
      : parts[0][0] === 'rain' ? 'rain takes some off' : 'wind sways the masts';
  }

  /** The days ahead in local time: [{ key, label, hours: [ms] }]; tonight
   * is the rest of today from 6 PM, or today when it's later. */
  function daysAhead(now, wxByHour) {
    const out = [];
    const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
    const today = day(now);
    const labels = ['Tonight', 'Tomorrow'];
    const keys = [];
    [...wxByHour.keys()].filter((ms) => ms >= now - 3600000).sort((a, b) => a - b).forEach((ms) => {
      const k = day(ms);
      if (k === today && new Date(ms).getHours() < 18 && new Date(now).getHours() < 18) return;
      if (!keys.includes(k)) keys.push(k);
    });
    keys.slice(0, 4).forEach((k, i) => {
      const evening = k === today && new Date(now).getHours() < 18;
      const hours = [...wxByHour.keys()].filter((ms) => day(ms) === k && ms >= now - 3600000 && !(evening && new Date(ms).getHours() < 18));
      const first = new Date(hours[0] || now);
      out.push({ key: k, label: i < 2 ? labels[i] : first.toLocaleDateString(undefined, { weekday: 'long' }), hours });
    });
    if (out.length && out[0].key !== today) out[0].label = 'Tomorrow';
    return out;
  }

  /** A day's weather in a few words, with an icon name. */
  function dayWeather(hours, wxByHour) {
    const ws = hours.map((h) => wxByHour.get(h)).filter(Boolean);
    if (!ws.length) return { head: '—', icon: 'clear' };
    const stab = Math.max(...ws.map((w) => w.stab)), rain = ws.reduce((a, w) => a + w.rain, 0), wind = Math.max(...ws.map((w) => w.wind));
    if (rain >= 5) return { head: `Rain, ${Math.round(rain)} mm`, icon: 'rain', stab, rain, wind };
    if (wind >= 35) return { head: `Windy, gusts to ${Math.round(wind)} km/h`, icon: 'wind', stab, rain, wind };
    if (stab >= -3) return { head: 'Temperature inversion', icon: 'inversion', stab, rain, wind };
    return { head: 'Settled', icon: 'clear', stab, rain, wind };
  }

  const ICONS = {
    inversion: 'M5 22h24 M8 16h18 M11 10h12',
    rain: 'M9 18a6 6 0 1 1 11-5 5 5 0 1 1 3 9H9z M12 26l-1 3 M18 26l-1 3',
    wind: 'M4 12h18a4 4 0 1 0-4-4 M4 18h22a4 4 0 1 1-4 4 M4 24h10',
    clear: 'M17 11a6 6 0 1 0 0.01 0 M17 2v4 M17 28v4 M2 17h4 M28 17h4',
  };

  // ---- The page --------------------------------------------------------------

  let destroyed = false;

  function pageHtml() {
    return `<div class="mmf-page">
      ${root.MediaMeshNav ? root.MediaMeshNav.html('forecast') : ''}
      <div class="mmf-head">
        <h1>Forecast</h1>
        <p class="text-muted">How far MediaMesh should carry over the next days: the weather ahead, and how each link heard on radio2 has done in weather like it.</p>
      </div>
      <p class="text-muted" id="mmfStatus">Loading…</p>
      <div class="mmf-days" id="mmfDays"></div>
      <div class="mmf-split">
        <div class="mmf-card mmf-wide"><h2>Links tonight</h2><div id="mmfLinks"></div></div>
        <div class="mmf-card"><h2>What it learned</h2><div id="mmfLearned"></div></div>
      </div>
      <p class="text-muted mmf-note">Weather: Open-Meteo, for the middle of the mesh. Inversion: the temperature at 850 hPa (about 1.5 km up) against at 2 m; the warmer the air above, the more stable, and over water radio carries further. Each link's fit needs ${MIN_HOURS} hours heard; it learns more every day the analyzer keeps hearing it.</p>
    </div>`;
  }

  async function init(app) {
    destroyed = false;
    app.innerHTML = pageHtml();
    const $ = (id) => app.querySelector('#' + id);
    const status = (t) => { if (!destroyed) $('mmfStatus').textContent = t; };
    let mm, hist, wx;
    try {
      mm = await CSApi.fetch('/api/analytics/mediamesh').then((r) => r.json());
    } catch (_) { status('The analyzer could not be reached.'); return; }
    const placed = ((mm && mm.repeaters) || []).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    const lat = placed.length ? placed.reduce((a, r) => a + r.lat, 0) / placed.length : 47.6;
    const lon = placed.length ? placed.reduce((a, r) => a + r.lon, 0) / placed.length : -122.33;
    try {
      [hist, wx] = await Promise.all([
        CSApi.fetch('/api/mediamesh/link-history?days=60').then((r) => (r.ok ? r.json() : { hours: [] })).catch(() => ({ hours: [] })),
        CSApi.fetch(`/api/mediamesh/weather?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`).then((r) => { if (!r.ok) throw new Error('weather'); return r.json(); }),
      ]);
    } catch (_) {
      status('The weather could not be loaded, so there is no forecast right now.');
      return;
    }
    if (destroyed) return;
    const wxByHour = weatherByHour(wx);
    // each link's hours, with the weather then
    const names = new Map(((mm && mm.links) || []).map((l) => [`${String(l.from).toLowerCase()}|${String(l.observer_id).toLowerCase()}`, l]));
    const byLink = new Map();
    ((hist && hist.hours) || []).forEach((h) => {
      const k = `${String(h.from).toLowerCase()}|${String(h.observer_id).toLowerCase()}`;
      const w = wxByHour.get(Date.parse(h.hour));
      if (!w) return;
      if (!byLink.has(k)) byLink.set(k, []);
      byLink.get(k).push(Object.assign({ snr: h.snr, n: h.n }, w));
    });
    const fits = [];
    byLink.forEach((rows, k) => {
      const f = fitLink(rows);
      if (f) fits.push(Object.assign(f, { key: k, rows, link: names.get(k) }));
    });
    const now = Date.now();
    const days = daysAhead(now, wxByHour);
    const hoursKept = (hist && hist.hours && hist.hours.length) || 0;
    status(fits.length
      ? `${fits.length} link${fits.length === 1 ? '' : 's'} with enough history to forecast, from ${hoursKept.toLocaleString()} link-hours.`
      : `Learning: ${hoursKept.toLocaleString()} link-hours kept so far. A link's forecast starts once it has been heard in ${MIN_HOURS} hours.`);
    // the days
    $('mmfDays').innerHTML = days.map((d, i) => {
      const dw = dayWeather(d.hours, wxByHour);
      const ds = fits.map((f) => d.hours.map((h) => delta(f, wxByHour.get(h))).reduce((a, v) => a + v, 0) / Math.max(1, d.hours.length));
      const med = ds.length ? ds.slice().sort((a, b) => a - b)[ds.length >> 1] : null;
      const cls = med == null ? '' : med >= 2 ? 'mmf-up' : med <= -2 ? 'mmf-down' : '';
      const text = med == null ? 'Forecast once the links have some history.'
        : Math.abs(med) < 1 ? 'Links as usual.' : med > 0 ? 'Links stronger than usual: the long ones over water most.' : 'Links weaker than usual.';
      return `<div class="mmf-day${i === 0 ? ' mmf-day--now' : ''}"><div class="mmf-dayhead"><svg width="32" height="32" viewBox="0 0 34 34" aria-hidden="true"><path d="${ICONS[dw.icon]}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>
        <div><div class="mmf-when">${esc(d.label)}</div><div class="mmf-what">${esc(dw.head)}</div></div></div>
        <div class="mmf-db ${cls}">${med == null ? 'Learning' : Math.abs(med) < 1 ? 'Normal' : fmtDb(med) + ' dB'}</div><div class="mmf-text">${esc(text)}</div></div>`;
    }).join('');
    // links tonight
    const tonight = days[0];
    if (!fits.length || !tonight) {
      $('mmfLinks').innerHTML = '<p class="text-muted">No link has enough history yet.</p>';
    } else {
      const rows = fits.slice().sort((a, b) => b.hours - a.hours).slice(0, 10).map((f) => {
        const ds = tonight.hours.map((h) => delta(f, wxByHour.get(h)));
        const d = ds.reduce((a, v) => a + v, 0) / Math.max(1, ds.length);
        const mid = wxByHour.get(tonight.hours[Math.floor(tonight.hours.length / 2)]) || wxByHour.get(tonight.hours[0]);
        const l = f.link || {};
        const name = `${esc(l.from_name || f.key.split('|')[0].slice(0, 8))} → ${esc(l.observer_name || f.key.split('|')[1].slice(0, 8))}`;
        return `<tr><td>${name}</td><td class="mm-ins-num">${fmtDb(f.mean)} dB</td><td class="mm-ins-num"><strong class="${d >= 2 ? 'mmf-up' : d <= -2 ? 'mmf-down' : ''}">${fmtDb(f.mean + d)} dB</strong></td><td class="text-muted">${esc(why(f, mid))}</td></tr>`;
      }).join('');
      $('mmfLinks').innerHTML = `<div class="mm-ins-scroll"><table class="analytics-table mmf-table"><thead><tr><th scope="col">Link</th><th scope="col" class="mm-ins-num">Usually</th><th scope="col" class="mm-ins-num">Tonight</th><th scope="col">Why</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    // what it learned: the link that follows the inversion most
    const best = fits.filter((f) => f.hours >= MIN_HOURS).sort((a, b) => Math.abs(b.b[1]) * Math.sqrt(b.hours) - Math.abs(a.b[1]) * Math.sqrt(a.hours))[0];
    if (!best) {
      $('mmfLearned').innerHTML = '<p class="text-muted">Nothing yet.</p>';
    } else {
      const xs = best.rows.map((r) => r.stab), ys = best.rows.map((r) => r.snr);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const X = (v) => 10 + ((v - x0) / Math.max(0.1, x1 - x0)) * 280, Y = (v) => 150 - ((v - y0) / Math.max(0.1, y1 - y0)) * 140;
      const dots = best.rows.slice(-400).map((r) => `<circle cx="${X(r.stab).toFixed(1)}" cy="${Y(r.snr).toFixed(1)}" r="3"></circle>`).join('');
      const l = best.link || {};
      $('mmfLearned').innerHTML = `<p class="text-muted mmf-sub">${esc(l.from_name || best.key.split('|')[0].slice(0, 8))} → ${esc(l.observer_name || '')}: SNR against the inversion, ${best.hours} hours.</p>
        <figure class="mmf-fig"><svg viewBox="0 0 300 160" role="img" aria-label="SNR against the inversion: ${best.b[1] >= 0 ? 'stronger' : 'weaker'} as the air above warms">${dots}</svg>
        <figcaption class="mmf-axis"><span>Less stable air</span><span>Inversion</span></figcaption></figure>
        <p class="mmf-learn">${fmtDb(best.b[1])} dB for every degree warmer the air 1.5 km up is, against the ground${Math.abs(best.b[2]) >= 0.3 ? `; ${fmtDb(best.b[2])} dB a millimetre of rain an hour` : ''}.</p>`;
    }
  }

  function destroy() { destroyed = true; }

  root.MediaMeshForecast = { weatherByHour, solve, fitLink, delta, why, daysAhead, dayWeather, MIN_HOURS, init, destroy };
  if (typeof root.registerPage === 'function') root.registerPage('mediamesh-forecast', { init, destroy });
})(typeof window !== 'undefined' ? window : globalThis);
