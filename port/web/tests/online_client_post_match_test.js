'use strict';

/* The post-match lobby (port/web/post_match.js): after a public match the
   lobby shows the carnage report from the game's scoreboard, a vote for
   the next game, a timer and Stay or Leave. A matchmade player queues
   again when the timer runs out with the vote's winner on their ticket; a
   match for SOL stakes nothing again without Play again; a player-hosted
   room's host tallies its guests' votes and sets the winner as its next
   game. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const build = fs.readFileSync(path.join(webDirectory, '..', '..', 'tools', 'web_build.py'), 'utf8');

/* the page: the panel in the lobby, and the module bundled before the client */
assert.match(shell, /<section id="lobby-post-match" aria-label="Post-match" hidden>/);
['post-match-title', 'post-match-timer', 'post-match-rows', 'post-match-money-head', 'post-match-vote',
  'post-match-note', 'post-match-stay', 'post-match-leave'].forEach(id => {
  assert.match(shell, new RegExp(`id="${id}"`), `missing ${id}`);
});
assert.match(build, /--pre-js \{WEB_DIR\}\/post_match\.js",\n\s*f"--pre-js \{WEB_DIR\}\/online_client\.js"/,
  'post_match.js must be bundled before online_client.js');

/* ---- the model on its own */
{
  const module = {};
  vm.runInNewContext(fs.readFileSync(path.join(webDirectory, 'post_match.js'), 'utf8'),
    { window: module }, { filename: 'post_match.js' });
  const PostMatch = module.HaloPostMatch;
  assert(PostMatch, 'post_match.js installs HaloPostMatch');
  /* (the module's arrays are the other realm's: compare by value) */
  const plain = value => JSON.parse(JSON.stringify(value));
  const offersOf = (played, rotation) => plain(PostMatch.offers(played, rotation));
  /* a playlist offers the three rotation entries after the one played */
  assert.deepEqual(offersOf({ mapIndex: 4, modeIndex: 0 }, { maps: [5, 4, 3, 6], modes: [0, 0, 0, 0] }), [[3, 0], [6, 0], [5, 0]]);
  /* a game not in the rotation: from its start */
  assert.deepEqual(offersOf({ mapIndex: 9, modeIndex: 1 }, { maps: [5, 4], modes: [0, 0] }), [[5, 0], [4, 0]]);
  /* a rotation of one offers that game */
  assert.deepEqual(offersOf({ mapIndex: 5, modeIndex: 0 }, { maps: [5], modes: [0] }), [[5, 0]]);
  /* no playlist: the map played and the next two, same game type */
  assert.deepEqual(offersOf({ mapIndex: 12, modeIndex: 2 }, null), [[12, 2], [0, 2], [1, 2]]);
  const offers = [[3, 0], [6, 0], [5, 0]];
  assert.deepEqual(plain(PostMatch.tally(offers, [{ mapIndex: 6, modeIndex: 0, votes: 2 }, { mapIndex: 9, modeIndex: 0, votes: 5 }])), [0, 2, 0]);
  assert.equal(PostMatch.winner(offers, [0, 0, 0]), null);
  assert.deepEqual(plain(PostMatch.winner(offers, [1, 2, 2])), [6, 0], 'the first of equals wins');
  /* the report: teams grouped, leader first; the self row marked; money by name */
  const rows = plain(PostMatch.rows({ teams: 1, red: 20, blue: 25, self: 'Me', players: [
    ['Me', 0, 12, 12, 9, 0], ['Ally', 0, 8, 8, 4, 1], ['Foe', 1, 25, 25, 20, 0],
  ] }, { state: 'settled', stake: 50000000, players: [
    { name: 'Foe', payout: 120000000, balance: 0, net: 0, killShare: 50000000, evenShare: 20000000 },
    { name: 'Me', payout: 0, balance: 0, net: 0, killShare: null, evenShare: null },
  ] }));
  assert.deepEqual(rows.map(row => [row.name, row.place, row.header || false, row.money ? row.money.net : null]),
    [['Blue Team', 1, true, null], ['Foe', 1, false, 70000000], ['Red Team', 2, true, null], ['Me', 2, false, -50000000], ['Ally', 2, false, null]]);
  assert.equal(rows[3].self, true);
  assert.equal(rows[4].quit, true);
  const solo = plain(PostMatch.rows({ teams: 0, self: 'B', players: [['A', 0, 5, 5, 1, 0], ['B', 0, 5, 5, 3, 0], ['C', 0, 2, 2, 1, 1]] }, null));
  assert.deepEqual(solo.map(row => [row.name, row.place]), [['A', 1], ['B', 1], ['C', null]]);
  assert.equal(PostMatch.secondsLeft({ since: 1000, seconds: 20 }, 6000), 15);
  assert.match(PostMatch.status({ kind: 'matchmade', stay: true, since: 0, seconds: 20 }, 4000), /searching again in 16 s/);
  assert.match(PostMatch.status({ kind: 'matchmade', stay: false, wagered: { stake: 1 }, since: 0, seconds: 20 }, 0), /Nothing is staked/);
}

/* ---- the page */
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
    type: '',
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
/* the in-match prompt has a text child the page rewrites */
byId('lobby-deploy').childNodes.push(element({ textContent: 'Match found' }));

let fakeNow = 1_700_000_000_000;
const requests = [];
const socketMessages = [];
const intervals = new Map();
const nextGames = [];
let nextTimer = 1;
let gameState = 0;
let clientState = 0;
let matchState = 0;
let transportOptions = null;
let latestSocket = null;
/* what the service answers, by route */
const answers = {};

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

/* the game's scoreboard, as JSON where the page reads it */
const HEAPU8 = new Uint8Array(16384);
const SCOREBOARD_POINTER = 1024;
function setScoreboard(value) {
  const text = JSON.stringify(value);
  for (let index = 0; index < text.length; index++) HEAPU8[SCOREBOARD_POINTER + index] = text.charCodeAt(index);
  HEAPU8[SCOREBOARD_POINTER + text.length] = 0;
}
setScoreboard({ a: 0 });

const context = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  requestAnimationFrame() { return 0; },
  atob: value => Buffer.from(String(value), 'base64').toString('binary'),
  btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
  console,
  crypto: require('node:crypto').webcrypto,
  Date: FakeDate,
  HEAPU8,
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
  fetch: async (url, options) => {
    url = String(url);
    const route = url.replace('https://signal.example', '');
    const method = (options && options.method) || 'GET';
    const body = options && options.body ? JSON.parse(options.body) : null;
    requests.push({ route, method, body });
    const answer = answers[method + ' ' + route];
    if (typeof answer === 'function') return { ok: true, status: 200, async json() { return answer(body); }, async text() { return ''; } };
    if (answer) return { ok: true, status: 200, async json() { return answer; }, async text() { return ''; } };
    return { ok: true, status: 200, async json() { return {}; }, async text() { return JSON.stringify({ ok: true, targets: [], v: 1 }); } };
  },
  HaloWebTransport: {
    configure(options) { transportOptions = options; },
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
    _platform_web_online_get_state: () => gameState,
    _platform_web_online_get_client_state: () => clientState,
    _platform_web_online_get_match_state: () => matchState,
    _platform_web_online_get_countdown_remaining: () => -1,
    _platform_web_online_host_configured: () => 1,
    _platform_web_online_host_dedicated: () => 1,
    _platform_web_online_request: () => 1,
    _platform_web_online_set_next_game: (mapIndex, modeIndex) => { nextGames.push([mapIndex, modeIndex]); return 1; },
    _platform_web_online_set_player_customization: () => 1,
    _platform_web_online_set_transport_state() {},
    _platform_web_scoreboard: () => SCOREBOARD_POINTER,
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
vm.runInContext(fs.readFileSync(path.join(webDirectory, 'post_match.js'), 'utf8'), context, { filename: 'post_match.js' });
vm.runInContext(fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8'), context, { filename: 'online_client.js' });

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

function requested(method, route) {
  return requests.filter(request => request.method === method && request.route === route);
}

function voteButtons() {
  return byId('post-match-vote').childNodes;
}

function voteLabels() {
  return voteButtons().map(button => button.childNodes.map(child => child.textContent).join(' '));
}

/* a matchmade match: the ticket says the match is ready, the room seats
   the guest, the transport connects */
async function playMatchmade(ticketId, match) {
  answers['POST /v1/queue'] = { v: 1, ticket: { id: ticketId, state: 'ready', queued: 0, waitedSeconds: 1, matches: 0, vote: null, match } };
  answers['GET /v1/queue/' + ticketId] = answers['POST /v1/queue'];
  answers['POST /v1/rooms/match-room/sessions'] = {
    v: 1,
    room: { id: 'match-room', visibility: 'private', dedicated: true, lobby: { mapIndex: match.mapIndex, modeIndex: match.modeIndex } },
    session: { peerId: 'g_0123456789abcdef', role: 'guest', websocketUrl: 'wss://signal.example/v1/socket' },
    iceServers: [],
  };
  byId('lobby-play').listeners.click();
  tick();
  await settle(() => requested('POST', '/v1/rooms/match-room/sessions').length > 0);
  await settle();
  latestSocket.onmessage({ data: JSON.stringify({
    v: 1, type: 'welcome',
    self: { peerId: 'g_0123456789abcdef', role: 'guest', identifier: '020000000001' },
    room: { id: 'match-room' },
    peers: [{ peerId: 'h_fedcba9876543210', role: 'host', identifier: '0a0a0a0a0a0a' }],
  }) });
  await settle();
  transportOptions.onStateChange({ peerId: 'h_fedcba9876543210', state: 'connected' });
  await settle();
  clientState = 3;
  gameState = 6;
  tick();
  await settle();
  assert.equal(byId('lobby-post-match').hidden, true, 'no panel during the match');
}

(async () => {
  context.HaloOnline.runtimeReady();

  /* ---- a matchmade match ends: the report, the vote, the timer */
  await playMatchmade('ticket-one-0123456789abcdef', {
    id: 'match-one', inviteCode: 'match-room.guest-ticket-0123456789abcdef', mapIndex: 5, modeIndex: 0, players: 2, endReason: null, votes: [],
  });
  clientState = 4;
  setScoreboard({ a: 1, over: 1, teams: 0, red: 0, blue: 0, title: 'Slayer', self: 'QuickOne',
    players: [['QuickOne', 0, 7, 7, 3, 0], ['Rival', 0, 9, 9, 7, 0], ['Gone', 0, 2, 2, 5, 1]] });
  tick();
  await settle();
  const panel = byId('lobby-post-match');
  assert.equal(panel.hidden, false, 'the panel shows at the postgame');
  assert.equal(byId('post-match-timer').textContent, '20');
  assert.equal(byId('post-match-title').textContent, 'Match over');
  assert.deepEqual(byId('post-match-rows').childNodes.map(row => row.childNodes.map(cell => cell.textContent)),
    [['1', 'Rival', '9', '9', '7'], ['2', 'QuickOne', '7', '7', '3'], ['–', 'Gone', '2', '2', '5']]);
  assert.equal(byId('post-match-rows').childNodes[1].childNodes[1].dataset.self, 'true');
  assert.equal(byId('post-match-money-head').hidden, true, 'no SOL column in a free match');
  /* Rumble Pit's rotation after Hang 'Em High: Prisoner, Rat Race, Chill Out */
  assert.deepEqual(voteLabels(), ['Prisoner · Slayer 0 votes', 'Rat Race · Slayer 0 votes', 'Chill Out · Slayer 0 votes']);
  assert.match(byId('lobby-status').textContent, /searching again in 20 s/);
  assert.equal(byId('post-match-stay').textContent, 'Staying');
  assert.equal(byId('post-match-stay').disabled, true);
  assert.equal(byId('lobby-play').textContent, 'Leave');

  /* a vote goes to the matchmaker on the ticket; its answer carries the tally */
  answers['POST /v1/queue/ticket-one-0123456789abcdef/vote'] = body => ({ v: 1, ticket: {
    id: 'ticket-one-0123456789abcdef', state: 'ended', queued: 0, waitedSeconds: 1, matches: 1, vote: body,
    match: { id: 'match-one', inviteCode: null, mapIndex: 5, modeIndex: 0, players: 2, endReason: 'finished',
      votes: [{ mapIndex: body.mapIndex, modeIndex: body.modeIndex, votes: 2 }] },
  } });
  voteButtons()[1].listeners.click();
  await settle(() => requested('POST', '/v1/queue/ticket-one-0123456789abcdef/vote').length > 0);
  await settle();
  assert.deepEqual(requested('POST', '/v1/queue/ticket-one-0123456789abcdef/vote')[0].body, { mapIndex: 3, modeIndex: 0 });
  fakeNow += 1000;
  tick();
  await settle();
  assert.deepEqual(voteLabels(), ['Prisoner · Slayer 0 votes', 'Rat Race · Slayer 2 votes', 'Chill Out · Slayer 0 votes']);
  assert.equal(voteButtons()[1].dataset.mine, 'true');
  assert.equal(byId('post-match-timer').textContent, '19');

  /* the server is gone: the ended ticket stays through the vote, and no
     search starts before the timer runs out */
  requests.length = 0;
  latestSocket.onclose({ code: 1006 });
  clientState = 0;
  gameState = 0;
  fakeNow += 5000;
  tick();
  await settle();
  tick();
  await settle();
  assert.equal(requested('POST', '/v1/queue').length, 0, 'no new ticket during the post-match lobby');
  assert.equal(panel.hidden, false);

  /* the timer runs out: back in the queue with the vote's winner */
  answers['POST /v1/queue'] = { v: 1, ticket: { id: 'ticket-two-0123456789abcdef', state: 'queued', queued: 1, waitedSeconds: 0, matches: 1, vote: { mapIndex: 3, modeIndex: 0 } } };
  fakeNow += 15000;
  tick();
  await settle();
  tick();
  await settle(() => requested('POST', '/v1/queue').length > 0);
  await settle();
  assert.equal(panel.hidden, true, 'the panel goes when the timer runs out');
  assert.deepEqual(requested('POST', '/v1/queue')[0].body.vote, { mapIndex: 3, modeIndex: 0 });
  assert.equal(requested('POST', '/v1/queue')[0].body.playlist, 'ffa');
  /* stop searching, for the next round */
  byId('lobby-play').listeners.click();
  await settle();
  tick();
  await settle();

  /* ---- a match for SOL: nothing is staked again without Play again */
  requests.length = 0;
  await playMatchmade('ticket-sol-0123456789abcdef', {
    id: 'match-sol', inviteCode: 'match-room.guest-ticket-0123456789abcdef', mapIndex: 4, modeIndex: 0, players: 2, endReason: null, votes: [],
    wager: { stake: 50000000, perKill: 10000000, mode: 'bounty', stakes: null, escrow: 'locked' },
  });
  answers['GET /v1/wagers/match-sol'] = { wager: { matchId: 'match-sol', state: 'settled', mode: 'bounty', stake: 50000000, perKill: 10000000, pot: 100000000,
    players: [{ name: 'QuickOne', balance: 70000000, payout: 70000000, net: 20000000, kills: 2, deaths: 0, killShare: null, evenShare: null },
      { name: 'Rival', balance: 30000000, payout: 30000000, net: -20000000, kills: 0, deaths: 2, killShare: null, evenShare: null }],
    signatures: {}, cluster: 'devnet' } };
  clientState = 4;
  setScoreboard({ a: 1, over: 1, teams: 0, red: 0, blue: 0, title: 'Slayer', self: 'QuickOne',
    players: [['QuickOne', 0, 2, 2, 0, 0], ['Rival', 0, 0, 0, 2, 0]] });
  /* the wager is polled every five seconds: the settled view arrives */
  fakeNow += 5001;
  tick();
  await settle(() => requested('GET', '/v1/wagers/match-sol').length > 1);
  await settle();
  tick();
  await settle();
  assert.equal(panel.hidden, false);
  assert.equal(byId('post-match-stay').textContent, 'Play again for 0.050 SOL');
  assert.equal(byId('post-match-stay').disabled, false);
  assert.match(byId('lobby-status').textContent, /Nothing is staked/);
  assert.equal(byId('post-match-money-head').hidden, false, 'the SOL column shows in a match for SOL');
  assert.deepEqual(byId('post-match-rows').childNodes.map(row => row.childNodes[5].textContent), ['+0.020 SOL', '−0.020 SOL']);
  requests.length = 0;
  latestSocket.onclose({ code: 1006 });
  clientState = 0;
  gameState = 0;
  fakeNow += 21000;
  tick();
  await settle();
  tick();
  await settle();
  assert.equal(panel.hidden, true);
  assert.equal(requested('POST', '/v1/queue').length, 0, 'the timer ran out without Play again: no new stake');

  /* Play again pressed: the next ticket is asked for when the timer runs out */
  await playMatchmade('ticket-sol-two-123456789abcdef', {
    id: 'match-sol-two', inviteCode: 'match-room.guest-ticket-0123456789abcdef', mapIndex: 4, modeIndex: 0, players: 2, endReason: null, votes: [],
    wager: { stake: 50000000, perKill: 10000000, mode: 'bounty', stakes: null, escrow: 'locked' },
  });
  clientState = 4;
  tick();
  await settle();
  byId('post-match-stay').listeners.click();
  tick();
  await settle();
  assert.equal(byId('post-match-stay').textContent, 'Playing again for 0.050 SOL');
  requests.length = 0;
  latestSocket.onclose({ code: 1006 });
  clientState = 0;
  gameState = 0;
  fakeNow += 21000;
  tick();
  await settle();
  tick();
  await settle(() => requested('POST', '/v1/queue').length > 0);
  assert.equal(requested('POST', '/v1/queue').length, 1, 'Play again queues once more');
  byId('lobby-play').listeners.click();
  await settle();
  tick();
  await settle();

  /* ---- a player-hosted public room: the host tallies and sets the next game */
  requests.length = 0;
  socketMessages.length = 0;
  answers['POST /v1/quickjoin'] = {
    v: 1,
    role: 'host',
    room: { id: 'public-room', visibility: 'public', dedicated: false, lobby: { mapIndex: 9, modeIndex: 0 } },
    host: { ticket: 'host-ticket-0123456789abcdef', session: { peerId: 'h_0123456789abcdef', websocketUrl: 'wss://signal.example/v1/socket' } },
    invite: { code: 'public-room.guest-ticket-0123456789abcdef' },
    iceServers: [],
  };
  await context.HaloOnline.quickJoin();
  await settle();
  latestSocket.onmessage({ data: JSON.stringify({
    v: 1, type: 'welcome',
    self: { peerId: 'h_0123456789abcdef', role: 'host', identifier: '020000000001' },
    room: { id: 'public-room' }, peers: [],
  }) });
  await settle();
  gameState = 3;
  matchState = 4;
  setScoreboard({ a: 1, over: 1, teams: 1, red: 10, blue: 25, title: 'Team Slayer', self: 'QuickOne',
    players: [['QuickOne', 0, 10, 10, 8, 0], ['Guest', 1, 25, 25, 10, 0]] });
  tick();
  await settle();
  assert.equal(panel.hidden, false, 'the host sees the panel at its postgame');
  assert.equal(byId('post-match-timer').textContent, '12', 'a hosted room\'s vote lasts the host\'s postgame');
  assert.equal(byId('post-match-title').textContent, 'Blue team wins');
  assert.deepEqual(byId('post-match-rows').childNodes.map(row => row.childNodes.map(cell => cell.textContent)),
    [['1', 'Blue Team', '25', '', ''], ['1', 'Guest', '25', '25', '10'], ['2', 'Red Team', '10', '', ''], ['2', 'QuickOne', '10', '10', '8']]);
  /* Blood Gulch, then Wizard and Chiron, Slayer */
  assert.deepEqual(voteLabels(), ['Blood Gulch · Slayer 0 votes', 'Wizard · Slayer 0 votes', 'Chiron TL-34 · Slayer 0 votes']);
  /* two guests vote through the room; the host votes too; the tally goes out */
  latestSocket.onmessage({ data: JSON.stringify({ v: 1, type: 'vote', from: 'g_aaaaaaaaaaaaaaaa', mapIndex: 10, modeIndex: 0 }) });
  latestSocket.onmessage({ data: JSON.stringify({ v: 1, type: 'vote', from: 'g_bbbbbbbbbbbbbbbb', mapIndex: 10, modeIndex: 0 }) });
  await settle();
  voteButtons()[2].listeners.click();
  tick();
  await settle();
  assert.deepEqual(voteLabels(), ['Blood Gulch · Slayer 0 votes', 'Wizard · Slayer 2 votes', 'Chiron TL-34 · Slayer 1 vote']);
  const tallies = socketMessages.filter(message => message.type === 'match' && message.vote);
  assert(tallies.length > 0, 'the host tells its guests the tally');
  assert.deepEqual(tallies[tallies.length - 1].vote, { offers: [[9, 0], [10, 0], [11, 0]], votes: [0, 2, 1] });
  /* the timer runs out: Wizard is the room's next game */
  fakeNow += 12000;
  tick();
  await settle();
  assert.equal(panel.hidden, true);
  assert.deepEqual(nextGames, [[10, 0]]);
  await settle(() => requested('POST', '/v1/rooms/public-room/renew').length > 0);
  assert.deepEqual(requested('POST', '/v1/rooms/public-room/renew')[0].body.lobby, { mapIndex: 10, modeIndex: 0 });
  assert.equal(byId('lobby-status').textContent !== '', true);
  await context.HaloOnline.leave();

  console.log('post-match lobby tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
