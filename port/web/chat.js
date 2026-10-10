/* Text chat: the lobby's chat panel and the compact overlay in a match.

   The lines come from the room (services/signaling/src/room.ts, "chat"
   messages over the room WebSocket) or, before a game, from the party
   (src/party.ts, with each poll). online_client.js hands them to
   HaloChat.receive and sends what the player types through
   HaloOnline.chat.send; this file owns what is shown and the keys.

   In a match, Y opens a one-line composer over the game (Halo's keys are
   W A S D, Q E R F G T X Z C, Tab, Space, Enter, Esc, F1; Y is free). The
   mouse stays captured: only the keyboard turns to the composer, and
   nothing typed reaches the game. Enter sends and closes, Esc closes, and
   an empty Enter just closes.

   A player can mute another by clicking their name: that player's lines
   are dropped on this browser from then on. Mutes are kept in the browser
   by name, since peer IDs change with every room. Nothing else is kept:
   the lines go with the room or party. */

;(function installHaloChat(global) {
  "use strict";

  if (!global || global.HaloChat) return;

  var MUTES_STORAGE_KEY = "halo.web.chat-mutes.v1";
  /* the server's limit (services/signaling/src/chat.ts, CHAT_MAX_LENGTH) */
  var MAX_LENGTH = 200;
  /* how many lines the lobby's panel and the overlay keep */
  var LOBBY_LINES = 100;
  var OVERLAY_LINES = 6;
  /* a line over the game fades after this long, unless the composer is open */
  var OVERLAY_LINE_MILLISECONDS = 9000;
  var OPEN_KEY = "y";

  var state = {
    /* every line, oldest first: { scope, from, name, username, style, text, at, id } */
    lines: [],
    mutes: new Set(),
    nextId: 1,
    composing: false,
    /* a note under the lobby's input: a refusal, a mute */
    note: null,
    lobbyDirty: true,
    overlayDirty: true,
    overlayTimer: 0,
    observer: null,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  /* ---------- mutes */

  function loadMutes() {
    try {
      var stored = JSON.parse(global.localStorage.getItem(MUTES_STORAGE_KEY) || "[]");
      if (Array.isArray(stored)) {
        stored.forEach(function(name) { if (typeof name === "string" && name) state.mutes.add(name); });
      }
    } catch (error) { /* a private window, or nothing kept */ }
  }

  function saveMutes() {
    try {
      global.localStorage.setItem(MUTES_STORAGE_KEY, JSON.stringify(Array.from(state.mutes)));
    } catch (error) { /* this visit only */ }
  }

  function muteKey(line) {
    return line.username || line.name;
  }

  function isMuted(line) {
    return state.mutes.has(muteKey(line));
  }

  function setMuted(name, muted) {
    if (!name) return;
    var self = selfName();
    if (muted && self && name === self) {
      state.note = "You can't mute yourself.";
      render();
      return;
    }
    if (muted) state.mutes.add(name); else state.mutes.delete(name);
    saveMutes();
    state.note = muted ? "Muted " + name + ". Their messages are hidden on this browser." : "Unmuted " + name + ".";
    render();
  }

  /* ---------- the lines */

  function normalizedLine(scope, message) {
    if (!message || typeof message !== "object") return null;
    if (typeof message.text !== "string" || !message.text || message.text.length > MAX_LENGTH) return null;
    if (typeof message.name !== "string" || !message.name) return null;
    var username = typeof message.username === "string" && message.username ? message.username : null;
    return {
      scope: scope,
      from: typeof message.from === "string" ? message.from : null,
      name: message.name,
      username: username,
      /* the links the room or party attached (badges.js) */
      links: global.HaloBadges ? global.HaloBadges.normalize(message.links) : null,
      style: typeof message.style === "string" ? message.style : "sage",
      text: message.text,
      at: typeof message.at === "number" ? message.at : Date.now(),
      id: state.nextId++,
    };
  }

  function receive(scope, message) {
    var line = normalizedLine(scope === "party" ? "party" : "room", message);
    if (!line || isMuted(line)) return;
    state.lines.push(line);
    if (state.lines.length > LOBBY_LINES) state.lines.splice(0, state.lines.length - LOBBY_LINES);
    state.lobbyDirty = true;
    state.overlayDirty = true;
    render();
  }

  /* the room's lines go with the room, the party's with the party */
  function clear(scope) {
    var before = state.lines.length;
    state.lines = scope ? state.lines.filter(function(line) { return line.scope !== scope; }) : [];
    if (state.lines.length !== before) {
      state.lobbyDirty = true;
      state.overlayDirty = true;
      render();
    }
  }

  function context() {
    var online = global.HaloOnline;
    if (!online || !online.chat || typeof online.chat.context !== "function") {
      return { room: false, party: false, inGame: false, selfName: null };
    }
    try {
      return online.chat.context() || { room: false, party: false, inGame: false, selfName: null };
    } catch (error) {
      return { room: false, party: false, inGame: false, selfName: null };
    }
  }

  function selfName() {
    return context().selfName || null;
  }

  /* the name shown: the account name when the player has one, else the name
     they play as */
  function shownName(line) {
    return line.username || line.name;
  }

  /* ---------- sending */

  function send(text, scope) {
    var trimmed = String(text || "").replace(/\s+/g, " ").trim();
    if (!trimmed) return Promise.resolve(false);
    if (trimmed.length > MAX_LENGTH) trimmed = trimmed.slice(0, MAX_LENGTH);
    var online = global.HaloOnline;
    if (!online || !online.chat || typeof online.chat.send !== "function") {
      return Promise.reject(new Error("Chat isn't ready yet."));
    }
    return Promise.resolve().then(function() { return online.chat.send(trimmed, scope); }).then(function() { return true; });
  }

  function reportProblem(error) {
    state.note = (error && error.message) || "That message wasn't sent.";
    render();
  }

  /* ---------- the lobby panel */

  function lineElement(line, compact) {
    var item = document.createElement("li");
    item.className = "chat-line";
    item.dataset.style = line.style;
    item.dataset.scope = line.scope;
    var name;
    if (compact) {
      name = document.createElement("span");
    } else {
      name = document.createElement("button");
      name.type = "button";
      name.title = "Mute " + shownName(line);
      name.dataset.mute = muteKey(line);
    }
    name.className = "chat-name";
    name.textContent = shownName(line);
    if (line.username && line.username !== line.name) name.title = (compact ? "" : "Mute ") + line.username + " (playing as " + line.name + ")";
    var text = document.createElement("span");
    text.className = "chat-text";
    text.textContent = line.text;
    item.appendChild(name);
    var badges = !compact && line.links && global.HaloBadges ? global.HaloBadges.element(line.links) : null;
    if (badges) item.appendChild(badges);
    item.appendChild(text);
    return item;
  }

  function renderLobby() {
    var panel = byId("lobby-chat");
    if (!panel) return;
    var current = context();
    var scope = current.room ? "room" : (current.party ? "party" : null);
    panel.dataset.scope = scope || "none";
    var input = byId("lobby-chat-input");
    var sendButton = byId("lobby-chat-send");
    if (input) {
      input.disabled = !scope;
      input.placeholder = scope === "room" ? "Say something to the game…" :
        (scope === "party" ? "Say something to your party…" : "Join a party or a game to chat");
    }
    if (sendButton) sendButton.disabled = !scope;
    var log = byId("lobby-chat-log");
    if (log && state.lobbyDirty && typeof document.createElement === "function") {
      state.lobbyDirty = false;
      while (log.firstChild) log.removeChild(log.firstChild);
      /* in a room the party's lines stay readable; the room's own come after */
      state.lines.forEach(function(line) { log.appendChild(lineElement(line, false)); });
      if (typeof log.scrollTop === "number") log.scrollTop = 1e9;
    }
    var note = byId("lobby-chat-note");
    if (note) {
      note.textContent = state.note || "";
      note.hidden = !state.note;
    }
    var muted = byId("lobby-chat-muted");
    if (muted && typeof document.createElement === "function") {
      var names = Array.from(state.mutes);
      var signature = names.join("|");
      if (muted.dataset.signature !== signature) {
        muted.dataset.signature = signature;
        while (muted.firstChild) muted.removeChild(muted.firstChild);
        muted.hidden = names.length === 0;
        if (names.length) {
          var label = document.createElement("span");
          label.textContent = "Muted:";
          muted.appendChild(label);
          names.forEach(function(name) {
            var chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chat-unmute";
            chip.dataset.unmute = name;
            chip.title = "Unmute " + name;
            chip.textContent = name + " ×";
            muted.appendChild(chip);
          });
        }
      }
    }
  }

  /* ---------- the overlay in a match */

  function renderOverlay() {
    var overlay = byId("chat-overlay");
    if (!overlay) return;
    var current = context();
    var now = Date.now();
    var recent = state.lines.filter(function(line) {
      return line.scope === "room" && (state.composing || now - line.at < OVERLAY_LINE_MILLISECONDS);
    }).slice(-OVERLAY_LINES);
    /* the overlay shows only in a game: the lobby has the panel */
    var visible = current.inGame && (state.composing || recent.length > 0);
    overlay.hidden = !visible;
    overlay.dataset.composing = state.composing ? "true" : "false";
    var log = byId("chat-overlay-log");
    if (log && typeof document.createElement === "function") {
      var signature = recent.map(function(line) { return line.id; }).join(",");
      if (log.dataset.signature !== signature) {
        log.dataset.signature = signature;
        while (log.firstChild) log.removeChild(log.firstChild);
        recent.forEach(function(line) { log.appendChild(lineElement(line, true)); });
      }
    }
    var input = byId("chat-overlay-input");
    if (input) input.hidden = !state.composing;
    var hint = byId("chat-overlay-hint");
    if (hint) hint.hidden = state.composing || !visible;
    /* the lines fade on their own: look again when the oldest is due */
    global.clearTimeout(state.overlayTimer);
    state.overlayTimer = 0;
    if (visible && !state.composing && recent.length) {
      var due = recent[0].at + OVERLAY_LINE_MILLISECONDS - now;
      state.overlayTimer = global.setTimeout(renderOverlay, Math.max(50, due));
    }
  }

  function render() {
    renderLobby();
    renderOverlay();
  }

  /* ---------- the composer over the game */

  function canvas() {
    return byId("canvas");
  }

  function gameOwnsKeyboard() {
    var target = canvas();
    if (!target) return false;
    if (document.pointerLockElement === target) return true;
    var active = document.activeElement;
    return active === target || !active || active === document.body;
  }

  function webUiOwnsKeyboard() {
    var active = document.activeElement;
    return !!(active && active !== canvas() && typeof active.matches === "function" &&
      active.matches("input, select, textarea, button, summary, [contenteditable='true']"));
  }

  function openComposer() {
    var input = byId("chat-overlay-input");
    if (!input || state.composing) return;
    state.composing = true;
    input.value = "";
    renderOverlay();
    /* the keyboard turns to the composer; the mouse stays the game's */
    try { input.focus({ preventScroll: true }); } catch (error) { try { input.focus(); } catch (ignored) { /* no focus */ } }
  }

  function closeComposer() {
    if (!state.composing) return;
    state.composing = false;
    var input = byId("chat-overlay-input");
    if (input) {
      input.value = "";
      try { input.blur(); } catch (error) { /* already */ }
    }
    var target = canvas();
    if (target && typeof target.focus === "function") {
      try { target.focus({ preventScroll: true }); } catch (error) { /* keyboard goes to the page */ }
    }
    renderOverlay();
  }

  function submitComposer() {
    var input = byId("chat-overlay-input");
    var text = input ? input.value : "";
    closeComposer();
    if (!String(text).trim()) return;
    send(text, "room").catch(reportProblem);
  }

  /* Every key while composing is the composer's: nothing reaches the game
     (SDL listens on the window too, after this; the lobby does the same in
     shell.html). Key-ups pass, so a key held when the composer opened is
     released in the game. */
  function onKey(event) {
    if (!event || typeof event.key !== "string") return;
    if (state.composing) {
      if (event.type === "keyup") return;
      event.stopImmediatePropagation();
      if (event.type !== "keydown") return;
      if (event.key === "Enter") {
        event.preventDefault();
        submitComposer();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeComposer();
      }
      return;
    }
    if (event.type !== "keydown" || event.repeat) return;
    if (event.key.toLowerCase() !== OPEN_KEY || event.altKey || event.ctrlKey || event.metaKey) return;
    if (document.body.dataset.lobby === "open" || document.body.dataset.spectate === "true") return;
    if (webUiOwnsKeyboard() || !gameOwnsKeyboard()) return;
    if (!context().inGame) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openComposer();
  }

  /* the composer closes when the page takes over (the Esc menu, the lobby)
     or when the mouse leaves the game */
  function watchPage() {
    if (typeof MutationObserver === "function" && document.body) {
      state.observer = new MutationObserver(function() {
        if (document.body.dataset.lobby === "open" && state.composing) closeComposer();
        state.overlayDirty = true;
        renderOverlay();
      });
      state.observer.observe(document.body, { attributes: true, attributeFilter: ["data-lobby", "data-spectate"] });
    }
    document.addEventListener("pointerlockchange", function() {
      if (state.composing && document.pointerLockElement !== canvas()) closeComposer();
    });
  }

  /* ---------- wiring */

  function installLobbyPanel() {
    var form = byId("lobby-chat-form");
    var input = byId("lobby-chat-input");
    var log = byId("lobby-chat-log");
    var muted = byId("lobby-chat-muted");
    if (form) {
      form.addEventListener("submit", function(event) {
        event.preventDefault();
        if (!input) return;
        var text = input.value;
        input.value = "";
        state.note = null;
        var current = context();
        send(text, current.room ? "room" : "party").then(function(sent) {
          if (sent) render();
        }).catch(reportProblem);
      });
      /* typing in the panel never reaches the game or the lobby's own keys */
      ["keydown", "keyup", "keypress"].forEach(function(type) {
        form.addEventListener(type, function(event) { event.stopPropagation(); });
      });
    }
    if (input) input.maxLength = MAX_LENGTH;
    if (log) {
      log.addEventListener("click", function(event) {
        var target = event.target;
        var name = target && target.dataset ? target.dataset.mute : null;
        if (name) setMuted(name, true);
      });
    }
    if (muted) {
      muted.addEventListener("click", function(event) {
        var target = event.target;
        var name = target && target.dataset ? target.dataset.unmute : null;
        if (name) setMuted(name, false);
      });
    }
  }

  function installOverlay() {
    var input = byId("chat-overlay-input");
    if (input) {
      input.maxLength = MAX_LENGTH;
      ["keydown", "keyup", "keypress"].forEach(function(type) {
        input.addEventListener(type, function(event) { event.stopPropagation(); });
      });
      /* clicking elsewhere, or the page taking the focus, closes it */
      input.addEventListener("blur", function() {
        global.setTimeout(function() {
          if (state.composing && document.activeElement !== input) closeComposer();
        }, 0);
      });
    }
    /* ahead of SDL's own window listeners (registered when the game starts) */
    ["keydown", "keyup", "keypress"].forEach(function(type) {
      global.addEventListener(type, onKey, true);
    });
  }

  function initialize() {
    loadMutes();
    installLobbyPanel();
    installOverlay();
    watchPage();
    render();
  }

  global.HaloChat = Object.freeze({
    receive: receive,
    clear: clear,
    /* the lobby's tick, the party's roster: the panel follows where chat goes */
    refresh: function() { render(); },
    mute: function(name) { setMuted(name, true); },
    unmute: function(name) { setMuted(name, false); },
    isMuted: function(name) { return state.mutes.has(name); },
    isComposing: function() { return state.composing; },
    open: openComposer,
    close: closeComposer,
    lines: function() { return state.lines.slice(); },
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})(typeof window !== "undefined" ? window : null);
