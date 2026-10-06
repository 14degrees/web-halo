'use strict';

/* The leaderboard and a player's own record (stats_panel.js): the lobby's
   footer opens a leaderboard the Worker sorts and pages, the Spartan dialog
   shows the player's verified record, and every view says the numbers come
   from dedicated-server matches only. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const client = fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8');
const build = fs.readFileSync(path.join(webDirectory, '..', '..', 'tools', 'web_build.py'), 'utf8');

/* the page: a footer button, the dialog, and the record in the Spartan dialog */
assert.match(shell, /<button id="lobby-leaderboard" class="lobby-foot" type="button">Leaderboard<\/button>/);
assert.match(shell, /<dialog id="leaderboard-dialog" class="h3-dialog leaderboard-dialog"/);
for (const id of ['leaderboard-dialog-close', 'leaderboard-sorts', 'leaderboard-rows', 'leaderboard-status',
  'leaderboard-prev', 'leaderboard-page', 'leaderboard-next', 'leaderboard-refresh',
  'spartan-stats', 'spartan-stats-identity', 'spartan-stats-grid', 'spartan-stats-status']) {
  assert.match(shell, new RegExp(`id="${id}"`), `${id} is on the page`);
}
/* the verified note is on the leaderboard, in words */
assert.match(shell, /<span class="stats-verified">Verified<\/span> Dedicated-server matches only\. Custom and player-hosted games aren't counted\./);
/* the Spartan dialog's record sits before Done */
assert.ok(shell.indexOf('id="spartan-stats"') < shell.indexOf('id="spartan-dialog-done"'));

/* the build: the panel is linked in before the client, which looks for it */
const panelAt = build.indexOf('--pre-js {WEB_DIR}/stats_panel.js');
const clientAt = build.indexOf('--pre-js {WEB_DIR}/online_client.js');
assert.ok(panelAt > 0 && panelAt < clientAt, 'stats_panel.js is a pre-js before online_client.js');
assert.match(build, /WEB_DIR \/ "stats_panel\.js",/);

/* the client: hands the panel its context, opens it from the footer, and
   refreshes the record when the Spartan dialog opens; all guarded, so the
   client still runs without the panel */
assert.match(client, /if \(global\.HaloStats\) \{\s*global\.HaloStats\.init\(\{\s*fetchJson: fetchJson,\s*playerKey: playerKey,\s*walletAddress: function\(\) \{ return wallet\.address; \},/);
assert.match(client, /lobbyElement\("lobby-leaderboard"\)/);
assert.match(client, /global\.HaloStats\.openLeaderboard\(\)/);
assert.match(client, /if \(global\.HaloStats\) global\.HaloStats\.refreshPlayerStats\(\);\s*spartanDialog\.showModal\(\);/);

/* ---------- the panel itself, on a fake page */

function element(tag) {
  const listeners = {};
  const node = {
    tagName: tag || 'div',
    childNodes: [],
    classList: {
      classes: new Set(),
      add(name) { this.classes.add(name); },
      remove(name) { this.classes.delete(name); },
      contains(name) { return this.classes.has(name); },
      toggle(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); },
    },
    className: '',
    dataset: {},
    attributes: {},
    disabled: false,
    open: false,
    title: '',
    type: '',
    textContent: '',
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild(child) { this.childNodes.push(child); return child; },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    click() { if (listeners.click) listeners.click({ target: this }); },
    listeners,
  };
  return node;
}

const elements = {};
function byId(id) {
  if (!elements[id]) elements[id] = element();
  return elements[id];
}
const requests = [];
let answers = {};
const context = {
  console,
  document: { getElementById: byId, createElement: element },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(webDirectory, 'stats_panel.js'), 'utf8'), context,
  { filename: 'stats_panel.js' });
const HaloStats = context.HaloStats;
assert.ok(HaloStats, 'the panel installs itself');
assert.deepEqual(Array.from(HaloStats.sorts, sort => sort.id), ['kills', 'wins', 'kd', 'matches', 'net']);

let walletAddress = null;
function fetchJson(requestPath, options) {
  requests.push(requestPath);
  assert.equal(options.method, 'GET');
  const answer = answers[requestPath.split('?')[0]];
  if (typeof answer === 'function') return answer(requestPath);
  if (!answer) {
    const error = new Error('That invite expired or is not valid.');
    error.haloStatus = 404;
    return Promise.reject(error);
  }
  return Promise.resolve(answer);
}
HaloStats.init({ fetchJson, playerKey: () => 'player-key-of-this-browser', walletAddress: () => walletAddress });

/* the sort buttons are built once, kills first and selected */
const sorts = byId('leaderboard-sorts');
assert.equal(sorts.childNodes.length, 5);
assert.equal(sorts.childNodes[0].textContent, 'Kills');
assert.equal(sorts.childNodes[0].attributes['aria-selected'], 'true');
assert.equal(sorts.childNodes[1].attributes['aria-selected'], 'false');

/* the record before any match: a note, no numbers, no crash */
assert.equal(byId('spartan-stats-grid').childNodes.length, 0);

function entry(rank, id, name, identity, kills, deaths, wins, losses, matches, wagered, wagerNet) {
  return { rank, id, name, identity, verified: true, kills, deaths, kd: Math.round((kills / Math.max(deaths, 1)) * 100) / 100,
    wins, losses, draws: 0, quits: 0, score: kills, matches, wagered, wagerNet };
}
const page1 = Array.from({ length: 25 }, (_, index) => entry(index + 1, `g${index}`, `Spartan${index}`, 'guest', 50 - index, 10, 1, 0, 1, 0, 0));
page1[0] = entry(1, 'Chief', 'Chief', 'username', 50, 10, 1, 0, 1, 2, 150000000);
page1[1] = entry(2, 'So1anaWa11etAddressXXXXXXXXXXXXXXXXXXXXX', 'So1a..XXXX', 'wallet', 49, 10, 1, 0, 1, 1, -100000000);
answers = {
  '/v1/leaderboard': requestPath => Promise.resolve(requestPath.includes('offset=25')
    ? { leaderboard: { sort: 'kills', order: 'desc', limit: 25, offset: 25, total: 27, source: 'dedicated',
      entries: [entry(26, 'g25', 'Late', 'guest', 1, 5, 0, 1, 1, 0, 0), entry(27, 'g26', 'Last', 'guest', 0, 9, 0, 1, 1, 0, 0)] } }
    : { leaderboard: { sort: 'kills', order: 'desc', limit: 25, offset: 0, total: 27, source: 'dedicated', entries: page1 } }),
};

(async () => {
  /* opening the board loads page one and shows it */
  await HaloStats.openLeaderboard();
  assert.equal(byId('leaderboard-dialog').open, true);
  assert.equal(requests[0], '/v1/leaderboard?sort=kills&limit=25&offset=0');
  /* and asks after the player, by this browser's key since no wallet is in */
  assert.equal(requests[1], '/v1/players/player-key-of-this-browser');
  const rows = byId('leaderboard-rows').childNodes;
  assert.equal(rows.length, 25);
  const first = rows[0].childNodes;
  assert.equal(first[0].textContent, '1');
  assert.equal(first[1].childNodes[0].textContent, 'Chief');
  assert.equal(first[1].childNodes[1].textContent, 'Username');
  assert.equal(first[1].childNodes[1].dataset.identity, 'username');
  assert.equal(first[2].textContent, '50');
  assert.equal(first[4].textContent, '5.00');
  assert.equal(first[5].textContent, '1–0');
  assert.equal(first[7].textContent, '+0.150', 'a wagering player shows their SOL');
  assert.equal(rows[1].childNodes[1].childNodes[1].textContent, 'Wallet');
  assert.equal(rows[1].childNodes[7].textContent, '-0.100');
  assert.equal(rows[2].childNodes[1].childNodes[1].textContent, 'Guest');
  assert.equal(rows[2].childNodes[7].textContent, '–', 'a player who never wagered shows none');
  assert.equal(byId('leaderboard-page').textContent, '1–25 of 27');
  assert.equal(byId('leaderboard-prev').disabled, true);
  assert.equal(byId('leaderboard-next').disabled, false);
  assert.equal(byId('leaderboard-status').textContent, '');
  /* nobody on record for this browser yet: the record says so, in words
     that name the source */
  assert.match(byId('spartan-stats-status').textContent, /^No matchmade games on record yet\. Only dedicated-server matches count/);
  assert.equal(byId('spartan-stats-grid').childNodes.length, 0);

  /* the next page */
  byId('leaderboard-next').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[requests.length - 1], '/v1/leaderboard?sort=kills&limit=25&offset=25');
  assert.equal(byId('leaderboard-rows').childNodes.length, 2);
  assert.equal(byId('leaderboard-rows').childNodes[0].childNodes[0].textContent, '26');
  assert.equal(byId('leaderboard-page').textContent, '26–27 of 27');
  assert.equal(byId('leaderboard-next').disabled, true);
  assert.equal(byId('leaderboard-prev').disabled, false);

  /* a new sort starts from the top */
  sorts.childNodes[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[requests.length - 1], '/v1/leaderboard?sort=wins&limit=25&offset=0');
  assert.equal(sorts.childNodes[1].attributes['aria-selected'], 'true');
  assert.equal(sorts.childNodes[0].attributes['aria-selected'], 'false');
  /* the same sort again asks nothing */
  const before = requests.length;
  sorts.childNodes[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, before);

  /* the player signs in: their record is looked up by wallet, shown, and
     their line on the board lights up */
  walletAddress = 'So1anaWa11etAddressXXXXXXXXXXXXXXXXXXXXX';
  answers['/v1/players/So1anaWa11etAddressXXXXXXXXXXXXXXXXXXXXX'] = {
    player: { ...entry(2, walletAddress, 'So1a..XXXX', 'wallet', 49, 10, 1, 0, 1, 1, -100000000), draws: 1,
      ranks: { kills: 2, wins: 7 }, recent: [] },
  };
  await HaloStats.refreshPlayerStats();
  assert.equal(requests[requests.length - 1], `/v1/players/${walletAddress}`);
  const cells = byId('spartan-stats-grid').childNodes.map(cell => [cell.childNodes[0].textContent, cell.childNodes[1].textContent]);
  assert.deepEqual(cells, [
    ['Matches', '1'], ['Record', '1–0–1'], ['Kills', '49'], ['Deaths', '10'], ['K/D', '4.90'], ['Rank', '#2 by kills'],
    ['SOL', '-0.100 in 1 match'],
  ]);
  assert.equal(byId('spartan-stats-identity').childNodes[0].textContent, 'Wallet');
  assert.match(byId('spartan-stats-status').textContent, /^Verified from dedicated-server matches\. Tied to your wallet\./);
  byId('leaderboard-prev').click();
  await new Promise(resolve => setImmediate(resolve));
  const yours = byId('leaderboard-rows').childNodes[1];
  assert.equal(yours.className, 'leaderboard-you');
  assert.equal(yours.childNodes[1].childNodes[0].textContent, 'So1a..XXXX (you)');

  /* a wallet with no record yet falls back to the browser's own record */
  walletAddress = 'FreshWa11etAddressYYYYYYYYYYYYYYYYYYYYYY';
  answers['/v1/players/player-key-of-this-browser'] = {
    player: { ...entry(9, 'abcdef0123456789', 'Rookie', 'guest', 3, 4, 0, 1, 1, 0, 0), ranks: { kills: 9, wins: 9 }, recent: [] },
  };
  await HaloStats.refreshPlayerStats();
  assert.deepEqual(requests.slice(-2), [`/v1/players/${walletAddress}`, '/v1/players/player-key-of-this-browser']);
  assert.equal(byId('spartan-stats-identity').childNodes[0].textContent, 'Guest');
  assert.match(byId('spartan-stats-status').textContent, /Tied to this browser only\. Sign in with a wallet to keep it\./);

  /* the service down: the board says so and keeps working */
  answers['/v1/leaderboard'] = () => Promise.reject(new Error('The private-room service is unreachable.'));
  await HaloStats.loadLeaderboard();
  assert.equal(byId('leaderboard-rows').childNodes.length, 0);
  assert.equal(byId('leaderboard-status').textContent, 'The private-room service is unreachable.');

  HaloStats.closeLeaderboard();
  assert.equal(byId('leaderboard-dialog').open, false);
  console.log('stats panel: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
