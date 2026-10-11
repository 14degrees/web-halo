'use strict';

/* The dashboard's "Fomo handles" panel (servers_fomo_handles.js): signed in
   with the shared admin session (servers_admin.js), it lists claimed
   handles on profiles with a proven fomo wallet (who, which handle, when,
   the wallet and how it was proven) with a link to fomo's profile page,
   Confirm and Reject ask for a note and a confirmation, and confirmed
   handles can be revoked. Driven with a fake DOM and a fake Worker. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const webDirectory = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(webDirectory, 'servers.html'), 'utf8');
const source = fs.readFileSync(path.join(webDirectory, 'servers_fomo_handles.js'), 'utf8');
const stage = fs.readFileSync(path.join(webDirectory, '..', '..', 'tools', 'web_stage_cloudflare.py'), 'utf8');
const workerSource = fs.readFileSync(
  path.join(webDirectory, '..', '..', 'services', 'signaling', 'src', 'profile.ts'), 'utf8');
const admin = require(path.join(webDirectory, 'servers_admin.js'));
const panel = require(path.join(webDirectory, 'servers_fomo_handles.js'));
const heldWagers = require(path.join(webDirectory, 'servers_wagers.js'));

test('the page and the staging script know the panel; no token in either', () => {
  assert.match(page, /<h2>Fomo handles<\/h2>\n\s*<section id="fomo-handles"><\/section>/);
  assert.match(page, /<script src="servers_wagers\.js"><\/script>\n\s*<script src="servers_fomo_handles\.js"><\/script>/);
  assert.match(page, /HaloFomoHandles\.mount\(\{ container: document\.getElementById\("fomo-handles"\), session: adminSession \}\);/);
  assert.match(stage, /"servers_fomo_handles\.js"/);
  assert.match(workerSource, /verified: await store\.verifiedFomoHandles\(/, 'the Worker lists confirmed handles too');
  for (const text of [page, source]) {
    assert.doesNotMatch(text, /Bearer [A-Za-z0-9_\-]{8,}/, 'no token literal');
    assert.doesNotMatch(text, /ADMIN_TOKEN\s*[:=]/, 'no token constant');
  }
});

/* ---- a fake DOM: enough for createElement, append, replaceChildren and events */
function fakeElement(tag) {
  const listeners = {};
  const node = {
    tag, attributes: {}, children: [], textContent: '', value: '', disabled: false,
    setAttribute(name, value) { node.attributes[name] = String(value); },
    append(...items) { items.forEach((item) => node.children.push(typeof item === 'string' ? { textContent: item, children: [] } : item)); },
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
const signInFields = (node) => find(node, (candidate) => candidate.tag === 'input' && candidate.attributes.type === 'password');

function fakeStorage(initial) {
  const store = Object.assign({}, initial || {});
  return {
    store,
    getItem(key) { return key in store ? store[key] : null; },
    setItem(key, value) { store[key] = value; },
    removeItem(key) { delete store[key]; },
  };
}

const NOW = 1_760_000_000_000;
const FOMO_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const PENDING = {
  profileId: 'p-alice', username: 'alice', handle: 'AliceTrades', handleSeen: null,
  claimedAt: NOW - 2 * 3_600_000, wallet: FOMO_WALLET, method: 'transfer',
};
const VERIFIED = {
  profileId: 'p-bob', username: 'bob', handle: 'bobby', verifiedAt: NOW - 26 * 3_600_000,
  wallet: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', method: 'fee_payer',
};

/* a Worker double for the two routes, after the real one's rules
   (services/signaling/src/profiles.ts adminVerifyFomoHandle) */
function fakeWorker(options) {
  const calls = [];
  const state = Object.assign({ token: 'secret-token', pending: [PENDING], verified: [VERIFIED], provenWallets: { 'p-alice': true, 'p-bob': true } }, options);
  const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
  const failure = (status, code, message) => reply(status, { error: { code, message } });
  async function fetchImpl(url, init) {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (init.headers.Authorization !== 'Bearer ' + state.token) return failure(401, 'UNAUTHORIZED', 'Unauthorized.');
    const route = url.replace('https://worker.test', '');
    if (route === '/v1/admin/wagers/held') return reply(200, { held: [] });
    if (route === '/v1/admin/profiles/fomo-handles' && init.method === 'GET') {
      if (state.listDown) return failure(503, 'UNAVAILABLE', 'Profiles are unavailable.');
      return reply(200, { pending: state.pending, verified: state.verified });
    }
    if (route !== '/v1/admin/profiles/fomo-handle' || init.method !== 'POST') return failure(404, 'NOT_FOUND', 'Route not found.');
    const body = JSON.parse(init.body);
    if (typeof body.profileId !== 'string' || typeof body.verified !== 'boolean' || typeof body.handle !== 'string') {
      return failure(400, 'VALIDATION_FAILED', 'profileId, handle and verified (true or false) are required.');
    }
    if (state.reply) return state.reply(body);
    const claim = state.pending.find((row) => row.profileId === body.profileId) ||
      state.verified.find((row) => row.profileId === body.profileId);
    if (!claim) return failure(404, 'FOMO_HANDLE_MISSING', 'That profile has no fomo handle.');
    if (claim.handle.toLowerCase() !== body.handle.toLowerCase()) return failure(409, 'FOMO_HANDLE_CHANGED', "That profile's fomo handle has changed. Look again.");
    state.pending = state.pending.filter((row) => row !== claim);
    state.verified = state.verified.filter((row) => row !== claim);
    if (!body.verified) return reply(200, { profile: { id: claim.profileId, fomo: { handle: null, handleVerified: false } } });
    if (!state.provenWallets[claim.profileId]) return failure(409, 'FOMO_WALLET_UNPROVEN', 'That profile has no proven fomo wallet yet.');
    state.verified.unshift({ profileId: claim.profileId, username: claim.username, handle: claim.handle, verifiedAt: NOW, wallet: claim.wallet, method: claim.method });
    return reply(200, { profile: { id: claim.profileId, fomo: { handle: claim.handle, handleVerified: true } } });
  }
  return { calls, state, fetch: fetchImpl };
}

/* both admin panels on one shared session, as servers.html mounts them */
function mountPanels(worker, storage) {
  const timers = [];
  const session = admin.session({
    fetch: worker.fetch, storage, signalingUrl: async () => 'https://worker.test',
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (id) => { timers[id - 1] = null; },
  });
  const wagersContainer = fakeElement('section');
  heldWagers.mount({ container: wagersContainer, document: fakeDocument, session, now: () => NOW });
  const container = fakeElement('section');
  const handle = panel.mount({ container, document: fakeDocument, session, now: () => NOW });
  return { container, wagersContainer, handle, session, timers };
}
const settle = async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const signedIn = () => fakeStorage({ 'halo-admin-token': 'secret-token' });
const fomoCalls = (worker) => worker.calls.filter((call) => call.url.includes('/profiles/'));

function openForm(container, label, note) {
  buttons(container, label)[0].fire('click');
  const form = byClass(container, 'admin-form')[0];
  assert(form, 'the ' + label + ' form opens');
  if (note !== undefined) {
    const field = find(form, (node) => node.tag === 'textarea')[0];
    field.value = note;
    field.fire('input');
  }
  return form;
}

test('one sign-in serves both admin panels; nothing is fetched before it', async () => {
  const worker = fakeWorker();
  const storage = fakeStorage();
  const { container, wagersContainer, handle, timers } = mountPanels(worker, storage);
  assert.equal(signInFields(container).length, 1);
  assert.match(text(container), /Confirming a fomo handle needs the Worker's admin token/);
  assert.equal(worker.calls.length, 0, 'nothing is fetched without a token');

  await handle.signIn('');
  assert.match(text(container), /Paste the admin token first/);
  assert.equal(worker.calls.length, 0);

  signInFields(container)[0].value = 'secret-token';
  buttons(container, 'Sign in')[0].fire('click');
  await settle();
  assert.equal(storage.store['halo-admin-token'], 'secret-token', 'the token lives in sessionStorage');
  const list = worker.calls.find((call) => call.url === 'https://worker.test/v1/admin/profiles/fomo-handles');
  assert(list, 'the queue is fetched');
  assert.equal(list.init.method, 'GET');
  assert.equal(list.init.headers.Authorization, 'Bearer secret-token');
  assert(worker.calls.some((call) => call.url.endsWith('/v1/admin/wagers/held')), 'the held-wagers panel signed in too');
  assert.equal(signInFields(wagersContainer).length, 0);
  assert.equal(timers.filter(Boolean).length, 2, 'each panel refreshes on its own timer');
  assert(timers.every((timer) => timer.ms === admin.REFRESH_MS));
});

test('a pending claim shows who, which handle, when, the wallet, the proof and the state, with fomo\'s page linked', async () => {
  const worker = fakeWorker();
  const { container } = mountPanels(worker, signedIn());
  await settle();
  const card = find(container, (node) => (node.attributes || {})['data-profile'] === 'p-alice' && node.tag === 'article')[0];
  assert(card, 'a card for the claim');
  const shown = text(card);
  assert.match(shown, /alice · @AliceTrades/);
  assert.match(shown, /2 h 00 min ago/, 'when it was claimed');
  assert.match(shown, new RegExp(FOMO_WALLET + ' \\(7xKX…gAsU\\)'), 'the proven fomo wallet, whole and masked');
  assert.match(shown, /a transfer from this wallet to the player's Halo wallet/, 'how it was proven');
  assert.match(shown, /^not checked$/m, 'the card check');
  assert.match(shown, /wallet proven · handle waiting for an admin/, 'the state');
  const links = find(card, (node) => node.tag === 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].attributes.href, 'https://fomo.family/profile/AliceTrades');
  assert.equal(links[0].attributes.target, '_blank', 'opens in a new tab');
  assert.equal(links[0].attributes.rel, 'noopener noreferrer');
  assert.equal(buttons(card, 'Confirm').length, 1);
  assert.equal(buttons(card, 'Reject').length, 1);
  assert.equal(byClass(container, 'admin-form').length, 0, 'no form until a button is pressed');

  const confirmed = find(container, (node) => node.tag === 'tr' && node.attributes['data-profile'] === 'p-bob')[0];
  assert(confirmed, 'confirmed handles are listed');
  assert.match(text(confirmed), /^bob$/m);
  assert.match(text(confirmed), /fomo\.family\/profile\/bobby ↗/);
  assert.match(text(confirmed), /26 h 00 min ago/);
  assert.match(text(confirmed), /9WzD…AWWM/);
  assert.match(text(confirmed), /fomo's fee payer paid for this wallet's trades/);
  assert.equal(buttons(confirmed, 'Revoke').length, 1);
  assert.match(text(container), /Waiting \(1\)/);
  assert.match(text(container), /Confirmed \(1\)/);
});

test('confirm asks for a note and a confirmation, then posts verified: true', async () => {
  const worker = fakeWorker();
  const { container, handle } = mountPanels(worker, signedIn());
  await settle();
  const form = openForm(container, 'Confirm');
  assert.match(text(form), /Confirm the handle · @AliceTrades for alice/);
  assert.match(text(form), new RegExp('Proven fomo wallet: ' + FOMO_WALLET));
  const confirm = buttons(form, 'Confirm confirm')[0];
  assert.equal(confirm.disabled, true, 'confirm waits for a note');
  assert.equal(find(form, (node) => node.tag === 'textarea')[0].attributes.maxlength, '500');
  const before = worker.calls.length;
  buttons(form, 'Cancel')[0].fire('click');
  assert.equal(byClass(container, 'admin-form').length, 0, 'cancel closes the form');
  assert.equal(worker.calls.length, before, 'cancel posts nothing');

  const again = openForm(container, 'Confirm', 'masked address 7xKX…gAsU matches');
  assert.equal(buttons(again, 'Confirm confirm')[0].disabled, false);
  buttons(again, 'Confirm confirm')[0].fire('click');
  await settle();
  const post = worker.calls.find((call) => call.init.method === 'POST');
  assert.equal(post.url, 'https://worker.test/v1/admin/profiles/fomo-handle');
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(post.body, { profileId: 'p-alice', handle: 'AliceTrades', verified: true, note: 'masked address 7xKX…gAsU matches' });
  assert.match(text(container), /alice's handle @AliceTrades: confirmed\./);
  assert.match(text(container), /No fomo handles are waiting/, 'the list refreshes after the decision');
  assert.match(text(container), /Confirmed \(2\)/);
  assert.equal(handle.state.form, null);
});

test('reject posts verified: false and the claim leaves the queue; an empty note never reaches the Worker', async () => {
  const worker = fakeWorker();
  const { container, handle } = mountPanels(worker, signedIn());
  await settle();
  const before = fomoCalls(worker).length;
  await handle.submit(PENDING, 'reject', '   ');
  assert.equal(fomoCalls(worker).length, before, 'no post without a note');
  assert.match(text(container), /A note of 1 to 500 characters is required/);

  const form = openForm(container, 'Reject', 'card shows another address');
  assert.match(text(form), /Reject the claim · @AliceTrades for alice/);
  buttons(form, 'Confirm reject')[0].fire('click');
  await settle();
  const post = worker.calls.find((call) => call.init.method === 'POST');
  assert.deepEqual(post.body, { profileId: 'p-alice', handle: 'AliceTrades', verified: false, note: 'card shows another address' });
  assert.match(text(container), /alice's handle @AliceTrades: rejected; the claim was dropped\./);
  assert.match(text(container), /No fomo handles are waiting/);
});

test('a confirmed handle can be revoked with a note', async () => {
  const worker = fakeWorker();
  const { container } = mountPanels(worker, signedIn());
  await settle();
  const form = openForm(container, 'Revoke', 'player reported a mix-up');
  assert.match(text(form), /Revoke the confirmation · @bobby for bob/);
  buttons(form, 'Confirm revoke')[0].fire('click');
  await settle();
  const post = worker.calls.find((call) => call.init.method === 'POST');
  assert.deepEqual(post.body, { profileId: 'p-bob', handle: 'bobby', verified: false, note: 'player reported a mix-up' });
  assert.match(text(container), /bob's handle @bobby: revoked; the claim was dropped\./);
  assert.match(text(container), /No handles are confirmed/);
});

test('409s say nothing was changed and refresh; a 400 keeps the form open', async () => {
  const worker = fakeWorker();
  const { container, handle } = mountPanels(worker, signedIn());
  await settle();

  /* the player changed the claim since the list was read */
  worker.state.pending = [Object.assign({}, PENDING, { handle: 'SomeoneElse' })];
  await handle.submit(PENDING, 'confirm', 'looks right');
  assert.match(text(container), /alice's claim changed since this list was read; nothing was changed\. Look again\./);
  assert.match(text(container), /alice · @SomeoneElse/, 'the list is read again');
  assert.equal(handle.state.form, null);

  /* the handle is confirmed on another profile */
  worker.state.reply = () => ({ status: 409, ok: false, json: async () => ({ error: { code: 'FOMO_HANDLE_TAKEN', message: 'That fomo handle is verified on another profile.' } }) });
  await handle.submit(PENDING, 'confirm', 'looks right');
  assert.match(text(container), /@AliceTrades is already confirmed on another profile; nothing was changed\. Revoke it there first\./);

  /* the wallet proof went away */
  worker.state.reply = () => ({ status: 409, ok: false, json: async () => ({ error: { code: 'FOMO_WALLET_UNPROVEN', message: 'x' } }) });
  await handle.submit(PENDING, 'confirm', 'looks right');
  assert.match(text(container), /alice no longer has a proven fomo wallet; nothing was changed\./);

  /* the claim is gone */
  worker.state.reply = () => ({ status: 404, ok: false, json: async () => ({ error: { code: 'FOMO_HANDLE_MISSING', message: 'x' } }) });
  await handle.submit(PENDING, 'reject', 'gone?');
  assert.match(text(container), /alice's handle @AliceTrades is gone; nothing was changed\./);

  /* a 400: the Worker's words, and the form stays */
  worker.state.reply = () => ({ status: 400, ok: false, json: async () => ({ error: { code: 'VALIDATION_FAILED', message: 'profileId, handle and verified (true or false) are required.' } }) });
  worker.state.pending = [PENDING];
  await handle.refresh();
  openForm(container, 'Confirm', 'looks right');
  buttons(container, 'Confirm confirm')[0].fire('click');
  await settle();
  assert.match(text(container), /profileId, handle and verified \(true or false\) are required\./);
  assert.equal(byClass(container, 'admin-form').length, 1, 'the form stays open');
});

test('a 401 on an action signs every panel out; so does one on the list', async () => {
  const worker = fakeWorker();
  const storage = signedIn();
  const { container, wagersContainer, handle, timers } = mountPanels(worker, storage);
  await settle();
  worker.state.token = 'rotated';
  await handle.submit(PENDING, 'confirm', 'looks right');
  assert.match(text(container), /rejected the token; nothing was changed/);
  assert.equal(storage.store['halo-admin-token'], undefined, 'the token is gone');
  assert.equal(signInFields(container).length, 1);
  assert.equal(signInFields(wagersContainer).length, 1, 'the held-wagers panel is signed out too');
  assert.equal(timers.filter(Boolean).length, 0, 'every timer stops');
  assert.equal(handle.state.pending.length, 0);

  const later = fakeWorker({ token: 'other' });
  const second = mountPanels(later, signedIn());
  await settle();
  assert.match(text(second.container), /The Worker rejected that token\. Sign in again\./);
  assert.equal(signInFields(second.container).length, 1);
});

test('sign out from either panel signs both out; a refresh is skipped while a form is open', async () => {
  const worker = fakeWorker();
  const storage = signedIn();
  const { container, wagersContainer, timers } = mountPanels(worker, storage);
  await settle();
  openForm(container, 'Reject');
  const before = fomoCalls(worker).length;
  timers.filter(Boolean).forEach((timer) => timer.fn());
  await settle();
  assert.equal(fomoCalls(worker).length, before, 'no fomo refresh under an open form');

  buttons(wagersContainer, 'Sign out')[0].fire('click');
  assert.equal(storage.store['halo-admin-token'], undefined);
  assert.match(text(container), /Signed out; the token was removed from this tab\./);
  assert.equal(signInFields(container).length, 1);
  assert.equal(byClass(container, 'admin-form').length, 0);
});

test('a failed list keeps the panel signed in and says why; the next good refresh clears it', async () => {
  const worker = fakeWorker({ listDown: true });
  const { container, handle } = mountPanels(worker, signedIn());
  await settle();
  assert.match(text(container), /Profiles are unavailable\./);
  assert.equal(signInFields(container).length, 0, 'still signed in');
  assert.equal(handle.state.stale, true);
  worker.state.listDown = false;
  await handle.refresh();
  assert.doesNotMatch(text(container), /Profiles are unavailable/);
  assert.match(text(container), /alice · @AliceTrades/);
});

test('formatting helpers', () => {
  assert.equal(panel.profileUrl('a b/c'), 'https://fomo.family/profile/a%20b%2Fc');
  assert.equal(panel.short(FOMO_WALLET), '7xKX…gAsU');
  assert.equal(panel.short(null), '–');
  assert.equal(panel.method('fee_payer'), "fomo's fee payer paid for this wallet's trades");
  assert.equal(panel.method('official'), "fomo's own lookup");
  assert.equal(panel.method(null), 'unknown');
  assert.equal(panel.cardCheck(true), "fomo's profile card showed the handle");
  assert.equal(panel.cardCheck(false), "fomo's profile card did not show the handle");
  assert.equal(panel.cardCheck(null), 'not checked');
});
