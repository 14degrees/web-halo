'use strict';

/* Mouse look: the Spartan dialog's sensitivity slider and invert-Y switch
   are saved in this browser and handed to the game thread when the runtime
   comes up and on every change (platform_web_set_mouse_look). */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const webOnlineUi = fs.readFileSync(
  path.join(webDirectory, 'src', 'web_online_ui.c'), 'utf8');
const xinput = fs.readFileSync(
  path.join(webDirectory, '..', 'linux', 'src', 'xinput_sdl.c'), 'utf8');

/* The controls live in the Spartan dialog, before Done. */
const dialog = shell.match(/<dialog id="spartan-dialog"[\s\S]*?<\/dialog>/);
assert(dialog, 'missing the Spartan dialog');
assert.match(dialog[0],
  /<input id="lobby-mouse-sensitivity" type="range" min="0\.1" max="4" step="0\.05" value="1"/);
assert.match(dialog[0], /<input id="lobby-invert-y" type="checkbox">/);
assert.match(dialog[0], /id="lobby-mouse-sensitivity-value"/);
assert(dialog[0].indexOf('id="lobby-mouse-sensitivity"') < dialog[0].indexOf('id="spartan-dialog-done"'),
  'the look settings come before Done');
assert.match(shell, /\.spartan-settings input\[type="range"\]/,
  'the slider must not inherit the text input frame');

/* The page reaches the game only through web_online_ui.c's atomics, and the
   input layer no longer caches the settings in statics. */
assert.match(webOnlineUi,
  /EMSCRIPTEN_KEEPALIVE void platform_web_set_mouse_look\(float sensitivity, int invert\)/);
assert.match(xinput, /static atomic_int mouse_sensitivity_thousandths/);
assert.match(xinput, /static atomic_int mouse_invert/);
assert.match(xinput, /void halo_linux_mouse_look_configure\(float sensitivity, int invert\)/);
assert.doesNotMatch(xinput, /static float sensitivity = -1\.0f/);
assert.doesNotMatch(xinput, /static int invert = -1/);

function element(overrides) {
  const listeners = {};
  return Object.assign({
    dataset: {},
    disabled: false,
    hidden: false,
    open: false,
    options: [],
    value: '',
    textContent: '',
    addEventListener(type, listener) { listeners[type] = listener; },
    close() { this.open = false; },
    focus() { this.focused = true; },
    removeAttribute(name) { delete this[name]; },
    replaceChildren() {},
    select() {},
    setAttribute(name, value) { this[name] = String(value); },
    showModal() { this.open = true; },
    listeners,
  }, overrides || {});
}

const elements = {};
[
  'online', 'online-dialog', 'online-close', 'online-status',
  'online-description', 'online-setup', 'online-quick', 'online-quick-join',
  'online-host-form', 'online-host', 'online-map', 'online-mode',
  'online-map-options', 'online-mode-options',
  'online-join-form', 'online-code', 'online-join', 'online-invite',
  'invite-link', 'invite-copy', 'invite-copy-status', 'online-leave-host',
  'online-progress', 'online-cancel', 'online-detail', 'canvas',
  'online-wizard', 'online-wizard-steps', 'online-wizard-map', 'online-wizard-mode',
  'online-step-map', 'online-step-mode', 'online-map-next', 'online-mode-back',
  'online-profile', 'online-player-name', 'online-style-options',
  'online-profile-preview', 'online-profile-preview-name', 'online-spartan-image',
  'online-join-confirm', 'online-join-profile', 'online-join-summary',
  'online-join-status', 'player-sidebar', 'player-count', 'player-empty',
  'player-sidebar-toggle',
  'lobby-mouse-sensitivity', 'lobby-mouse-sensitivity-value', 'lobby-invert-y',
].forEach(id => { elements[id] = element(); });
elements['online-map-options'].querySelectorAll = () => [];
elements['online-mode-options'].querySelectorAll = () => [];
elements['online-style-options'].querySelectorAll = () => [element({ checked: true, value: 'cyan' })];
elements['online-wizard-steps'].querySelectorAll = () => [];
elements['lobby-mouse-sensitivity'].value = '1';
elements['lobby-invert-y'].checked = false;

const MOUSE_LOOK_KEY = 'halo.web.mouse-look.v1';
const storage = new Map([
  /* a saved setting from an earlier visit, with a value off the slider's
     grid and a stale field */
  [MOUSE_LOOK_KEY, JSON.stringify({ sensitivity: 2.5, invertY: true, legacy: 1 })],
]);
let storageBlocked = false;
const applied = [];

function makeContext(storageItems) {
  const context = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    requestAnimationFrame() { return 0; },
    atob: value => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
    console,
    document: {
      readyState: 'complete',
      body: { dataset: {} },
      getElementById: id => elements[id],
      querySelector: () => null,
    },
    fetch: async () => { throw new Error('no network in this test'); },
    HaloWebTransport: {
      configure() {},
      disconnectAll() {},
      getLocalIdentifier: () => '020000000001',
      isSupported: () => true,
    },
    history: { replaceState() {} },
    localStorage: {
      getItem(key) {
        if (storageBlocked) throw new Error('SecurityError');
        return storageItems.has(key) ? storageItems.get(key) : null;
      },
      setItem(key, value) {
        if (storageBlocked) throw new Error('QuotaExceededError');
        storageItems.set(key, value);
      },
      removeItem(key) { storageItems.delete(key); },
    },
    location: {
      hash: '',
      hostname: 'halo.example',
      href: 'https://halo.example/halo.html',
      origin: 'https://halo.example',
      pathname: '/halo.html',
      port: '',
      protocol: 'https:',
      search: '',
    },
    Module: {
      _platform_web_online_get_error: () => 0,
      _platform_web_online_get_state: () => 0,
      _platform_web_online_set_player_customization: () => 1,
      _platform_web_online_set_transport_state() {},
      _platform_web_set_mouse_look: (sensitivity, invert) => { applied.push([sensitivity, invert]); },
    },
    navigator: {},
    URL,
    URLSearchParams,
    WebSocket: class { close() {} send() {} },
    clearInterval() {},
    clearTimeout() {},
    setInterval: () => 1,
    setTimeout: () => 1,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8'),
    context,
    { filename: 'online_client.js' });
  return context;
}

const slider = elements['lobby-mouse-sensitivity'];
const readout = elements['lobby-mouse-sensitivity-value'];
const invert = elements['lobby-invert-y'];

/* Loading restores the saved setting into the controls, but cannot hand it
   to Halo before the runtime exists. */
const context = makeContext(storage);
assert.equal(slider.value, '2.5');
assert.equal(readout.textContent, '2.50×');
assert.equal(invert.checked, true);
assert.deepEqual(applied, [], 'nothing reaches Halo before the runtime is up');

/* The runtime comes up: the saved setting is applied once. */
context.HaloOnline.runtimeReady();
assert.deepEqual(applied, [[2.5, 1]]);

/* Dragging the slider applies and saves each value as it goes. */
slider.value = '0.75';
slider.listeners.input({ target: slider });
assert.deepEqual(applied.at(-1), [0.75, 1]);
assert.equal(readout.textContent, '0.75×');
assert.deepEqual(JSON.parse(storage.get(MOUSE_LOOK_KEY)), { sensitivity: 0.75, invertY: true });

/* The switch too, keeping the sensitivity. */
invert.checked = false;
invert.listeners.change({ target: invert });
assert.deepEqual(applied.at(-1), [0.75, 0]);
assert.deepEqual(JSON.parse(storage.get(MOUSE_LOOK_KEY)), { sensitivity: 0.75, invertY: false });

/* Values off the range are clamped, and nonsense falls back to the default. */
slider.value = '99';
slider.listeners.input({ target: slider });
assert.deepEqual(applied.at(-1), [4, 0]);
assert.equal(slider.value, '4');
slider.value = 'abc';
slider.listeners.input({ target: slider });
assert.deepEqual(applied.at(-1), [1, 0]);

/* A blocked store never breaks the controls: the change still reaches Halo. */
storageBlocked = true;
slider.value = '1.5';
slider.listeners.input({ target: slider });
assert.deepEqual(applied.at(-1), [1.5, 0]);
assert.equal(readout.textContent, '1.50×');
storageBlocked = false;

/* A fresh browser, or a corrupt saved value, starts at the default and
   applies it when the runtime is up. */
applied.length = 0;
const corrupt = new Map([[MOUSE_LOOK_KEY, '{not json']]);
const fresh = makeContext(corrupt);
assert.equal(slider.value, '1');
assert.equal(invert.checked, false);
fresh.HaloOnline.runtimeReady();
assert.deepEqual(applied, [[1, 0]]);

/* A page without the controls (an older shell, a dedicated host) loads fine. */
delete elements['lobby-mouse-sensitivity'];
delete elements['lobby-mouse-sensitivity-value'];
delete elements['lobby-invert-y'];
applied.length = 0;
makeContext(new Map()).HaloOnline.runtimeReady();
assert.deepEqual(applied, [[1, 0]]);

console.log('mouse look settings tests passed');
