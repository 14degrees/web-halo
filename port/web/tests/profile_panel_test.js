'use strict';

/* The profile and linked accounts (profile_panel.js): claim or rename a
   username, link and unlink wallets with a signed message, prove a fomo
   wallet and claim a handle, link X with a post, and choose what other
   players see. Every error code the profile routes return has words for
   the player. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDirectory = path.join(__dirname, '..');
const repository = path.join(webDirectory, '..', '..');
const shell = fs.readFileSync(path.join(webDirectory, 'shell.html'), 'utf8');
const client = fs.readFileSync(path.join(webDirectory, 'online_client.js'), 'utf8');
const build = fs.readFileSync(path.join(repository, 'tools', 'web_build.py'), 'utf8');

/* ---------- the page, the build and the client */

for (const id of ['spartan-profile', 'spartan-profile-username', 'lobby-wallet-profile', 'profile-dialog', 'profile-dialog-close',
  'profile-dialog-done', 'profile-signed-out', 'profile-sign-in', 'profile-body', 'profile-status',
  'profile-username-current', 'profile-username-input', 'profile-username-save', 'profile-username-rules',
  'profile-username-left', 'profile-username-status', 'profile-needs-username', 'profile-links',
  'profile-wallets', 'profile-wallet-link', 'profile-wallet-status',
  'profile-fomo-detect', 'profile-fomo-recheck', 'profile-fomo-status', 'profile-fomo-handle-state',
  'profile-fomo-handle-input', 'profile-fomo-handle-save', 'profile-fomo-handle-remove', 'profile-fomo-handle-status',
  'profile-fomo-transfer-box', 'profile-fomo-transfer-start', 'profile-fomo-transfer', 'profile-fomo-transfer-amount',
  'profile-fomo-transfer-to', 'profile-fomo-transfer-copy', 'profile-fomo-transfer-expiry', 'profile-fomo-transfer-check',
  'profile-fomo-transfer-status', 'profile-x-state', 'profile-x-profile', 'profile-x-unlink', 'profile-x-start',
  'profile-x-proof', 'profile-x-code', 'profile-x-expiry', 'profile-x-text', 'profile-x-intent', 'profile-x-copy',
  'profile-x-url', 'profile-x-verify', 'profile-x-status', 'profile-show-wallets', 'profile-show-fomo', 'profile-show-x',
  'profile-show-status']) {
  assert.equal(shell.split(`id="${id}"`).length, 2, `${id} is on the page once`);
}
/* the opener sits in the Spartan dialog; the dialog is a native one, so Esc closes it */
assert.ok(shell.indexOf('id="spartan-profile"') > shell.indexOf('id="spartan-dialog"'));
assert.ok(shell.indexOf('id="spartan-profile"') < shell.indexOf('id="spartan-dialog-done"'));
assert.match(shell, /<dialog id="profile-dialog" class="h3-dialog profile-dialog"/);
/* links to X open in a new tab without handing it the page */
assert.match(shell, /<a id="profile-x-intent" class="profile-link-button" target="_blank" rel="noopener noreferrer">/);

/* a pre-js before post_match.js, which stays directly before online_client.js */
const order = ['stats_panel', 'loading_ux', 'stakes', 'profile_panel', 'post_match', 'online_client']
  .map(name => build.indexOf(`--pre-js {WEB_DIR}/${name}.js`));
assert.ok(order.every(at => at > 0), 'every module is a pre-js');
assert.deepEqual([...order].sort((a, b) => a - b), order, 'in order');
assert.match(build, /f"--pre-js \{WEB_DIR\}\/post_match\.js",\n\s*f"--pre-js \{WEB_DIR\}\/online_client\.js",/);
assert.match(build, /WEB_DIR \/ "profile_panel\.js",/);

/* the client hands over its context, guarded, and follows sign-in and out */
assert.match(client, /if \(global\.HaloProfile\) \{\s*global\.HaloProfile\.init\(\{\s*fetchJson: fetchJson,/);
assert.match(client, /pickWallet: pickLinkWallet,\s*signMessage: signLinkMessage,/);
assert.match(client, /if \(global\.HaloProfile\) global\.HaloProfile\.reset\(\);/);
assert.match(client, /if \(global\.HaloProfile\) global\.HaloProfile\.refresh\(\);/);
assert.match(client, /username: ownUsername,/, 'the stats panel learns the username');
/* the lobby shows the username where it shows the in-game name */
assert.match(client, /var username = player\.username \|\| \(self \? ownUsername\(\) : null\);\s*name\.textContent = username \|\| profile\.name;/);
assert.match(client, /setText\("landing-name", ownUsername\(\) \|\| profile\.name\);/);
assert.match(client, /setText\("lobby-wallet-name", ownUsername\(\) \|\| wallet\.name \|\| ""\);/);
assert.match(client, /username: typeof value\.username === "string" && \/\^\[A-Za-z0-9_\]\{3,11\}\$\/\.test\(value\.username\)/);
assert.match(client, /requestError\.haloServerMessage = /);

/* ---------- the module, on a fake page */

function element(tag) {
  const listeners = {};
  return {
    tagName: tag || 'div',
    childNodes: [],
    className: '',
    dataset: {},
    attributes: {},
    disabled: false,
    hidden: false,
    checked: false,
    open: false,
    value: '',
    href: '',
    title: '',
    type: '',
    textContent: '',
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild(child) { this.childNodes.push(child); return child; },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    click() { if (listeners.click) return listeners.click({ target: this }); },
    change(checked) { this.checked = checked; if (listeners.change) return listeners.change({ target: this }); },
    listeners,
  };
}

const elements = {};
function byId(id) {
  if (!elements[id]) elements[id] = element();
  return elements[id];
}
const context = { console, document: { getElementById: byId, createElement: element } };
context.window = context;
context.navigator = { clipboard: { written: [], writeText(text) { this.written.push(text); return Promise.resolve(); } } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(webDirectory, 'profile_panel.js'), 'utf8'), context, { filename: 'profile_panel.js' });
const HaloProfile = context.HaloProfile;
assert.ok(HaloProfile, 'the module installs itself');

/* every error code the Worker's profile routes can answer has words here */
const routeSources = ['profile.ts', 'fomo.ts', 'fomo_handle.ts', 'x.ts', 'wallet.ts']
  .map(name => fs.readFileSync(path.join(repository, 'services', 'signaling', 'src', name), 'utf8')).join('\n');
const codes = new Set([...routeSources.matchAll(/\(\s*\d{3},\s*"([A-Z][A-Z_]+)"/g)].map(match => match[1]));
codes.add('USERNAME_INVALID').add('USERNAME_RESERVED').add('RATE_LIMITED');
assert.ok(codes.size > 30, 'the codes were found');
for (const code of codes) {
  assert.ok(Object.prototype.hasOwnProperty.call(HaloProfile.messages, code), `${code} has a message`);
}
/* the ones the Worker words best keep its words */
function failure(code, status, serverMessage) {
  const error = new Error(status === 404 ? 'That invite expired or is not valid.' : serverMessage || 'nope');
  error.haloCode = code;
  error.haloStatus = status;
  error.haloServerMessage = serverMessage || null;
  return error;
}
assert.equal(HaloProfile.failureText(failure('X_CODE_MISSING', 422, "That post doesn't contain your code ABCD2345.")),
  "That post doesn't contain your code ABCD2345.");
assert.equal(HaloProfile.failureText(failure('FOMO_HANDLE_MISSING', 404, 'That profile has no fomo handle.')),
  'Your profile has no fomo handle.', 'a 404 never reads as an expired invite');
assert.equal(HaloProfile.failureText(failure('SOMETHING_NEW', 404, null)), "The profile service isn't available.");

/* the page's own username check matches the Worker's rules */
assert.equal(HaloProfile.usernameProblem('ab'), 'A username is 3 to 11 characters.');
assert.equal(HaloProfile.usernameProblem('twelve_chars'), 'A username is 3 to 11 characters.');
assert.equal(HaloProfile.usernameProblem('bad name'), 'A username has only letters, digits and underscores.');
assert.equal(HaloProfile.usernameProblem('_chief'), "A username can't start or end with an underscore.");
assert.equal(HaloProfile.usernameProblem('12345'), 'A username needs at least one letter.');
assert.equal(HaloProfile.usernameProblem('@Chief_117'), null);

/* ---------- a fake Worker */

const SIGNED_IN = 'So1anaWa11etAddressXXXXXXXXXXXXXXXXXXXXX';
const SECOND = 'SecondWa11etAddressYYYYYYYYYYYYYYYYYYYYY';
let walletToken = null;
let clock = 1_000_000_000_000;
const calls = [];
const handlers = {};
function respond(method, route, handler) { handlers[`${method} ${route}`] = handler; }
function fetchJson(requestPath, options) {
  const body = options.body === undefined ? undefined : JSON.parse(options.body);
  calls.push({ path: requestPath, method: options.method, body, auth: options.headers.Authorization });
  const handler = handlers[`${options.method} ${requestPath}`];
  if (!handler) return Promise.reject(failure('NOT_FOUND', 404, 'Route not found.'));
  try {
    return Promise.resolve(handler(body));
  } catch (error) {
    return Promise.reject(error);
  }
}
function view(changes) {
  return {
    id: 'p1', username: 'Chief', createdAt: clock, updatedAt: clock,
    wallets: [{ wallet: SIGNED_IN, linkedAt: clock }],
    fomo: null, x: null, fomoChecks: [], show: { wallets: false, fomo: false, x: false }, usernameChangesLeft: 3,
    ...changes,
  };
}
const usernames = [];
const signed = [];
HaloProfile.init({
  fetchJson,
  now: () => clock,
  walletToken: () => walletToken,
  walletAddress: () => (walletToken ? SIGNED_IN : null),
  signIn: () => { walletToken = 'token-of-the-session-xxxxxxxxxxxxxxxxxxxx'; },
  pickWallet: linked => {
    assert.deepEqual(Array.from(linked), [SIGNED_IN], 'the linked wallets are left out');
    return { address: SECOND, account: { address: SECOND } };
  },
  signMessage: (account, message) => { signed.push([account.address, message]); return 'signature-in-base58'; },
  onUsernameChange: name => usernames.push(name),
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = id => byId(id).textContent;

(async () => {
  /* signed out: the dialog asks for a wallet and asks the Worker nothing */
  await HaloProfile.open();
  assert.equal(byId('profile-dialog').open, true);
  assert.equal(byId('profile-signed-out').hidden, false);
  assert.equal(byId('profile-body').hidden, true);
  assert.equal(calls.length, 0);

  /* sign in from the dialog: no profile yet, so a username comes first */
  respond('GET', '/v1/profile', () => ({ profile: null }));
  await byId('profile-sign-in').click();
  await tick();
  assert.equal(calls[0].path, '/v1/profile');
  assert.equal(calls[0].auth, 'Bearer token-of-the-session-xxxxxxxxxxxxxxxxxxxx');
  assert.equal(byId('profile-body').hidden, false);
  assert.equal(text('profile-username-current'), 'No username yet');
  assert.equal(text('profile-username-save'), 'Claim');
  assert.match(text('profile-username-rules'), /^3 to 11 letters, digits or underscores.*reserved.*rename 3 times a day/);
  assert.equal(byId('profile-needs-username').hidden, false);
  assert.equal(byId('profile-links').hidden, true);

  /* a bad name is caught on the page */
  byId('profile-username-input').value = 'x';
  await byId('profile-username-save').click();
  assert.equal(text('profile-username-status'), 'A username is 3 to 11 characters.');
  assert.equal(byId('profile-username-status').dataset.tone, 'error');
  assert.equal(calls.length, 1);

  /* the Worker's refusals, in words */
  const refusals = [
    [failure('USERNAME_RESERVED', 400, 'That name is reserved.'), 'That name is reserved. Pick another.'],
    [failure('USERNAME_TAKEN', 409, 'That username is taken.'), 'That username is taken.'],
    [failure('USERNAME_INVALID', 400, 'A username needs at least one letter.'), 'A username needs at least one letter.'],
    [failure('RATE_LIMITED', 429, 'Too many requests.'), 'Too many requests. Wait a minute and try again.'],
  ];
  for (const [error, words] of refusals) {
    respond('POST', '/v1/profile/username', () => { throw error; });
    byId('profile-username-input').value = 'Halo';
    await byId('profile-username-save').click();
    assert.equal(text('profile-username-status'), words);
  }

  /* the claim */
  respond('POST', '/v1/profile/username', body => ({ profile: view({ username: body.username }) }));
  byId('profile-username-input').value = '@Chief';
  await byId('profile-username-save').click();
  assert.deepEqual(calls[calls.length - 1].body, { username: 'Chief' });
  assert.equal(text('profile-username-status'), "You're Chief.");
  assert.equal(text('profile-username-current'), 'Chief');
  assert.equal(text('profile-username-save'), 'Rename');
  assert.equal(text('profile-username-left'), '3 renames left today.');
  assert.equal(HaloProfile.username(), 'Chief');
  assert.deepEqual(usernames, ['Chief'], 'the lobby hears of the new name');
  assert.equal(byId('profile-links').hidden, false);
  assert.equal(byId('profile-username-input').value, '');

  /* renames run out */
  respond('POST', '/v1/profile/username', body => ({ profile: view({ username: body.username, usernameChangesLeft: 0 }) }));
  byId('profile-username-input').value = 'Arbiter';
  await byId('profile-username-save').click();
  assert.equal(text('profile-username-status'), 'Renamed to Arbiter.');
  assert.equal(text('profile-username-left'), 'No renames left today.');
  assert.equal(byId('profile-username-save').disabled, true);
  assert.deepEqual(usernames, ['Chief', 'Arbiter']);
  respond('POST', '/v1/profile/username', () => { throw failure('USERNAME_RATE_LIMITED', 429); });

  /* wallets: one, the signed-in one, which can't be unlinked */
  let wallets = byId('profile-wallets').childNodes;
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].childNodes[0].textContent, 'So1a…XXXX');
  assert.equal(wallets[0].childNodes[1].textContent, 'signed in');
  assert.equal(wallets[0].childNodes.length, 2, 'no Unlink on the only wallet');

  /* linking: pick the other wallet, get the message, sign, prove */
  respond('POST', '/v1/profile/wallets/challenge', body => {
    assert.deepEqual(body, { wallet: SECOND });
    return { message: 'Link this wallet to your Halo profile.', nonce: 'n'.repeat(43), expiresAt: clock + 300000 };
  });
  respond('POST', '/v1/profile/wallets', body => {
    assert.deepEqual(body, { wallet: SECOND, nonce: 'n'.repeat(43), signature: 'signature-in-base58' });
    return { profile: view({ username: 'Arbiter', usernameChangesLeft: 0,
      wallets: [{ wallet: SIGNED_IN, linkedAt: clock }, { wallet: SECOND, linkedAt: clock }] }) };
  });
  await byId('profile-wallet-link').click();
  assert.deepEqual(signed, [[SECOND, 'Link this wallet to your Halo profile.']]);
  assert.equal(text('profile-wallet-status'), 'Linked Seco…YYYY. Switch your wallet app back to So1a…XXXX to play with it.');
  wallets = byId('profile-wallets').childNodes;
  assert.equal(wallets.length, 2);
  assert.equal(wallets[1].childNodes[1].textContent, 'Unlink');

  /* the Worker's refusals of a link */
  for (const [code, words] of [
    ['WALLET_ALREADY_LINKED', 'That wallet already belongs to a profile. Unlink it there first.'],
    ['WALLET_SIGNATURE_INVALID', "The wallet's signature didn't check out. Try again."],
    ['LINK_CHALLENGE_EXPIRED', 'That link request expired. Press Link again.'],
    ['PROFILE_CHANGED', 'Your profile changed while linking. Press Link again.'],
  ]) {
    respond('GET', '/v1/profile', () => ({ profile: view({ username: 'Arbiter' }) }));
    await HaloProfile.refresh();
    respond('POST', '/v1/profile/wallets', () => { throw failure(code, 409); });
    await byId('profile-wallet-link').click();
    assert.equal(text('profile-wallet-status'), words);
    assert.equal(byId('profile-wallet-status').dataset.tone, 'error');
  }

  /* unlinking the second wallet */
  respond('DELETE', `/v1/profile/wallets/${SECOND}`, () => ({ profile: view({ username: 'Arbiter' }) }));
  respond('GET', '/v1/profile', () => ({ profile: view({ username: 'Arbiter',
    wallets: [{ wallet: SIGNED_IN, linkedAt: clock }, { wallet: SECOND, linkedAt: clock }] }) }));
  await HaloProfile.refresh();
  await byId('profile-wallets').childNodes[1].childNodes[1].click();
  await tick();
  assert.equal(text('profile-wallet-status'), 'Unlinked Seco…YYYY.');
  assert.equal(byId('profile-wallets').childNodes.length, 1);

  /* fomo: not checked yet, then not seen, then off */
  assert.equal(text('profile-fomo-detect'), 'Not checked on fomo yet.');
  respond('POST', '/v1/profile/fomo/check', () => ({ enabled: true, checks: [],
    profile: view({ fomoChecks: [{ wallet: SIGNED_IN, checkedAt: clock - 3 * 3600000, detected: false, signature: null }] }) }));
  await byId('profile-fomo-recheck').click();
  assert.equal(text('profile-fomo-detect'), 'Not seen on fomo (checked 1 wallet, 3 h ago).');
  assert.match(text('profile-fomo-status'), /^Not seen on fomo\. Try the transfer below/);
  respond('POST', '/v1/profile/fomo/check', () => { throw failure('FOMO_CHECK_RATE_LIMITED', 429); });
  await byId('profile-fomo-recheck').click();
  assert.equal(text('profile-fomo-status'), 'Checked recently. Try again in a few minutes.');
  respond('POST', '/v1/profile/fomo/check', () => { throw failure('FOMO_CHECK_UNAVAILABLE', 503); });
  await byId('profile-fomo-recheck').click();
  assert.equal(text('profile-fomo-status'), "Couldn't read the chain. Try again later.");

  /* the handle: claimed, private, and what it waits for */
  respond('PUT', '/v1/profile/fomo/handle', body => {
    assert.deepEqual(body, { handle: '@quanterty' });
    return { profile: view({ fomo: { handle: 'quanterty', handleSeen: true, handleClaimedAt: clock, handleVerified: false,
      handleVerifiedAt: null, wallet: null, verified: false, verifiedAt: null, method: null } }) };
  });
  byId('profile-fomo-handle-input').value = '@quanterty';
  await byId('profile-fomo-handle-save').click();
  assert.equal(byId('profile-fomo-handle-state').dataset.state, 'claimed');
  assert.match(text('profile-fomo-handle-state'), /^@quanterty · claimed\. Prove a fomo wallet below, then an admin confirms the handle\. Private until then\.$/);
  assert.equal(text('profile-fomo-handle-save'), 'Change');
  assert.equal(byId('profile-fomo-handle-remove').hidden, false);
  for (const [code, words] of [
    ['FOMO_HANDLE_TAKEN', 'That fomo handle is verified on another profile.'],
    ['FOMO_HANDLE_RATE_LIMITED', 'Too many handle changes. Try again in an hour.'],
  ]) {
    respond('PUT', '/v1/profile/fomo/handle', () => { throw failure(code, 409); });
    byId('profile-fomo-handle-input').value = 'someone';
    await byId('profile-fomo-handle-save').click();
    assert.equal(text('profile-fomo-handle-status'), words);
  }

  /* the transfer proof: the amount, where to, until when */
  respond('POST', '/v1/profile/fomo/transfer', () => ({ transfer: { to: SIGNED_IN, tokenAccount: 'Ata', asset: 'USDC',
    mint: 'EPj', amount: '0.37', units: '370000', expiresAt: clock + 30 * 60000 } }));
  assert.equal(byId('profile-fomo-transfer').hidden, true);
  await byId('profile-fomo-transfer-start').click();
  assert.equal(byId('profile-fomo-transfer').hidden, false);
  assert.equal(text('profile-fomo-transfer-amount'), '0.37 USDC');
  assert.equal(text('profile-fomo-transfer-to'), SIGNED_IN);
  assert.equal(text('profile-fomo-transfer-expiry'), 'in 30 min');
  await byId('profile-fomo-transfer-copy').click();
  assert.deepEqual(context.navigator.clipboard.written, [SIGNED_IN]);
  respond('POST', '/v1/profile/fomo/transfer/check', () => { throw failure('FOMO_TRANSFER_NOT_FOUND', 404); });
  await byId('profile-fomo-transfer-check').click();
  assert.equal(text('profile-fomo-transfer-status'), 'No matching transfer from fomo yet. It can take a minute to land.');
  respond('POST', '/v1/profile/fomo/transfer/check', () => { throw failure('FOMO_TRANSFER_RATE_LIMITED', 429); });
  await byId('profile-fomo-transfer-check').click();
  assert.equal(text('profile-fomo-transfer-status'), 'Checked a moment ago. Try again in a minute.');
  /* found: the wallet is proven, the handle now waits for an admin */
  respond('POST', '/v1/profile/fomo/transfer/check', () => ({ signature: 'sig', profile: view({ fomo: { handle: 'quanterty',
    handleSeen: true, handleClaimedAt: clock, handleVerified: false, handleVerifiedAt: null, wallet: 'FomoWa11et1111111111111111111111',
    verified: true, verifiedAt: clock, method: 'transfer' } }) }));
  await byId('profile-fomo-transfer-check').click();
  assert.equal(text('profile-fomo-detect'), 'fomo wallet proven ✓ by transfer · Fomo…1111 · just now');
  assert.equal(byId('profile-fomo-recheck').hidden, true);
  assert.equal(byId('profile-fomo-transfer-box').hidden, true, 'nothing left to prove');
  assert.equal(byId('profile-fomo-handle-state').dataset.state, 'awaiting');
  assert.match(text('profile-fomo-handle-state'), /waiting for an admin to confirm it belongs to your fomo wallet\. Private until then\./);
  /* an admin confirms it */
  respond('GET', '/v1/profile', () => ({ profile: view({ fomo: { handle: 'quanterty', handleSeen: true, handleClaimedAt: clock,
    handleVerified: true, handleVerifiedAt: clock, wallet: 'FomoWa11et1111111111111111111111', verified: true, verifiedAt: clock,
    method: 'fee_payer' } }) }));
  await HaloProfile.refresh();
  assert.equal(byId('profile-fomo-handle-state').dataset.state, 'verified');
  assert.equal(text('profile-fomo-handle-state'), '@quanterty · verified ✓ · hidden from other players');
  assert.match(text('profile-fomo-detect'), /^fomo wallet proven ✓ seen on chain/);

  /* the transfer, expired while open */
  respond('GET', '/v1/profile', () => ({ profile: view({}) }));
  await HaloProfile.refresh();
  await byId('profile-fomo-transfer-start').click();
  clock += 31 * 60000;
  HaloProfile.render();
  assert.equal(byId('profile-fomo-transfer').hidden, true);
  assert.equal(text('profile-fomo-transfer-status'), 'That transfer request expired. Start a new one.');
  respond('POST', '/v1/profile/fomo/transfer', () => { throw failure('FOMO_DETECTION_OFF', 503); });
  await byId('profile-fomo-transfer-start').click();
  assert.equal(text('profile-fomo-transfer-status'), "fomo checks aren't switched on for this server yet.");
  assert.equal(byId('profile-fomo-transfer-start').disabled, true);
  assert.equal(byId('profile-fomo-recheck').disabled, true);

  /* X: a code and an intent link, the post's address, then the link */
  assert.equal(text('profile-x-state'), "X isn't linked.");
  assert.equal(byId('profile-x-proof').hidden, true);
  respond('POST', '/v1/profile/x/challenge', () => ({ code: 'ABCD2345', text: 'Linking my Halo Spartan: ABCD2345',
    intentUrl: 'https://x.com/intent/post?text=Linking%20my%20Halo%20Spartan%3A%20ABCD2345', expiresAt: clock + 15 * 60000 }));
  await byId('profile-x-start').click();
  assert.equal(byId('profile-x-proof').hidden, false);
  assert.equal(text('profile-x-code'), 'ABCD2345');
  assert.equal(text('profile-x-text'), 'Linking my Halo Spartan: ABCD2345');
  assert.equal(text('profile-x-expiry'), 'in 15 min');
  assert.equal(byId('profile-x-intent').href, 'https://x.com/intent/post?text=Linking%20my%20Halo%20Spartan%3A%20ABCD2345');
  await byId('profile-x-copy').click();
  assert.equal(context.navigator.clipboard.written[1], 'Linking my Halo Spartan: ABCD2345');
  /* nothing pasted */
  await byId('profile-x-verify').click();
  assert.equal(text('profile-x-status'), 'Paste the link to your post, like https://x.com/you/status/123.');
  for (const [code, words] of [
    ['X_URL_INVALID', 'Paste the link to your post, like https://x.com/you/status/123.'],
    ['X_TWEET_NOT_FOUND', "We couldn't see that post. Check the link and that your account is public."],
    ['X_HANDLE_MISMATCH', 'That post was written by a different account than its link says.'],
    ['X_HANDLE_TAKEN', 'That X account is already linked to another profile. It has to be unlinked there first.'],
    ['X_UNAVAILABLE', "Couldn't reach X. Try again in a minute."],
    ['X_VERIFY_RATE_LIMITED', 'Too many tries. Wait a few minutes.'],
    ['X_VERIFY_BUSY', 'Lots of players are linking X right now. Try again in a minute.'],
  ]) {
    respond('POST', '/v1/profile/x/verify', () => { throw failure(code, 422); });
    byId('profile-x-url').value = 'https://x.com/jack/status/1';
    await byId('profile-x-verify').click();
    assert.equal(text('profile-x-status'), words);
    assert.equal(byId('profile-x-proof').hidden, false, 'the code stays for another try');
  }
  respond('POST', '/v1/profile/x/verify', () => ({ handle: 'jack', message: 'Linked @jack. You can delete the post now.',
    profile: view({ x: { handle: 'jack', verified: true, verifiedAt: clock, proofUrl: 'https://x.com/jack/status/1' } }) }));
  await byId('profile-x-verify').click();
  assert.deepEqual(calls[calls.length - 1].body, { url: 'https://x.com/jack/status/1' });
  assert.equal(text('profile-x-status'), 'Linked @jack. You can delete the post now.');
  assert.equal(byId('profile-x-proof').hidden, true);
  assert.equal(text('profile-x-state'), '@jack · linked ✓ · hidden from other players');
  assert.equal(byId('profile-x-profile').href, 'https://x.com/jack');
  assert.equal(byId('profile-x-unlink').hidden, false);
  /* a used or expired code is gone */
  respond('POST', '/v1/profile/x/challenge', () => ({ code: 'ZZZZ2345', text: 'Linking my Halo Spartan: ZZZZ2345',
    intentUrl: 'https://x.com/intent/post?text=x', expiresAt: clock + 15 * 60000 }));
  await byId('profile-x-start').click();
  respond('POST', '/v1/profile/x/verify', () => { throw failure('X_CHALLENGE_EXPIRED', 410); });
  byId('profile-x-url').value = 'https://x.com/jack/status/2';
  await byId('profile-x-verify').click();
  assert.equal(text('profile-x-status'), 'That code expired or was used. Get a new one.');
  assert.equal(byId('profile-x-proof').hidden, true);
  respond('POST', '/v1/profile/x/challenge', () => { throw failure('X_CHALLENGE_RATE_LIMITED', 429); });
  await byId('profile-x-start').click();
  assert.equal(text('profile-x-status'), 'Too many codes this hour. Try again later.');
  /* unlink */
  respond('DELETE', '/v1/profile/x', () => ({ profile: view({}) }));
  await byId('profile-x-unlink').click();
  assert.equal(text('profile-x-state'), "X isn't linked.");

  /* who sees what: off at first, one switch at a time, a refusal puts it back */
  assert.equal(byId('profile-show-x').checked, false);
  respond('PATCH', '/v1/profile', body => {
    assert.deepEqual(body, { showX: true });
    return { profile: view({ show: { wallets: false, fomo: false, x: true } }) };
  });
  await byId('profile-show-x').change(true);
  await tick();
  assert.equal(byId('profile-show-x').checked, true);
  assert.equal(text('profile-show-status'), 'Saved.');
  respond('PATCH', '/v1/profile', () => { throw failure('RATE_LIMITED', 429); });
  await byId('profile-show-wallets').change(true);
  await tick();
  assert.equal(byId('profile-show-wallets').checked, false, 'put back');
  assert.equal(text('profile-show-status'), 'Too many requests. Wait a minute and try again.');

  /* a profile gone from under the page: it looks again */
  respond('GET', '/v1/profile', () => ({ profile: null }));
  respond('DELETE', '/v1/profile/fomo/handle', () => { throw failure('PROFILE_NOT_FOUND', 404); });
  byId('profile-fomo-handle-remove').hidden = false;
  await byId('profile-fomo-handle-remove').click();
  await tick();
  assert.equal(HaloProfile.username(), null);
  assert.equal(byId('profile-links').hidden, true);

  /* an expired session says so */
  respond('GET', '/v1/profile', () => { throw failure('WALLET_SIGN_IN_REQUIRED', 401); });
  await HaloProfile.refresh();
  assert.equal(text('profile-status'), 'Your sign-in expired. Sign in with your wallet again.');

  /* signing out forgets it all */
  respond('GET', '/v1/profile', () => ({ profile: view({}) }));
  await HaloProfile.refresh();
  assert.equal(HaloProfile.username(), 'Chief');
  walletToken = null;
  HaloProfile.reset();
  assert.equal(HaloProfile.username(), null);
  assert.equal(usernames[usernames.length - 1], null);
  assert.equal(byId('profile-signed-out').hidden, false);

  byId('profile-dialog-done').click();
  assert.equal(byId('profile-dialog').open, false);
  console.log('profile panel: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
