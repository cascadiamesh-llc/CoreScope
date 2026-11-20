/* === CoreScope — observer-setup.js ===
 * "Add your observer": how to send this analyzer packets, on the Observers
 * page and the MediaMesh tab. The headline is the one command that switches
 * an existing MCtoMQTT to the CascadiaMesh version (MediaMesh support), then
 * a new install, a Keymind Cascade repeater's built-in MQTT, and the full
 * guide (docs/observers.md). Also: whether an observer could report MediaMesh
 * and doesn't (an MCtoMQTT observer with no radio2 heard), for its page.
 */
'use strict';

(function (root) {
  const FORK = 'jade-on-mesh/meshcoretomqtt';
  const BRANCH = 'radio2-profile';
  const RAW = `https://raw.githubusercontent.com/${FORK}/${BRANCH}`;
  const SWITCH_CMD = `curl -fsSL ${RAW}/scripts/switch-to-cascadiamesh.sh | sudo bash`;
  const INSTALL_CMD = `curl -fsSL ${RAW}/install.sh | sudo bash`;
  const GUIDE_URL = 'https://github.com/cascadiamesh-llc/CoreScope/blob/master/docs/observers.md';
  const FORK_URL = `https://github.com/${FORK}/tree/${BRANCH}`;
  const KEYMIND_CMDS = 'set mqtt3.preset cascadiamesh\nset mqtt.enabled on\nreboot';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cmdHtml(cmd, label) {
    return `<div class="obs-setup-cmd"><pre><code>${esc(cmd)}</code></pre><button type="button" class="btn-secondary obs-setup-copy" data-obs-setup-copy="${esc(cmd)}" aria-label="Copy ${esc(label)}">Copy</button></div>`;
  }

  /** The card. opts.open: start opened; opts.mediamesh: worded for the
   * MediaMesh tab. */
  function cardHtml(opts) {
    const o = opts || {};
    const title = o.mediamesh ? 'Help observe MediaMesh' : 'Add your observer';
    const lead = o.mediamesh
      ? 'Only observers that report radio2 show MediaMesh here. A repeater running MCtoMQTT can, with the CascadiaMesh version:'
      : 'A repeater (or a Raspberry Pi with one on USB) reporting to this analyzer makes the map, coverage and MediaMesh more accurate for everyone. Already running MCtoMQTT? One command switches it to the CascadiaMesh version, which adds MediaMesh and keeps your config and other brokers:';
    return `<details class="obs-setup" data-obs-setup${o.open ? ' open' : ''}>
      <summary><span class="obs-setup-title">${title}</span> <span class="obs-setup-sub">MCtoMQTT, Keymind Cascade and others</span></summary>
      <div class="obs-setup-body">
        <p>${lead}</p>
        ${cmdHtml(SWITCH_CMD, 'the switch command')}
        <p class="text-muted obs-setup-note">Then turn the repeater's packet log on: <code>set usb.logging on</code> and <code>set usb.logging.always on</code>. It adds this analyzer's broker unless you already send here, and every later update stays on the CascadiaMesh version (<a href="${FORK_URL}" target="_blank" rel="noopener">source</a>). On a repeater without MediaMesh it works exactly like the regular MCtoMQTT.</p>
        <div class="obs-setup-more">
          <div><h4>New Raspberry Pi observer</h4>${cmdHtml(INSTALL_CMD, 'the install command')}<p class="text-muted obs-setup-note">Pick <strong>cascadiamesh</strong> among the broker presets.</p></div>
          <div><h4>Keymind Cascade with built-in MQTT</h4>${cmdHtml(KEYMIND_CMDS, 'the repeater commands')}<p class="text-muted obs-setup-note">In the repeater's CLI, on a free slot (mqtt3 to mqtt6). MediaMesh needs v1.18.0.2 or newer and <code>set radio2 mediamesh</code>.</p></div>
        </div>
        <p class="obs-setup-guide"><a href="${GUIDE_URL}" target="_blank" rel="noopener">The full guide</a>: turning MediaMesh on, meshcore-packet-capture and OpenHop, checking it works.</p>
      </div>
    </details>`;
  }

  /** Copy buttons in el (once). */
  function bind(el) {
    if (!el || el._obsSetupBound) return;
    el._obsSetupBound = true;
    el.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-obs-setup-copy]');
      if (!b) return;
      const text = b.getAttribute('data-obs-setup-copy');
      const done = () => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1600); };
      const nav = root.navigator;
      if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(text).then(done, () => {});
    });
  }

  /** An MCtoMQTT observer that has never reported radio2: the switch would
   * let it show MediaMesh (if its repeater runs it). */
  function couldReportMediaMesh(obs) {
    if (!obs || !/^meshcoretomqtt\//i.test(String(obs.client_version || ''))) return false;
    const hist = Array.isArray(obs.radio_history) ? obs.radio_history : [];
    return !hist.some((h) => h && h.radio_id === 'radio2');
  }

  /** The hint on an observer's page, or ''. */
  function hintHtml(obs) {
    if (!couldReportMediaMesh(obs)) return '';
    return `<div class="obs-setup-hint" data-obs-setup-hint><strong>Is this repeater on MediaMesh?</strong> This observer runs MCtoMQTT and hasn't reported radio2. To show its MediaMesh traffic here, switch it to the CascadiaMesh version on the computer it runs on:${cmdHtml(SWITCH_CMD, 'the switch command')}</div>`;
  }

  root.ObserverSetup = { cardHtml, bind, hintHtml, couldReportMediaMesh, SWITCH_CMD, INSTALL_CMD, GUIDE_URL };
})(typeof window !== 'undefined' ? window : globalThis);
