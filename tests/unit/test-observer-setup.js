/* Unit tests for public/observer-setup.js: "Add your observer". */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../../public/observer-setup.js'));
const S = globalThis.ObserverSetup;
const pub = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.log('  ❌ ' + name + ': ' + e.message); }
}

console.log('\n=== Observer setup ===');

test('the commands: the CascadiaMesh MCtoMQTT, at addresses that exist', () => {
  assert.strictEqual(S.SWITCH_CMD, 'curl -fsSL https://raw.githubusercontent.com/jade-on-mesh/meshcoretomqtt/radio2-profile/scripts/switch-to-cascadiamesh.sh | sudo bash');
  assert.strictEqual(S.INSTALL_CMD, 'curl -fsSL https://raw.githubusercontent.com/jade-on-mesh/meshcoretomqtt/radio2-profile/install.sh | sudo bash');
  // the guide says the same
  const guide = fs.readFileSync(path.join(__dirname, '../../docs/observers.md'), 'utf8');
  assert.ok(guide.includes(S.SWITCH_CMD) && guide.includes(S.INSTALL_CMD));
  assert.ok(!/cascadiamesh-llc\/meshcoretomqtt/.test(guide + pub('observer-setup.js')), 'no address that 404s');
});

test('the card: switch first, then new installs and Keymind Cascade, the guide; escaped', () => {
  const h = S.cardHtml({ open: true });
  assert.ok(h.includes('<details class="obs-setup" data-obs-setup open>') && h.includes('Add your observer'));
  assert.ok(h.indexOf('switch-to-cascadiamesh.sh') < h.indexOf('install.sh | sudo bash'));
  assert.ok(h.includes('set mqtt3.preset cascadiamesh') && h.includes(S.GUIDE_URL));
  assert.ok(h.includes('data-obs-setup-copy="curl -fsSL') && !h.includes('<script'));
  assert.ok(!S.cardHtml().includes(' open>'), 'closed unless asked');
  assert.ok(S.cardHtml({ mediamesh: true }).includes('Help observe MediaMesh'));
});

test('an observer page hint only for MCtoMQTT observers that never reported radio2', () => {
  const mc = { client_version: 'meshcoretomqtt/1.3.0.0-preview-abc', radio_history: [{ radio: '910.525,62.5,7,7' }] };
  assert.ok(S.couldReportMediaMesh(mc) && S.hintHtml(mc).includes('Is this repeater on MediaMesh?'));
  assert.ok(!S.couldReportMediaMesh(Object.assign({}, mc, { radio_history: [{ radio_id: 'radio2' }] })), 'already reports it');
  assert.ok(!S.couldReportMediaMesh({ client_version: 'Keymind Cascade 1.18.0.2' }), 'not MCtoMQTT');
  assert.ok(!S.couldReportMediaMesh(null) && S.hintHtml({}) === '');
});

test('wiring: loaded before the pages, on the Observers page, the MediaMesh tab and observer pages', () => {
  const idx = pub('index.html');
  assert.ok(idx.indexOf('observer-setup.js') > 0 && idx.indexOf('observer-setup.js') < idx.indexOf('observers.js?v='));
  const obs = pub('observers.js');
  assert.ok(obs.includes('<div id="obsSetup"></div>') && obs.includes("mountObserverSetup(document.getElementById('obsSetup'))"));
  assert.ok(obs.includes("localStorage.getItem(OBS_SETUP_CLOSED_KEY) === '1'"), 'remembers being closed');
  assert.ok(pub('analytics.js').includes('window.ObserverSetup.cardHtml({ mediamesh: true })'));
  assert.ok(pub('observer-detail.js').includes('window.ObserverSetup.hintHtml(obs)'));
  assert.ok(/\.obs-setup-title \{[^}]*color: var\(--text\)/.test(pub('style.css')), 'text follows the theme');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
