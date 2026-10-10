'use strict';

/* Badges beside players' names (badges.js): the links the room or party
   attached, checked, drawn as links that open in a new tab, and shown in
   the lobby roster, the room sidebar, the scoreboard, the carnage report
   and the lobby chat. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(webDirectory, 'badges.js'), 'utf8');
const onlineClient = fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8');
const chat = fs.readFileSync(path.join(webDirectory, 'chat.js'), 'utf8');
const postMatch = fs.readFileSync(path.join(webDirectory, 'post_match.js'), 'utf8');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const webBuild = fs.readFileSync(path.join(webDirectory, '..', '..', 'tools', 'web_build.py'), 'utf8');

/* ---- the build: its own module, before post_match.js, which stays right before online_client.js */
const order = [...webBuild.matchAll(/f"--pre-js \{WEB_DIR\}\/([a-z_]+\.js)",/g)].map(match => match[1]);
assert(order.includes('badges.js'), 'badges.js is bundled');
assert(order.indexOf('badges.js') < order.indexOf('post_match.js'));
assert.equal(order.indexOf('post_match.js') + 1, order.indexOf('online_client.js'));
assert.match(webBuild, /WEB_DIR \/ "badges\.js",/);

/* ---- the places that draw them */
assert.match(onlineClient, /links: global\.HaloBadges \? global\.HaloBadges\.normalize\(value\.links\) : null,/, 'the room roster');
assert.match(onlineClient, /links: global\.HaloBadges \? global\.HaloBadges\.normalize\(member\.links\) : null,/, 'the party');
assert.match(onlineClient, /row\.appendChild\(label\);\s*appendBadges\(row, player\.links\);/, 'the sidebar');
assert.match(onlineClient, /row\.appendChild\(name\);\s*appendBadges\(row, player\.links\);/, 'the lobby roster');
assert.match(onlineClient, /appendBadges\(nameCell, links\);/, 'the scoreboard');
assert.match(onlineClient, /lobby\.postMatch\.badges = badges;/, 'the carnage report');
assert.match(postMatch, /global\.HaloBadges\.element\(badges\[row\.name\]\)/);
assert.match(chat, /links: global\.HaloBadges \? global\.HaloBadges\.normalize\(message\.links\) : null,/, 'chat lines');
assert.match(shell, /\.player-badges \{/);

/* ---- a page to run badges.js in */
function element(tagName) {
  const listeners = {};
  return {
    tagName, childNodes: [], className: '', textContent: '', title: '', listeners,
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild(child) { this.childNodes.push(child); return child; },
  };
}
const window = {};
const context = { window, document: { createElement: element }, encodeURIComponent };
vm.runInNewContext(source, context, { filename: 'badges.js' });
const badges = window.HaloBadges;
/* the module's objects come from another realm: compare them as JSON */
const plain = value => JSON.parse(JSON.stringify(value));
assert(badges, 'badges.js installs HaloBadges');

/* ---- what a message may carry */
assert.equal(badges.normalize(null), null);
assert.equal(badges.normalize({}), null);
assert.equal(badges.normalize({ x: { handle: 'not a handle!' } }), null, 'a malformed handle is dropped');
assert.deepEqual(plain(badges.normalize({ fomo: { handle: null }, x: { handle: 'halo_online' }, wallet: 'W' })),
  { fomo: { handle: null }, x: { handle: 'halo_online' } });
assert.deepEqual(plain(badges.normalize({ fomo: { handle: 'javascript:alert(1)' } })), { fomo: { handle: null } },
  'a fomo wallet with a bad handle links nowhere');

/* ---- drawing */
assert.equal(badges.element(null), null);
const drawn = badges.element({ fomo: { handle: 'chief.117' }, x: { handle: 'halo_online' } });
assert.equal(drawn.className, 'player-badges');
const [fomo, x] = drawn.childNodes;
assert.equal(fomo.tagName, 'a');
assert.equal(fomo.href, 'https://fomo.family/profile/chief.117');
assert.equal(fomo.target, '_blank');
assert.equal(fomo.rel, 'noopener noreferrer');
assert.equal(fomo.title, '@chief.117 on fomo');
assert.equal(x.tagName, 'a');
assert.equal(x.href, 'https://x.com/halo_online');
assert.equal(x.rel, 'noopener noreferrer');
let stopped = false;
x.listeners.click({ stopPropagation() { stopped = true; } });
assert(stopped, 'a click on a badge goes no further than the badge');

const walletOnly = badges.element({ fomo: { handle: null } });
assert.equal(walletOnly.childNodes[0].tagName, 'span', 'a fomo wallet without a confirmed handle links nowhere');
assert.equal(walletOnly.childNodes[0].title, 'fomo wallet');
assert.equal(walletOnly.childNodes[0].href, undefined);

/* ---- by the name a player plays under, for the scoreboard and the carnage report */
const roster = new Map([
  ['g_1', { profile: { name: 'Chief' }, links: { x: { handle: 'chief' } } }],
  ['g_2', { profile: { name: 'Arbiter' }, links: null }],
  ['g_3', { profile: null, links: { x: { handle: 'ghost' } } }],
]);
assert.deepEqual(plain(badges.byName(roster)), { Chief: { x: { handle: 'chief' } } });
assert.equal(badges.key({ x: { handle: 'chief' } }), 'x:https://x.com/chief');
assert.equal(badges.key(null), '');

console.log('badges: ok');
