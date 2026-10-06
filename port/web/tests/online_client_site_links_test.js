'use strict';

/* The landing's links out: fomo.family with the deployment's referral
   code and, once one is configured, the game's X account. The page ships
   its own hrefs and asks the signaling Worker (GET /v1/site) once, when
   the landing first renders; the Worker's answer wins, a missing or
   broken answer leaves the page's own links alone, and the X link stays
   hidden until a real X profile URL is configured. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const onlineClient = fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8');

/* ---- markup: both links open a new tab without a referrer; X hidden by default */
const links = shell.match(/<nav class="landing-links" aria-label="Halo elsewhere">([\s\S]*?)<\/nav>/);
assert(links, 'the landing has its links out');
assert.match(links[1], /<a id="landing-fomo-link" href="https:\/\/fomo\.family\/r\/ARCH" target="_blank" rel="noopener noreferrer"[^>]*>fomo<\/a>/,
  'the fomo link carries the default referral code until the Worker answers');
assert.match(links[1], /<a id="landing-x-link" href="https:\/\/x\.com\/" target="_blank" rel="noopener noreferrer"[^>]*\bhidden>X<\/a>/,
  'the X link is hidden until an account is configured');
assert.match(shell, /\.landing-links a\[hidden\] \{ display: none; \}/);

function element(overrides) {
  const listeners = {};
  const node = {
    childNodes: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    className: '',
    dataset: {},
    disabled: false,
    hidden: false,
    href: '',
    open: false,
    options: [],
    style: { setProperty() {} },
    title: '',
    value: '',
    textContent: '',
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild(child) { this.childNodes.push(child); return child; },
    append(...children) { children.forEach(child => this.childNodes.push(child)); },
    close() { this.open = false; },
    closest() { return null; },
    focus() {},
    get firstChild() { return this.childNodes[0] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    removeAttribute(name) { delete this[name]; },
    removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); return child; },
    replaceChildren(...children) { this.childNodes = children; },
    select() {},
    setAttribute(name, value) { this[name] = String(value); },
    showModal() { this.open = true; },
    listeners,
  };
  return Object.assign(node, overrides || {});
}

/* A fresh page whose Worker answers GET /v1/site with `answer` (or cannot
   be reached), ticked once onto the landing. */
function page(answer, options) {
  options = options || {};
  const elements = {};
  const byId = id => elements[id] || (elements[id] = element());
  byId('online-map').options = [{ value: '0', textContent: 'Battle Creek' }];
  byId('online-map').value = '0';
  byId('online-mode').options = [{ value: '0', textContent: 'Slayer' }];
  byId('online-mode').value = '0';
  byId('online-style-options').querySelectorAll = () => [element({ checked: true, value: 'cyan' })];
  byId('online-player-name').value = 'QuickOne';
  /* as shell.html ships them */
  byId('landing-fomo-link').href = 'https://fomo.family/r/ARCH';
  byId('landing-x-link').href = 'https://x.com/';
  byId('landing-x-link').hidden = true;

  const intervals = new Map();
  const requests = [];
  let nextTimer = 1;
  const context = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    requestAnimationFrame() { return 0; },
    atob: value => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
    console,
    Date,
    performance: { now: () => 0 },
    document: {
      readyState: 'complete',
      addEventListener() {},
      removeEventListener() {},
      body: { dataset: {}, classList: { add() {}, remove() {} } },
      documentElement: { dataset: {}, classList: { add() {}, remove() {} } },
      createElement: () => element(),
      getElementById: byId,
      querySelector: selector => selector === 'meta[name="halo-build-id"]' ?
        { content: 'test-build' } :
        selector === 'meta[name="halo-signaling-url"]' ?
          { content: 'https://signal.example' } : null,
      querySelectorAll: () => [],
    },
    fetch: async (url, init) => {
      url = String(url);
      if (url.endsWith('/v1/site')) {
        requests.push({ url, method: init && init.method });
        if (options.unreachable) throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, async json() { return answer; } };
      }
      /* the ping, the playlists, the listing: nothing here */
      return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
    },
    HaloWebTransport: {
      configure() {},
      disconnectAll() {},
      getLocalIdentifier: () => '020000000001',
      getStats: async () => new Map(),
      isSupported: () => true,
      addPeer: async () => ({}),
      handleSignal: async () => {},
      removePeer() {},
    },
    history: { replaceState() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    location: {
      hash: '', hostname: 'halo.example', href: 'https://halo.example/halo.html',
      origin: 'https://halo.example', pathname: '/halo.html', port: '', protocol: 'https:', search: '',
    },
    Module: {
      _platform_web_online_get_error: () => 0,
      _platform_web_online_get_state: () => 0,
      _platform_web_online_get_client_state: () => 0,
      _platform_web_online_host_configured: () => 1,
      _platform_web_online_host_dedicated: () => 1,
      _platform_web_online_request: () => 1,
      _platform_web_online_set_player_customization: () => 1,
      _platform_web_online_set_transport_state() {},
    },
    navigator: {},
    URL,
    URLSearchParams,
    WebSocket: class { static OPEN = 1; constructor() { this.readyState = 1; } close() {} send() {} },
    clearInterval: id => intervals.delete(id),
    clearTimeout() {},
    setInterval: (callback, milliseconds) => {
      const id = nextTimer++;
      intervals.set(id, { callback, milliseconds });
      return id;
    },
    setTimeout: () => nextTimer++,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(onlineClient, context, { filename: 'online_client.js' });
  context.HaloOnline.runtimeReady();

  /* the lobby's tick, as the page runs it four times a second */
  const tick = () => {
    const timer = Array.from(intervals.values()).find(entry => entry.milliseconds === 250);
    assert(timer, 'the page polls the lobby');
    timer.callback();
  };
  const settle = async () => {
    for (let index = 0; index < 400; index++) await Promise.resolve();
  };
  return { fomo: byId('landing-fomo-link'), x: byId('landing-x-link'), requests, tick, settle };
}

(async () => {
  /* The Worker's answer: its referral code, and the X account it names;
     asked once, not on every tick. */
  let view = page({ links: { fomo: 'https://fomo.family/r/HALO1', x: 'https://x.com/halo_online' }, fomoDetection: true, v: 1 });
  view.tick();
  await view.settle();
  assert.deepEqual(view.requests, [{ url: 'https://signal.example/v1/site', method: 'GET' }]);
  assert.equal(view.fomo.href, 'https://fomo.family/r/HALO1');
  assert.equal(view.x.href, 'https://x.com/halo_online');
  assert.equal(view.x.hidden, false);
  view.tick();
  view.tick();
  await view.settle();
  assert.equal(view.requests.length, 1);

  /* No X account yet, and a fomo link that is not fomo's: the page's own
     fomo link stays, the X link stays hidden. */
  view = page({ links: { fomo: 'https://example.com/r/ARCH', x: null }, fomoDetection: false, v: 1 });
  view.tick();
  await view.settle();
  assert.equal(view.fomo.href, 'https://fomo.family/r/ARCH');
  assert.equal(view.x.hidden, true);

  /* An X link that is not a profile is not shown either. */
  view = page({ links: { fomo: 'https://fomo.family/r/ARCH', x: 'https://example.com/halo' }, fomoDetection: false, v: 1 });
  view.tick();
  await view.settle();
  assert.equal(view.x.hidden, true);
  assert.equal(view.x.href, 'https://x.com/');

  /* The Worker unreachable, or answering something else: the page's own links. */
  view = page(null, { unreachable: true });
  view.tick();
  await view.settle();
  assert.equal(view.fomo.href, 'https://fomo.family/r/ARCH');
  assert.equal(view.x.hidden, true);
  view = page({ ok: true });
  view.tick();
  await view.settle();
  assert.equal(view.fomo.href, 'https://fomo.family/r/ARCH');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
