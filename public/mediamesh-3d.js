/* MediaMesh coverage in 3D: the coverage estimate draped over the terrain it
 * was worked out from, with a mast for each repeater and the week's backbone
 * as arcs between them. Opened from the coverage card ("3D view"); three.js
 * is loaded only then. Drawn in its own dark scene with its own light text,
 * whatever the page theme. */
'use strict';

(function (root) {
  const THREE_SRC = 'vendor/three-0.149.0.min.js';
  const M_PER_DEG = 111320;
  const MAX_CELLS = 200;        // terrain samples along the longer side
  const LABELS = 8;             // repeaters named in the scene
  const PALETTE = {
    sky: 0x0b1020, water: [15, 42, 74], low: [31, 42, 46], high: [59, 74, 63],
    cover: [232, 121, 249], mast: 0xf0abfc, arc: 0x7dd3fc, spark: 0xbae6fd,
  };

  /**
   * The terrain under the coverage grid, sampled at most MAX_CELLS along the
   * longer side: { nx, ny, bounds, elev (m, NaN no data), margin (dB, NaN
   * none), widthM, depthM }. cov is a merged coverage (margins/width/height/
   * bounds); elevAt(lat, lon) gives metres.
   */
  function terrainGrid(cov, elevAt, maxCells) {
    const b = cov.bounds, max = maxCells || MAX_CELLS;
    const midLat = (b.north + b.south) / 2;
    const widthM = (b.east - b.west) * M_PER_DEG * Math.cos(midLat * Math.PI / 180);
    const depthM = (b.north - b.south) * M_PER_DEG;
    const step = Math.max(widthM, depthM) / (max - 1);
    const nx = Math.max(2, Math.round(widthM / step) + 1), ny = Math.max(2, Math.round(depthM / step) + 1);
    const elev = new Float32Array(nx * ny), margin = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const lat = b.north - (j / (ny - 1)) * (b.north - b.south);
      const row = Math.min(cov.height - 1, Math.floor((j / (ny - 1)) * cov.height));
      for (let i = 0; i < nx; i++) {
        const lon = b.west + (i / (nx - 1)) * (b.east - b.west);
        const col = Math.min(cov.width - 1, Math.floor((i / (nx - 1)) * cov.width));
        const k = j * nx + i;
        const e = elevAt(lat, lon);
        elev[k] = Number.isFinite(e) ? e : NaN;
        const m = cov.margins ? cov.margins[row * cov.width + col] : NaN;
        margin[k] = Number.isFinite(m) && m >= 0 ? m : NaN;
      }
    }
    return { nx, ny, bounds: b, elev, margin, widthM, depthM };
  }

  /** Height exaggeration: hills stay hills in a city of low relief, but a
   * mountain range doesn't become a wall. */
  function exaggeration(grid) {
    let hi = 0;
    for (const e of grid.elev) if (e > hi) hi = e;
    const size = Math.max(grid.widthM, grid.depthM);
    // aim for the highest ground at about 6% of the view's width
    return Math.max(1.5, Math.min(8, (size * 0.06) / Math.max(30, hi)));
  }

  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  /** A vertex's colour, 0..255 rgb: water, land shaded by height and slope,
   * and coverage on top, stronger for more to spare. */
  function vertexColor(e, slope, m) {
    if (!Number.isFinite(e) || e <= 0.5) return PALETTE.water.slice();
    let c = mix(PALETTE.low, PALETTE.high, Math.max(0, Math.min(1, (e - 20) / 110)));
    const shade = 1 + Math.max(-0.3, Math.min(0.4, slope * 0.05));
    c = c.map((v) => Math.min(255, v * shade));
    if (Number.isFinite(m)) c = mix(c, PALETTE.cover, 0.1 + 0.4 * Math.min(1, m / 25));
    return c;
  }

  /** The repeaters worth naming: the busiest on the backbone, then the rest
   * in order, at most n. reps: [{ name, lat, lon, public_key }]. */
  function labelled(reps, backbone, n) {
    const busy = new Map();
    for (const e of backbone || []) {
      for (const k of [e.a, e.b]) if (k) busy.set(k, (busy.get(k) || 0) + (e.packets || 0));
    }
    return reps.filter((r) => r.name)
      .map((r, i) => ({ r, i, w: busy.get(r.public_key) || 0 }))
      .sort((x, y) => y.w - x.w || x.i - y.i)
      .slice(0, n == null ? LABELS : n).map((x) => x.r);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let threeLoading = null;
  function loadThree() {
    if (root.THREE) return Promise.resolve(root.THREE);
    if (!threeLoading) {
      threeLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = THREE_SRC;
        s.onload = () => (root.THREE ? resolve(root.THREE) : reject(new Error('three')));
        s.onerror = () => { threeLoading = null; reject(new Error('three')); };
        document.head.appendChild(s);
      });
    }
    return threeLoading;
  }

  let st = null;

  /**
   * Opens the 3D view. opts: { cov (merged coverage), elevAt, reps (the
   * repeaters counted: {name, lat, lon, public_key}), backbone ([{a, b,
   * a_lat, a_lon, b_lat, b_lon, packets}]), areaKm2, modeLabel, onClose }.
   */
  async function open(opts) {
    if (st) return;
    const el = document.createElement('div');
    el.className = 'mm3d';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'MediaMesh coverage in 3D');
    const reps = (opts.reps || []).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    const area = opts.areaKm2 ? ` · ${Math.round(opts.areaKm2).toLocaleString()} km²` : '';
    el.innerHTML = `<div class="mm3d-stage" data-mm3d-stage></div>
      <div class="mm3d-title"><h2>MediaMesh coverage in 3D</h2>
        <p>${esc(opts.modeLabel || 'Where photos, video and voice should get through')}${area} · ${reps.length} repeater${reps.length === 1 ? '' : 's'}</p></div>
      <button type="button" class="mm3d-close" data-mm3d-close aria-label="Close the 3D view">Close</button>
      <div class="mm3d-labels" aria-hidden="true"></div>
      <div class="mm3d-legend">
        <span>Marginal <span class="mm3d-ramp"></span> Strong</span>
        <span><span class="mm3d-pin"></span>Repeater</span>
        ${(opts.backbone || []).length ? '<span><span class="mm3d-arc"></span>Backbone this week</span>' : ''}
      </div>
      <p class="mm3d-hint">Drag to turn · scroll or pinch to zoom · heights exaggerated</p>
      <p class="mm3d-status" data-mm3d-status role="status">Loading 3D…</p>`;
    document.body.appendChild(el);
    st = { el, opts, raf: 0, cleanup: [] };
    const me = st;
    const onKey = (e) => { if (e.key === 'Escape') close(); else if (me.keys) me.keys(e); };
    document.addEventListener('keydown', onKey);
    me.cleanup.push(() => document.removeEventListener('keydown', onKey));
    el.addEventListener('click', (e) => { if (e.target.closest('[data-mm3d-close]')) close(); });
    el.querySelector('[data-mm3d-close]').focus();
    const status = el.querySelector('[data-mm3d-status]');
    let THREE;
    try { THREE = await loadThree(); } catch (_) {
      if (st === me) status.textContent = 'The 3D view could not be loaded.';
      return;
    }
    if (st !== me) return;
    try {
      build(THREE, me, reps);
      status.textContent = '';
    } catch (_) {
      status.textContent = 'This browser can\'t draw the 3D view.';
    }
  }

  function build(THREE, me, reps) {
    const { el, opts } = me;
    const stage = el.querySelector('[data-mm3d-stage]');
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: !!opts.keepFrames });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    stage.appendChild(renderer.domElement);
    me.renderer = renderer;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.sky);

    const grid = terrainGrid(opts.cov, opts.elevAt);
    const EX = exaggeration(grid);
    const size = Math.max(grid.widthM, grid.depthM);
    scene.fog = new THREE.Fog(PALETTE.sky, size * 1.2, size * 3);
    const b = grid.bounds;
    const kx = M_PER_DEG * Math.cos(((b.north + b.south) / 2) * Math.PI / 180);
    const cx = (b.west + b.east) / 2, cy = (b.north + b.south) / 2;
    const X = (lon) => (lon - cx) * kx, Z = (lat) => (cy - lat) * M_PER_DEG;
    const hAt = (lat, lon) => {
      const i = Math.round((lon - b.west) / (b.east - b.west) * (grid.nx - 1));
      const j = Math.round((b.north - lat) / (b.north - b.south) * (grid.ny - 1));
      const e = grid.elev[Math.max(0, Math.min(grid.ny - 1, j)) * grid.nx + Math.max(0, Math.min(grid.nx - 1, i))];
      return Math.max(0, Number.isFinite(e) ? e : 0) * EX;
    };

    // terrain, coloured per vertex
    const geo = new THREE.PlaneGeometry(grid.widthM, grid.depthM, grid.nx - 1, grid.ny - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const k = j * grid.nx + i, e = grid.elev[k];
        pos.setY(k, (Number.isFinite(e) ? Math.max(-4, e) : -4) * EX);
        const eL = i ? grid.elev[k - 1] : e, eU = j ? grid.elev[k - grid.nx] : e;
        const slope = (Number.isFinite(eL) && Number.isFinite(eU) && Number.isFinite(e)) ? (e - eL) + (e - eU) : 0;
        const c = vertexColor(e, slope, grid.margin[k]);
        col[k * 3] = c[0] / 255; col[k * 3 + 1] = c[1] / 255; col[k * 3 + 2] = c[2] / 255;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));
    const waterC = new THREE.Color(`rgb(${PALETTE.water.join(',')})`);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(size * 12, size * 12), new THREE.MeshLambertMaterial({ color: waterC }));
    sea.rotateX(-Math.PI / 2); sea.position.y = -5 * EX; scene.add(sea);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(-size * 0.4, size * 0.45, -size * 0.2); scene.add(sun);

    // repeaters: a mast and a glowing head
    const glow = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(250,210,255,1)'); gr.addColorStop(0.3, 'rgba(232,121,249,0.8)'); gr.addColorStop(1, 'rgba(232,121,249,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    const mastH = size * 0.012, headS = size * 0.009;
    const heads = new Map(), pulses = [];
    const mastMat = new THREE.LineBasicMaterial({ color: PALETTE.mast, transparent: true, opacity: 0.8 });
    reps.forEach((r, i) => {
      const base = hAt(r.lat, r.lon), top = base + mastH;
      const at = new THREE.Vector3(X(r.lon), top, Z(r.lat));
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(at.x, base, at.z), at]), mastMat));
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.position.copy(at); s.scale.set(headS, headS, 1); scene.add(s);
      pulses.push({ s, ph: i * 1.7 });
      if (r.public_key) heads.set(r.public_key, at);
    });

    // the week's backbone: arcs between masts, thicker for busier, with sparks
    const backbone = (opts.backbone || []).filter((e) => [e.a_lat, e.a_lon, e.b_lat, e.b_lon].every(Number.isFinite));
    const maxP = Math.max(1, ...backbone.map((e) => e.packets || 0));
    const sparkMat = new THREE.SpriteMaterial({ map: glow, color: PALETTE.spark, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const sparks = [];
    backbone.forEach((e, i) => {
      const A = heads.get(e.a) || new THREE.Vector3(X(e.a_lon), hAt(e.a_lat, e.a_lon) + mastH, Z(e.a_lat));
      const B = heads.get(e.b) || new THREE.Vector3(X(e.b_lon), hAt(e.b_lat, e.b_lon) + mastH, Z(e.b_lat));
      const mid = A.clone().add(B).multiplyScalar(0.5);
      mid.y += mastH + A.distanceTo(B) * 0.22;
      const curve = new THREE.QuadraticBezierCurve3(A, mid, B);
      const w = size * (0.0004 + 0.0012 * Math.log1p(e.packets || 0) / Math.log1p(maxP));
      scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, w, 6, false),
        new THREE.MeshBasicMaterial({ color: PALETTE.arc, transparent: true, opacity: 0.85, depthWrite: false })));
      const sp = new THREE.Sprite(sparkMat);
      sp.scale.set(headS * 0.8, headS * 0.8, 1); scene.add(sp);
      sparks.push({ sp, curve, off: (i * 0.37) % 1, speed: 0.08 + 0.12 * (e.packets || 0) / maxP });
    });

    // names, kept on screen as HTML so they stay sharp and readable
    const labelsEl = el.querySelector('.mm3d-labels');
    const named = labelled(reps, backbone).map((r) => {
      const d = document.createElement('div');
      d.className = 'mm3d-label'; d.textContent = r.name;
      labelsEl.appendChild(d);
      return { d, p: new THREE.Vector3(X(r.lon), hAt(r.lat, r.lon) + mastH * 1.15, Z(r.lat)) };
    });

    // the camera orbits the middle of the repeaters
    const camera = new THREE.PerspectiveCamera(40, 1, size * 0.002, size * 8);
    const mid = reps.length
      ? new THREE.Vector3(reps.reduce((a, r) => a + X(r.lon), 0) / reps.length, 0, reps.reduce((a, r) => a + Z(r.lat), 0) / reps.length)
      : new THREE.Vector3(0, 0, 0);
    const view = { az: -0.6, pol: 0.95, dist: size * 0.55, minD: size * 0.08, maxD: size * 2.2 };
    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let touched = !!still, lastT = performance.now();
    function place() {
      view.pol = Math.max(0.25, Math.min(1.35, view.pol));
      view.dist = Math.max(view.minD, Math.min(view.maxD, view.dist));
      camera.position.set(mid.x + view.dist * Math.sin(view.pol) * Math.sin(view.az),
        mid.y + view.dist * Math.cos(view.pol), mid.z + view.dist * Math.sin(view.pol) * Math.cos(view.az));
      camera.lookAt(mid);
    }

    // drag to turn, wheel or pinch to zoom, arrows and +/- from the keyboard
    const canvas = renderer.domElement;
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label', 'Coverage in 3D: arrow keys turn and tilt, plus and minus zoom');
    const ptrs = new Map();
    let pinch = 0;
    const down = (e) => { touched = true; ptrs.set(e.pointerId, [e.clientX, e.clientY]); canvas.setPointerCapture(e.pointerId); };
    const move = (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      if (ptrs.size === 2) {
        ptrs.set(e.pointerId, [e.clientX, e.clientY]);
        const [a, c] = [...ptrs.values()];
        const d = Math.hypot(a[0] - c[0], a[1] - c[1]);
        if (pinch) view.dist *= pinch / d;
        pinch = d;
        return;
      }
      view.az -= (e.clientX - p[0]) * 0.006;
      view.pol -= (e.clientY - p[1]) * 0.004;
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    };
    const up = (e) => { ptrs.delete(e.pointerId); pinch = 0; };
    const wheel = (e) => { e.preventDefault(); touched = true; view.dist *= Math.exp(e.deltaY * 0.0012); };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    me.keys = (e) => {
      const k = { ArrowLeft: () => { view.az += 0.12; }, ArrowRight: () => { view.az -= 0.12; }, ArrowUp: () => { view.pol -= 0.08; }, ArrowDown: () => { view.pol += 0.08; },
        '+': () => { view.dist *= 0.85; }, '=': () => { view.dist *= 0.85; }, '-': () => { view.dist /= 0.85; } }[e.key];
      if (k && document.activeElement === canvas) { e.preventDefault(); touched = true; k(); }
    };

    function resize() {
      const w = stage.clientWidth || window.innerWidth, h = stage.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      camera.aspect = w / h; camera.updateProjectionMatrix();
      // a tall phone screen sees less across: start further back
      if (!me.w) view.dist = size * 0.55 * (w < h ? Math.min(1.8, Math.sqrt(h / w)) : 1);
      me.w = w; me.h = h;
    }
    resize();
    window.addEventListener('resize', resize);
    me.cleanup.push(() => window.removeEventListener('resize', resize));

    function frame(now) {
      if (st !== me) return;
      step(now);
      me.raf = requestAnimationFrame(frame);
    }
    function step(now) {
      const t = now / 1000, dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      if (!touched) view.az += dt * 0.05;
      place();
      for (const s of sparks) s.sp.position.copy(s.curve.getPoint((s.off + t * s.speed) % 1));
      if (!still) for (const p of pulses) { const k = headS * (1 + 0.18 * Math.sin(t * 2.2 + p.ph)); p.s.scale.set(k, k, 1); }
      renderer.render(scene, camera);
      // in order of importance, skipping any that would cover one already placed
      const placed = [];
      for (const l of named) {
        const v = l.p.clone().project(camera);
        let on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        const x = (v.x + 1) / 2 * me.w, y = (1 - v.y) / 2 * me.h;
        if (on) {
          if (!l.wd) { l.d.style.display = 'block'; l.wd = l.d.offsetWidth || 80; l.ht = l.d.offsetHeight || 16; }
          const box = [x - l.wd / 2 - 4, y - l.ht * 1.3 - 2, x + l.wd / 2 + 4, y - l.ht * 0.3 + 2];
          on = box[0] >= 0 && box[2] <= me.w && !placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]);
          if (on) placed.push(box);
        }
        l.d.style.display = on ? 'block' : 'none';
        if (on) l.d.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -130%)`;
      }
    }
    place();
    me.raf = requestAnimationFrame(frame);
    me.cleanup.push(() => {
      geo.dispose(); glow.dispose();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      renderer.dispose();
    });
    // for tests and screenshots: set the view and draw now
    me.view = view;
    me.draw = (now) => { touched = true; step(now == null ? performance.now() : now); };
  }

  function close() {
    if (!st) return;
    const me = st;
    st = null;
    cancelAnimationFrame(me.raf);
    me.cleanup.forEach((f) => { try { f(); } catch (_) { /* gone already */ } });
    me.el.remove();
    if (me.opts.onClose) me.opts.onClose();
  }

  function isOpen() { return !!st; }
  function debug() { return st; }

  root.MediaMesh3D = { open, close, isOpen, terrainGrid, exaggeration, vertexColor, labelled, loadThree, debug, PALETTE, THREE_SRC };
})(typeof window !== 'undefined' ? window : globalThis);
