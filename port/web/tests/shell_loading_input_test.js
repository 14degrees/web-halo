'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const xinput = fs.readFileSync(
  path.join(webDirectory, '..', 'linux', 'src', 'xinput_sdl.c'), 'utf8');

const loading = shell.match(/<section id="loading"[\s\S]*?<\/section>/);
assert(loading, 'missing loading overlay');
assert.doesNotMatch(loading[0], /class="loading-wordmark"/,
  'loading must not show a large duplicate Halo wordmark');
assert.match(loading[0], /class="loading-orbit"/);
assert.match(shell, /.loading-panel \{[\s\S]*?height: 5.25rem;/,
  'loading panel needs fixed geometry so status changes cannot move it');
assert.match(shell, /#loading progress\[hidden\][\s\S]*?visibility: hidden;/,
  'hidden progress must retain its reserved layout slot');
assert.match(shell, /url\("assets\/ui\/shell\/halo-ce-ring-menu\.jpg"\)/);
assert.match(shell, /url\("assets\/ui\/shell\/hud-frame\.png"\)/);

const setStatus = shell.match(/function setStatus\(text\) \{[\s\S]*?\n    \}/);
assert(setStatus, 'missing setStatus');
assert.doesNotMatch(setStatus[0], /loadingElement\.hidden = true/,
  'runtime status alone must never expose an unpresented black canvas');

const presentationGate = shell.match(
  /function waitForPresentedGame\(\) \{[\s\S]*?\n    \}/);
assert(presentationGate, 'missing first-presentation gate');
assert.match(presentationGate[0], /_platform_web_profile_loops/);
assert.match(presentationGate[0], /_platform_web_profile_swaps/);
assert.match(presentationGate[0], /completedLoops >= 4/);
assert.match(presentationGate[0], /submittedFrames >= 2/);
assert.match(shell, /function revealPresentedGame\(token\)[\s\S]*token !== presentationWaitToken/);

const controls = shell.match(/<div class="game-controls"[\s\S]*?<\/div>/);
assert(controls, 'missing game controls');
assert.match(controls[0], /id="focus"/,
  'Focus game must be a visible control next to mute/fullscreen');
assert.doesNotMatch(controls[0], /id="focus"[^>]* hidden/);
assert.match(shell,
  /<section id="game-frame"[\s\S]*?<canvas[\s\S]*?<footer>[\s\S]*?<div class="game-controls"/,
  'game controls must render directly beneath the framed canvas');
assert.match(shell,
  /<div class="game-controls"[\s\S]*?id="footer-hint"/,
  'mouse-capture guidance must sit opposite the controls beneath the game');
assert.match(shell, /<header hidden>/,
  'the redundant top-right runtime chip must stay hidden');
assert.match(shell, /#game-frame footer \{[\s\S]*?background: transparent;/,
  'the controls must not render inside a full-width bottom bar');
assert.match(shell, /#game-area:fullscreen #game-frame footer \{\s*display: none;/,
  'fullscreen must hide the under-screen control row');
assert.match(shell,
  /#game-area:fullscreen #player-sidebar,\s*#game-area:fullscreen #duke-legend \{ display: none; \}/,
  'fullscreen must hide the online sidebar and Duke legend');
assert.match(shell, /id="duke-legend"[\s\S]*xbox-duke-controller\.png/,
  'the legend must use the high-resolution Duke image');
assert.match(shell, /<dt>A<\/dt>[\s\S]*?<dd>- Space<\/dd>[\s\S]*?<dt>B<\/dt>[\s\S]*?<dd>- F<\/dd>[\s\S]*?<dt>X<\/dt><dd>- E \/ R<\/dd>[\s\S]*?<dt>Y<\/dt><dd>- Tab \/ Wheel<\/dd>[\s\S]*?<dt>White<\/dt><dd>- Q<\/dd>[\s\S]*?<dt>Black<\/dt><dd>- X<\/dd>[\s\S]*?<dt>LT<\/dt><dd>- G \/ RMB<\/dd>[\s\S]*?<dt>RT<\/dt><dd>- LMB<\/dd>[\s\S]*?<dt>Move<\/dt><dd>- WASD<\/dd>[\s\S]*?<dt>Aim<\/dt><dd>- Mouse<\/dd>[\s\S]*?<dt>L3<\/dt><dd>- Ctrl \/ C<\/dd>[\s\S]*?<dt>R3<\/dt><dd>- Z \/ MMB<\/dd>[\s\S]*?<dt>D-pad<\/dt><dd>- Arrows<\/dd>[\s\S]*?<dt>Start<\/dt><dd>- Esc<\/dd>[\s\S]*?<dt>Back<\/dt><dd>- F1<\/dd>/,
  'the high-resolution Duke legend must document the complete keyboard mapping');
assert.doesNotMatch(shell, /<figcaption>Duke<\/figcaption>/,
  'the controller image must not carry a redundant Duke caption');
assert.match(shell, /Made by[\s\S]*mitchellhynes\.com[\s\S]*Mitchell Hynes[\s\S]*id="about-open"[\s\S]*Learn more[\s\S]*ko-fi\.com\/mitchellhynes[\s\S]*Buy me a coffee/,
  'the under-screen row must include the compact creator credit');
assert.match(shell, /id="about-dialog"[\s\S]*mitchell-jester-card\.svg[\s\S]*github\.com\/bnunu\/halo-ce-universal[\s\S]*github\.com\/cybersecurity\/halo-ce-universal[\s\S]*independently hosted[\s\S]*mitchellhynes\.com[\s\S]*responsible for this website[\s\S]*ko-fi\.com\/mitchellhynes[\s\S]*kofi-support-dark\.png/,
  'Learn more must disclose sources, independence, support link, and Joker card');
assert.match(shell, /onlineDialog\.open \|\| aboutDialog\.open/,
  'the creator dialog must own keyboard focus instead of controlling Halo');
assert.match(shell, /addEventListener\("pointerlockchange"/);
assert.match(shell, /addEventListener\("pointerlockerror"/);

const tabBranch = shell.match(
  /if \(event\.key === "Tab"[\s\S]*?\} else if/);
assert(tabBranch, 'missing in-game Tab handling');
assert.match(tabBranch[0], /event\.preventDefault\(\)/,
  'Tab must suppress browser focus traversal while Halo owns input');
assert.doesNotMatch(tabBranch[0], /stopPropagation/,
  'Tab must continue propagating to SDL so it can switch weapons');
assert.match(shell, /!diagnosticsOverlay\.hidden \|\| onlineDialog\.open/,
  'web dialogs must retain accessible Tab navigation');

const connectedGamepads = xinput.match(
  /static DWORD connected_gamepads\(void\)[\s\S]*?\n\}/);
assert(connectedGamepads, 'missing connected_gamepads');
assert.match(connectedGamepads[0], /first pad shares port 0 with the keyboard/);
assert.doesNotMatch(connectedGamepads[0], /HALO_WEB/,
  'web must not shift the first physical controller away from player one');
assert.match(xinput,
  /if \(count > 0\)\s+sdl_gamepad_state\(gamepads\[0\], &state->Gamepad\);/,
  'the first physical controller must merge into Halo player one');
assert.match(shell,
  /function refreshControllerStatus\(\)[\s\S]*?navigator\.getGamepads[\s\S]*?Player 1[\s\S]*?controllers detected/,
  'the shell must continuously report connected browser controllers');
assert.match(shell,
  /gamepadconnected", refreshControllerStatus[\s\S]*?gamepaddisconnected", refreshControllerStatus/,
  'controller status must update for hot-plug and disconnect events');
assert.match(shell,
  /controllerSummary[\s\S]*?mouse capture optional/,
  'a controller must remain usable without mouse capture');

console.log('shell loading, focus, Tab, and controller routing tests passed');
