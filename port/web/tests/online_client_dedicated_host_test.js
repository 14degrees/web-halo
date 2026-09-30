'use strict';

/* A dedicated host: the page on a server keeps a public room open with the
   service credential, hands Halo the lobby driver's settings, and advances
   its map rotation after each game. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
assert.match(shell, /window\.HALO_DEDICATED[\s\S]*_platform_web_online_set_headless\(1\)/,
  'the page tells the game to run headless before it starts');
const headlessHook = shell.indexOf('_platform_web_online_set_headless(1)');
const runtimeReadyCall = shell.indexOf('window.HaloOnline.runtimeReady()');
assert(headlessHook >= 0 && headlessHook < runtimeReadyCall,
  'headless must be set before the online client learns the runtime is ready');

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
    focus() {},
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
].forEach(id => { elements[id] = element(); });

const mapOptions = [
  'Battle Creek', 'Sidewinder', 'Damnation', 'Rat Race', 'Prisoner',
  "Hang 'Em High", 'Chill Out', 'Derelict', 'Boarding Action',
  'Blood Gulch', 'Wizard', 'Chiron TL-34', 'Longest',
].map((textContent, index) => ({ value: String(index), textContent }));
const modeOptions = [
  'Slayer', 'Team Slayer', 'Capture the Flag', 'Oddball',
  'King of the Hill', 'Race',
].map((textContent, index) => ({ value: String(index), textContent }));
elements['online-map'].options = mapOptions;
elements['online-map'].value = '0';
elements['online-mode'].options = modeOptions;
elements['online-mode'].value = '0';
elements['online-map-options'].querySelectorAll = () => [];
elements['online-mode-options'].querySelectorAll = () => [];
const styleInput = element({ checked: true, value: 'sage' });
elements['online-style-options'].querySelectorAll = () => [styleInput];

const requests = [];
const dedicatedRequests = [];
const configuredHosts = [];
const nextGames = [];
const customizations = [];
const intervals = new Map();
let nextTimer = 1;
let gameState = 3;
let matchState = 0;
let playerCount = 1;
let answer = null;

class FakeWebSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    queueMicrotask(() => this.onopen && this.onopen());
  }

  close() { this.readyState = 3; }
  send() {}
}

const context = {
  console,
  document: {
    readyState: 'complete',
    getElementById: id => elements[id],
    querySelector: selector => selector === 'meta[name="halo-build-id"]' ?
      { content: 'test-build' } :
      selector === 'meta[name="halo-signaling-url"]' ?
        { content: 'https://signal.example' } : null,
  },
  fetch: async (url, options) => {
    requests.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    return { ok: true, async json() { return answer; } };
  },
  HaloWebTransport: {
    configure() {},
    disconnectAll() {},
    getLocalIdentifier: () => '020000000001',
    isSupported: () => true,
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
    _platform_web_online_get_match_state: () => matchState,
    _platform_web_online_get_player_count: () => playerCount,
    _platform_web_online_host_configured: (mapIndex, modeIndex) => {
      configuredHosts.push([mapIndex, modeIndex]);
      return 1;
    },
    _platform_web_online_host_dedicated: (...values) => {
      dedicatedRequests.push(values);
      return 1;
    },
    _platform_web_online_set_next_game: (mapIndex, modeIndex) => {
      nextGames.push([mapIndex, modeIndex]);
      return 1;
    },
    _platform_web_online_request: () => 1,
    _platform_web_online_set_player_customization: (...values) => {
      customizations.push(values);
      return 1;
    },
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

async function settle() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

(async () => {
  assert.equal(context.HaloOnline.isRuntimeReady(), false);
  await assert.rejects(context.HaloOnline.hostDedicated({ serviceToken: 'x'.repeat(40) }), /still starting/);
  context.HaloOnline.runtimeReady();
  assert.equal(context.HaloOnline.isRuntimeReady(), true);
  await assert.rejects(context.HaloOnline.hostDedicated({}), /service credential/);

  answer = {
    v: 1,
    room: { id: 'dedicated-room', visibility: 'public', dedicated: true,
      lobby: { mapIndex: 9, modeIndex: 0 }, expiresAt: 1 },
    host: {
      ticket: 'host-ticket-0123456789abcdef',
      session: { peerId: 'h_0123456789abcdef', websocketUrl: 'wss://signal.example/v1/socket' },
    },
    invite: { code: 'dedicated-room.guest-ticket-0123456789abcdef' },
    iceServers: [],
  };
  await context.HaloOnline.hostDedicated({
    serviceToken: 'test-only-host-service-token-32-bytes-min',
    rotation: [{ mapIndex: 9, modeIndex: 0 }, { mapIndex: 5, modeIndex: 1 }],
    minimumPlayers: 2,
    countdownSeconds: 30,
    postgameSeconds: 10,
    name: 'Server',
    style: 'white',
  });
  await settle();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://signal.example/v1/rooms');
  assert.equal(requests[0].headers.Authorization, 'Bearer test-only-host-service-token-32-bytes-min');
  assert.equal(requests[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(requests[0].body, {
    protocolVersion: 1,
    buildId: 'test-build',
    capacity: 128,
    identifier: '020000000001',
    visibility: 'public',
    dedicated: true,
    lobby: { mapIndex: 9, modeIndex: 0 },
  });
  assert.deepEqual(dedicatedRequests, [[9, 0, 2, 30, 10]],
    'Halo receives the lobby and the driver settings');
  assert.deepEqual(configuredHosts, [], 'a dedicated host does not use the ordinary host request');
  assert.deepEqual(customizations[0].slice(0, 7), [0, ...Array.from('Server', c => c.charCodeAt(0))]);

  let status = context.HaloOnline.dedicatedStatus();
  assert.equal(status.active, true);
  assert.equal(status.dedicated, true);
  assert.equal(status.roomId, 'dedicated-room');
  assert.equal(status.matchState, 'none');
  assert.equal(status.lobby.label, 'Blood Gulch · Slayer');

  const gamePoll = Array.from(intervals.values()).find(timer => timer.milliseconds === 200);
  assert(gamePoll, 'the dedicated host polls the game');

  /* Players arrive, the game runs, then the report comes up: the rotation
     advances and the room advertises the next lobby. */
  matchState = 2;
  playerCount = 3;
  gamePoll.callback();
  assert.equal(context.HaloOnline.dedicatedStatus().matchState, 'countdown');
  assert.equal(context.HaloOnline.dedicatedStatus().players, 3);
  matchState = 3;
  gamePoll.callback();
  assert.deepEqual(nextGames, []);
  answer = { v: 1, room: { id: 'dedicated-room', lobby: { mapIndex: 5, modeIndex: 1 }, expiresAt: 2 } };
  matchState = 4;
  gamePoll.callback();
  await settle();
  assert.deepEqual(nextGames, [[5, 1]], 'the next map of the rotation goes to Halo');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://signal.example/v1/rooms/dedicated-room/renew');
  assert.equal(requests[1].headers.Authorization, 'Bearer test-only-host-service-token-32-bytes-min');
  assert.deepEqual(requests[1].body, {
    ticket: 'host-ticket-0123456789abcdef',
    lobby: { mapIndex: 5, modeIndex: 1 },
  });
  status = context.HaloOnline.dedicatedStatus();
  assert.equal(status.matchState, 'postgame');
  assert.equal(status.gamesPlayed, 1);
  assert.equal(status.rotationIndex, 1);
  assert.equal(status.lobby.label, "Hang 'Em High · Team Slayer");

  /* Back in the lobby, then a second game: the rotation wraps. */
  matchState = 1;
  gamePoll.callback();
  matchState = 3;
  gamePoll.callback();
  matchState = 4;
  gamePoll.callback();
  await settle();
  assert.deepEqual(nextGames, [[5, 1], [9, 0]]);
  assert.equal(context.HaloOnline.dedicatedStatus().gamesPlayed, 2);

  /* The scheduled renewal carries the credential too. */
  const renewal = Array.from(intervals.values()).find(timer => timer.milliseconds === 50 * 60 * 1000);
  assert(renewal);
  renewal.callback();
  await settle();
  assert.equal(requests[requests.length - 1].headers.Authorization,
    'Bearer test-only-host-service-token-32-bytes-min');

  await context.HaloOnline.leave();
  assert.equal(context.HaloOnline.dedicatedStatus().active, false);
  assert.equal(context.HaloOnline.dedicatedStatus().dedicated, false);

  console.log('online client dedicated host tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
