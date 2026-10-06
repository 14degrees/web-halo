'use strict';

/* Text chat (chat.js): the lobby's panel and the overlay in a match. Lines
   come from the room over its WebSocket and from the party with each poll;
   Y opens a composer over the game without touching the mouse capture, and
   nothing typed reaches the game; a click on a name mutes that player on
   this browser. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const onlineClient = fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(webDirectory, 'chat.js'), 'utf8');
const webBuild = fs.readFileSync(path.join(webDirectory, '..', '..', 'tools', 'web_build.py'), 'utf8');

/* ---- the page: the panel under the lobby's roster, the overlay over the game */
const lobbyRight = shell.match(/<div class="lobby-right">[\s\S]*?<\/div>\s*<\/section>/);
assert(lobbyRight, 'missing the lobby roster column');
assert.match(lobbyRight[0], /<section id="lobby-chat" class="lobby-chat" aria-label="Chat" data-scope="none">/);
['lobby-chat-log', 'lobby-chat-muted', 'lobby-chat-form', 'lobby-chat-input', 'lobby-chat-send', 'lobby-chat-note']
  .forEach(id => assert.match(lobbyRight[0], new RegExp(`id="${id}"`), `missing ${id}`));
assert.match(lobbyRight[0], /<input id="lobby-chat-input" type="text" maxlength="200"[^>]*disabled>/,
  'the lobby input waits for a party or a room');
assert.match(shell, /<section id="chat-overlay" aria-label="Chat" data-composing="false" hidden>/);
assert.match(shell, /<input id="chat-overlay-input" type="text" maxlength="200"[^>]*hidden>/);
assert.match(shell, /<div><dt>Y<\/dt><dd>Chat<\/dd><\/div>/, 'the key tips name the chat key');
assert.match(shell, /body\[data-lobby="open"\] #chat-overlay \{ display: none; \}/, 'the page over the game hides the overlay');
/* the server's limit (services/signaling/src/chat.ts) */
assert.match(chatSource, /var MAX_LENGTH = 200;/);

/* ---- the build bundles chat.js with the page's other scripts */
assert.match(webBuild, /f"--pre-js \{WEB_DIR\}\/chat\.js",/);
assert.match(webBuild, /WEB_DIR \/ "chat\.js",/);

/* ---- online_client.js hands lines over and sends what is typed */
assert.match(onlineClient, /if \(message\.type === "chat"\) \{\s*\/\*[^*]*\*\/\s*if \(global\.HaloChat\) global\.HaloChat\.receive\("room", message\);/);
assert.match(onlineClient, /chat: Object\.freeze\(\{\s*send: function\(text, scope\)/);
assert.match(onlineClient, /sendSocket\(\{ v: PROTOCOL_VERSION, type: "chat", text: String\(text\) \}\);/);
assert.match(onlineClient, /partyRequest\("chat", \{ text: String\(text\) \}\)/);
assert.match(onlineClient, /body\.chatSince = lobby\.party\.chatSeq \|\| 0;/, 'a poll asks only for the lines after the last seen');
assert.match(onlineClient, /global\.HaloChat\.receive\("party", line\);/);
assert.match(onlineClient, /function resetSessionState\(\) \{[\s\S]*?global\.HaloChat\.clear\("room"\);/,
  'the room\'s lines go with the room');

/* ---- a page to run chat.js in */
function element(overrides) {
  const listeners = {};
  const node = {
    childNodes: [],
    dataset: {},
    disabled: false,
    hidden: false,
    value: '',
    textContent: '',
    title: '',
    placeholder: '',
    scrollTop: 0,
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; },
    get firstChild() { return this.childNodes[0] || null; },
    removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); return child; },
    focus(options) { document.activeElement = this; this.focusOptions = options; },
    blur() { if (document.activeElement === this) document.activeElement = document.body; },
    matches(selector) { return selector.split(',').some(part => part.trim() === this.tagName); },
    listeners,
  };
  return Object.assign(node, overrides || {});
}
const elements = {};
function byId(id) {
  if (!elements[id]) elements[id] = element({ id });
  return elements[id];
}
const canvas = byId('canvas');
canvas.tagName = 'canvas';
byId('lobby-chat-input').tagName = 'input';
byId('chat-overlay-input').tagName = 'input';
const document = {
  readyState: 'complete',
  body: element({ tagName: 'body' }),
  pointerLockElement: null,
  activeElement: null,
  listeners: {},
  addEventListener(type, listener) { this.listeners[type] = listener; },
  createElement: tagName => element({ tagName }),
  getElementById: byId,
};
document.activeElement = document.body;
const windowListeners = {};
const stored = {};
let fakeNow = 1_700_000_000_000;
const sent = [];
let chatContext = { room: false, party: false, inGame: false, selfName: 'Me' };
let observerCallback = null;
const timers = [];
const context = {
  addEventListener(type, listener, capture) { windowListeners[type] = { listener, capture }; },
  console,
  document,
  Date: class extends Date { static now() { return fakeNow; } },
  MutationObserver: class { constructor(callback) { observerCallback = callback; } observe() {} },
  localStorage: {
    getItem: key => (key in stored ? stored[key] : null),
    setItem(key, value) { stored[key] = String(value); },
  },
  setTimeout(callback, milliseconds) { timers.push({ callback, milliseconds }); return timers.length; },
  clearTimeout() {},
  HaloOnline: {
    chat: {
      send(text, scope) { sent.push({ text, scope }); return Promise.resolve(); },
      context: () => chatContext,
    },
  },
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(chatSource, context, { filename: 'chat.js' });
const HaloChat = context.HaloChat;
assert(HaloChat && typeof HaloChat.receive === 'function', 'chat.js installs HaloChat');

function keyEvent(type, key, extra) {
  const event = Object.assign({
    type, key, repeat: false, altKey: false, ctrlKey: false, metaKey: false,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  }, extra || {});
  const entry = windowListeners[type];
  assert(entry && entry.capture === true, `chat.js listens to ${type} on the window, ahead of SDL`);
  entry.listener(event);
  return event;
}
function lines(list) {
  return list.childNodes.map(line => ({
    name: line.childNodes[0].textContent, text: line.childNodes[1].textContent,
    style: line.dataset.style, scope: line.dataset.scope, mute: line.childNodes[0].dataset.mute,
  }));
}
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

(async () => {
  const lobbyLog = byId('lobby-chat-log');
  const overlay = byId('chat-overlay');
  const overlayLog = byId('chat-overlay-log');
  const overlayInput = byId('chat-overlay-input');
  const lobbyInput = byId('lobby-chat-input');

  /* nowhere to send yet: the panel waits */
  assert.equal(lobbyInput.disabled, true);
  assert.equal(byId('lobby-chat').dataset.scope, 'none');

  /* a party: its lines show with a tag, and the panel sends to it */
  chatContext = { room: false, party: true, inGame: false, selfName: 'Me' };
  HaloChat.receive('party', { seq: 1, from: 'abcd', name: 'Friend', style: 'blue', text: 'ready?', at: fakeNow });
  assert.deepEqual(lines(lobbyLog), [{ name: 'Friend', text: 'ready?', style: 'blue', scope: 'party', mute: 'Friend' }]);
  assert.equal(lobbyInput.disabled, false);
  assert.equal(byId('lobby-chat').dataset.scope, 'party');
  assert.equal(overlay.hidden, true, 'no overlay outside a game');
  lobbyInput.value = '  yes   lets go ';
  byId('lobby-chat-form').listeners.submit({ preventDefault() {} });
  await settle();
  assert.deepEqual(sent.splice(0), [{ text: 'yes lets go', scope: 'party' }]);
  assert.equal(lobbyInput.value, '');

  /* the room: the account name over the in-game name, and the room first */
  chatContext = { room: true, party: true, inGame: false, selfName: 'Me' };
  HaloChat.receive('room', { from: 'g_0123456789abcdef', name: '7xKX..gAsU', username: 'Archiviste', style: 'red', text: 'gg', at: fakeNow });
  assert.deepEqual(lines(lobbyLog)[1], { name: 'Archiviste', text: 'gg', style: 'red', scope: 'room', mute: 'Archiviste' });
  assert.equal(byId('lobby-chat').dataset.scope, 'room');
  lobbyInput.value = 'hi';
  byId('lobby-chat-form').listeners.submit({ preventDefault() {} });
  await settle();
  assert.deepEqual(sent.splice(0), [{ text: 'hi', scope: 'room' }]);

  /* a bad line is dropped: no name, no text, too long */
  HaloChat.receive('room', { from: 'g_0123456789abcdef', style: 'red', text: 'nameless' });
  HaloChat.receive('room', { from: 'g_0123456789abcdef', name: 'X', style: 'red', text: '' });
  HaloChat.receive('room', { from: 'g_0123456789abcdef', name: 'X', style: 'red', text: 'x'.repeat(201) });
  assert.equal(lobbyLog.childNodes.length, 2);

  /* in a game: the overlay shows the room's recent lines, not the party's */
  chatContext = { room: true, party: true, inGame: true, selfName: 'Me' };
  document.body.dataset.lobby = 'closed';
  observerCallback();
  assert.equal(overlay.hidden, false);
  assert.deepEqual(lines(overlayLog).map(line => line.text), ['gg']);
  assert.equal(overlayLog.childNodes[0].childNodes[0].tagName, 'span', 'no mute buttons over the game');
  /* ... and they fade */
  fakeNow += 9001;
  observerCallback();
  assert.equal(overlay.hidden, true);

  /* Y opens the composer while the mouse stays captured; nothing typed
     reaches the game; Enter sends to the room and closes */
  document.pointerLockElement = canvas;
  document.activeElement = canvas;
  let event = keyEvent('keydown', 'y');
  assert.equal(event.prevented && event.stopped, true, 'Y is the composer\'s');
  assert.equal(HaloChat.isComposing(), true);
  assert.equal(overlayInput.hidden, false);
  assert.equal(document.activeElement, overlayInput, 'the composer has the keyboard');
  assert.equal(overlayInput.focusOptions && overlayInput.focusOptions.preventScroll, true, 'the page never scrolls to the composer');
  assert.equal(document.pointerLockElement, canvas, 'the mouse stays the game\'s');
  assert.equal(overlay.hidden, false);
  event = keyEvent('keydown', 'w');
  assert.equal(event.stopped, true, 'typing never moves the Spartan');
  assert.equal(event.prevented, false, 'the letter still lands in the input');
  event = keyEvent('keyup', 'w');
  assert.equal(event.stopped, false, 'a key let go is the game\'s to see');
  event = keyEvent('keypress', 'w');
  assert.equal(event.stopped, true);
  overlayInput.value = 'nice shot';
  event = keyEvent('keydown', 'Enter');
  await settle();
  assert.equal(event.prevented && event.stopped, true);
  assert.deepEqual(sent.splice(0), [{ text: 'nice shot', scope: 'room' }]);
  assert.equal(HaloChat.isComposing(), false);
  assert.equal(overlayInput.hidden, true);
  assert.equal(document.activeElement, canvas, 'the keyboard is the game\'s again');
  /* an empty Enter, or Esc, just closes */
  keyEvent('keydown', 'y');
  keyEvent('keydown', 'Enter');
  await settle();
  assert.deepEqual(sent, []);
  assert.equal(HaloChat.isComposing(), false);
  keyEvent('keydown', 'y');
  keyEvent('keydown', 'Escape');
  assert.equal(HaloChat.isComposing(), false);
  /* a modifier, a repeat, the lobby open, or no game: Y is not the composer's */
  assert.equal(keyEvent('keydown', 'y', { ctrlKey: true }).stopped, false);
  assert.equal(keyEvent('keydown', 'y', { repeat: true }).stopped, false);
  document.body.dataset.lobby = 'open';
  assert.equal(keyEvent('keydown', 'y').stopped, false);
  document.body.dataset.lobby = 'closed';
  chatContext = { room: true, party: true, inGame: false, selfName: 'Me' };
  assert.equal(keyEvent('keydown', 'y').stopped, false);
  assert.equal(HaloChat.isComposing(), false);
  chatContext = { room: true, party: true, inGame: true, selfName: 'Me' };
  /* the page taking over (Esc menu) closes an open composer */
  keyEvent('keydown', 'y');
  document.body.dataset.lobby = 'open';
  observerCallback();
  assert.equal(HaloChat.isComposing(), false);
  document.body.dataset.lobby = 'closed';

  /* a click on a name mutes that player here: their lines stop, the
     muted list offers the way back, and the mute is kept in the browser */
  const row = lobbyLog.childNodes[1];
  byId('lobby-chat-log').listeners.click({ target: row.childNodes[0] });
  assert.equal(HaloChat.isMuted('Archiviste'), true);
  HaloChat.receive('room', { from: 'g_0123456789abcdef', name: '7xKX..gAsU', username: 'Archiviste', style: 'red', text: 'hidden', at: fakeNow });
  assert.equal(lobbyLog.childNodes.length, 2);
  assert.deepEqual(JSON.parse(stored['halo.web.chat-mutes.v1']), ['Archiviste']);
  const muted = byId('lobby-chat-muted');
  assert.equal(muted.hidden, false);
  assert.match(byId('lobby-chat-note').textContent, /^Muted Archiviste/);
  const chip = muted.childNodes.find(child => child.dataset.unmute === 'Archiviste');
  assert(chip, 'the muted list names the player');
  muted.listeners.click({ target: chip });
  assert.equal(HaloChat.isMuted('Archiviste'), false);
  HaloChat.receive('room', { from: 'g_0123456789abcdef', name: '7xKX..gAsU', username: 'Archiviste', style: 'red', text: 'back', at: fakeNow });
  assert.equal(lobbyLog.childNodes.length, 3);
  /* not yourself */
  HaloChat.mute('Me');
  assert.equal(HaloChat.isMuted('Me'), false);

  /* leaving: the room's lines go, the party's stay; then the party's */
  HaloChat.clear('room');
  assert.deepEqual(lines(lobbyLog).map(line => line.scope), ['party']);
  HaloChat.clear('party');
  assert.equal(lobbyLog.childNodes.length, 0);

  /* a refused line is said under the input */
  context.HaloOnline.chat.send = () => Promise.reject(new Error("You're sending messages too quickly."));
  chatContext = { room: true, party: false, inGame: false, selfName: 'Me' };
  lobbyInput.value = 'spam';
  byId('lobby-chat-form').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(byId('lobby-chat-note').textContent, "You're sending messages too quickly.");
  assert.equal(byId('lobby-chat-note').hidden, false);

  console.log('chat tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
