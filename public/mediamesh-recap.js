/* "This week on MediaMesh": a 1200 x 630 picture for Discord, Mastodon and
 * the like (the size link previews use), drawn in the browser from the
 * week's clips, repeaters, coverage and backbone, to download or copy. Its
 * own dark design, so it reads the same wherever it's posted. Also drawn
 * full-screen by the kiosk. */
'use strict';

(function (root) {
  const W = 1200, H = 630;

  /**
   * The week's figures: { photos, videos, voice, clips, newRepeaters,
   * repeaters, km2, longestHops, from, to, where, stars [{lat, lon}],
   * edges [[lat, lon, lat, lon, packets]] }.
   */
  function recapData(mm, clips, km2, now) {
    now = now || Date.now();
    const weekAgo = now - 7 * 86400000;
    const recent = (clips || []).filter((c) => Date.parse(c.at) >= weekAgo);
    const kinds = { photo: 0, video: 0, voice: 0 };
    recent.forEach((c) => { if (kinds[c.kind] !== undefined) kinds[c.kind]++; });
    const reps = (mm && mm.repeaters) || [];
    const seattle = reps.filter((r) => /Seattle/.test(r.near || '')).length;
    return {
      photos: kinds.photo, videos: kinds.video, voice: kinds.voice, clips: recent.length,
      newRepeaters: reps.filter((r) => r.first_seen && Date.parse(r.first_seen) >= weekAgo).length,
      repeaters: reps.length + (((mm && mm.unknown_repeaters) || []).length),
      km2: km2 || 0,
      longestHops: recent.reduce((m, c) => Math.max(m, c.outcome && c.outcome !== 'none' ? c.hops || 0 : 0), 0),
      from: weekAgo, to: now,
      where: reps.length && seattle * 2 >= reps.length ? 'Seattle' : 'the mesh',
      stars: reps.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)).map((r) => ({ lat: r.lat, lon: r.lon })),
      edges: ((mm && mm.backbone) || []).filter((e) => [e.a_lat, e.a_lon, e.b_lat, e.b_lon].every(Number.isFinite)).map((e) => [e.a_lat, e.a_lon, e.b_lat, e.b_lon, e.packets || 0]),
    };
  }

  /** The headline: the biggest of photos, videos, voice clips. */
  function headline(d) {
    const top = [['photo', d.photos, 'photos'], ['video', d.videos, 'videos'], ['voice', d.voice, 'voice clips']].sort((a, b) => b[1] - a[1])[0];
    if (!top[1]) return d.repeaters ? `${d.repeaters} repeaters carry photos, video and voice by radio` : 'Photos, video and voice by radio';
    return `${top[1].toLocaleString()} ${top[1] === 1 ? top[2].replace(/s$/, '').replace('voice clip', 'voice clip') : top[2]} crossed ${d.where} by radio`;
  }

  /** The six figures under the headline: [value, label]. */
  function figures(d) {
    const rest = [['videos', d.videos], ['photos', d.photos], ['voice clips', d.voice]].filter(([, v]) => v).sort((a, b) => b[1] - a[1]).slice(1);
    const out = rest.map(([l, v]) => [v.toLocaleString(), l]);
    out.push([(d.newRepeaters ? '+' : '') + d.newRepeaters, d.newRepeaters === 1 ? 'new repeater' : 'new repeaters']);
    if (d.km2) out.push([Math.round(d.km2).toLocaleString(), 'km² covered']);
    out.push([String(d.repeaters), 'repeaters']);
    if (d.longestHops) out.push([String(d.longestHops), 'hops, longest']);
    return out.slice(0, 6);
  }

  function dateRange(from, to) {
    const f = new Date(from), t = new Date(to);
    const md = { month: 'short', day: 'numeric' };
    const a = f.toLocaleDateString('en-US', md), b = f.getMonth() === t.getMonth() ? String(t.getDate()) : t.toLocaleDateString('en-US', md);
    return `${a}–${b}, ${t.getFullYear()}`;
  }

  function wrap(g, text, maxW) {
    const words = text.split(' '), lines = [];
    let line = '';
    words.forEach((w) => {
      const t = line ? line + ' ' + w : w;
      if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    });
    if (line) lines.push(line);
    return lines;
  }

  /** Draws the card onto a canvas (any size; drawn at 1200 x 630 and scaled). */
  function draw(canvas, d, site) {
    const g = canvas.getContext('2d');
    canvas.width = W; canvas.height = H;
    const bg = g.createRadialGradient(W * 0.72, H * 0.42, 20, W * 0.72, H * 0.42, W * 0.7);
    bg.addColorStop(0, '#3b0a4a'); bg.addColorStop(0.6, '#0b0f1e'); bg.addColorStop(1, '#070a14');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // the constellation: repeaters and the week's backbone, on the right
    if (d.stars.length) {
      let s = 90, n = -90, w = 180, e = -180;
      d.stars.forEach((p) => { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); });
      const k = Math.cos(((s + n) / 2) * Math.PI / 180);
      const spanY = Math.max(n - s, 0.04), spanX = Math.max((e - w) * k, 0.04);
      const box = { x: 700, y: 60, w: 440, h: 510 };
      const sc = Math.min(box.w / spanX, box.h / spanY);
      const ox = box.x + (box.w - (e - w) * k * sc) / 2, oy = box.y + (box.h - (n - s) * sc) / 2;
      const P = (lat, lon) => [ox + (lon - w) * k * sc, oy + (n - lat) * sc];
      const maxP = Math.max(1, ...d.edges.map((x) => x[4]));
      d.edges.forEach(([a1, o1, a2, o2, pk]) => {
        const [x1, y1] = P(a1, o1), [x2, y2] = P(a2, o2);
        const wgt = 1 + 2.5 * Math.log1p(pk) / Math.log1p(maxP);
        g.strokeStyle = 'rgba(125,211,252,0.35)'; g.lineWidth = wgt + 5; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        g.strokeStyle = 'rgba(186,230,253,0.95)'; g.lineWidth = wgt; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      });
      d.stars.forEach((p) => {
        const [x, y] = P(p.lat, p.lon);
        const gl = g.createRadialGradient(x, y, 0, x, y, 14);
        gl.addColorStop(0, 'rgba(240,171,252,0.8)'); gl.addColorStop(1, 'rgba(240,171,252,0)');
        g.fillStyle = gl; g.beginPath(); g.arc(x, y, 14, 0, 7); g.fill();
        g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill();
      });
    }
    const font = (wt, px) => `${wt} ${px}px Inter, system-ui, -apple-system, Segoe UI, sans-serif`;
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#f0abfc'; g.font = font(600, 17);
    g.fillText('MEDIAMESH  ·  THIS WEEK', 64, 84);
    g.fillStyle = '#f8fafc'; g.font = font(700, 54);
    wrap(g, headline(d), 600).slice(0, 3).forEach((l, i) => g.fillText(l, 64, 158 + i * 60));
    const figs = figures(d);
    figs.forEach(([v, l], i) => {
      const x = 64 + (i % 3) * 200, y = 380 + Math.floor(i / 3) * 105;
      g.fillStyle = '#f8fafc'; g.font = font(600, 42); g.fillText(v, x, y);
      g.fillStyle = '#cbd5e1'; g.font = font(400, 16); g.fillText(l, x, y + 28);
    });
    g.fillStyle = '#cbd5e1'; g.font = font(400, 16);
    g.fillText(`${site || ''}${site ? '  ·  ' : ''}${dateRange(d.from, d.to)}`, 64, H - 40);
    return canvas;
  }

  function cardHtml() {
    return `<div class="analytics-row"><div class="analytics-card flex-1 mm-ins-card" id="mmRecapCard">
      <h3>This week on MediaMesh</h3><p class="text-muted mm-ins-sub">A picture of the week to post on Discord, Mastodon or anywhere else, 1200 × 630 (the size link previews use).</p>
      <canvas class="mm-recap-canvas" id="mmRecapCanvas" width="1200" height="630" role="img" aria-label="This week on MediaMesh"></canvas>
      <div class="mm-ins-toggle mm-recap-actions"><button type="button" class="tab-btn" data-mm-recap="download">Download image</button><button type="button" class="tab-btn" data-mm-recap="copy">Copy image</button><a class="tab-btn" href="#/kiosk">Kiosk mode</a><span class="text-muted mm-recap-msg" aria-live="polite"></span></div>
      <details class="mm-cov-details"><summary>Put MediaMesh live on your site</summary>
        <p class="text-muted mm-cov-note">A small live widget: counts, the latest clip and a tiny night sky of the network, linking back here. Paste this where it should go:</p>
        <pre class="mm-recap-code"><code>${embedCode()}</code></pre></details>
    </div></div>`;
  }

  function embedCode() {
    let origin = '';
    try { origin = root.location ? root.location.origin : ''; } catch (_) { /* none */ }
    const src = (origin || 'https://analyzer.example') + '/mediamesh-widget.html';
    return `&lt;iframe src="${src}" width="340" height="330" style="border:0;border-radius:12px" title="MediaMesh live"&gt;&lt;/iframe&gt;`;
  }

  let state = null;

  function siteName() {
    try { return root.location ? root.location.host : ''; } catch (_) { return ''; }
  }

  function redraw() {
    if (!state) return;
    const cv = state.el.querySelector('#mmRecapCanvas');
    if (cv) draw(cv, recapData(state.mm, state.clips, state.km2), siteName());
  }

  async function init(el, mm) {
    state = { el, mm, clips: [], km2: 0 };
    const me = state;
    redraw();
    const card = el.querySelector('#mmRecapCard');
    if (card) {
      me.onClick = async (e) => {
        const b = e.target.closest('[data-mm-recap]');
        if (!b) return;
        const cv = card.querySelector('#mmRecapCanvas'), msg = card.querySelector('.mm-recap-msg');
        if (b.dataset.mmRecap === 'download') {
          const a = document.createElement('a');
          a.href = cv.toDataURL('image/png');
          a.download = 'mediamesh-week-' + new Date().toISOString().slice(0, 10) + '.png';
          document.body.appendChild(a); a.click(); a.remove();
        } else {
          try {
            const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
            await navigator.clipboard.write([new root.ClipboardItem({ 'image/png': blob })]);
            if (msg) msg.textContent = 'Copied.';
          } catch (_) {
            if (msg) msg.textContent = 'This browser won\'t copy images; download it instead.';
          }
        }
      };
      card.addEventListener('click', me.onClick);
    }
    if (typeof root.api !== 'function') return;
    try {
      const data = await root.api('/analytics/mediamesh/clips?days=7', { ttl: 60000 });
      if (state !== me) return;
      me.clips = (data && data.clips) || [];
      redraw();
    } catch (_) { /* figures without clips */ }
  }

  function setArea(km2) {
    if (!state || !(km2 > 0)) return;
    state.km2 = km2;
    redraw();
  }

  root.MediaMeshRecap = { init, setArea, cardHtml, recapData, headline, figures, draw, dateRange, W, H };
})(typeof window !== 'undefined' ? window : globalThis);
