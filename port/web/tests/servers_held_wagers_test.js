'use strict';

/* The dashboard's "Held wagers" panel (servers_wagers.js): the operator
   pastes the admin token (kept in sessionStorage only), each held match
   lists its reason, dropped teams, stakes, deadline, ceiling and history,
   and Forfeit, Void and Extend ask for a note (and hours) and a
   confirmation before calling the Worker's admin routes. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const webDirectory = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(webDirectory, 'servers.html'), 'utf8');
const source = fs.readFileSync(path.join(webDirectory, 'servers_wagers.js'), 'utf8');
const stage = fs.readFileSync(path.join(webDirectory, '..', '..', 'tools', 'web_stage_cloudflare.py'), 'utf8');
const worker = fs.readFileSync(
  path.join(webDirectory, '..', '..', 'services', 'signaling', 'src', 'index.ts'), 'utf8');
const panel = require(path.join(webDirectory, 'servers_wagers.js'));

/* ---- the page loads the panel, the stage copies it, the Worker answers its preflight */
test('the page, the staging script and the Worker know the panel', () => {
  assert.match(page, /<section id="held-wagers"><\/section>/);
  assert.match(page, /<script src="servers_wagers\.js"><\/script>/);
  assert.match(page, /HaloHeldWagers\.mount\(\{ container: document\.getElementById\("held-wagers"\), signalingUrl: signaling \}\);/);
  assert.match(stage, /"servers_wagers\.js", output \/ "servers_wagers\.js"/);
  assert.match(worker, /if \(request\.method === "OPTIONS"\) \{\n\s+return corsPreflight\(\);/,
    'the admin routes answer the preflight before the bearer check');
  assert.match(worker, /withCors\(adminResponse, request\.headers\.get\("Origin"\) === null \? null : allowedOrigin\(request, env\)\)/);
  /* the repo is public: no token in the page or the panel */
  for (const text of [page, source]) {
    assert.doesNotMatch(text, /Bearer [A-Za-z0-9_\-]{8,}/, 'no token literal');
    assert.doesNotMatch(text, /ADMIN_TOKEN\s*[:=]/, 'no token constant');
  }
  assert.match(source, /sessionStorage/);
  assert.equal(panel.TOKEN_KEY, 'halo-admin-token');
});

/* ---- a fake DOM: enough for createElement, append, replaceChildren and events */
function fakeElement(tag) {
  const listeners = {};
  const node = {
    tag, attributes: {}, children: [], textContent: '', value: '', disabled: false,
    setAttribute(name, value) { node.attributes[name] = String(value); },
    append(...items) { items.forEach((item) => node.children.push(item)); },
    replaceChildren(...items) { node.children = items; },
    addEventListener(type, listener) { (listeners[type] = listeners[type] || []).push(listener); },
    fire(type) { (listeners[type] || []).forEach((listener) => listener({ type })); },
  };
  return node;
}
const fakeDocument = { createElement: fakeElement };

function find(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  (node.children || []).forEach((child) => find(child, predicate, found));
  return found;
}
const byClass = (node, name) => find(node, (candidate) => (candidate.attributes || {}).class === name);
const buttons = (node, text) => find(node, (candidate) => candidate.tag === 'button' && candidate.textContent === text);
const text = (node) => find(node, () => true).map((candidate) => candidate.textContent).join('\n');

function fakeStorage(initial, broken) {
  const store = Object.assign({}, initial || {});
  return {
    store,
    getItem(key) { if (broken) throw new Error('storage disabled'); return key in store ? store[key] : null; },
    setItem(key, value) { if (broken) throw new Error('storage disabled'); store[key] = value; },
    removeItem(key) { if (broken) throw new Error('storage disabled'); delete store[key]; },
  };
}

const NOW = 1_760_000_000_000;
const HELD_ROW = { matchId: 'match-held-1', playlist: 'teamstakes', since: NOW - 3_600_000, deadline: NOW + 8 * 3_600_000, limit: NOW + 22 * 3_600_000, reason: 'group 1 dropped out' };
const RECORD = {
  view: {
    matchId: 'match-held-1', state: 'held', mode: 'team', stake: 50_000_000, pot: 200_000_000, feeBps: 250,
    players: [
      { wallet: 'AAAAwalletAAAA1111', name: 'red-one', balance: 50_000_000, kills: 12, deaths: 3 },
      { wallet: 'BBBBwalletBBBB2222', name: 'red-two', balance: 50_000_000, kills: 7, deaths: 4 },
      { wallet: 'CCCCwalletCCCC3333', name: 'blue-one', balance: 50_000_000, kills: 4, deaths: 9 },
      { wallet: 'DDDDwalletDDDD4444', name: 'blue-two', balance: 50_000_000, kills: 3, deaths: 10 },
    ],
  },
  config: { stake: 50_000_000, killTarget: 50, teamShareBps: 2500, groups: 2 },
  hold: {
    reason: 'group 1 dropped out', dropped: [1], since: HELD_ROW.since, deadline: HELD_ROW.deadline, limit: HELD_ROW.limit,
    history: [{ at: HELD_ROW.since, by: 'match', action: 'held', detail: { reason: 'group 1 dropped out', dropped: [1] } }],
    decision: null,
  },
  result: { teams: true, teamScores: [19, 7], players: [
    { name: 'red-one', team: 0, score: 12, quit: false }, { name: 'red-two', team: 0, score: 7, quit: false },
    { name: 'blue-one', team: 1, score: 4, quit: true }, { name: 'blue-two', team: 1, score: 3, quit: true },
  ] },
  settlement: { payouts: [115_000_000, 80_000_000, 0, 0], fee: 5_000_000, winningGroups: [0], perKill: 3_000_000, killShares: [], evenShares: [] },
  payouts: null, createdAt: HELD_ROW.since - 600_000, updatedAt: HELD_ROW.since,
};

/* a Worker double: answers by route, records every request, and can be told to reject */
function fakeWorker(options) {
  const calls = [];
  const state = Object.assign({ token: 'secret-token', held: [HELD_ROW], records: { 'match-held-1': RECORD } }, options);
  async function fetchImpl(url, init) {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
    if (init.headers.Authorization !== 'Bearer ' + state.token) return reply(401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } });
    const route = url.replace('https://worker.test', '');
    if (route === '/v1/admin/wagers/held') return reply(200, { held: state.held });
    const match = /^\/v1\/admin\/wagers\/([^/]+)(?:\/(decide|hold))?$/.exec(route);
    const record = match && state.records[match[1]];
    if (!match[2]) return record ? reply(200, record) : reply(404, { error: { code: 'NOT_FOUND', message: 'No wager for that match.' } });
    if (!record || record.view.state !== 'held') return reply(409, { error: { code: 'NOT_HELD', message: 'That wager is not held.' } });
    const body = JSON.parse(init.body);
    if (match[2] === 'decide') {
      if (!['forfeit', 'void'].includes(body.action) || !body.note) return reply(400, { error: { code: 'VALIDATION_FAILED', message: 'action must be forfeit or void, with a note.' } });
      state.held = state.held.filter((row) => row.matchId !== match[1]);
      return reply(200, { wager: Object.assign({}, record.view, { state: body.action === 'forfeit' ? 'settling' : 'voiding' }) });
    }
    if (!(body.hours > 0) || !body.note) return reply(400, { error: { code: 'VALIDATION_FAILED', message: 'hours must be a number up to 168, with a note.' } });
    const wanted = record.hold.deadline + body.hours * 3_600_000;
    const clamped = wanted > record.hold.limit;
    record.hold.deadline = clamped ? record.hold.limit : wanted;
    return reply(200, { deadline: record.hold.deadline, limit: record.hold.limit, clamped });
  }
  return { calls, state, fetch: fetchImpl };
}

function mountPanel(worker, storage) {
  const timers = [];
  const container = fakeElement('section');
  const handle = panel.mount({
    container, document: fakeDocument, fetch: worker.fetch, storage,
    signalingUrl: async () => 'https://worker.test', now: () => NOW,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (id) => { timers[id - 1] = null; },
  });
  return { container, handle, timers };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('signed out: a token field, nothing fetched, the token kept in sessionStorage on sign-in', async () => {
  const worker = fakeWorker();
  const storage = fakeStorage();
  const { container, handle, timers } = mountPanel(worker, storage);
  assert.equal(find(container, (node) => node.tag === 'input' && node.attributes.type === 'password').length, 1);
  assert.equal(worker.calls.length, 0, 'nothing is fetched without a token');
  assert.equal(buttons(container, 'Sign in').length, 1);

  await handle.signIn('  ');
  assert.match(text(container), /Paste the admin token first/);
  assert.equal(worker.calls.length, 0);

  const input = find(container, (node) => node.tag === 'input')[0];
  input.value = 'secret-token';
  buttons(container, 'Sign in')[0].fire('click');
  await settle(); await settle(); await settle();
  assert.equal(storage.store['halo-admin-token'], 'secret-token', 'the token lives in sessionStorage');
  assert.equal(worker.calls[0].url, 'https://worker.test/v1/admin/wagers/held');
  assert.equal(worker.calls[0].init.headers.Authorization, 'Bearer secret-token');
  assert.equal(worker.calls[1].url, 'https://worker.test/v1/admin/wagers/match-held-1');
  assert.equal(timers.filter(Boolean).length, 1, 'refreshes on a timer once signed in');
  assert.equal(timers[0].ms, panel.REFRESH_MS);

  const shown = text(container);
  assert.match(shown, /Match match-held-1 · teamstakes/);
  assert.match(shown, /group 1 dropped out/);
  assert.match(shown, /^Blue$/m, 'the dropped team is named');
  assert.match(shown, /0\.050 SOL each · pot 0\.200 SOL · fee 2\.5%/);
  assert.match(shown, /in 8 h 00 min/, 'the deadline');
  assert.match(shown, /in 22 h 00 min/, 'the ceiling');
  assert.match(shown, /red-one · AAAA…1111/);
  assert.match(shown, /blue-one · CCCC…3333/);
  assert.match(shown, /Blue \(quit\)/);
  assert.match(shown, /0\.115 SOL/, 'the forfeit payout of the top scorer');
  assert.match(shown, /match · held: group 1 dropped out \(dropped: Blue\)/, 'the history');
  for (const label of ['Forfeit', 'Void', 'Extend']) assert.equal(buttons(container, label).length, 1, label);
  assert.equal(byClass(container, 'admin-form').length, 0, 'no form until a button is pressed');
});

test('a stored token signs in on load; sign out removes it and stops the refresh', async () => {
  const worker = fakeWorker();
  const storage = fakeStorage({ 'halo-admin-token': 'secret-token' });
  const { container, timers } = mountPanel(worker, storage);
  await settle(); await settle(); await settle();
  assert.equal(worker.calls[0].init.headers.Authorization, 'Bearer secret-token');
  assert.match(text(container), /Match match-held-1/);
  buttons(container, 'Sign out')[0].fire('click');
  assert.equal(storage.store['halo-admin-token'], undefined, 'the token is gone');
  assert.equal(timers.filter(Boolean).length, 0, 'the timer stops');
  assert.match(text(container), /Signed out; the token was removed/);
  assert.equal(find(container, (node) => node.tag === 'input' && node.attributes.type === 'password').length, 1);
  assert.equal(find(container, (node) => (node.attributes || {})['data-match']).length, 0, 'the cards are gone');
});

test('a rejected token (401) signs the operator out with a message', async () => {
  const worker = fakeWorker({ token: 'other-token' });
  const storage = fakeStorage({ 'halo-admin-token': 'secret-token' });
  const { container } = mountPanel(worker, storage);
  await settle(); await settle();
  assert.match(text(container), /rejected that token/);
  assert.equal(storage.store['halo-admin-token'], undefined);
  assert.equal(find(container, (node) => node.tag === 'input' && node.attributes.type === 'password').length, 1);
});

test('forfeit asks for a note and a confirmation, then posts the decision', async () => {
  const worker = fakeWorker();
  const { container, handle } = mountPanel(worker, fakeStorage({ 'halo-admin-token': 'secret-token' }));
  await settle(); await settle(); await settle();
  buttons(container, 'Forfeit')[0].fire('click');
  const form = byClass(container, 'admin-form')[0];
  assert(form, 'the form opens');
  assert.match(text(form), /Forfeit the dropped team · match match-held-1/);
  assert.match(text(form), /Winners share 0\.195 SOL after a 0\.005 SOL fee/);
  const confirm = buttons(form, 'Confirm forfeit')[0];
  assert.equal(confirm.disabled, true, 'confirm waits for a note');
  const note = find(form, (node) => node.tag === 'textarea')[0];
  assert.equal(note.attributes.maxlength, '500');
  note.value = 'red quit while behind';
  note.fire('input');
  assert.equal(confirm.disabled, false);
  const before = worker.calls.length;
  buttons(form, 'Cancel')[0].fire('click');
  assert.equal(byClass(container, 'admin-form').length, 0, 'cancel closes the form');
  assert.equal(worker.calls.length, before, 'cancel posts nothing');

  buttons(container, 'Forfeit')[0].fire('click');
  const again = byClass(container, 'admin-form')[0];
  find(again, (node) => node.tag === 'textarea')[0].value = 'red quit while behind';
  find(again, (node) => node.tag === 'textarea')[0].fire('input');
  buttons(again, 'Confirm forfeit')[0].fire('click');
  await settle(); await settle(); await settle(); await settle();
  const decide = worker.calls.find((call) => call.url.endsWith('/decide'));
  assert(decide, 'the decision is posted');
  assert.equal(decide.init.method, 'POST');
  assert.deepEqual(decide.body, { action: 'forfeit', note: 'red quit while behind' });
  assert.equal(decide.init.headers['Content-Type'], 'application/json');
  assert.match(text(container), /match-held-1: forfeit recorded; the stakes are being paid/);
  assert.match(text(container), /No wagers are held/, 'the list refreshes after the decision');
  assert.equal(handle.state.form, null);
});

test('void posts void; an empty note never reaches the Worker', async () => {
  const worker = fakeWorker();
  const { container, handle } = mountPanel(worker, fakeStorage({ 'halo-admin-token': 'secret-token' }));
  await settle(); await settle(); await settle();
  const before = worker.calls.length;
  await handle.submit('match-held-1', 'void', '   ');
  assert.equal(worker.calls.length, before, 'no post without a note');
  assert.match(text(container), /A note of 1 to 500 characters is required/);
  await handle.submit('match-held-1', 'void', 'server outage confirmed');
  const decide = worker.calls.find((call) => call.url.endsWith('/decide'));
  assert.deepEqual(decide.body, { action: 'void', note: 'server outage confirmed' });
  assert.match(text(container), /void recorded; the stakes are being returned/);
});

test('extend asks for hours and a note, posts them, and reports a clamp', async () => {
  const worker = fakeWorker();
  const { container } = mountPanel(worker, fakeStorage({ 'halo-admin-token': 'secret-token' }));
  await settle(); await settle(); await settle();
  buttons(container, 'Extend')[0].fire('click');
  const form = byClass(container, 'admin-form')[0];
  const hours = find(form, (node) => node.tag === 'input' && node.attributes.type === 'number')[0];
  assert(hours, 'an hours field');
  assert.equal(hours.attributes.max, '168');
  hours.value = '20';
  const note = find(form, (node) => node.tag === 'textarea')[0];
  note.value = 'waiting on the players';
  note.fire('input');
  buttons(form, 'Confirm extend')[0].fire('click');
  await settle(); await settle(); await settle(); await settle();
  const hold = worker.calls.find((call) => call.url.endsWith('/hold'));
  assert.deepEqual(hold.body, { hours: 20, note: 'waiting on the players' });
  assert.match(text(container), /is held until .* \(clamped at the ceiling\)/);
  assert.match(text(container), /in 22 h 00 min\) · forfeits by itself then/, 'the refreshed deadline sits at the ceiling');
});

test('a 409 says the match is no longer held and refreshes; a 401 on an action signs out', async () => {
  const worker = fakeWorker();
  const storage = fakeStorage({ 'halo-admin-token': 'secret-token' });
  const { container, handle } = mountPanel(worker, storage);
  await settle(); await settle(); await settle();
  worker.state.records['match-held-1'] = Object.assign({}, RECORD, { view: Object.assign({}, RECORD.view, { state: 'settling' }) });
  worker.state.held = [];
  await handle.submit('match-held-1', 'forfeit', 'late');
  assert.match(text(container), /match-held-1 is no longer held; nothing was changed/);
  assert.match(text(container), /No wagers are held/);
  assert.equal(storage.store['halo-admin-token'], 'secret-token', 'still signed in');

  worker.state.held = [HELD_ROW];
  worker.state.records['match-held-1'] = RECORD;
  await handle.refresh();
  worker.state.token = 'rotated';
  await handle.submit('match-held-1', 'extend', 'more time', 2);
  assert.match(text(container), /rejected the token; nothing was changed/);
  assert.equal(storage.store['halo-admin-token'], undefined);
});

test('a refresh is skipped while a form is open, and storage that throws is survived', async () => {
  const worker = fakeWorker();
  const { container, handle, timers } = mountPanel(worker, fakeStorage({}, true));
  assert.equal(handle.state.token, null, 'a throwing storage reads as signed out');
  await handle.signIn('secret-token');
  assert.match(text(container), /kept only in memory/);
  assert.match(text(container), /Match match-held-1/, 'signed in all the same');
  buttons(container, 'Void')[0].fire('click');
  const before = worker.calls.length;
  timers[0].fn();
  await settle();
  assert.equal(worker.calls.length, before, 'no refresh under an open form');
  handle.signOut();
  assert.equal(handle.state.token, null);
});

test('formatting helpers', () => {
  assert.equal(panel.sol(50_000_000), '0.050 SOL');
  assert.equal(panel.sol(12_345_678), '0.0123 SOL');
  assert.equal(panel.sol(undefined), '–');
  assert.equal(panel.span(30_000), 'under a minute');
  assert.equal(panel.span(5 * 60_000), '5 min');
  assert.equal(panel.span(3 * 3_600_000 + 7 * 60_000), '3 h 07 min');
  assert.equal(panel.span(50 * 3_600_000), '2 d 2 h');
  assert.equal(panel.groupLabel(0, { groups: 2 }, []), 'Red');
  assert.equal(panel.groupLabel(2, { groups: 3 }, []), 'Team 3');
  assert.equal(panel.groupLabel(1, { groups: 0 }, [{ name: 'a' }, { name: 'b' }]), 'b');
  assert.equal(panel.describeHistory({ action: 'decided', detail: { action: 'void', note: 'outage' } }), 'decided: void: outage');
  assert.match(panel.describeHistory({ action: 'extended', detail: { hours: 6, deadline: NOW, clamped: true, note: 'n' } }), /extended by 6 h to .*, clamped at the ceiling: n/);
});
