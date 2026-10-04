'use strict';

/* Ping before and outside a match: the page times a round trip to the
   signaling Worker and to each game region it lists, shows the nearest in
   the scoreboard's colors on the landing and in the lobby, and in a room a
   browser host measures each player over WebRTC and tells the room, as a
   dedicated server's gateway does. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');

/* the page: a readout on the landing, one on the lobby's Network line, and
   one set of colors for every ping */
assert.match(shell, /<span id="landing-ping" class="landing-ping" title="Ping" hidden><\/span>/);
assert.match(shell, /<span id="lobby-network">Online<\/span><span id="lobby-ping" title="Ping" hidden><\/span>/);
for (const tone of ['good', 'fair', 'poor']) {
  assert.match(shell, new RegExp(`\\.sb-ping\\[data-tone="${tone}"\\], \\.ping\\[data-tone="${tone}"\\], #lobby-ping\\[data-tone="${tone}"\\], #landing-ping\\[data-tone="${tone}"\\] \\{ color: #[0-9a-f]{6}; \\}`));
}

function element(overrides) {
  const listeners = {};
  const node = {
    childNodes: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    className: '',
    dataset: {},
    disabled: false,
    hidden: false,
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
    focus() { this.focused = true; },
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

/* every id the page has: the lobby and the landing render into them */
const elements = {};
function byId(id) {
  if (!elements[id]) elements[id] = element();
  return elements[id];
}
const mapOptions = ['Battle Creek', 'Sidewinder', 'Damnation', 'Rat Race', 'Prisoner',
  "Hang 'Em High", 'Chill Out', 'Derelict', 'Boarding Action', 'Blood Gulch', 'Wizard',
  'Chiron TL-34', 'Longest'].map((textContent, index) => ({ value: String(index), textContent }));
const modeOptions = ['Slayer', 'Team Slayer', 'Capture the Flag', 'Oddball', 'King of the Hill',
  'Race', 'Team Oddball', 'Team King of the Hill'].map((textContent, index) => ({ value: String(index), textContent }));
byId('online-map').options = mapOptions;
byId('online-map').value = '0';
byId('online-mode').options = modeOptions;
byId('online-mode').value = '0';
const styleInput = element({ checked: true, value: 'cyan' });
byId('online-style-options').querySelectorAll = () => [styleInput];
byId('online-player-name').value = 'QuickOne';

/* the clocks: Date.now for the page's pacing, performance.now for timing a
   round trip; a fetch advances the latter by its planned latency */
let fakeNow = 1_700_000_000_000;
let clockMs = 0;
const latencies = {};
const probes = [];
const requests = [];
const socketMessages = [];
const intervals = new Map();
let nextTimer = 1;
let gameState = 0;
let transportOptions = null;
let quickJoinAnswer = null;
let latestSocket = null;
let statsFor = () => new Map();
let targets = [{ id: 'lax', label: 'Los Angeles', url: 'https://game.example/ping' }];

class FakeWebSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    latestSocket = this;
    queueMicrotask(() => this.onopen && this.onopen());
  }

  close() { this.readyState = 3; }
  send(value) { socketMessages.push(JSON.parse(value)); }
}

class FakeDate extends Date {
  static now() { return fakeNow; }
}

const context = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  requestAnimationFrame() { return 0; },
  atob: value => Buffer.from(String(value), 'base64').toString('binary'),
  btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
  console,
  Date: FakeDate,
  performance: { now: () => clockMs },
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
  fetch: async (url, options) => {
    url = String(url);
    if (options && options.body) {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, async json() { return quickJoinAnswer; } };
    }
    if (options && options.method === 'GET' && !/\/v1\/ping$|\/ping$/.test(url)) {
      /* the playlists and the listing: nothing here */
      return { ok: true, async json() { return {}; } };
    }
    probes.push(url);
    assert.equal(options.cache, 'no-store', 'a probe never reads a cached answer');
    const plan = latencies[url];
    if (!plan || !plan.length) throw new TypeError('Failed to fetch');
    clockMs += plan.shift();
    const body = url.endsWith('/v1/ping') ? JSON.stringify({ ok: true, targets, v: 1 }) : '';
    return { ok: true, status: body ? 200 : 204, async text() { return body; } };
  },
  HaloWebTransport: {
    configure(options) { transportOptions = options; },
    disconnectAll() {},
    getLocalIdentifier: () => '020000000001',
    getStats: async peerId => statsFor(peerId),
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
    _platform_web_online_get_state: () => gameState,
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
  WebSocket: FakeWebSocket,
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
vm.runInContext(
  fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8'),
  context,
  { filename: 'online_client.js' });

async function settle(until) {
  for (let index = 0; index < 400; index++) {
    await Promise.resolve();
    if (until && until()) return;
  }
  if (until) assert.fail('the page never settled: ' + until.toString());
}

/* the lobby's tick, as the page runs it four times a second */
function tick() {
  const timer = Array.from(intervals.values()).find(entry => entry.milliseconds === 250);
  assert(timer, 'the page polls the lobby');
  timer.callback();
}

function pingCells(list) {
  return list.childNodes.map(row => ({
    name: (row.childNodes.find(child => child.className === 'name' || child.className === 'player-name') || {}).textContent,
    ping: row.childNodes.find(child => child.className === 'ping'),
  }));
}

(async () => {
  context.HaloOnline.runtimeReady();

  /* On the landing: four GETs each (one warms the connection up), the least
     of the timed three; the readout shows the game region, the title the
     rest. */
  latencies['https://signal.example/v1/ping'] = [90, 30, 35, 40];
  latencies['https://game.example/ping'] = [120, 70, 60, 65];
  tick();
  await settle(() => probes.length === 8);
  await settle();
  assert.deepEqual(probes, [
    'https://signal.example/v1/ping', 'https://signal.example/v1/ping',
    'https://signal.example/v1/ping', 'https://signal.example/v1/ping',
    'https://game.example/ping', 'https://game.example/ping',
    'https://game.example/ping', 'https://game.example/ping',
  ]);
  const landingPing = byId('landing-ping');
  assert.equal(landingPing.hidden, false);
  assert.equal(landingPing.textContent, '60 ms');
  assert.equal(landingPing.dataset.tone, 'good');
  assert.equal(landingPing.title, 'Ping 60 ms to Los Angeles (Los Angeles 60 ms, lobby service 30 ms)');

  /* Not again for twenty seconds. */
  probes.length = 0;
  tick();
  await settle();
  assert.deepEqual(probes, []);

  /* The scoreboard's thresholds: yellow from 80 ms, red from 150. */
  fakeNow += 20_001;
  latencies['https://signal.example/v1/ping'] = [40, 20, 20, 20];
  latencies['https://game.example/ping'] = [150, 100, 110, 120];
  tick();
  await settle(() => probes.length === 8);
  await settle();
  assert.equal(landingPing.textContent, '100 ms');
  assert.equal(landingPing.dataset.tone, 'fair');

  probes.length = 0;
  fakeNow += 20_001;
  latencies['https://signal.example/v1/ping'] = [40, 20, 20, 20];
  latencies['https://game.example/ping'] = [250, 200, 210, 220];
  tick();
  await settle(() => probes.length === 8);
  await settle();
  assert.equal(landingPing.textContent, '200 ms');
  assert.equal(landingPing.dataset.tone, 'poor');

  /* The Worker unreachable: the regions it listed last time are still
     probed, and the title says nothing about it. */
  probes.length = 0;
  fakeNow += 20_001;
  latencies['https://game.example/ping'] = [60, 50, 50, 50];
  tick();
  await settle(() => probes.length === 5);
  await settle();
  assert.equal(landingPing.textContent, '50 ms');
  assert.equal(landingPing.title, 'Ping 50 ms to Los Angeles (Los Angeles 50 ms)');

  /* No region listed: the lobby service's own round trip shows. */
  probes.length = 0;
  fakeNow += 20_001;
  targets = [];
  latencies['https://signal.example/v1/ping'] = [40, 24, 26, 28];
  tick();
  await settle(() => probes.length === 4);
  await settle();
  assert.equal(landingPing.textContent, '24 ms');
  assert.equal(landingPing.title, 'Ping 24 ms to the lobby service (lobby service 24 ms)');

  /* Nothing answers: no readout rather than a stale one. */
  probes.length = 0;
  fakeNow += 20_001;
  tick();
  await settle(() => probes.length === 1);
  await settle();
  assert.equal(landingPing.hidden, true);

  /* Hosting a public game in this browser: each connected player's round
     trip, from WebRTC, every two seconds, by signaling peer ID to the room
     (which passes them on by name) and by name on this page. */
  quickJoinAnswer = {
    v: 1,
    role: 'host',
    room: { id: 'public-room', visibility: 'public', dedicated: false, lobby: { mapIndex: 9, modeIndex: 0 } },
    host: {
      ticket: 'host-ticket-0123456789abcdef',
      session: { peerId: 'h_0123456789abcdef', websocketUrl: 'wss://signal.example/v1/socket' },
    },
    invite: { code: 'public-room.guest-ticket-0123456789abcdef' },
    iceServers: [],
  };
  await context.HaloOnline.quickJoin();
  await settle();
  assert(latestSocket, 'quick join opened the room socket');
  latestSocket.onmessage({ data: JSON.stringify({
    v: 1, type: 'welcome',
    self: { peerId: 'h_0123456789abcdef', role: 'host', identifier: '020000000001' },
    room: { id: 'public-room' }, peers: [],
  }) });
  await settle();
  latestSocket.onmessage({ data: JSON.stringify({
    v: 1, type: 'peer-joined',
    peer: { peerId: 'g_fedcba9876543210', role: 'guest', identifier: '0a0a0a0a0a0a', profile: { name: 'Guest', style: 'sage' } },
  }) });
  await settle();
  transportOptions.onStateChange({ peerId: 'g_fedcba9876543210', state: 'connected' });
  await settle();
  statsFor = () => new Map([
    ['pair-0', { type: 'candidate-pair', nominated: false, state: 'in-progress', currentRoundTripTime: 0.9 }],
    ['pair-1', { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.0421 }],
  ]);
  socketMessages.length = 0;
  fakeNow += 2_001;
  tick();
  await settle(() => socketMessages.some(message => message.type === 'pings'));
  assert.deepEqual(socketMessages.filter(message => message.type === 'pings'),
    [{ v: 1, type: 'pings', pings: { g_fedcba9876543210: 42 } }]);
  let cells = pingCells(byId('player-list'));
  assert.deepEqual(cells.map(cell => [cell.name === 'Guest' ? 'Guest' : 'host', cell.ping.hidden ? null : cell.ping.textContent, cell.ping.dataset.tone]),
    [['host', null, undefined], ['Guest', '42 ms', 'good']],
    'the host has no ping to itself; the guest shows what the host measured');

  /* Not again within two seconds, and a player without a measure yet is
     left out. */
  socketMessages.length = 0;
  statsFor = () => new Map();
  tick();
  await settle();
  assert.deepEqual(socketMessages, []);
  fakeNow += 2_001;
  tick();
  await settle();
  assert.deepEqual(socketMessages, []);
  cells = pingCells(byId('player-list'));
  assert.equal(cells[1].ping.hidden, true);

  await context.HaloOnline.leave();
  await settle();

  /* A guest on a dedicated server: its own round trip from WebRTC on the
     lobby's Network line and its row; the rest of the room's as the server
     measured them, in the lobby's list too. */
  quickJoinAnswer = {
    v: 1,
    role: 'guest',
    room: { id: 'public-room', visibility: 'public', dedicated: true, lobby: { mapIndex: 9, modeIndex: 0 } },
    session: { peerId: 'g_0123456789abcdef', role: 'guest', websocketUrl: 'wss://signal.example/v1/socket' },
    iceServers: [],
  };
  await context.HaloOnline.quickJoin();
  await settle();
  latestSocket.onmessage({ data: JSON.stringify({
    v: 1, type: 'welcome',
    self: { peerId: 'g_0123456789abcdef', role: 'guest', identifier: '020000000001' },
    room: { id: 'public-room' },
    peers: [{ peerId: 'h_fedcba9876543210', role: 'host', identifier: '0a0a0a0a0a0a' }],
  }) });
  await settle();
  transportOptions.onStateChange({ peerId: 'h_fedcba9876543210', state: 'connected' });
  await settle();
  latestSocket.onmessage({ data: JSON.stringify({
    v: 1, type: 'roster',
    players: [
      { peerId: 'h_fedcba9876543210', role: 'host', profile: { name: 'Server', style: 'white' } },
      { peerId: 'g_0123456789abcdef', role: 'guest', profile: { name: 'QuickOne', style: 'cyan' } },
      { peerId: 'g_aaaaaaaaaaaaaaaa', role: 'guest', profile: { name: 'Other', style: 'red' } },
    ],
  }) });
  latestSocket.onmessage({ data: JSON.stringify({ v: 1, type: 'pings', pings: { QuickOne: 50, Other: 160 } }) });
  await settle();
  statsFor = () => new Map([['pair', { type: 'candidate-pair', selected: true, currentRoundTripTime: 0.1234 }]]);
  socketMessages.length = 0;
  byId('landing-matchmaking').listeners.click();
  fakeNow += 2_001;
  tick();
  await settle(() => byId('lobby-ping').textContent === '123 ms');
  assert.deepEqual(socketMessages.filter(message => message.type === 'pings'), [], 'a guest measures, but only the host reports');
  const lobbyPing = byId('lobby-ping');
  assert.equal(lobbyPing.hidden, false);
  assert.equal(lobbyPing.dataset.tone, 'fair');
  assert.match(lobbyPing.title, /^Ping 123 ms to the server/);
  assert.equal(landingPing.textContent, '123 ms', 'the landing shows the same while in a room');
  /* (this page plays under its own generated name, not the roster's) */
  const named = cell => ['Server', 'Other'].includes(cell.name) ? cell.name : 'self';
  cells = pingCells(byId('player-list'));
  assert.deepEqual(cells.map(cell => [named(cell), cell.ping.hidden ? null : cell.ping.textContent, cell.ping.dataset.tone]),
    [['Server', null, undefined], ['Other', '160 ms', 'poor'], ['self', '123 ms', 'fair']],
    "the guest's own measure beats the server's; the server itself has none");
  cells = pingCells(byId('lobby-players'));
  assert.deepEqual(cells.map(cell => [named(cell), cell.ping.hidden ? null : cell.ping.textContent]),
    [['self', '123 ms'], ['Other', '160 ms']],
    'the lobby lists the players with their pings, not the server');

  /* Leaving clears the room's pings. */
  await context.HaloOnline.leave();
  await settle();
  tick();
  await settle();
  assert.equal(lobbyPing.hidden, true);

  console.log('online client ping tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
