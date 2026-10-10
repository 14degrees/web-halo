'use strict';

/* Stakes the player picks (port/web/stakes.js): a playlist for SOL's
   tiers and what each means, a party's custom game for SOL, and the
   pickers; the page sends the tier with its queue ticket and shows the
   terms before anyone commits. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const client = fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8');
const build = fs.readFileSync(path.join(webDirectory, '..', '..', 'tools', 'web_build.py'), 'utf8');

/* the page: the pickers, the dialog, and the module bundled before the client */
['playlist-detail-stakes', 'lobby-stakes-open', 'lobby-stakes', 'lobby-stakes-accept', 'stakes-dialog', 'stakes-tiers',
  'stakes-custom', 'stakes-kill-target', 'stakes-team-share', 'stakes-terms', 'stakes-detail', 'stakes-acceptance',
  'stakes-accept', 'stakes-done', 'stakes-dialog-close'].forEach(id => {
  assert.match(shell, new RegExp(`id="${id}"`), `missing ${id}`);
});
assert(build.indexOf('{WEB_DIR}/stakes.js') > 0 && build.indexOf('{WEB_DIR}/stakes.js') < build.indexOf('{WEB_DIR}/online_client.js'),
  'stakes.js must be bundled before online_client.js');
/* the ticket carries the tier; the party's members accept by the terms' number */
assert.match(client, /request\.stake = wager\.stake/);
assert.match(client, /partyRequest\("accept", \{ terms: view\.terms \}\)/);

const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(webDirectory, 'stakes.js'), 'utf8'), { window: sandbox }, { filename: 'stakes.js' });
const Stakes = sandbox.HaloStakes;
assert(Stakes, 'stakes.js installs HaloStakes');
const plain = value => JSON.parse(JSON.stringify(value));
const SOL = 1e9;

/* amounts: as few places as they need */
assert.equal(Stakes.sol(SOL / 20), '0.05');
assert.equal(Stakes.sol(SOL / 10), '0.1');
assert.equal(Stakes.sol(1425000), '0.0014');
assert.equal(Stakes.sol(0), '0');

/* a bounty tier: the stake and the bounty, exactly */
const bounty = Stakes.terms({ stake: SOL / 100, perKill: SOL / 500, mode: 'bounty', stakes: null }, 2, 500);
assert.equal(bounty.perKill, SOL / 500);
assert.equal(bounty.line, '◎ 0.01 SOL stake · ◎ 0.002 a kill · 5% fee on winnings');

/* Team Stakes, 2 on 2 at 0.05: the losers' 0.1 less 5% is 0.095; a
   quarter evenly, the rest over 50 kills: 0.001425 a kill (wager.ts's
   stakesProjection) */
const team = { stake: SOL / 20, perKill: 0, mode: 'team', stakes: { stake: SOL / 20, killTarget: 50, teamShareBps: 2500, groups: 2 } };
assert.deepEqual(plain(Stakes.projection(team.stakes, 4, 500)), { perKill: 1425000, floor: 11875000, prize: 95000000, winners: 2 });
const teamTerms = Stakes.terms(team, 4, 500);
assert.equal(teamTerms.perKill, 1425000);
assert.match(teamTerms.line, /^◎ 0\.05 SOL stake · about ◎ 0\.0014 a kill/);
assert.match(teamTerms.detail, /If your team wins: your stake back, an even 25% of the prize/);
assert.match(teamTerms.detail, /over 50 kills/);
assert.equal(Stakes.terms(null, 4), null);

/* a custom game: Team Stakes rules, in teams for a team game type, each
   alone otherwise; a free one is no wager */
const custom = { stake: SOL / 100, killTarget: 25, teamShareBps: 5000 };
assert.equal(Stakes.customWager(custom, 1).stakes.groups, 2);
assert.equal(Stakes.customWager(custom, 0).stakes.groups, 0);
assert.equal(Stakes.customWager(null, 1), null);
/* a free-for-all of three at 0.01: two forfeit 0.02, less 5%; half evenly
   (the one winner), half over 25 kills */
assert.equal(Stakes.terms(Stakes.customWager(custom, 0), 3, 500).perKill, Math.floor((19000000 - 9500000) / 25));
assert.match(Stakes.terms(Stakes.customWager(custom, 0), 3, 500).detail, /^If you win:/);

/* the tier picker: each tier's stake, a kill, and who is searching at it */
const tiers = [
  { stake: SOL / 100, perKill: SOL / 500, mode: 'bounty', stakes: null, searching: 0 },
  { stake: SOL / 20, perKill: SOL / 100, mode: 'bounty', stakes: null, searching: 3 },
];
assert.deepEqual(plain(Stakes.tierChoices(tiers, 2, 500)), [
  { value: SOL / 100, label: '◎ 0.01', note: '◎ 0.002/kill' },
  { value: SOL / 20, label: '◎ 0.05', note: '◎ 0.01/kill · 3 searching' },
]);
const customChoices = plain(Stakes.customChoices([SOL / 100, SOL / 20]));
assert.deepEqual(customChoices.stake.map(choice => choice.value), [null, SOL / 100, SOL / 20]);
assert.deepEqual(customChoices.killTarget.map(choice => choice.value), [10, 25, 50, 100]);
assert.deepEqual(customChoices.teamShare.map(choice => choice.label), ['0%', '25%', '50%', '100%']);

/* drawing: a button per choice, the picked one pressed, a click picks;
   a member who may only look can't */
function fakeDocument() {
  const make = tag => {
    const node = {
      tagName: tag, children: [], dataset: {}, attributes: {}, listeners: {}, textContent: '', disabled: false,
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      replaceChildren(...children) { this.children = children; },
    };
    node.ownerDocument = documentRef;
    return node;
  };
  const documentRef = { createElement: make };
  return documentRef;
}
const documentRef = fakeDocument();
const container = documentRef.createElement('div');
const picked = [];
Stakes.renderChoices(container, Stakes.tierChoices(tiers, 2, 500), SOL / 20, value => picked.push(value), false);
assert.equal(container.children.length, 2);
assert.equal(container.children[1].attributes['aria-pressed'], 'true');
assert.equal(container.children[0].attributes['aria-pressed'], 'false');
container.children[0].listeners.click();
assert.deepEqual(picked, [SOL / 100]);
/* the same picker again draws nothing new */
const before = container.children[0];
Stakes.renderChoices(container, Stakes.tierChoices(tiers, 2, 500), SOL / 20, value => picked.push(value), false);
assert.equal(container.children[0], before);
Stakes.renderChoices(container, Stakes.tierChoices(tiers, 2, 500), SOL / 20, value => picked.push(value), true);
assert.equal(container.children[0].disabled, true);
container.children[0].listeners.click();
assert.deepEqual(picked, [SOL / 100]);
Stakes.renderChoices(null, [], null, () => {}, false);

console.log('stakes: ok');
