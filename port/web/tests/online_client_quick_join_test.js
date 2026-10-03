'use strict';

/* Quick join: one button seats the player in the open public game, or makes
   the player its host when nobody is playing. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');

const quickSection = shell.indexOf('id="online-quick"');
const wizard = shell.indexOf('id="online-wizard"');
assert(quickSection >= 0 && wizard > quickSection,
  'the public game section must come before the friends wizard');
assert.match(shell, /id="online-quick-join"[^>]*>Join multiplayer</);

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
].forEach(id => { elements[id] = element(); });

const mapOptions = [
  'Battle Creek', 'Sidewinder', 'Damnation', 'Rat Race', 'Prisoner',
  "Hang 'Em High", 'Chill Out', 'Derelict', 'Boarding Action',
  'Blood Gulch', 'Wizard', 'Chiron TL-34', 'Longest',
].map((textContent, index) => ({ value: String(index), textContent }));
const modeOptions = [
  'Slayer', 'Team Slayer', 'Capture the Flag', 'Oddball',
  'King of the Hill', 'Race', 'Team Oddball', 'Team King of the Hill',
].map((textContent, index) => ({ value: String(index), textContent }));
elements['online-map'].options = mapOptions;
elements['online-map'].value = '0';
elements['online-mode'].options = modeOptions;
elements['online-mode'].value = '0';
elements['online-map-options'].querySelectorAll = () => [];
elements['online-mode-options'].querySelectorAll = () => [];
const styleInput = element({ checked: true, value: 'cyan' });
elements['online-style-options'].querySelectorAll = () => [styleInput];
elements['online-player-name'].value = 'QuickOne';
elements['online-step-mode'].hidden = true;
elements['online-join-confirm'].hidden = true;
elements['online-invite'].hidden = true;
elements['online-progress'].hidden = true;

const requests = [];
const configuredHosts = [];
const drivenHosts = [];
const commands = [];
const intervals = new Map();
const socketMessages = [];
let nextTimer = 1;
let gameState = 0;
let transportOptions = null;
let quickJoinAnswer = null;
let latestSocket = null;

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

const context = {
  /* The client guards the page against refresh mid-match and talks to the
     shell through window events; the tests do not exercise either. */
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
    querySelector: selector => selector === 'meta[name="halo-build-id"]' ?
      { content: 'test-build' } :
      selector === 'meta[name="halo-signaling-url"]' ?
        { content: 'https://signal.example' } : null,
  },
  fetch: async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok: true,
      async json() { return quickJoinAnswer; },
    };
  },
  HaloWebTransport: {
    configure(options) { transportOptions = options; },
    disconnectAll() {},
    getLocalIdentifier: () => '020000000001',
    isSupported: () => true,
    addPeer: async () => ({}),
    handleSignal: async () => {},
    removePeer() {},
  },
  history: { replaceState() {} },
  localStorage: {
    getItem() { return null; },
    setItem() {},
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
    _platform_web_online_get_state: () => gameState,
    _platform_web_online_host_configured: (mapIndex, modeIndex) => {
      configuredHosts.push([mapIndex, modeIndex]);
      return 1;
    },
    _platform_web_online_host_dedicated: (...values) => {
      drivenHosts.push(values);
      return 1;
    },
    _platform_web_online_request: command => {
      commands.push(command);
      return 1;
    },
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

async function settle() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

(async () => {
  /* Start-up restores a generated profile into the inputs; the player then
     types their own. */
  elements['online-player-name'].value = 'QuickOne';
  styleInput.checked = true;

  /* Before the runtime is ready the button is disabled, like the others. */
  assert.equal(elements['online-quick-join'].disabled, true);
  context.HaloOnline.runtimeReady();
  assert.equal(elements['online-quick-join'].disabled, false);

  /* The button leads to the name-and-armor step, worded for the public game. */
  elements['online-quick-join'].listeners.click();
  assert.equal(elements['online-dialog'].open, true);
  assert.equal(elements['online-dialog'].dataset.view, 'join');
  assert.equal(elements['online-quick'].hidden, true);
  assert.equal(elements['online-join-confirm'].hidden, false);
  assert.match(elements['online-join-summary'].textContent, /public game/);
  assert.equal(elements.online.textContent, 'Ready to play');

  /* Nobody is playing: the service makes this browser the host. */
  quickJoinAnswer = {
    v: 1,
    role: 'host',
    room: {
      id: 'public-room', visibility: 'public', dedicated: false,
      lobby: { mapIndex: 9, modeIndex: 0 },
    },
    host: {
      ticket: 'host-ticket-0123456789abcdef',
      session: { peerId: 'h_0123456789abcdef', websocketUrl: 'wss://signal.example/v1/socket' },
    },
    invite: { code: 'public-room.guest-ticket-0123456789abcdef' },
    iceServers: [],
  };
  elements['online-join-profile'].listeners.click();
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://signal.example/v1/quickjoin');
  assert.deepEqual(requests[0].body, {
    protocolVersion: 1,
    buildId: 'test-build',
    identifier: '020000000001',
  });
  assert.deepEqual(drivenHosts, [[9, 0, 1, 15, 12]],
    'the host opens the lobby the service chose, with the lobby driver starting matches');
  assert.deepEqual(configuredHosts, []);
  assert.deepEqual(commands, []);
  assert.equal(elements['online-invite'].hidden, false,
    'a public host still gets the invite link for friends');
  assert.match(elements['online-status'].textContent, /hosting Blood Gulch · Slayer/);
  assert(socketMessages.some(message => message.type === 'profile' &&
    message.profile.name === 'QuickOne' && message.profile.style === 'cyan'));
  const renewal = Array.from(intervals.values()).find(
    timer => timer.milliseconds === 50 * 60 * 1000);
  assert(renewal, 'a host renews its room before the service expires it');
  quickJoinAnswer = { v: 1, room: { id: 'public-room', expiresAt: 5 } };
  renewal.callback();
  await settle();
  assert.equal(requests[1].url, 'https://signal.example/v1/rooms/public-room/renew');
  assert.deepEqual(requests[1].body, { ticket: 'host-ticket-0123456789abcdef' });

  gameState = 3;
  Array.from(intervals.values()).find(timer => timer.milliseconds === 200).callback();
  assert.equal(elements.online.textContent, 'Waiting for players');
  assert.match(elements['online-status'].textContent, /open to everyone/);

  await context.HaloOnline.leave();
  assert.equal(elements['online-dialog'].dataset.view, 'setup');
  assert.equal(elements['online-quick'].hidden, false);
  assert.equal(intervals.size, 0, 'leaving stops polling and renewal');
  assert.deepEqual(commands, [3], 'leaving a hosted round cancels it in Halo');
  commands.length = 0;

  /* Somebody is playing: the service seats this browser as a guest. */
  quickJoinAnswer = {
    v: 1,
    role: 'guest',
    room: { id: 'public-room', visibility: 'public', dedicated: true,
      lobby: { mapIndex: 9, modeIndex: 0 } },
    session: { peerId: 'g_0123456789abcdef', role: 'guest',
      websocketUrl: 'wss://signal.example/v1/socket' },
    iceServers: [],
  };
  requests.length = 0;
  await context.HaloOnline.quickJoin();
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://signal.example/v1/quickjoin');
  assert.deepEqual(drivenHosts, [[9, 0, 1, 15, 12]], 'a guest hosts nothing');
  assert.equal(elements['online-dialog'].dataset.view, 'progress');
  assert.match(elements['online-status'].textContent, /Connecting to the host/);

  /* The room names the host; once the WebRTC transport to it connects, the
     guest asks Halo to join, exactly as an invited guest does. */
  assert(transportOptions && typeof transportOptions.onStateChange === 'function');
  assert(latestSocket, 'quick join opened the room socket');
  latestSocket.onmessage({
    data: JSON.stringify({
      v: 1,
      type: 'welcome',
      self: { peerId: 'g_0123456789abcdef', role: 'guest', identifier: '020000000001' },
      room: { id: 'public-room' },
      peers: [{ peerId: 'h_fedcba9876543210', role: 'host', identifier: '0a0a0a0a0a0a' }],
    }),
  });
  await settle();
  transportOptions.onStateChange({ peerId: 'h_fedcba9876543210', state: 'connected' });
  await settle();
  assert.deepEqual(commands, [2], 'the guest asks Halo to join once connected');
  assert.match(elements['online-status'].textContent, /Finding the game's Halo lobby/);

  gameState = 6;
  Array.from(intervals.values()).find(timer => timer.milliseconds === 200).callback();
  assert.equal(elements.online.textContent, 'In the public game');

  /* A public guest reconnects without a ticket. */
  requests.length = 0;
  quickJoinAnswer = {
    v: 1,
    room: { id: 'public-room', visibility: 'public' },
    session: { peerId: 'g_0123456789abcdef', websocketUrl: 'wss://signal.example/v1/socket' },
    iceServers: [],
  };
  latestSocket.onclose({ code: 1006 });
  await settle();
  assert.equal(intervals.size >= 1, true);

  await context.HaloOnline.leave();
  assert.equal(elements['online-dialog'].dataset.view, 'setup');

  console.log('online client quick join tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
