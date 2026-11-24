/* === CoreScope — mediamesh-nav.js ===
 * The MediaMesh bar: one flat row of every MediaMesh page, the same on the
 * MediaMesh tab and on each tool page, with the page you're on lit, so
 * Overview is always the way back. On a phone it wraps to two lines, with
 * the longer names shortened.
 */
'use strict';

(function (root) {
  const PAGES = [
    { id: 'overview', href: '#/analytics?tab=mediamesh', label: 'Overview' },
    { id: 'status', href: '#/mediamesh-status', label: 'Is it up?' },
    { id: 'lab', href: '#/mediamesh-lab', label: 'MediaMeshLab', short: 'Lab' },
    { id: 'timemachine', href: '#/mediamesh-timemachine', label: 'Time machine' },
    { id: 'grow', href: '#/mediamesh-grow', label: 'Grow the mesh', short: 'Grow' },
    { id: 'forecast', href: '#/mediamesh-forecast', label: 'Forecast' },
    // full screen over the Live page, so it has no bar of its own
    { id: 'nightsky', href: '#/live?nightsky=1', label: 'Night sky' },
  ];

  /** The bar, with `active` (a PAGES id) lit. */
  function html(active) {
    const items = PAGES.map((p) => {
      const on = p.id === active;
      const label = p.short
        ? `<span class="mmnav-long">${p.label}</span><span class="mmnav-short" aria-hidden="true">${p.short}</span>`
        : p.label;
      return `<a class="mmnav-item${on ? ' mmnav-item--on' : ''}" href="${p.href}"${on ? ' aria-current="page"' : ''}${p.short ? ` aria-label="${p.label}"` : ''}>${label}</a>`;
    }).join('');
    return `<nav class="mmnav" aria-label="MediaMesh pages"><span class="mmnav-title">MediaMesh</span>${items}</nav>`;
  }

  root.MediaMeshNav = { PAGES, html };
})(typeof window !== 'undefined' ? window : globalThis);
