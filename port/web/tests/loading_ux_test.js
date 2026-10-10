'use strict';

/* From loading to playing (port/web/loading_ux.js): the landing repeats the
   loading panel's words and bar while Halo starts; the lobby shows the steps
   from a found match to playing, with a bar and an estimate while a server
   starts; a multiplayer map's load shows over the game. One look (the
   landing's) for all of them, and nothing moves with reduced motion. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const client = fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8');
const platform = fs.readFileSync(path.join(webDirectory, 'src', 'web_platform.c'), 'utf8');
const build = fs.readFileSync(path.join(webDirectory, '..', '..', 'tools', 'web_build.py'), 'utf8');
const source = fs.readFileSync(path.join(webDirectory, 'loading_ux.js'), 'utf8');

/* ---- the page: the meters' places, the module bundled before the client */
assert.match(shell, /<div id="landing-boot" class="halo-meter" role="status" aria-live="polite" hidden><\/div>/);
assert.match(shell, /<div id="lobby-progress" class="halo-meter" role="status" aria-live="polite" hidden><\/div>/);
assert.match(shell, /<div id="map-loading" class="halo-meter" role="status" aria-live="polite" hidden><\/div>/);
assert.match(build, /--pre-js \{WEB_DIR\}\/loading_ux\.js"/);
assert(build.indexOf('{WEB_DIR}/loading_ux.js') < build.indexOf('--pre-js {WEB_DIR}/online_client.js'),
  'loading_ux.js must be bundled before online_client.js');
assert.match(build, /WEB_DIR \/ "loading_ux\.js"/, 'a change to loading_ux.js must relink');
assert.match(client, /global\.HaloLoading\.update\(/);
assert.match(client, /queue\.serverStarting = !!ticket\.serverStarting;/);
/* one set of tokens for the loading panel, the meters and the campaign bar */
assert.match(shell, /--h3-accent: #ffb069;/);
assert.match(shell, /\.loading-panel, \.halo-meter, #campaign-loading \{[\s\S]*?var\(--h3-surface-strong\)/);
/* the landing fades in over the loading panel, which goes once it is in */
assert.match(shell, /body\[data-lobby="open"\] #loading \{[\s\S]*?visibility: hidden;[\s\S]*?visibility 0s linear var\(--h3-fade\)/);
assert.doesNotMatch(shell, /body\[data-lobby="open"\] #loading \{ display: none; \}/);
/* reduced motion: no fades, sweeps or pulses */
const reduced = shell.match(/@media \(prefers-reduced-motion: reduce\) \{\n      \.loading-orbit[\s\S]*?\n    \}\n/);
assert(reduced, 'missing the reduced-motion block');
['#map-loading', '.halo-meter-bar:indeterminate', '.landing-play', '#lobby-play[data-mode="play"]', '#landing:not([hidden])']
  .forEach(selector => assert(reduced[0].includes(selector), `reduced motion must still ${selector}`));
/* the module's map files are the game's (web_platform.c, map_files) */
const files = platform.match(/map_files\[\] =\s*\{([\s\S]*?)\};/)[1].match(/"([a-z0-9]+)\.map"/g).map(name => name.slice(1, -5));
const moduleFiles = source.match(/var MAP_FILES = \[([\s\S]*?)\];/)[1].match(/"([a-z0-9]+)"/g).map(name => name.slice(1, -1));
assert.deepEqual(moduleFiles, files);

/* ---- the model on its own */
const window = {};
vm.runInNewContext(source, { window }, { filename: 'loading_ux.js' });
const Loading = window.HaloLoading;
assert(Loading, 'loading_ux.js installs HaloLoading');
const plain = value => JSON.parse(JSON.stringify(value));

/* a multiplayer map by index; the campaign's and the menu's are not */
assert.deepEqual(plain(Loading.mapLoad(0.42, 11)), { title: 'Blood Gulch', progress: 0.42 });
assert.deepEqual(plain(Loading.mapLoad(1.5, 13)), { title: 'Derelict', progress: 1 });
assert.equal(Loading.mapLoad(0.5, 3), null, 'a campaign mission has its own bar');
assert.equal(Loading.mapLoad(0.5, 22), null, 'the menu map is no match');
assert.equal(Loading.mapLoad(-1, 11), null, 'nothing loading');
assert.equal(Loading.mapLoad(null, null), null);

/* a timed bar reaches 90% at its estimate and never fills */
assert.equal(Loading.timed(0, 8).progress, 0);
assert(Math.abs(Loading.timed(8, 8).progress - 0.9) < 0.01);
assert.equal(Loading.timed(600, 8).progress, 0.97);
assert.equal(Loading.timed(3.2, 8).eta, 5);
assert.equal(Loading.timed(20, 8).eta, 0);

/* the stages, from the ticket, the session and the map */
const stageKey = input => (Loading.stage(input) || { key: null }).key;
assert.equal(stageKey({ queue: { state: 'queued' } }), null, 'searching is the lobby status');
assert.equal(stageKey({ queue: { state: 'queued', serverStarting: true } }), 'boot');
assert.equal(stageKey({ queue: { state: 'assigning' } }), 'open');
assert.equal(Loading.stage({ queue: { state: 'assigning', custom: true } }).label, 'Setting up your custom game');
assert.equal(stageKey({ queue: { state: 'assigning', staking: true } }), 'stake');
assert.equal(stageKey({ queue: { state: 'ready', staking: true } }), 'stake');
assert.equal(stageKey({ queue: { state: 'ready' } }), 'join');
assert.equal(stageKey({ queue: { state: 'ready' }, session: { active: true, connected: false } }), 'join');
assert.equal(stageKey({ queue: { state: 'ready' }, session: { active: true, connected: true } }), null,
  'in the room: the countdown takes over');
assert.equal(stageKey({ session: { active: true, connected: true }, map: { title: 'Wizard', progress: 0.3 } }), 'map');
assert.equal(stageKey({ queue: { state: 'ended' } }), null);
assert.deepEqual([1, 2, 3].map(step => Loading.STEPS[step]), ['Server', 'Joining', 'Map']);

/* the clock restarts with each stage, and holds through the same one */
{
  const track = Loading.tracker();
  let view = track.update({ queue: { state: 'assigning' } }, 10_000);
  assert.equal(view.eta, Loading.ESTIMATES.open);
  view = track.update({ queue: { state: 'assigning' } }, 13_000);
  assert.equal(view.eta, Loading.ESTIMATES.open - 3);
  assert.equal(Loading.valueText(view), `About ${Loading.ESTIMATES.open - 3} s`);
  view = track.update({ queue: { state: 'ready' } }, 14_000);
  assert.equal(view.key, 'join');
  assert.equal(view.eta, Loading.ESTIMATES.join);
  view = track.update({ queue: { state: 'ready' } }, 30_000);
  assert.equal(Loading.valueText(view), 'Almost there');
  view = track.update({ session: { active: true, connected: true }, map: { title: 'Wizard', progress: 0.256 } }, 31_000);
  assert.equal(view.eta, null);
  assert.equal(Loading.valueText(view), '26%');
  assert.equal(track.update({ session: { active: true, connected: true } }, 32_000), null);
}

/* ---- the drawing, into a stand-in for the page */
function fakeDocument() {
  const nodes = {};
  const make = tag => ({
    tagName: tag, children: [], dataset: {}, attributes: {}, hidden: false, textContent: '', className: '',
    value: 0, max: 1,
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
  });
  ['landing-boot', 'lobby-progress', 'map-loading'].forEach(id => {
    nodes[id] = make('div');
    nodes[id].hidden = true;
  });
  nodes['loading-label'] = Object.assign(make('div'), { textContent: 'Preparing files… (3/4)' });
  nodes.progress = Object.assign(make('progress'), { value: 3, max: 4 });
  return { nodes, document: { createElement: make, getElementById: id => nodes[id] || null } };
}

{
  const page = fakeDocument();
  const context = { window: {}, document: page.document };
  context.window.Module = {
    _platform_web_map_load_progress: () => -1,
    _platform_web_map_load_index: () => -1,
  };
  vm.runInNewContext(source, context, { filename: 'loading_ux.js' });
  const Page = context.window.HaloLoading;
  const meterOf = id => page.nodes[id].haloMeter;

  /* booting: the landing shows the loading panel's words and figure */
  Page.update({ runtimeReady: false, queue: null, session: { active: false }, lobbyOpen: false }, 0);
  assert.equal(page.nodes['landing-boot'].hidden, false);
  assert.equal(meterOf('landing-boot').label.textContent, 'Preparing files… (3/4)');
  assert.equal(meterOf('landing-boot').value.textContent, '75%');
  assert.equal(meterOf('landing-boot').bar.value, 75);
  assert.equal(meterOf('landing-boot').steps, undefined, 'the boot has no steps');
  assert.equal(page.nodes['lobby-progress'].hidden, true);

  /* started, and a server starting for the match: the lobby's steps */
  Page.update({ runtimeReady: true, queue: { state: 'queued', serverStarting: true },
    session: { active: false }, lobbyOpen: true }, 1000);
  assert.equal(page.nodes['landing-boot'].hidden, true);
  assert.equal(page.nodes['lobby-progress'].hidden, false);
  const lobbyMeter = meterOf('lobby-progress');
  assert.equal(lobbyMeter.label.textContent, 'Starting a server');
  assert.equal(lobbyMeter.value.textContent, `About ${Loading.ESTIMATES.boot} s`);
  assert.equal(lobbyMeter.value.attributes['aria-hidden'], 'true', 'the figures are not read out each second');
  assert.equal(lobbyMeter.steps.attributes['aria-hidden'], 'true');
  assert.deepEqual(plain(lobbyMeter.stepItems.map(item => item.dataset.state)), ['done', 'current', 'next', 'next']);
  assert.match(lobbyMeter.detail.textContent, /under a minute/);
  assert.equal(lobbyMeter.bar.attributes['aria-label'], 'Starting a server');

  /* in the game, the map loading: over the game when the lobby is not up */
  context.window.Module._platform_web_map_load_progress = () => 0.5;
  context.window.Module._platform_web_map_load_index = () => 20;
  Page.update({ runtimeReady: true, queue: null, session: { active: true, connected: true }, lobbyOpen: false }, 2000);
  assert.equal(page.nodes['lobby-progress'].hidden, true);
  assert.equal(page.nodes['map-loading'].hidden, false);
  assert.equal(meterOf('map-loading').label.textContent, 'Loading Rat Race');
  assert.equal(meterOf('map-loading').bar.value, 50);
  /* in the lobby: its steps show the map, and the bar over the game does not */
  Page.update({ runtimeReady: true, queue: { state: 'ready' }, session: { active: true, connected: true }, lobbyOpen: true }, 2500);
  assert.equal(page.nodes['map-loading'].hidden, true);
  assert.equal(lobbyMeter.label.textContent, 'Loading Rat Race');
  assert.deepEqual(plain(lobbyMeter.stepItems.map(item => item.dataset.state)), ['done', 'done', 'done', 'current']);
  /* no session: the landing's own backdrop map is no match's */
  Page.update({ runtimeReady: true, queue: null, session: { active: false }, lobbyOpen: false }, 3000);
  assert.equal(page.nodes['map-loading'].hidden, true);
  assert.equal(page.nodes['lobby-progress'].hidden, true);
}
