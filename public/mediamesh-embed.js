/* MediaMesh on other websites: the analyzer in an iframe, showing one thing.
 *
 *   /?embed=sky        the Live night sky, full frame, no controls
 *   /?embed=coverage   the MediaMesh coverage map card alone
 *   /embed/badge.html  a small live stats badge (its own page)
 *
 * ?theme=light|dark works as on any page (index.html). The analyzer's own
 * navigation is hidden, and a small link opens the full analyzer in a new
 * tab. Runs before the router (index.html loads it first), so the first page
 * drawn is the embed's. See docs/embeds.md. */
'use strict';

(function (root) {
  const KINDS = ['sky', 'coverage'];

  /** 'sky', 'coverage' or null: from ?embed= or the hash's &embed=. */
  function kindOf(search, hash) {
    const q = new URLSearchParams(String(search || '').replace(/^\?/, '')).get('embed')
      || new URLSearchParams(String(hash || '').split('?')[1] || '').get('embed');
    return KINDS.includes(q) ? q : null;
  }

  /** The hash an embed shows (null: leave it). */
  function routeFor(kind, hash) {
    const h = String(hash || '');
    if (kind === 'sky') return /^#\/live(\?|$)/.test(h) && /[?&]nightsky=1/.test(h) ? null : '#/live?nightsky=1&embed=sky';
    if (kind === 'coverage') return /^#\/analytics\?/.test(h) && /[?&]tab=mediamesh/.test(h) ? null : '#/analytics?tab=mediamesh&embed=coverage';
    return null;
  }

  let current = null;
  function kind() { return current; }

  /** Leaves only the coverage card in the MediaMesh tab. */
  function coverageOnly(el) {
    if (!el) return;
    const card = el.querySelector('#mmCoverageCard');
    if (!card) return;
    // at each level from the card up to the tab, everything beside it
    let n = card;
    while (n && n !== el && n.parentElement) {
      // hidden and display:none: a block's own display (grid, flex) beats [hidden]
      [...n.parentElement.children].forEach((c) => { if (c !== n) { c.hidden = true; if (c.style) c.style.display = 'none'; } });
      n = n.parentElement;
    }
  }

  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** The iframe code for each embed, for the MediaMesh tab (base: the
   * analyzer's address, ending in /). */
  function snippets(base) {
    const b = String(base || '/').replace(/[?#].*$/, '');
    return [
      { name: 'Night sky', note: 'Photos, video and voice crossing MediaMesh live, in the CascadiaMesh colours.', code: `<iframe src="${b}?embed=sky" width="100%" height="520" style="border:0;border-radius:12px" allow="fullscreen" loading="lazy" title="MediaMesh live night sky"></iframe>` },
      { name: 'Coverage map', note: 'The coverage estimate, with "Can I join from here?". Add &theme=light or &theme=dark to match the page.', code: `<iframe src="${b}?embed=coverage" width="100%" height="1000" style="border:0" loading="lazy" title="MediaMesh coverage map"></iframe>` },
      { name: 'Live badge', note: 'Repeaters, the week\'s packets and who is listening, refreshed every minute. ?theme=light for a light page.', code: `<iframe src="${b}embed/badge.html" width="360" height="132" style="border:0" loading="lazy" title="MediaMesh live"></iframe>` },
    ];
  }

  function snippetsHtml(base) {
    return `<div class="analytics-row"><details class="analytics-card flex-1 mm-embed-snippets"><summary>Put MediaMesh on your website</summary>
      <p class="text-muted">Copy one of these into a page (cascadiamesh.org, a club site, a forum). Each opens the full analyzer in a new tab when clicked.</p>
      ${snippets(base).map((s) => `<div class="mm-embed-snippet"><strong>${s.name}</strong> <span class="text-muted">${escAttr(s.note)}</span><textarea readonly rows="2" aria-label="${s.name} embed code">${escAttr(s.code)}</textarea></div>`).join('')}
    </details></div>`;
  }

  function openLink(doc, href) {
    const a = doc.createElement('a');
    a.className = 'mm-embed-open';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Open the analyzer ↗';
    doc.body.appendChild(a);
  }

  function start(win) {
    const doc = win.document;
    current = kindOf(win.location.search, win.location.hash);
    if (!current) return;
    doc.documentElement.classList.add('mm-embed', 'mm-embed--' + current);
    const to = routeFor(current, win.location.hash);
    if (to) win.history.replaceState(null, '', win.location.pathname + win.location.search + to);
    const add = () => openLink(doc, win.location.origin + win.location.pathname + (current === 'sky' ? '#/live' : '#/analytics?tab=mediamesh'));
    if (doc.body) add(); else doc.addEventListener('DOMContentLoaded', add);
  }

  root.MediaMeshEmbed = { kind, kindOf, routeFor, coverageOnly, start, snippets, snippetsHtml };
  if (typeof window !== 'undefined' && window.document && window.location) start(window);
})(typeof window !== 'undefined' ? window : globalThis);
