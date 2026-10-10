/* The player's profile and linked accounts, from the signaling Worker's
   profile routes (services/signaling/src/profile.ts, fomo.ts,
   fomo_handle.ts, x.ts; docs/profiles.md).

   A profile is a username with one or more wallets under it. On it the
   player can prove a fomo.family wallet (seen on chain, or by a small USDC
   transfer from fomo), claim their fomo handle (an admin confirms it
   against that wallet), and link X with a post that carries a code. Every
   link is private until the player turns on showing it, and other players
   only ever see links that are verified.

   This file knows nothing of the room or the game. online_client.js hands
   it what it needs through HaloProfile.init (the Worker fetch helper, the
   wallet session, a way to pick and sign with another wallet) and opens it
   from the Spartan dialog and the lobby's wallet panel. It tells the client
   when the username changes, so the lobby can show it. */

;(function installHaloProfile(global) {
  "use strict";

  if (!global || global.HaloProfile) return;

  /* services/signaling/src/profiles.ts */
  var USERNAME_MIN_LENGTH = 3;
  var USERNAME_MAX_LENGTH = 11;
  var USERNAME_CHANGES_PER_DAY = 3;
  var USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;
  var USERNAME_RULES = "3 to 11 letters, digits or underscores, with at least one letter and no underscore at either end. " +
    "Some names are reserved. You can rename " + USERNAME_CHANGES_PER_DAY + " times a day; a name you give up stays held for you for 7 days.";

  /* what each error code from the profile routes means to the player */
  var MESSAGES = Object.freeze({
    WALLET_SIGN_IN_REQUIRED: "Your sign-in expired. Sign in with your wallet again.",
    RATE_LIMITED: "Too many requests. Wait a minute and try again.",
    VALIDATION_FAILED: null,
    NOT_FOUND: "The profile service doesn't know that request. Reload the page.",
    PROFILE_NOT_FOUND: "Claim a username first.",
    USERNAME_INVALID: null,
    USERNAME_RESERVED: "That name is reserved. Pick another.",
    USERNAME_TAKEN: "That username is taken.",
    USERNAME_RATE_LIMITED: "You've changed your username " + USERNAME_CHANGES_PER_DAY + " times today. Try again tomorrow.",
    WALLET_ALREADY_LINKED: "That wallet already belongs to a profile. Unlink it there first.",
    WALLET_NOT_LINKED: "That wallet isn't linked to your profile.",
    PROFILE_LAST_WALLET: "A profile keeps at least one wallet.",
    LINK_CHALLENGE_EXPIRED: "That link request expired. Press Link again.",
    WALLET_SIGNATURE_INVALID: "The wallet's signature didn't check out. Try again.",
    PROFILE_CHANGED: "Your profile changed while linking. Press Link again.",
    FOMO_DETECTION_OFF: "fomo checks aren't switched on for this server yet.",
    FOMO_CHECK_RATE_LIMITED: "Checked recently. Try again in a few minutes.",
    FOMO_CHECK_UNAVAILABLE: "Couldn't read the chain. Try again later.",
    FOMO_HANDLE_RATE_LIMITED: "Too many handle changes. Try again in an hour.",
    FOMO_HANDLE_UNKNOWN: "fomo doesn't know that handle. Check the spelling.",
    FOMO_HANDLE_TAKEN: "That fomo handle is verified on another profile.",
    FOMO_HANDLE_MISSING: "Your profile has no fomo handle.",
    FOMO_HANDLE_CHANGED: "Your fomo handle changed. Reload and look again.",
    FOMO_WALLET_UNPROVEN: "Prove a fomo wallet first.",
    FOMO_TRANSFER_EXPIRED: "That transfer request expired. Start a new one.",
    FOMO_TRANSFER_RATE_LIMITED: "Checked a moment ago. Try again in a minute.",
    FOMO_TRANSFER_NOT_FOUND: "No matching transfer from fomo yet. It can take a minute to land.",
    X_CHALLENGE_RATE_LIMITED: "Too many codes this hour. Try again later.",
    X_URL_INVALID: "Paste the link to your post, like https://x.com/you/status/123.",
    X_CHALLENGE_EXPIRED: "That code expired or was used. Get a new one.",
    X_VERIFY_RATE_LIMITED: "Too many tries. Wait a few minutes.",
    X_VERIFY_BUSY: "Lots of players are linking X right now. Try again in a minute.",
    X_TWEET_NOT_FOUND: "We couldn't see that post. Check the link and that your account is public.",
    X_UNAVAILABLE: "Couldn't reach X. Try again in a minute.",
    X_HANDLE_MISMATCH: "That post was written by a different account than its link says.",
    X_CODE_MISSING: null,
  });

  var FOMO_METHODS = Object.freeze({ fee_payer: "seen on chain", transfer: "by transfer", official: "by fomo" });

  var context = null;
  var state = {
    loading: false,
    loaded: false,
    profile: null,
    error: "",
    /* the action running now, e.g. "username"; its buttons are disabled */
    busy: null,
    /* each section's last word: { text, tone } */
    notes: {},
    fomoOff: false,
    transfer: null,
    x: null,
  };

  function byId(id) {
    var document = global.document;
    return document && typeof document.getElementById === "function" ? document.getElementById(id) : null;
  }

  function setText(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
  }

  function setHidden(element, hidden) {
    if (element && element.hidden !== hidden) element.hidden = hidden;
  }

  function setDisabled(element, disabled) {
    if (element && element.disabled !== disabled) element.disabled = disabled;
  }

  function make(tag, className, text) {
    var element = global.document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function now() {
    return context && typeof context.now === "function" ? context.now() : Date.now();
  }

  function token() {
    return context && typeof context.walletToken === "function" ? context.walletToken() : null;
  }

  function signedInAddress() {
    return context && typeof context.walletAddress === "function" ? context.walletAddress() : null;
  }

  function shortWallet(address) {
    return address && address.length > 10 ? address.slice(0, 4) + "…" + address.slice(-4) : address || "";
  }

  /* "just now", "5 min ago", "3 h ago", "2 days ago" */
  function ago(at) {
    var minutes = Math.max(0, Math.round((now() - at) / 60000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";
    var hours = Math.round(minutes / 60);
    if (hours < 48) return hours + " h ago";
    return Math.round(hours / 24) + " days ago";
  }

  /* "in 14 min", "expired" */
  function until(at) {
    var minutes = Math.ceil((at - now()) / 60000);
    if (minutes <= 0) return "expired";
    return "in " + minutes + " min";
  }

  /* what the player should read for a failed request */
  function failureText(error) {
    var code = error && error.haloCode;
    if (code && Object.prototype.hasOwnProperty.call(MESSAGES, code) && MESSAGES[code]) return MESSAGES[code];
    /* the server's own words are the best for these (they name the rule or the code) */
    if (code && error.haloServerMessage) return error.haloServerMessage;
    if (error && error.haloStatus === 404) return "The profile service isn't available.";
    return error && error.message ? error.message : "The profile service is unreachable.";
  }

  function note(section, text, tone) {
    state.notes[section] = text ? { text: text, tone: tone || null } : null;
  }

  function request(path, method, body) {
    var headers = { "Content-Type": "application/json" };
    var bearer = token();
    if (bearer) headers.Authorization = "Bearer " + bearer;
    var options = { method: method, headers: headers };
    if (body !== undefined) options.body = JSON.stringify(body);
    return context.fetchJson(path, options);
  }

  function setProfile(profile) {
    var before = state.profile ? state.profile.username : null;
    state.profile = profile || null;
    state.loaded = true;
    var after = state.profile ? state.profile.username : null;
    if (before !== after && context && typeof context.onUsernameChange === "function") {
      try { context.onUsernameChange(after); } catch (error) { /* the lobby catches up on its next tick */ }
    }
  }

  /* Run one action: its section's buttons wait, its note says how it went. */
  function act(section, work) {
    if (state.busy || !context) return Promise.resolve(false);
    state.busy = section;
    note(section, "Working…");
    render();
    return Promise.resolve().then(work).then(function(text) {
      note(section, typeof text === "string" ? text : "", "ok");
      return true;
    }, function(error) {
      if (error && error.haloCode === "FOMO_DETECTION_OFF") state.fomoOff = true;
      if (error && (error.haloCode === "X_CHALLENGE_EXPIRED")) state.x = null;
      if (error && (error.haloCode === "FOMO_TRANSFER_EXPIRED")) state.transfer = null;
      note(section, failureText(error), "error");
      if (error && error.haloCode === "PROFILE_NOT_FOUND") return refresh().then(function() { return false; });
      return false;
    }).then(function(ok) {
      state.busy = null;
      render();
      return ok;
    });
  }

  /* ---------- loading */

  function refresh() {
    if (!context) return Promise.resolve();
    if (!token()) {
      reset();
      return Promise.resolve();
    }
    state.loading = true;
    state.error = "";
    render();
    return request("/v1/profile", "GET").then(function(result) {
      setProfile(result && result.profile);
    }, function(error) {
      state.error = failureText(error);
    }).then(function() {
      state.loading = false;
      render();
    });
  }

  /* signed out: nothing of the last wallet's profile stays */
  function reset() {
    var had = state.profile !== null;
    state.profile = null;
    state.loaded = false;
    state.loading = false;
    state.error = "";
    state.notes = {};
    state.transfer = null;
    state.x = null;
    state.fomoOff = false;
    if (had && context && typeof context.onUsernameChange === "function") {
      try { context.onUsernameChange(null); } catch (error) { /* as above */ }
    }
    render();
  }

  /* ---------- the username */

  /* the page's own check, the same rules as the Worker's, so a typo is
     caught before a request */
  function usernameProblem(input) {
    var name = String(input || "").trim().replace(/^@/, "");
    if (name.length < USERNAME_MIN_LENGTH || name.length > USERNAME_MAX_LENGTH) {
      return "A username is " + USERNAME_MIN_LENGTH + " to " + USERNAME_MAX_LENGTH + " characters.";
    }
    if (!USERNAME_PATTERN.test(name)) return "A username has only letters, digits and underscores.";
    if (/^_|_$/.test(name)) return "A username can't start or end with an underscore.";
    if (!/[A-Za-z]/.test(name)) return "A username needs at least one letter.";
    return null;
  }

  function saveUsername() {
    var input = byId("profile-username-input");
    var name = input ? String(input.value || "").trim().replace(/^@/, "") : "";
    var problem = usernameProblem(name);
    if (problem) {
      note("username", problem, "error");
      render();
      return Promise.resolve(false);
    }
    var first = !state.profile;
    if (!first && state.profile.username === name) {
      note("username", "That's already your username.", "ok");
      render();
      return Promise.resolve(false);
    }
    return act("username", function() {
      return request("/v1/profile/username", "POST", { username: name }).then(function(result) {
        setProfile(result.profile);
        if (input) input.value = "";
        return first ? "You're " + result.profile.username + "." : "Renamed to " + result.profile.username + ".";
      });
    });
  }

  /* ---------- wallets */

  function linkWallet() {
    if (!state.profile) return Promise.resolve(false);
    return act("wallets", function() {
      if (!context.pickWallet || !context.signMessage) throw new Error("This browser has no Solana wallet to link.");
      var linked = state.profile.wallets.map(function(entry) { return entry.wallet; });
      var picked;
      var challenge;
      return Promise.resolve(context.pickWallet(linked)).then(function(result) {
        picked = result;
        note("wallets", "Sign the message in your wallet to link " + shortWallet(picked.address) + "…");
        render();
        return request("/v1/profile/wallets/challenge", "POST", { wallet: picked.address });
      }).then(function(result) {
        challenge = result;
        return context.signMessage(picked.account, challenge.message);
      }).then(function(signature) {
        return request("/v1/profile/wallets", "POST", { wallet: picked.address, nonce: challenge.nonce, signature: signature });
      }).then(function(result) {
        setProfile(result.profile);
        return "Linked " + shortWallet(picked.address) + ". Switch your wallet app back to " +
          shortWallet(signedInAddress()) + " to play with it.";
      });
    });
  }

  function unlinkWallet(address) {
    if (!state.profile) return Promise.resolve(false);
    return act("wallets", function() {
      return request("/v1/profile/wallets/" + encodeURIComponent(address), "DELETE").then(function(result) {
        setProfile(result.profile);
        return "Unlinked " + shortWallet(address) + ".";
      });
    });
  }

  /* ---------- fomo */

  function checkFomo() {
    return act("fomo", function() {
      return request("/v1/profile/fomo/check", "POST", {}).then(function(result) {
        if (result && result.enabled === false) state.fomoOff = true;
        if (result && result.profile) setProfile(result.profile);
        var proven = state.profile && state.profile.fomo && state.profile.fomo.verified;
        return proven ? "fomo wallet found." : "Not seen on fomo. Try the transfer below, or link the wallet you use on fomo.";
      });
    });
  }

  function saveFomoHandle() {
    var input = byId("profile-fomo-handle-input");
    var handle = input ? String(input.value || "").trim() : "";
    if (!handle) {
      note("fomoHandle", "Type your fomo handle.", "error");
      render();
      return Promise.resolve(false);
    }
    return act("fomoHandle", function() {
      return request("/v1/profile/fomo/handle", "PUT", { handle: handle }).then(function(result) {
        setProfile(result.profile);
        if (input) input.value = "";
        var fomo = result.profile.fomo;
        return fomo && fomo.handleSeen === null ? "Saved. fomo couldn't be asked whether that handle exists right now." : "Saved.";
      });
    });
  }

  function removeFomoHandle() {
    return act("fomoHandle", function() {
      return request("/v1/profile/fomo/handle", "DELETE").then(function(result) {
        setProfile(result.profile);
        return "Handle removed.";
      });
    });
  }

  function startTransfer() {
    return act("transfer", function() {
      return request("/v1/profile/fomo/transfer", "POST", {}).then(function(result) {
        state.transfer = result.transfer;
        return "";
      });
    });
  }

  function checkTransfer() {
    if (!state.transfer) return Promise.resolve(false);
    return act("transfer", function() {
      return request("/v1/profile/fomo/transfer/check", "POST", {}).then(function(result) {
        state.transfer = null;
        setProfile(result.profile);
        return "Transfer found: your fomo wallet is proven. Keep the USDC.";
      });
    });
  }

  /* ---------- X */

  function startX() {
    return act("x", function() {
      return request("/v1/profile/x/challenge", "POST", {}).then(function(result) {
        state.x = result;
        return "";
      });
    });
  }

  function verifyX() {
    var input = byId("profile-x-url");
    var url = input ? String(input.value || "").trim() : "";
    if (!url) {
      note("x", MESSAGES.X_URL_INVALID, "error");
      render();
      return Promise.resolve(false);
    }
    return act("x", function() {
      return request("/v1/profile/x/verify", "POST", { url: url }).then(function(result) {
        state.x = null;
        if (input) input.value = "";
        setProfile(result.profile);
        return (result.message || "Linked @" + result.handle + ". You can delete the post now.") +
          (result.moved ? " It was linked to another profile before; it's yours now." : "");
      });
    });
  }

  function unlinkX() {
    return act("x", function() {
      return request("/v1/profile/x", "DELETE").then(function(result) {
        state.x = null;
        setProfile(result.profile);
        return "X unlinked.";
      });
    });
  }

  function copy(text, section) {
    var clipboard = global.navigator && global.navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") return Promise.resolve(false);
    return clipboard.writeText(text).then(function() {
      note(section, "Copied.", "ok");
      render();
      return true;
    }, function() { return false; });
  }

  /* ---------- who sees what */

  var VISIBILITY = Object.freeze([
    { id: "profile-show-wallets", field: "showWallets", key: "wallets" },
    { id: "profile-show-fomo", field: "showFomo", key: "fomo" },
    { id: "profile-show-x", field: "showX", key: "x" },
  ]);

  function setVisibility(entry, on) {
    if (!state.profile) return Promise.resolve(false);
    var body = {};
    body[entry.field] = on;
    return act("show", function() {
      return request("/v1/profile", "PATCH", body).then(function(result) {
        setProfile(result.profile);
        return "Saved.";
      });
    });
  }

  /* ---------- the dialog */

  function renderNote(id, section) {
    var element = byId(id);
    if (!element) return;
    var entry = state.notes[section];
    setText(element, entry ? entry.text : "");
    if (element.dataset) {
      if (entry && entry.tone) element.dataset.tone = entry.tone;
      else delete element.dataset.tone;
    }
  }

  function fomoDetectionText(profile) {
    var fomo = profile.fomo;
    if (fomo && fomo.verified) {
      return "fomo wallet proven ✓ " + (FOMO_METHODS[fomo.method] || "") + " · " + shortWallet(fomo.wallet) +
        (fomo.verifiedAt ? " · " + ago(fomo.verifiedAt) : "");
    }
    if (state.fomoOff) return "fomo checks aren't switched on for this server yet.";
    var checks = profile.fomoChecks || [];
    if (!checks.length) return "Not checked on fomo yet.";
    var last = checks.reduce(function(latest, check) { return Math.max(latest, check.checkedAt); }, 0);
    return "Not seen on fomo (checked " + checks.length + (checks.length === 1 ? " wallet, " : " wallets, ") + ago(last) + ").";
  }

  /* claimed → awaiting admin → verified */
  function fomoHandleState(profile) {
    var fomo = profile.fomo;
    if (!fomo || !fomo.handle) return { state: "none", text: "No fomo handle claimed." };
    var name = "@" + fomo.handle;
    if (fomo.handleVerified) {
      return { state: "verified", text: name + " · verified ✓" + (profile.show.fomo ? " · shown to other players" : " · hidden from other players") };
    }
    var unchecked = fomo.handleSeen === null ? " fomo couldn't be asked whether it exists." : "";
    if (fomo.verified) {
      return { state: "awaiting", text: name + " · claimed, waiting for an admin to confirm it belongs to your fomo wallet. Private until then." + unchecked };
    }
    return { state: "claimed", text: name + " · claimed. Prove a fomo wallet below, then an admin confirms the handle. Private until then." + unchecked };
  }

  function renderWallets(profile) {
    var list = byId("profile-wallets");
    if (!list || typeof list.replaceChildren !== "function") return;
    var mine = signedInAddress();
    var wallets = profile ? profile.wallets : [];
    var signature = wallets.map(function(entry) { return entry.wallet; }).join(",") + "#" + mine + "#" + (state.busy ? "1" : "0");
    if (list.dataset && list.dataset.signature === signature) return;
    if (list.dataset) list.dataset.signature = signature;
    list.replaceChildren.apply(list, wallets.map(function(entry) {
      var row = make("li", "profile-wallet");
      var address = make("span", "profile-wallet-address", shortWallet(entry.wallet));
      address.title = entry.wallet;
      row.appendChild(address);
      if (entry.wallet === mine) row.appendChild(make("span", "profile-wallet-you", "signed in"));
      if (wallets.length > 1) {
        var unlink = make("button", "profile-link-button", "Unlink");
        unlink.type = "button";
        unlink.disabled = !!state.busy;
        unlink.dataset.wallet = entry.wallet;
        unlink.addEventListener("click", function() { unlinkWallet(entry.wallet); });
        row.appendChild(unlink);
      }
      return row;
    }));
  }

  function render() {
    var dialog = byId("profile-dialog");
    if (!dialog) return;
    var signedIn = !!token();
    var profile = state.profile;
    var busy = !!state.busy;
    setHidden(byId("profile-signed-out"), signedIn);
    setHidden(byId("profile-body"), !signedIn);
    var status = byId("profile-status");
    setText(status, state.loading ? "Loading your profile…" : state.error);

    /* the username */
    setText(byId("profile-username-current"), profile ? profile.username : "No username yet");
    setText(byId("profile-username-save"), profile ? "Rename" : "Claim");
    setText(byId("profile-username-rules"), USERNAME_RULES);
    var left = profile ? profile.usernameChangesLeft : null;
    setText(byId("profile-username-left"), profile ?
      (left > 0 ? left + (left === 1 ? " rename" : " renames") + " left today." : "No renames left today.") :
      "Your username shows in lobbies and chat, and keeps your record across every wallet you link.");
    setDisabled(byId("profile-username-input"), busy || !state.loaded || (profile !== null && left === 0));
    setDisabled(byId("profile-username-save"), busy || !state.loaded || (profile !== null && left === 0));
    renderNote("profile-username-status", "username");

    /* everything else needs a username */
    var needsProfile = !profile;
    setHidden(byId("profile-needs-username"), !needsProfile || !state.loaded);
    setHidden(byId("profile-links"), needsProfile);
    if (profile) {
      renderWallets(profile);
      setDisabled(byId("profile-wallet-link"), busy);
      renderNote("profile-wallet-status", "wallets");

      /* fomo: the wallet, then the handle, then the transfer proof */
      var proven = !!(profile.fomo && profile.fomo.verified);
      setText(byId("profile-fomo-detect"), fomoDetectionText(profile));
      setHidden(byId("profile-fomo-recheck"), proven);
      setDisabled(byId("profile-fomo-recheck"), busy || state.fomoOff);
      renderNote("profile-fomo-status", "fomo");
      var handle = fomoHandleState(profile);
      var handleState = byId("profile-fomo-handle-state");
      setText(handleState, handle.text);
      if (handleState && handleState.dataset) handleState.dataset.state = handle.state;
      setText(byId("profile-fomo-handle-save"), handle.state === "none" ? "Claim" : "Change");
      setDisabled(byId("profile-fomo-handle-save"), busy);
      setDisabled(byId("profile-fomo-handle-input"), busy);
      setHidden(byId("profile-fomo-handle-remove"), handle.state === "none");
      setDisabled(byId("profile-fomo-handle-remove"), busy);
      renderNote("profile-fomo-handle-status", "fomoHandle");
      setHidden(byId("profile-fomo-transfer-box"), proven);
      var transfer = state.transfer;
      if (transfer && transfer.expiresAt <= now()) {
        state.transfer = transfer = null;
        note("transfer", MESSAGES.FOMO_TRANSFER_EXPIRED, "error");
      }
      setHidden(byId("profile-fomo-transfer"), !transfer);
      setText(byId("profile-fomo-transfer-start"), transfer ? "New amount" : "Prove with a transfer");
      setDisabled(byId("profile-fomo-transfer-start"), busy || state.fomoOff);
      if (transfer) {
        setText(byId("profile-fomo-transfer-amount"), transfer.amount + " " + (transfer.asset || "USDC"));
        setText(byId("profile-fomo-transfer-to"), transfer.to);
        setText(byId("profile-fomo-transfer-expiry"), until(transfer.expiresAt));
      }
      setDisabled(byId("profile-fomo-transfer-check"), busy || !transfer);
      renderNote("profile-fomo-transfer-status", "transfer");

      /* X */
      var x = profile.x && profile.x.verified ? profile.x : null;
      setText(byId("profile-x-state"), x ? "@" + x.handle + " · linked ✓" + (profile.show.x ? " · shown to other players" : " · hidden from other players") : "X isn't linked.");
      var profileLink = byId("profile-x-profile");
      if (profileLink) {
        setHidden(profileLink, !x);
        if (x) profileLink.href = "https://x.com/" + encodeURIComponent(x.handle);
      }
      setHidden(byId("profile-x-unlink"), !x);
      setDisabled(byId("profile-x-unlink"), busy);
      setText(byId("profile-x-start"), state.x ? "New code" : x ? "Link another X account" : "Link X");
      setDisabled(byId("profile-x-start"), busy);
      var challenge = state.x;
      if (challenge && challenge.expiresAt <= now()) {
        state.x = challenge = null;
        note("x", MESSAGES.X_CHALLENGE_EXPIRED, "error");
      }
      setHidden(byId("profile-x-proof"), !challenge);
      if (challenge) {
        setText(byId("profile-x-code"), challenge.code);
        setText(byId("profile-x-text"), challenge.text);
        setText(byId("profile-x-expiry"), until(challenge.expiresAt));
        var intent = byId("profile-x-intent");
        if (intent) intent.href = challenge.intentUrl;
      }
      setDisabled(byId("profile-x-verify"), busy || !challenge);
      setDisabled(byId("profile-x-url"), busy || !challenge);
      renderNote("profile-x-status", "x");

      /* who sees what */
      VISIBILITY.forEach(function(entry) {
        var box = byId(entry.id);
        if (!box) return;
        if (box.checked !== profile.show[entry.key]) box.checked = profile.show[entry.key];
        setDisabled(box, busy);
      });
      renderNote("profile-show-status", "show");
    }
  }

  function open() {
    var dialog = byId("profile-dialog");
    if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    render();
    return refresh();
  }

  function close() {
    var dialog = byId("profile-dialog");
    if (dialog && dialog.open) dialog.close();
  }

  /* ---------- wiring */

  function bind(id, type, listener) {
    var element = byId(id);
    if (element && typeof element.addEventListener === "function") element.addEventListener(type, listener);
  }

  function onEnter(id, action) {
    bind(id, "keydown", function(event) {
      if (event.key === "Enter") {
        if (typeof event.preventDefault === "function") event.preventDefault();
        action();
      }
    });
  }

  function init(options) {
    context = options || null;
    bind("spartan-profile", "click", open);
    bind("profile-dialog-close", "click", close);
    bind("profile-dialog-done", "click", close);
    bind("profile-sign-in", "click", function() {
      if (!context || typeof context.signIn !== "function") return;
      Promise.resolve(context.signIn()).then(function() { return refresh(); });
    });
    bind("profile-username-save", "click", saveUsername);
    onEnter("profile-username-input", saveUsername);
    bind("profile-wallet-link", "click", linkWallet);
    bind("profile-fomo-recheck", "click", checkFomo);
    bind("profile-fomo-handle-save", "click", saveFomoHandle);
    onEnter("profile-fomo-handle-input", saveFomoHandle);
    bind("profile-fomo-handle-remove", "click", removeFomoHandle);
    bind("profile-fomo-transfer-start", "click", startTransfer);
    bind("profile-fomo-transfer-check", "click", checkTransfer);
    bind("profile-fomo-transfer-copy", "click", function() {
      if (state.transfer) copy(state.transfer.to, "transfer");
    });
    bind("profile-x-start", "click", startX);
    bind("profile-x-copy", "click", function() {
      if (state.x) copy(state.x.text, "x");
    });
    bind("profile-x-verify", "click", verifyX);
    onEnter("profile-x-url", verifyX);
    bind("profile-x-unlink", "click", unlinkX);
    VISIBILITY.forEach(function(entry) {
      bind(entry.id, "change", function(event) {
        setVisibility(entry, !!event.target.checked).then(function(ok) {
          /* a refused change puts the box back */
          if (!ok) render();
        });
      });
    });
    var dialog = byId("profile-dialog");
    if (dialog && typeof dialog.addEventListener === "function") {
      dialog.addEventListener("click", function(event) {
        /* a click on the backdrop closes it */
        if (event.target === dialog) close();
      });
      dialog.addEventListener("keydown", function(event) { event.stopPropagation(); });
    }
    render();
  }

  global.HaloProfile = Object.freeze({
    init: init,
    open: open,
    close: close,
    refresh: refresh,
    reset: reset,
    render: render,
    /* the signed-in wallet's username, or null */
    username: function() { return state.profile ? state.profile.username : null; },
    profile: function() { return state.profile; },
    usernameProblem: usernameProblem,
    failureText: failureText,
    messages: MESSAGES,
  });
})(typeof window !== "undefined" ? window : null);
