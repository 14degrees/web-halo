'use strict';

/* Controls (controls.js): the key bindings the game reads through
   platform_web_set_key_binding (port/linux/src/xinput_sdl.c's key map), the
   dialog that changes them, the page's legends, and the first-match tips. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* (values from the page's realm: compared as plain data) */
const plain = value => JSON.parse(JSON.stringify(value));
const deepEqual = (actual, expected, message) => assert.deepStrictEqual(plain(actual), plain(expected), message);

const webDirectory = path.join(__dirname, '..');
const repository = path.join(webDirectory, '..', '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const source = fs.readFileSync(path.join(webDirectory, 'controls.js'), 'utf8');
const xinput = fs.readFileSync(path.join(repository, 'port', 'linux', 'src', 'xinput_sdl.c'), 'utf8');
const webUi = fs.readFileSync(path.join(webDirectory, 'src', 'web_online_ui.c'), 'utf8');
const webBuild = fs.readFileSync(path.join(repository, 'tools', 'web_build.py'), 'utf8');

/* ---- the build, the page and the game thread's setter */
assert.match(webBuild, /f"--pre-js \{WEB_DIR\}\/chat\.js",\s*f"--pre-js \{WEB_DIR\}\/controls\.js",/);
assert.match(webBuild, /WEB_DIR \/ "controls\.js",/);
assert.match(webUi, /EMSCRIPTEN_KEEPALIVE int platform_web_set_key_binding\(int action, int slot, int input\)\s*\{\s*return halo_linux_key_binding_configure\(action, slot, input\);/);
assert.match(shell, /window\.HaloOnline\.runtimeReady\(\);\s*\}\s*if \(window\.HaloControls\) \{\s*window\.HaloControls\.runtimeReady\(\);/);
assert.match(shell, /<button id="spartan-controls"[^>]*>Controls &amp; key bindings<\/button>/);
['controls-dialog', 'controls-list', 'controls-note', 'controls-tips', 'controls-reset', 'controls-tips-again',
  'controls-done', 'controls-close', 'match-tip', 'match-tip-text', 'match-tip-close']
  .forEach(id => assert.match(shell, new RegExp(`id="${id}"`), `missing ${id}`));
assert.match(shell, /<div class="duke-binding"[^>]*data-controls="scores F1"/, 'the legend\'s Back row names F1 too');
assert.match(shell, /<div data-controls="grenade" data-controls-prefer="mouse"><dt>Right click<\/dt>/);
assert.match(shell, /<div><dt>Y<\/dt><dd>Chat<\/dd><\/div>/, 'chat\'s key stays fixed');

/* ---- the JavaScript table follows the C key map: order and browser defaults */
const enumBody = xinput.match(/enum\s*\{\s*(KEY_ACTION_MOVE_FORWARD[\s\S]*?)KEY_ACTION_COUNT\s*\};/)[1];
const cActions = [...enumBody.matchAll(/KEY_ACTION_([A-Z_]+),/g)].map(m => m[1]);
const camel = name => name.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const jsActions = [...source.matchAll(/\{ id: "(\w+)", label: "[^"]+", group: "\w+", defaults: \[([^\]]*)\] \}/g)]
  .map(m => ({ id: m[1], defaults: m[2].split(',').map(part => part.trim()) }));
const C_NAMES = {
  moveForward: 'MOVE_FORWARD', moveBack: 'MOVE_BACK', moveLeft: 'MOVE_LEFT', moveRight: 'MOVE_RIGHT',
  jump: 'JUMP', melee: 'MELEE', action: 'ACTION', switchWeapon: 'SWITCH_WEAPON', flashlight: 'FLASHLIGHT',
  switchGrenade: 'SWITCH_GRENADE', grenade: 'GRENADE', fire: 'FIRE', crouch: 'CROUCH', zoom: 'ZOOM',
  dpadUp: 'DPAD_UP', dpadDown: 'DPAD_DOWN', dpadLeft: 'DPAD_LEFT', dpadRight: 'DPAD_RIGHT', scores: 'SCORES',
};
deepEqual(jsActions.map(action => C_NAMES[action.id]), cActions, 'the actions must be in the key map\'s order');
cActions.forEach(name => assert(Object.values(C_NAMES).includes(name), `unknown C action ${name} (${camel(name)})`));
/* the HALO_WEB side of each #ifdef, else the shared line */
const defaultsBody = xinput.match(/static const int key_defaults\[KEY_ACTION_COUNT\]\[KEY_SLOTS\] =\s*\{([\s\S]*?)\n\};/)[1]
  .replace(/#else[\s\S]*?#endif/g, '').replace(/#ifdef HALO_WEB|#endif/g, '');
const cDefaults = {};
for (const m of defaultsBody.matchAll(/\[KEY_ACTION_(\w+)\] = \{ ([^,]+), ([^}]+?) \},/g)) cDefaults[m[1]] = [m[2], m[3]];
const C_INPUTS = {
  null: 'KEY_UNBOUND', Space: 'SDL_SCANCODE_SPACE', Tab: 'SDL_SCANCODE_TAB', ArrowUp: 'SDL_SCANCODE_UP',
  ArrowDown: 'SDL_SCANCODE_DOWN', ArrowLeft: 'SDL_SCANCODE_LEFT', ArrowRight: 'SDL_SCANCODE_RIGHT',
  Mouse1: 'KEY_MOUSE(SDL_BUTTON_LEFT)', Mouse2: 'KEY_MOUSE(SDL_BUTTON_MIDDLE)', Mouse3: 'KEY_MOUSE(SDL_BUTTON_RIGHT)',
  Mouse4: 'KEY_MOUSE(SDL_BUTTON_X1)', Wheel: 'KEY_INPUT_WHEEL',
};
jsActions.forEach(action => {
  const expected = action.defaults.map(token => {
    const name = token === 'null' ? 'null' : JSON.parse(token);
    return C_INPUTS[name] || 'SDL_SCANCODE_' + name.replace(/^Key/, '');
  });
  deepEqual(cDefaults[C_NAMES[action.id]], expected, `${action.id}'s defaults differ from the key map's`);
});
assert.match(source, /var INPUT_MOUSE_BUTTON = 1000;/);
assert.match(xinput, /#define KEY_INPUT_MOUSE_BUTTON 1000/);
assert.match(source, /var INPUT_WHEEL = 1100;/);
assert.match(xinput, /#define KEY_INPUT_WHEEL 1100/);
assert.match(xinput, /if \(code == KEY_INPUT_WHEEL\)\s*return mouse && SDL_GetTicks\(\) < wheel_press_until_ms;/,
  'the wheel is a short press of whatever it is bound to, and only while the mouse is captured');

/* ---- a page to run controls.js in */
let clock = 1000000;
const listeners = {};
function element(overrides) {
  const node = {
    childNodes: [],
    dataset: {},
    attributes: {},
    hidden: false,
    checked: false,
    textContent: '',
    open: false,
    listeners: {},
    addEventListener(type, listener) { (this.listeners[type] = this.listeners[type] || []).push(listener); },
    appendChild(child) { this.childNodes.push(child); return child; },
    get firstChild() { return this.childNodes[0] || null; },
    removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    focus() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
    querySelector() { return null; },
  };
  return Object.assign(node, overrides || {});
}
const elements = {};
function byId(id) {
  if (!elements[id]) elements[id] = element({ id });
  return elements[id];
}
/* the legends: a few rows with their dt and dd */
function row(controls, dt, dd, extra) {
  const term = element({ textContent: dt });
  const value = element({ textContent: dd });
  return element(Object.assign({
    dataset: Object.assign({ controls }, extra || {}),
    querySelector(selector) { return selector === 'dt' ? term : (selector === 'dd' ? value : null); },
    term,
    value,
  }));
}
const dukeRows = {
  move: row('moveForward moveLeft moveBack moveRight', 'Move', '- WASD', { controlsName: 'Move' }),
  back: row('scores F1', 'Back', '- Tab / F1', { controlsName: 'Back' }),
  y: row('switchWeapon', 'Y', '- Q / Wheel', { controlsName: 'Y button' }),
  dpad: row('dpadUp dpadDown dpadLeft dpadRight', 'D-pad', '- Arrows', { controlsName: 'Directional pad' }),
};
const tipRows = {
  grenade: row('grenade', 'Right click', 'Throw grenade', { controlsPrefer: 'mouse' }),
  melee: row('melee', 'F', 'Melee'),
  move: row('moveForward moveLeft moveBack moveRight', 'WASD', 'Move'),
};
byId('duke-legend').querySelectorAll = () => Object.values(dukeRows);
byId('key-tips').querySelectorAll = () => Object.values(tipRows);

const storage = {};
let storageBlocked = false;
const localStorage = {
  getItem(key) { if (storageBlocked) throw new Error('blocked'); return key in storage ? storage[key] : null; },
  setItem(key, value) { if (storageBlocked) throw new Error('blocked'); storage[key] = String(value); },
};
const document = {
  readyState: 'complete',
  body: element({ dataset: { lobby: 'closed' } }),
  activeElement: null,
  pointerLockElement: null,
  getElementById: byId,
  createElement(tag) { return element({ tagName: tag }); },
  querySelectorAll() { return []; },
  addEventListener() {},
};
const calls = [];
let inGame = false;
const window = {
  localStorage,
  Module: { _platform_web_set_key_binding(action, slot, input) { calls.push([action, slot, input]); return 1; } },
  HaloOnline: { chat: { context: () => ({ inGame }) } },
  addEventListener(type, listener, options) {
    (listeners[type] = listeners[type] || []).push({ listener, capture: options === true || !!(options && options.capture) });
  },
  setInterval() { return 1; },
  clearInterval() {},
  setTimeout() { return 1; },
  clearTimeout() {},
};
const context = vm.createContext({
  window, document, console, JSON, Object, Array, Number, String, RegExp, Math, Error,
  Date: { now: () => clock },
});
vm.runInContext(source, context);
const controls = window.HaloControls;
assert(controls, 'controls.js must install window.HaloControls');

/* a window event through every listener, capture first, until one stops it */
function dispatch(type, fields) {
  const event = Object.assign({
    type,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
    stopPropagation() {},
  }, fields);
  const ordered = (listeners[type] || []).filter(l => l.capture).concat((listeners[type] || []).filter(l => !l.capture));
  for (const { listener } of ordered) {
    listener(event);
    if (event.stopped) break;
  }
  return event;
}
function click(target) {
  for (const listener of byId('controls-list').listeners.click || []) listener({ target });
}

/* ---- the defaults reach the game once the runtime is up, every slot */
assert.equal(calls.length, 0, 'nothing is handed over before the runtime is up');
controls.runtimeReady();
assert.equal(calls.length, controls.actions().length * 2);
deepEqual(calls.slice(0, 2), [[0, 0, 26], [0, 1, -1]], 'W moves forward, nothing else');
const fire = controls.actions().indexOf('fire');
deepEqual(calls.filter(call => call[0] === fire), [[fire, 0, 1001], [fire, 1, -1]], 'the left button fires');
const switchWeapon = controls.actions().indexOf('switchWeapon');
deepEqual(calls.filter(call => call[0] === switchWeapon), [[switchWeapon, 0, 20], [switchWeapon, 1, 1100]]);

/* ---- the legends follow the bindings */
assert.equal(dukeRows.move.value.textContent, '- WASD');
assert.equal(dukeRows.back.value.textContent, '- Tab / F1');
assert.equal(dukeRows.y.value.textContent, '- Q / Wheel');
assert.equal(dukeRows.dpad.value.textContent, '- Arrows');
assert.equal(dukeRows.y.attributes['aria-label'], 'Y button - Q / Wheel');
assert.equal(tipRows.grenade.term.textContent, 'Right click', 'the key tips prefer the mouse where marked');
assert.equal(tipRows.move.term.textContent, 'WASD');

/* ---- rebinding: a conflict moves the key and says what lost it */
calls.length = 0;
let result = controls.bind('flashlight', 0, 'KeyQ');
assert.equal(result.ok, true);
assert.match(result.note, /Q moved from Switch weapon to Flashlight\./);
deepEqual(controls.bindings().switchWeapon, [null, 'Wheel']);
deepEqual(controls.bindings().flashlight, ['KeyQ', null]);
assert.equal(calls.length, controls.actions().length * 2, 'a change is handed over at once');
deepEqual(calls.filter(call => call[0] === switchWeapon)[0], [switchWeapon, 0, -1]);
assert.equal(dukeRows.y.value.textContent, '- Wheel');
result = controls.bind('melee', 0, 'KeyE');
assert.match(result.note, /Reload \/ action/);
result = controls.bind('melee', 1, 'KeyR');
assert.match(result.note, /Reload \/ action has no key now\./, 'an action left with nothing is called out');

/* reserved keys and browser shortcuts are refused */
for (const [name, why] of [['KeyY', /chat/], ['Escape', /menu/], ['F1', /scores/], ['ControlLeft', /browser shortcuts/],
  ['Enter', /select/], ['Bogus', /can't be used/]]) {
  result = controls.bind('jump', 0, name);
  assert.equal(result.ok, false, `${name} must be refused`);
  assert.match(result.note, why);
}
deepEqual(controls.bindings().jump, ['Space', null]);
/* Tab, the scores' default, can move to another action like any key */
result = controls.bind('switchWeapon', 0, 'Tab');
assert.match(result.note, /Tab moved from Scoreboard to Switch weapon\. Scoreboard has no key now\./);

/* ---- kept in the browser, and read back cleaned up */
const stored = JSON.parse(storage['halo.web.key-bindings.v1']);
deepEqual(stored.bindings.flashlight, ['KeyQ', null]);
controls.reset();
deepEqual(controls.bindings().switchWeapon, ['KeyQ', 'Wheel']);
deepEqual(controls.bindings().scores, ['Tab', null]);

/* a fresh page with a stale or tampered store */
function freshPage(saved, blocked) {
  const page = {};
  const pageStorage = { 'halo.web.key-bindings.v1': saved };
  const pageWindow = Object.assign({}, window, {
    HaloControls: undefined,
    localStorage: {
      getItem(key) { if (blocked) throw new Error('blocked'); return pageStorage[key] || null; },
      setItem() { if (blocked) throw new Error('blocked'); },
    },
    addEventListener() {},
  });
  delete pageWindow.HaloControls;
  vm.runInContext(source, vm.createContext({
    window: pageWindow, document, console, JSON, Object, Array, Number, String, RegExp, Math, Error, Date: { now: () => clock },
  }));
  page.controls = pageWindow.HaloControls;
  return page;
}
let page = freshPage(JSON.stringify({ bindings: { fire: ['KeyY', 'Mouse1'], zoom: ['Mouse1', 'KeyZ'], melee: 'F' } }));
deepEqual(page.controls.bindings().fire, [null, 'Mouse1'], 'a reserved key is dropped');
deepEqual(page.controls.bindings().zoom, [null, 'KeyZ'], 'an input used twice keeps its first use');
deepEqual(page.controls.bindings().melee, ['KeyF', 'Mouse4'], 'a malformed entry is the default');
page = freshPage('{not json', false);
deepEqual(page.controls.bindings().jump, ['Space', null]);
page = freshPage(null, true);
deepEqual(page.controls.bindings().jump, ['Space', null], 'a blocked store still gives the defaults');
assert.equal(page.controls.bind('jump', 0, 'KeyV').ok, true, 'and binding still works for the visit');

/* ---- the dialog: a slot listens for the next key, mouse button or wheel */
const opener = byId('spartan-controls');
opener.listeners.click[0]();
assert.equal(byId('controls-dialog').open, true);
const list = byId('controls-list');
assert(list.childNodes.some(node => node.tagName === 'h3' && node.textContent === 'Combat'));
click({ dataset: { action: 'jump', slot: '1' } });
let event = dispatch('keydown', { code: 'KeyV', key: 'v' });
assert.equal(event.stopped, true, 'a listening slot keeps the key from the game and the page');
assert.equal(event.defaultPrevented, true);
deepEqual(controls.bindings().jump, ['Space', 'KeyV']);
/* Esc cancels without changing anything */
click({ dataset: { action: 'jump', slot: '0' } });
dispatch('keydown', { code: 'Escape', key: 'Escape' });
deepEqual(controls.bindings().jump, ['Space', 'KeyV']);
/* a mouse button; the rest of its press does not start listening again */
click({ dataset: { action: 'zoom', slot: '0' } });
event = dispatch('mousedown', { button: 4 });
assert.equal(event.stopped, true);
deepEqual(controls.bindings().zoom, ['Mouse5', 'Mouse2']);
event = dispatch('click', { button: 4 });
assert.equal(event.stopped, true, 'the bound press\'s click is swallowed');
/* the wheel */
click({ dataset: { action: 'switchGrenade', slot: '1' } });
dispatch('wheel', { deltaY: 100 });
deepEqual(controls.bindings().switchGrenade, ['KeyX', 'Wheel']);
deepEqual(controls.bindings().switchWeapon, ['KeyQ', null], 'the wheel moved off Switch weapon');
assert.match(byId('controls-note').textContent, /Wheel moved from Switch weapon to Switch grenades\./);
/* clearing a slot */
click({ dataset: { clearAction: 'jump', clearSlot: '1' } });
deepEqual(controls.bindings().jump, ['Space', null]);
/* not listening: keys pass untouched */
event = dispatch('keydown', { code: 'KeyV', key: 'v' });
assert.equal(event.stopped, false);
controls.reset();

/* ---- a bound key's browser default is dropped while the game has the keyboard */
const canvas = byId('canvas');
document.pointerLockElement = canvas;
event = dispatch('keydown', { code: 'Space', key: ' ' });
assert.equal(event.defaultPrevented, true, 'Space must not scroll the page in a match');
assert.equal(event.stopped, false, 'the key still reaches SDL');
event = dispatch('keydown', { code: 'KeyP', key: 'p' });
assert.equal(event.defaultPrevented, false, 'an unbound key is left alone');

/* ---- tips: in a match, one at a time, with the player's own keys */
controls.bind('melee', 0, 'KeyV');
inGame = true;
controls.tips.tick();
assert.equal(controls.tips.current(), null, 'no tip in the first seconds (the key overview is up)');
clock += 13000;
controls.tips.tick();
assert.equal(controls.tips.current(), 'move');
assert.equal(byId('match-tip').hidden, false);
assert.match(byId('match-tip-text').textContent, /^WASD to move, Space to jump, C to crouch$/);
/* doing what it says, after a moment, dismisses it for good */
dispatch('keydown', { code: 'KeyW', key: 'w' });
assert.equal(controls.tips.current(), 'move', 'a key already held does not dismiss it unread');
clock += 2000;
dispatch('keydown', { code: 'KeyW', key: 'w' });
assert.equal(controls.tips.current(), null);
deepEqual(controls.tips.seen(), ['move']);
assert.equal(byId('match-tip').hidden, true);
clock += 7000;
controls.tips.tick();
assert.equal(controls.tips.current(), 'shoot');
assert.match(byId('match-tip-text').textContent, /^Click to shoot, Z to zoom$/);
/* timed out: seen */
clock += 9000;
controls.tips.tick();
deepEqual(controls.tips.seen(), ['move', 'shoot']);
clock += 7000;
controls.tips.tick();
assert.equal(controls.tips.current(), 'grenades');
/* the close button */
byId('match-tip-close').listeners.click[0]();
deepEqual(controls.tips.seen(), ['move', 'shoot', 'grenades']);
clock += 7000;
controls.tips.tick();
assert.equal(controls.tips.current(), 'melee');
assert.match(byId('match-tip-text').textContent, /^V to melee/, 'tips name the player\'s own binding');
/* the mouse let go (the menu): a tip barely shown comes back next time */
document.pointerLockElement = null;
controls.tips.tick();
assert.equal(controls.tips.current(), null);
assert(!controls.tips.seen().includes('melee'));
document.pointerLockElement = canvas;
/* remembered across visits */
deepEqual(JSON.parse(storage['halo.web.tips.v1']).seen, ['move', 'shoot', 'grenades']);
/* turned off: nothing shows */
controls.tips.setEnabled(false);
clock += 20000;
controls.tips.tick();
assert.equal(controls.tips.current(), null);
assert.equal(JSON.parse(storage['halo.web.tips.v1']).enabled, false);
/* shown again on request */
byId('controls-tips-again').listeners.click[0]();
assert.equal(controls.tips.enabled(), true);
deepEqual(controls.tips.seen(), []);
controls.tips.tick();
assert.equal(controls.tips.current(), 'move');
/* out of the match: the tip goes */
inGame = false;
controls.tips.tick();
assert.equal(controls.tips.current(), null);

/* the chat tip names Y, and the scores tip the player's scoreboard key */
const tipSource = source.match(/var TIPS = \[[\s\S]*?\n  \];/)[0];
assert.match(tipSource, /id: "scores"[\s\S]*?"Hold " \+ \(keysOf\("scores", true\) \|\| "F1"\)/);
assert.match(tipSource, /id: "chat",\s*keys: \["KeyY"\]/);
deepEqual([...tipSource.matchAll(/id: "(\w+)"/g)].map(m => m[1]),
  ['move', 'shoot', 'grenades', 'melee', 'reload', 'scores', 'chat']);

console.log('controls: bindings, dialog, legends and tips tests passed');
