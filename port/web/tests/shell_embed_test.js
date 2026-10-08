'use strict';

/* The game inside an X post (services/web/src/embed.js serves /embed with
   <body data-embed>): no mouse capture there, so the page aims; no wallet;
   and a browser that cannot isolate the frame gets the game in a new tab. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webDirectory = path.join(__dirname, '..');
const repository = path.join(webDirectory, '..', '..');
const read = file => fs.readFileSync(path.join(repository, file), 'utf8');
const shell = read('port/web/shell.html');
const online = read('port/web/online_client.js');
const coi = read('port/web/coi-serviceworker.js');
const platform = read('port/linux/src/sdl_platform.c');
const wrangler = read('services/web/wrangler.jsonc');

assert.match(wrangler, /"run_worker_first": \["\/", "\/embed", "\/embed\/"\]/,
  'the Worker must add the card tags to / and serve /embed');

assert.match(shell, /const embedded = Boolean\(document\.body\.dataset\.embed\);/);
assert.match(shell, /const embedFallback = embedded && !self\.crossOriginIsolated;/);
assert.match(shell, /<section id="embed-fallback"[^>]*hidden>[\s\S]*?<a href="\/" target="_blank" rel="noopener">/,
  'the fallback opens the full game in a new tab');
assert.match(shell, /<a id="landing-full" class="landing-full" href="\/" target="_blank" rel="noopener" hidden>/);
assert.match(shell, /<div class="game-controls"[\s\S]*?<a id="full-game"[^>]*target="_blank"[^>]*hidden>/);
assert.match(shell, /body\[data-embed\] \.landing-modes, body\[data-embed\] \.landing-spartan,\s*body\[data-embed\] \.landing-links \{ display: none !important; \}/,
  'the landing fits the card: Click to play only, and no referral links in a card');
assert.match(shell, /const embedAim = window\.HaloEmbedAim = \{/);
assert.match(shell, /Module\._platform_web_page_aim\(embedAim\.engaged \? 1 : 0, dx, dy\)/);
assert.match(shell, /function captureGameInput\(\) \{\s*focusCanvas\(\);\s*if \(embedAim\.engage\(\)\) \{/,
  'a click into the game engages the page aim before trying a capture');
assert.match(shell, /if \(event\.type === "keydown" && event\.key === "Escape"\) embedAim\.release\(\);/,
  'Esc gives the mouse back, as with a capture');
assert.match(shell, /window\.addEventListener\("error", event => \{\s*if \(embedFallback\) return;/);

assert.match(online, /WALLET_ENABLED = \(function\(\) \{[\s\S]{0,200}?dataset\.embed\) return false;/,
  'no money inside an X post');
assert.match(online, /function mouseCaptured\(\) \{[\s\S]*?global\.HaloEmbedAim && global\.HaloEmbedAim\.engaged/,
  'the page aim counts as captured, or the menu would cover the match');
assert.match(online, /closest\("\.landing-mode, \.landing-customize, \.landing-leave, \.landing-full"\)/,
  'Full game must not also start Quick Play');
assert.equal((online.match(/releaseMouse\(\);/g) || []).length, 2,
  'the landing and the lobby release the page aim with the capture');

assert.match(coi, /scope\.top !== scope/, 'a frame cannot be isolated by the service worker');

assert.match(platform, /EMSCRIPTEN_KEEPALIVE void platform_web_page_aim\(int active, float dx, float dy\)/);
assert.match(platform, /case SDL_EVENT_MOUSE_MOTION:[\s\S]*?if \(web_page_aim\)\s*break;[\s\S]*?input_state\.mouse_dx \+= event\.motion\.xrel;/,
  "SDL's absolute motion must not add to the page's aim");
