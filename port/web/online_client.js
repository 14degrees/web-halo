/* Private-room signalling and the browser "Play online" experience.

   Gameplay never passes through the room service.  It only exchanges room
   membership and WebRTC descriptions/candidates, then Halo's normal system-
   link packets travel through HaloWebTransport's DataChannels. */

;(function installHaloOnline(global) {
  "use strict";

  if (!global || global.HaloOnline) return;

  var PROTOCOL_VERSION = 1;
  /* The wager experiment's wallet: sign-in, the Play prompt, the balance
     panel and the in-match balance. Off for now; true brings it all back. */
  var WALLET_ENABLED = true;
  var ROOM_CAPACITY = 128;
  var MAX_PENDING_SIGNALING_MESSAGES = ROOM_CAPACITY * 128;
  var HEARTBEAT_MILLISECONDS = 40000;
  var GAME_POLL_MILLISECONDS = 200;
  /* A host extends its room before the service's six-hour room life ends. */
  var ROOM_RENEW_MILLISECONDS = 50 * 60 * 1000;
  /* The map and mode the page assumes when quick join makes it host and the
     service sends no lobby settings (Blood Gulch Slayer). */
  var DEFAULT_PUBLIC_LOBBY = Object.freeze({ mapIndex: 9, modeIndex: 0 });
  var TURNSTILE_RENDER_ATTEMPTS = 80;
  var HOST_SETTINGS_STORAGE_KEY = "halo.web.host-settings.v1";
  var PLAYER_PROFILE_STORAGE_KEY = "halo.web.player-profile.v1";
  var PLAYER_NAME_MAXIMUM_LENGTH = 11;
  var LAST_MAP_INDEX = 12;
  var LAST_MODE_INDEX = 5;
  var PLAYER_STYLES = Object.freeze([
    "white", "black", "red", "blue", "sage", "yellow", "lime", "pink", "purple",
    "cyan", "cornflower", "orange", "teal", "forest", "brown", "tan", "maroon", "rose",
  ]);
  var PLAYER_STYLE_COLORS = Object.freeze({
    white: 0,
    black: 1,
    red: 2,
    blue: 3,
    sage: 4,
    yellow: 5,
    lime: 6,
    pink: 7,
    purple: 8,
    cyan: 9,
    cornflower: 10,
    orange: 11,
    teal: 12,
    forest: 13,
    brown: 14,
    tan: 15,
    maroon: 16,
    rose: 17,
  });

  var COMMAND = Object.freeze({ HOST: 1, JOIN: 2, CANCEL: 3 });
  var GAME_STATE = Object.freeze({
    IDLE: 0,
    WAITING: 1,
    HOST_STARTING: 2,
    HOSTING: 3,
    JOIN_SEARCHING: 4,
    JOIN_CONNECTING: 5,
    JOINED: 6,
    ERROR: 7,
  });
  /* web_online_ui.h's enum web_online_match_state */
  var MATCH_STATE = Object.freeze({
    NONE: 0,
    LOBBY: 1,
    COUNTDOWN: 2,
    INGAME: 3,
    POSTGAME: 4,
  });
  var MATCH_STATE_NAMES = Object.freeze(["none", "lobby", "countdown", "ingame", "postgame"]);
  /* A dedicated host's defaults (services/dedicated-host) */
  var DEDICATED_DEFAULTS = Object.freeze({
    name: "Server",
    style: "white",
    minimumPlayers: 1,
    countdownSeconds: 20,
    postgameSeconds: 15,
  });
  var TRANSPORT_STATE = Object.freeze({
    DISCONNECTED: 0,
    CONNECTING: 1,
    CONNECTED: 2,
    FAILED: 3,
  });
  var GAME_ERRORS = Object.freeze({
    1: "Halo could not open the host lobby.",
    2: "Halo could not start its multiplayer client.",
    3: "Halo could not open the pregame lobby.",
    4: "The host rejected or ended the join.",
    5: "The host lobby did not answer within 90 seconds.",
  });

  var MAP_SLUGS = Object.freeze([
    "battle-creek", "sidewinder", "damnation", "rat-race", "prisoner", "hang-em-high",
    "chill-out", "derelict", "boarding-action", "blood-gulch", "wizard", "chiron-tl-34", "longest",
  ]);
  /* The browser that hosts a public game because nobody else was playing runs
     the same lobby driver as a dedicated host, so nobody presses Start. */
  var PLAYER_HOST_DRIVER = Object.freeze({ minimumPlayers: 1, countdownSeconds: 15, postgameSeconds: 12 });
  var LOBBY_TICK_MILLISECONDS = 250;
  var LOBBY_STALE_MILLISECONDS = 6000;
  var LOBBY_REJOIN_ATTEMPTS = 6;
  var CLIENT_STATE = Object.freeze({ NONE: -1, SEARCHING: 0, JOINING: 1, PREGAME: 2, INGAME: 3, POSTGAME: 4 });

  /* The matchmaking lobby that covers the game until a match begins. */
  var lobby = {
    installed: false,
    wantsPlay: false,
    rejoinTimer: 0,
    rejoinAttempts: 0,
    staleSince: 0,
    deployed: false,
    error: null,
    elements: {},
    /* The public rooms before joining (GET /v1/lobbies), refreshed while idle. */
    listing: null,
    listingAt: 0,
    listingBusy: false,
    /* Host: guests that said they are waiting, by peer ID, with when. */
    waitingPeers: new Map(),
    /* Guest: since when this tab has been trying to join, and its last note. */
    joiningSince: 0,
    waitingSentAt: 0,
    /* What this host last told its guests about the match. */
    sentMatch: "",
    sentMatchAt: 0,
  };
  var LOBBY_LISTING_MILLISECONDS = 5000;
  /* How long a connected player may wait for a running match before the
     host restarts it to let them in. */
  var WAITING_NOTE_EXPIRY_MILLISECONDS = 10000;
  /* A match runs at least this long before a newcomer may restart it. */
  var MINIMUM_MATCH_MILLISECONDS = 60000;

  var elements = {};
  var humanVerification = {
    action: null,
    busy: false,
    generation: 0,
    renderAttempts: 0,
    renderTimer: 0,
    state: "idle",
    token: null,
    widgetId: null,
  };
  var session = {
    runtimeReady: false,
    active: false,
    closing: false,
    role: null,
    room: null,
    roomTicket: null,
    inviteCode: null,
    inviteUrl: null,
    selfPeerId: null,
    iceServers: [],
    socket: null,
    socketGeneration: 0,
    operationGeneration: 0,
    heartbeatTimer: 0,
    renewTimer: 0,
    reconnectTimer: 0,
    reconnectAttempts: 0,
    gamePollTimer: 0,
    gameCommandIssued: false,
    transportConnected: false,
    connectedPeerCount: 0,
    connectionPath: null,
    peerPromises: new Map(),
    peerIdentifiers: new Map(),
    peerStates: new Map(),
    peerAliases: new Map(),
    peerSignalTargets: new Map(),
    roster: new Map(),
    messageChain: Promise.resolve(),
    pendingInvite: null,
    /* The join view is asking for a name before quick join, not an invite. */
    pendingQuick: false,
    /* This session is in a public room, hosting or joined through quick join. */
    publicLobby: false,
    profile: null,
    hostWasReady: false,
    hostSettings: null,
    guestWasJoined: false,
    leavePromise: null,
    wizardStep: "map",
    /* The lobby driver's settings when this browser hosts a public game. */
    lobbyDriver: null,
    /* A dedicated host: its credential, rotation and progress through it. */
    dedicated: null,
    matchState: MATCH_STATE.NONE,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function syncTelemetryContext() {
    if (!global.HaloTelemetry || typeof global.HaloTelemetry.setContext !== "function") return;
    global.HaloTelemetry.setContext({
      role: session.role === "host" ? "host" : (session.role === "guest" ? "guest" : "offline"),
      connection: session.connectionPath || "unknown",
    });
  }

  function telemetry(event, stage) {
    if (global.HaloTelemetry && typeof global.HaloTelemetry.event === "function") {
      global.HaloTelemetry.event(event, stage);
    }
  }

  function collectElements() {
    elements.button = byId("online");
    elements.dialog = byId("online-dialog");
    elements.close = byId("online-close");
    elements.status = byId("online-status");
    elements.description = byId("online-description");
    elements.setup = byId("online-setup");
    elements.quick = byId("online-quick");
    elements.quickJoin = byId("online-quick-join");
    elements.hostForm = byId("online-host-form");
    elements.host = byId("online-host");
    elements.map = byId("online-map");
    elements.mode = byId("online-mode");
    elements.mapOptions = byId("online-map-options");
    elements.modeOptions = byId("online-mode-options");
    elements.joinForm = byId("online-join-form");
    elements.code = byId("online-code");
    elements.join = byId("online-join");
    elements.invite = byId("online-invite");
    elements.inviteLink = byId("invite-link");
    elements.copy = byId("invite-copy");
    elements.copyStatus = byId("invite-copy-status");
    elements.leaveHost = byId("online-leave-host");
    elements.progress = byId("online-progress");
    elements.cancel = byId("online-cancel");
    elements.detail = byId("online-detail");
    elements.wizard = byId("online-wizard");
    elements.wizardSteps = byId("online-wizard-steps");
    elements.wizardMap = byId("online-wizard-map");
    elements.wizardMode = byId("online-wizard-mode");
    elements.wizardLink = byId("online-wizard-link");
    elements.stepMap = byId("online-step-map");
    elements.stepMode = byId("online-step-mode");
    elements.stepLink = byId("online-step-link");
    elements.mapNext = byId("online-map-next");
    elements.modeBack = byId("online-mode-back");
    elements.profile = byId("online-profile");
    elements.playerName = byId("online-player-name");
    elements.styleOptions = byId("online-style-options");
    elements.profilePreview = byId("online-profile-preview");
    elements.profilePreviewName = byId("online-profile-preview-name");
    elements.spartanImage = byId("online-spartan-image");
    elements.joinConfirm = byId("online-join-confirm");
    elements.joinProfile = byId("online-join-profile");
    elements.joinSummary = byId("online-join-summary");
    elements.joinStatus = byId("online-join-status");
    elements.verification = byId("online-human-verification");
    elements.verificationStatus = byId("online-verification-status");
    elements.verificationRetry = byId("online-verification-retry");
    elements.turnstile = byId("online-turnstile");
    elements.playerSidebar = byId("player-sidebar");
    elements.playerList = byId("player-list");
    elements.playerCount = byId("player-count");
    elements.playerEmpty = byId("player-empty");
    elements.playerSidebarToggle = byId("player-sidebar-toggle");
  }

  function buildId() {
    var page = new URL(global.location.href);
    var meta = document.querySelector('meta[name="halo-build-id"]');
    var value = meta && meta.content;
    var pageIsLoopback = page.hostname === "127.0.0.1" || page.hostname === "localhost";
    /* A query override is useful while testing two local builds, but a public
       invite must not be able to opt an incompatible client into a room. */
    if (pageIsLoopback && page.searchParams.get("build")) {
      value = page.searchParams.get("build");
    }
    return value && /^[A-Za-z0-9._-]{1,96}$/.test(value) ? value : "development";
  }

  function apiBase() {
    var page = new URL(global.location.href);
    var query = page.searchParams.get("signal");
    var meta = document.querySelector('meta[name="halo-signaling-url"]');
    var pageIsLoopback = page.hostname === "127.0.0.1" || page.hostname === "localhost";
    if (query) {
      var override = new URL(query, global.location.href);
      var overrideIsLoopback = override.hostname === "127.0.0.1" ||
        override.hostname === "localhost";
      if (!pageIsLoopback || !overrideIsLoopback) {
        throw new Error("Custom room services are allowed only for loopback development.");
      }
    }
    var configured = query || (meta && meta.content);
    if (configured) {
      var parsed = new URL(configured, global.location.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("The room service URL must use HTTP or HTTPS.");
      }
      return parsed.href.replace(/\/$/, "");
    }
    if ((page.hostname === "127.0.0.1" || page.hostname === "localhost") &&
        page.port !== "8787") {
      return page.protocol + "//" + page.hostname + ":8787";
    }
    return page.origin;
  }

  function turnstileSiteKey() {
    var meta = document.querySelector('meta[name="halo-turnstile-sitekey"]');
    var value = meta && meta.content;
    return value && /^0x[A-Za-z0-9_-]{20,120}$/.test(value) ? value : null;
  }

  function clearTurnstileTimer() {
    if (humanVerification.renderTimer) global.clearTimeout(humanVerification.renderTimer);
    humanVerification.renderTimer = 0;
  }

  function turnstileReady(action) {
    return !turnstileSiteKey() ||
      (humanVerification.action === action && !!humanVerification.token);
  }

  function syncVerificationButtons() {
    if (elements.host) {
      elements.host.disabled = humanVerification.busy || !session.runtimeReady ||
        !turnstileReady("create_room");
    }
    if (elements.joinProfile) {
      elements.joinProfile.disabled = humanVerification.busy || !session.runtimeReady ||
        !turnstileReady("join_room");
    }
  }

  function setVerificationState(state, message) {
    humanVerification.state = state;
    if (elements.verification) {
      elements.verification.hidden = !turnstileSiteKey();
      elements.verification.dataset.state = state;
    }
    if (elements.verificationStatus) {
      elements.verificationStatus.textContent = message || "";
      elements.verificationStatus.hidden = !message;
    }
    if (elements.verificationRetry) {
      elements.verificationRetry.hidden = state !== "error";
    }
    syncVerificationButtons();
  }

  function resetTurnstile() {
    humanVerification.token = null;
    if (turnstileSiteKey()) {
      setVerificationState("loading", "Checking that you're human…");
    }
    if (global.turnstile && humanVerification.widgetId !== null) {
      try { global.turnstile.reset(humanVerification.widgetId); } catch (error) { /* not rendered */ }
    }
  }

  function renderTurnstile(action, force) {
    var sitekey = turnstileSiteKey();
    if (!sitekey || !elements.turnstile) {
      setVerificationState("ready", "");
      return;
    }
    if (!force && humanVerification.action === action &&
        humanVerification.widgetId !== null) return;
    clearTurnstileTimer();
    var changedAction = humanVerification.action !== action;
    humanVerification.action = action;
    humanVerification.token = null;
    if (changedAction || force) {
      humanVerification.generation++;
      humanVerification.renderAttempts = 0;
      setVerificationState("loading", "Checking that you're human…");
    }
    if (!global.turnstile || typeof global.turnstile.render !== "function") {
      humanVerification.renderAttempts++;
      if (humanVerification.renderAttempts >= TURNSTILE_RENDER_ATTEMPTS) {
        setVerificationState(
          "error",
          "Human verification is taking longer than expected. Try it again.");
        return;
      }
      humanVerification.renderTimer = global.setTimeout(function() {
        renderTurnstile(action);
      }, 150);
      return;
    }
    if (humanVerification.widgetId !== null) {
      try { global.turnstile.remove(humanVerification.widgetId); } catch (error) { /* stale widget */ }
      humanVerification.widgetId = null;
    }
    elements.turnstile.replaceChildren();
    var generation = humanVerification.generation;
    try {
      humanVerification.widgetId = global.turnstile.render(elements.turnstile, {
        action: action,
        appearance: "interaction-only",
        callback: function(token) {
          if (generation !== humanVerification.generation || humanVerification.action !== action) return;
          humanVerification.token = token;
          setVerificationState(
            "ready",
            action === "join_room" ? "Verified — ready to join." : "Verified — ready to create your link.");
          setStatus("");
        },
        "error-callback": function() {
          if (generation !== humanVerification.generation) return;
          humanVerification.token = null;
          setVerificationState(
            "error",
            "We couldn't verify you this time. Check your connection and try again.");
        },
        "expired-callback": function() {
          if (generation !== humanVerification.generation) return;
          humanVerification.token = null;
          setVerificationState("loading", "Verification expired — checking again…");
          try {
            global.turnstile.reset(humanVerification.widgetId);
          } catch (error) {
            setVerificationState("error", "Verification expired. Try it again.");
          }
        },
        "timeout-callback": function() {
          if (generation !== humanVerification.generation) return;
          humanVerification.token = null;
          setVerificationState("error", "Human verification timed out. Try it again.");
        },
        sitekey: sitekey,
        size: "flexible",
        theme: "dark",
      });
    } catch (error) {
      humanVerification.widgetId = null;
      setVerificationState("error", "Human verification could not start. Try it again.");
    }
  }

  function consumeTurnstile(action) {
    if (!turnstileSiteKey()) return null;
    if (humanVerification.action !== action || !humanVerification.token) {
      renderTurnstile(action);
      throw new Error(humanVerification.state === "error" ?
        "Use Try again to restart human verification." :
        "One moment — human verification is still finishing.");
    }
    var token = humanVerification.token;
    humanVerification.token = null;
    return token;
  }

  function showDialog() {
    /* The lobby speaks for public play; the dialog is for private games. */
    if (lobby.wantsPlay) return;
    if (!elements.dialog.open) elements.dialog.showModal();
  }

  /* SDL listens for keyboard events on window so the game keeps receiving
     input when its canvas has focus. Keyboard events from modal and sidebar
     controls bubble there too unless their surfaces contain them. Do not
     prevent the default: text editing, control activation, and Escape's
     native dialog behavior must keep working. */
  function containDialogKeyboardEvent(event) {
    event.stopPropagation();
  }

  function setHeader(text, state) {
    elements.button.textContent = text;
    elements.button.dataset.state = state || "offline";
  }

  function setStatus(text, tone) {
    var message = String(text || "").trim();
    elements.status.textContent = message;
    elements.status.hidden = !message;
    if (tone) elements.status.dataset.tone = tone;
    else delete elements.status.dataset.tone;
    if (elements.joinStatus) {
      var joinView = elements.dialog && elements.dialog.dataset.view === "join";
      elements.joinStatus.textContent = message;
      elements.joinStatus.hidden = !message || !joinView;
      if (tone) elements.joinStatus.dataset.tone = tone;
      else delete elements.joinStatus.dataset.tone;
    }
  }

  function setBusy(busy) {
    humanVerification.busy = !!busy;
    if (elements.quickJoin) elements.quickJoin.disabled = !!busy || !session.runtimeReady;
    elements.map.disabled = !!busy;
    elements.mode.disabled = !!busy;
    setPickerLocked(elements.mapOptions, "halo-map-choice", !!busy);
    setPickerLocked(elements.modeOptions, "halo-mode-choice", !!busy);
    elements.join.disabled = !!busy || !session.runtimeReady;
    elements.code.disabled = !!busy;
    if (elements.mapNext) elements.mapNext.disabled = !!busy;
    if (elements.modeBack) elements.modeBack.disabled = !!busy;
    syncVerificationButtons();
    setProfileLocked(!!busy || session.active);
  }

  function pickerInputs(container, name) {
    if (!container || typeof container.querySelectorAll !== "function") return [];
    return Array.prototype.slice.call(
      container.querySelectorAll('input[name="' + name + '"]'));
  }

  function setPickerLocked(container, name, locked) {
    pickerInputs(container, name).forEach(function(input) {
      input.disabled = !!locked;
    });
  }

  function syncPickerCards(container, name, select) {
    if (!select) return;
    pickerInputs(container, name).forEach(function(input) {
      var selected = input.value === select.value;
      input.checked = selected;
      input.setAttribute("aria-checked", selected ? "true" : "false");
      if (typeof input.closest === "function") {
        var card = input.closest("[data-picker-option], label");
        if (card && card.dataset) card.dataset.selected = selected ? "true" : "false";
      }
    });
  }

  function syncHostPickerCards() {
    syncPickerCards(elements.mapOptions, "halo-map-choice", elements.map);
    syncPickerCards(elements.modeOptions, "halo-mode-choice", elements.mode);
  }

  function attachPickerEvents(container, name, select) {
    if (!container || !select) return;
    container.addEventListener("change", function(event) {
      var input = event.target;
      if (!input || input.name !== name || input.disabled) return;
      select.value = input.value;
      syncPickerCards(container, name, select);
    });
    select.addEventListener("change", function() {
      syncPickerCards(container, name, select);
    });
  }

  function profileStyleInputs() {
    if (!elements.styleOptions || typeof elements.styleOptions.querySelectorAll !== "function") {
      return [];
    }
    return Array.prototype.slice.call(
      elements.styleOptions.querySelectorAll('input[name="player-style"]'));
  }

  function setProfileLocked(locked) {
    if (elements.playerName) elements.playerName.disabled = !!locked;
    profileStyleInputs().forEach(function(input) { input.disabled = !!locked; });
  }

  function generatedPlayerName() {
    var value = Math.floor(Math.random() * 900) + 100;
    try {
      if (global.crypto && typeof global.crypto.getRandomValues === "function") {
        var random = new Uint16Array(1);
        global.crypto.getRandomValues(random);
        value = 100 + (random[0] % 900);
      }
    } catch (error) {
      /* A friendly fallback does not require cryptographic randomness. */
    }
    return "Spartan " + value;
  }

  /* ---------- emblems and ranks (Halo 3's emblem_foregrounds_ui.png and
     exp_med_ui.png, from the halo-3-menus-remake art) */
  var EMBLEM_COUNT = 70;
  var EMBLEM_COLUMNS = 12;
  var RANK_COUNT = 42;
  var RANK_COLUMNS = 11;
  var PLAYER_KEY_STORAGE_KEY = "halo-player-key";
  var EMBLEM_STORAGE_KEY = "halo-emblem";
  var cachedPlayerKey = null;

  /* This browser's lasting player ID: the matchmaker counts its matches
     (its rank), where the machine identifier changes on every load. */
  function playerKey() {
    if (cachedPlayerKey) return cachedPlayerKey;
    try { cachedPlayerKey = global.localStorage.getItem(PLAYER_KEY_STORAGE_KEY); } catch (error) { cachedPlayerKey = null; }
    if (!cachedPlayerKey || !/^[A-Za-z0-9_-]{16,64}$/.test(cachedPlayerKey)) {
      var bytes = new Uint8Array(18);
      global.crypto.getRandomValues(bytes);
      cachedPlayerKey = btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, "-").replace(/\//g, "_");
      try { global.localStorage.setItem(PLAYER_KEY_STORAGE_KEY, cachedPlayerKey); } catch (error) { /* this load only */ }
    }
    return cachedPlayerKey;
  }

  function validEmblem(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < EMBLEM_COUNT;
  }

  function textHash(text) {
    var hash = 0;
    for (var index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    return hash;
  }

  /* the emblem this player chose, or one their player ID picks */
  function chosenEmblem() {
    var stored = NaN;
    try { stored = Number(global.localStorage.getItem(EMBLEM_STORAGE_KEY)); } catch (error) { stored = NaN; }
    return validEmblem(stored) ? stored : textHash(playerKey()) % EMBLEM_COUNT;
  }

  /* the rank icon for a number of finished matches: a step up the ladder
     early, slower later (0 recruit, 3 a step, 12 two, 48 four, 588 general) */
  function rankIndex(matches) {
    return Math.min(RANK_COUNT - 1, Math.floor(Math.sqrt(Math.max(0, matches) * 3)));
  }

  function emblemElement(index) {
    var plate = document.createElement("span");
    plate.className = "emblem";
    var symbol = document.createElement("span");
    symbol.style.setProperty("--emblem-column", String(index % EMBLEM_COLUMNS));
    symbol.style.setProperty("--emblem-row", String(Math.floor(index / EMBLEM_COLUMNS)));
    plate.appendChild(symbol);
    return plate;
  }

  function rankElement(matches) {
    var icon = document.createElement("span");
    icon.className = "rank";
    var index = rankIndex(matches);
    icon.style.setProperty("--rank-column", String(index % RANK_COLUMNS));
    icon.style.setProperty("--rank-row", String(Math.floor(index / RANK_COLUMNS)));
    icon.title = "Rank " + (index + 1) + " · " + matches + (matches === 1 ? " match" : " matches");
    return icon;
  }

  function normalizePlayerProfile(value) {
    var source = value || {};
    var name = String(source.name || "").replace(/\s+/g, " ").trim();
    var style = String(source.style || "sage").toLowerCase();
    if (name.length < 1 || name.length > PLAYER_NAME_MAXIMUM_LENGTH ||
        !/^[A-Za-z0-9][A-Za-z0-9 ._'-]*$/.test(name)) {
      throw new Error("Use 1–11 basic letters or numbers for your player name.");
    }
    if (PLAYER_STYLES.indexOf(style) < 0) {
      throw new Error("Choose a valid player style.");
    }
    return validEmblem(source.emblem) ? { name: name, style: style, emblem: source.emblem } :
      { name: name, style: style };
  }

  function selectedPlayerStyle() {
    var inputs = profileStyleInputs();
    var selected = inputs.find(function(input) { return input.checked; });
    return selected ? selected.value : "sage";
  }

  function renderPlayerProfilePreview(profile) {
    if (elements.profilePreview) elements.profilePreview.dataset.style = profile.style;
    if (elements.profilePreviewName) elements.profilePreviewName.textContent = profile.name;
    if (elements.spartanImage) {
      if (elements.spartanImage.dataset.style !== profile.style) {
        elements.spartanImage.src = "assets/ui/spartan/" + profile.style + ".png?art=2";
        elements.spartanImage.dataset.style = profile.style;
      }
      elements.spartanImage.alt = profile.name + " in " + profile.style + " armor";
    }
  }

  function writePlayerProfile(profile) {
    if (elements.playerName) elements.playerName.value = profile.name;
    profileStyleInputs().forEach(function(input) {
      input.checked = input.value === profile.style;
    });
    renderPlayerProfilePreview(profile);
  }

  function readPlayerProfile() {
    return normalizePlayerProfile({
      name: elements.playerName ? elements.playerName.value :
        (session.profile && session.profile.name),
      style: selectedPlayerStyle(),
      emblem: chosenEmblem(),
    });
  }

  function savePlayerProfile(profile) {
    session.profile = profile;
    writePlayerProfile(profile);
    try {
      global.localStorage.setItem(PLAYER_PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } catch (error) {
      /* A blocked store should never prevent joining a game. */
    }
    updateLocalRoster();
  }

  function restorePlayerProfile() {
    var profile = { name: generatedPlayerName(), style: "sage" };
    try {
      var saved = JSON.parse(global.localStorage.getItem(PLAYER_PROFILE_STORAGE_KEY));
      profile = normalizePlayerProfile(saved);
    } catch (error) {
      /* First-time and stale profiles get a friendly, editable default. */
    }
    savePlayerProfile(profile);
  }

  function applyPlayerCustomization(profile) {
    var fn = global.Module && global.Module._platform_web_online_set_player_customization;
    if (typeof fn !== "function") return;
    var args = [PLAYER_STYLE_COLORS[profile.style]];
    for (var index = 0; index < PLAYER_NAME_MAXIMUM_LENGTH; index++) {
      args.push(index < profile.name.length ? profile.name.charCodeAt(index) : 0);
    }
    if (!fn.apply(null, args)) {
      throw new Error("Halo could not apply your player customization.");
    }
  }

  function setWizardStep(step) {
    session.wizardStep = step;
    if (elements.wizard) elements.wizard.dataset.step = step;
    if (elements.stepMap) elements.stepMap.hidden = step !== "map";
    if (elements.stepMode) elements.stepMode.hidden = step !== "mode";
    /* The invite lives in the persistent player sidebar once hosting starts;
       it is not a third wizard step. Keep these guards for stale shells while
       allowing the Link markup to be removed entirely. */
    if (elements.stepLink) elements.stepLink.hidden = true;
    if (elements.wizardLink) elements.wizardLink.hidden = true;
    var order = ["map", "mode"];
    var current = order.indexOf(step);
    [elements.wizardMap, elements.wizardMode]
      .forEach(function(indicator, index) {
        if (!indicator) return;
        if (index === current) indicator.setAttribute("aria-current", "step");
        else indicator.removeAttribute("aria-current");
        indicator.dataset.complete = index < current ? "true" : "false";
      });
  }

  function playerFallbackName(player) {
    if (player.peerId === session.selfPeerId && session.profile) return session.profile.name;
    return player.role === "host" ? "Host" : "Joining…";
  }

  function normalizedRosterPlayer(value) {
    if (!value || typeof value.peerId !== "string" ||
        !/^[hg]_[A-Za-z0-9_-]{16}$/.test(value.peerId) ||
        (value.role !== "host" && value.role !== "guest")) return null;
    var profile = null;
    if (value.profile !== null && value.profile !== undefined) {
      try { profile = normalizePlayerProfile(value.profile); } catch (error) { return null; }
    }
    return {
      peerId: value.peerId, role: value.role, profile: profile,
      matches: typeof value.matches === "number" && value.matches >= 0 ? value.matches : null,
    };
  }

  function renderRoster() {
    if (!elements.playerSidebar) return;
    elements.playerSidebar.hidden = false;
    elements.playerSidebar.dataset.onlineActive = session.active ? "true" : "false";
    if (!session.active && elements.playerSidebar.dataset.collapsed === "true") {
      delete elements.playerSidebar.dataset.collapsed;
      if (elements.playerSidebarToggle) {
        elements.playerSidebarToggle.setAttribute("aria-expanded", "true");
        elements.playerSidebarToggle.setAttribute("aria-label", "Collapse player list");
        elements.playerSidebarToggle.textContent = "⌃";
      }
    }
    var players = Array.from(session.roster.values());
    players.sort(function(left, right) {
      if (left.role !== right.role) return left.role === "host" ? -1 : 1;
      var leftName = left.profile ? left.profile.name : playerFallbackName(left);
      var rightName = right.profile ? right.profile.name : playerFallbackName(right);
      return leftName.localeCompare(rightName);
    });
    if (elements.playerCount) {
      elements.playerCount.textContent = players.length + "/" + ROOM_CAPACITY;
      elements.playerCount.setAttribute(
        "aria-label",
        "Players in room: " + players.length + " of " + ROOM_CAPACITY);
    }
    if (elements.playerEmpty) elements.playerEmpty.hidden = players.length !== 0;
    if (elements.playerList && typeof document.createElement === "function") {
      while (elements.playerList.firstChild) elements.playerList.removeChild(elements.playerList.firstChild);
      players.forEach(function(player) {
        var profile = player.profile || {
          name: playerFallbackName(player),
          style: player.peerId === session.selfPeerId && session.profile ?
            session.profile.style : "sage",
        };
        var row = document.createElement("li");
        row.className = "player-row";
        row.dataset.style = profile.style;
        row.dataset.role = player.role;
        row.dataset.self = player.peerId === session.selfPeerId ? "true" : "false";
        var swatch = document.createElement("span");
        swatch.className = "player-swatch";
        swatch.setAttribute("aria-hidden", "true");
        var label = document.createElement("span");
        label.className = "player-name";
        label.textContent = profile.name;
        var role = document.createElement("span");
        role.className = "player-role";
        role.textContent = player.peerId === session.selfPeerId ? "You" :
          (player.role === "host" ? "Host" : "Player");
        row.appendChild(swatch);
        row.appendChild(label);
        row.appendChild(role);
        elements.playerList.appendChild(row);
      });
    }
  }

  function replaceRoster(players) {
    if (!Array.isArray(players) || players.length > ROOM_CAPACITY) return;
    var next = new Map();
    players.forEach(function(value) {
      var player = normalizedRosterPlayer(value);
      if (player) next.set(player.peerId, player);
    });
    session.roster = next;
    updateLocalRoster();
    renderRoster();
  }

  function updateLocalRoster() {
    if (!session.selfPeerId || !session.profile || !session.role) return;
    session.roster.set(session.selfPeerId, {
      peerId: session.selfPeerId,
      profile: session.profile,
      role: session.role,
    });
    renderRoster();
  }

  function selectHasIndex(select, index) {
    return Array.prototype.some.call(select.options, function(option) {
      return option.value === String(index);
    });
  }

  function validatedIndex(value, maximum, select, label) {
    if (value === null || value === undefined || String(value).trim() === "") {
      throw new Error("Choose a " + label + ".");
    }
    var index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index > maximum ||
        !selectHasIndex(select, index)) {
      throw new Error("Choose a valid " + label + ".");
    }
    return index;
  }

  function selectedLabel(select, index) {
    var option = Array.prototype.find.call(select.options, function(candidate) {
      return candidate.value === String(index);
    });
    return option ? option.textContent.trim() : "";
  }

  function normalizeHostSettings(value) {
    var source = value || {
      mapIndex: elements.map.value,
      modeIndex: elements.mode.value,
    };
    var mapIndex = validatedIndex(source.mapIndex, LAST_MAP_INDEX, elements.map, "map");
    var modeIndex = validatedIndex(source.modeIndex, LAST_MODE_INDEX, elements.mode, "mode");
    return {
      mapIndex: mapIndex,
      modeIndex: modeIndex,
      mapName: selectedLabel(elements.map, mapIndex),
      modeName: selectedLabel(elements.mode, modeIndex),
    };
  }

  function restoreHostSettings() {
    elements.map.value = "0";
    elements.mode.value = "0";
    try {
      var saved = JSON.parse(global.localStorage.getItem(HOST_SETTINGS_STORAGE_KEY));
      var settings = normalizeHostSettings(saved);
      elements.map.value = String(settings.mapIndex);
      elements.mode.value = String(settings.modeIndex);
    } catch (error) {
      /* Missing, blocked, or stale storage falls back to Battle Creek + Slayer. */
    }
    syncHostPickerCards();
  }

  function saveHostSettings(settings) {
    try {
      global.localStorage.setItem(HOST_SETTINGS_STORAGE_KEY, JSON.stringify({
        mapIndex: settings.mapIndex,
        modeIndex: settings.modeIndex,
      }));
    } catch (error) {
      /* Private browsing may make local storage unavailable; hosting still works. */
    }
  }

  function hostSettingsLabel() {
    return session.hostSettings ?
      session.hostSettings.mapName + " · " + session.hostSettings.modeName :
      "Your game";
  }

  function connectedFriendsLabel(count) {
    var noun = session.publicLobby ? "player" : "friend";
    return count === 1 ? "1 " + noun + " connected" : count + " " + noun + "s connected";
  }

  /* The other side, as the status lines name it. */
  function hostNoun() {
    return session.publicLobby ? "the host" : "your friend";
  }

  function setQuickVisible(visible) {
    if (elements.quick) elements.quick.hidden = !visible;
  }

  function requireCurrentOperation(generation) {
    if (generation !== session.operationGeneration || !session.active || session.closing) {
      var error = new Error("Online operation was canceled.");
      error.haloCanceled = true;
      throw error;
    }
  }

  function isCurrentSocketOperation(socketGeneration, operationGeneration) {
    return socketGeneration === session.socketGeneration &&
      operationGeneration === session.operationGeneration &&
      session.active && !session.closing;
  }

  function showSetup() {
    if (elements.dialog) elements.dialog.dataset.view = "setup";
    if (elements.wizardSteps) elements.wizardSteps.hidden = false;
    setQuickVisible(true);
    elements.setup.hidden = false;
    elements.invite.hidden = true;
    elements.progress.hidden = true;
    if (elements.joinConfirm) elements.joinConfirm.hidden = true;
    session.pendingQuick = false;
    setWizardStep("map");
    setProfileLocked(false);
    renderTurnstile("create_room");
    setStatus("");
    elements.description.textContent =
      "Join the public game, or pick a map and mode and invite friends.";
  }

  function showProgress() {
    if (elements.dialog) elements.dialog.dataset.view = "progress";
    if (elements.wizardSteps) {
      elements.wizardSteps.hidden = session.role === "guest" || session.publicLobby;
    }
    setQuickVisible(false);
    elements.setup.hidden = true;
    elements.invite.hidden = true;
    elements.progress.hidden = false;
    if (elements.joinConfirm) elements.joinConfirm.hidden = true;
  }

  function showInvite() {
    if (elements.wizardSteps) elements.wizardSteps.hidden = true;
    setQuickVisible(false);
    elements.setup.hidden = true;
    elements.progress.hidden = true;
    elements.invite.hidden = false;
    if (elements.joinConfirm) elements.joinConfirm.hidden = true;
    if (elements.playerSidebar) elements.playerSidebar.hidden = false;
    elements.inviteLink.value = session.inviteUrl || "";
    /* Hosting setup is complete. The invite remains visible beside the game,
       so dismiss the wizard instead of replacing it with a third screen. */
    if (elements.dialog.open) elements.dialog.close();
  }

  /* The name-and-armor step before a join: of an invite, or (quick) of the
     public game. Both verify the join_room Turnstile action. */
  function showJoinConfirmation(invite, quick) {
    session.pendingInvite = quick ? null : invite;
    session.pendingQuick = !!quick;
    if (elements.dialog) elements.dialog.dataset.view = "join";
    if (elements.wizardSteps) elements.wizardSteps.hidden = true;
    setQuickVisible(false);
    elements.setup.hidden = true;
    elements.invite.hidden = true;
    elements.progress.hidden = true;
    if (elements.joinConfirm) elements.joinConfirm.hidden = false;
    if (elements.joinSummary) elements.joinSummary.textContent = quick ?
      "Choose your name and color, then jump into the public game." :
      "Choose your name and color, then join your friend's game.";
    elements.description.textContent = quick ? "Public game." : "You're invited.";
    setHeader(quick ? "Ready to play" : "Ready to join", "waiting");
    setStatus(session.runtimeReady ? "" : "Loading Halo…");
    setProfileLocked(false);
    renderTurnstile("join_room");
    setBusy(false);
  }

  function parseInvite(value) {
    var text = String(value || "").trim();
    if (!text || text.length > 1024) throw new Error("Paste a valid invite link.");
    try {
      var url = new URL(text);
      var fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
      text = fragment.get("join") || "";
    } catch (error) {
      /* A room code is expected not to be a URL. */
    }
    try {
      text = decodeURIComponent(text);
    } catch (error) {
      throw new Error("That invite link is malformed.");
    }
    var separator = text.indexOf(".");
    if (separator <= 0 || separator === text.length - 1) {
      throw new Error("That invite link is incomplete.");
    }
    var roomId = text.slice(0, separator);
    var ticket = text.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(roomId) ||
        !/^[A-Za-z0-9_-]{16,256}$/.test(ticket)) {
      throw new Error("That invite link is not valid.");
    }
    return { code: text, roomId: roomId, ticket: ticket };
  }

  function takeInviteFromLocation() {
    var fragment = new URLSearchParams(global.location.hash.replace(/^#/, ""));
    var invite = fragment.get("join");
    if (!invite) return null;
    /* Capabilities in fragments do not reach the server.  Remove it from the
       address bar as soon as this page has copied it into memory. */
    var sanitized = new URL(global.location.href);
    sanitized.hash = "";
    sanitized.searchParams.delete("signal");
    history.replaceState(null, "", sanitized.pathname + sanitized.search);
    return invite;
  }

  function makeInviteUrl(code) {
    var url = new URL(global.location.href);
    url.searchParams.delete("signal");
    url.hash = "join=" + encodeURIComponent(code);
    return url.href;
  }

  async function fetchJson(path, options) {
    var response;
    try {
      response = await fetch(apiBase() + path, Object.assign({
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
      }, options || {}));
    } catch (error) {
      throw new Error("The private-room service is unreachable.");
    }
    var result = null;
    try {
      result = await response.json();
    } catch (error) {
      /* A proxy error page is not useful to the player. */
    }
    if (!response.ok) {
      var message = result && result.error &&
        (result.error.message || (typeof result.error === "string" && result.error));
      if (response.status === 404) message = "That invite expired or is not valid.";
      if (response.status === 409 && !message) message = "That room is full or no longer available.";
      var requestError = new Error(message || "The private-room service rejected the request.");
      requestError.haloCode = result && result.error && result.error.code;
      requestError.haloStatus = response.status;
      throw requestError;
    }
    return result;
  }

  function wasmFunction(name) {
    var fn = global.Module && global.Module["_" + name];
    if (typeof fn !== "function") throw new Error("Halo is still starting.");
    return fn;
  }

  function requestGame(command) {
    if (!wasmFunction("platform_web_online_request")(command)) {
      throw new Error("Halo could not accept the online-play request.");
    }
  }

  function requestDedicatedHost(settings, dedicated) {
    var fn = wasmFunction("platform_web_online_host_dedicated");
    if (!fn(settings.mapIndex, settings.modeIndex, dedicated.minimumPlayers,
        dedicated.countdownSeconds, dedicated.postgameSeconds)) {
      throw new Error("Halo rejected the dedicated host settings.");
    }
  }

  function requestConfiguredHost(settings) {
    if (!wasmFunction("platform_web_online_host_configured")(
      settings.mapIndex, settings.modeIndex)) {
      throw new Error("Halo could not accept those host settings.");
    }
  }

  function gameState() {
    return wasmFunction("platform_web_online_get_state")();
  }

  function gameError() {
    return wasmFunction("platform_web_online_get_error")();
  }

  function setGameTransportState(value) {
    if (!session.runtimeReady) return;
    wasmFunction("platform_web_online_set_transport_state")(value);
  }

  function transport() {
    if (!global.HaloWebTransport || !global.HaloWebTransport.isSupported()) {
      throw new Error("This browser does not support WebRTC multiplayer.");
    }
    return global.HaloWebTransport;
  }

  function localIdentifier() {
    return transport().getLocalIdentifier();
  }

  function wireSignal(signal) {
    if (signal && signal.description) {
      return { kind: "description", description: signal.description };
    }
    if (signal && Object.prototype.hasOwnProperty.call(signal, "candidate")) {
      return { kind: "candidate", candidate: signal.candidate };
    }
    throw new Error("WebRTC produced an unsupported signal.");
  }

  function transportSignal(signal) {
    if (!signal || typeof signal !== "object") throw new Error("The host sent an invalid signal.");
    if (signal.kind === "description") return { description: signal.description };
    if (signal.kind === "candidate") return { candidate: signal.candidate };
    /* Accept the direct transport shape for local/older signalling servers. */
    if (signal.description || Object.prototype.hasOwnProperty.call(signal, "candidate")) return signal;
    throw new Error("The host sent an unsupported signal.");
  }

  function sendSocket(message) {
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
      throw new Error("The room connection is temporarily unavailable.");
    }
    session.socket.send(JSON.stringify(message));
  }

  function configureTransport(iceServers) {
    transport().configure({
      iceServers: iceServers || [],
      onSignal: function(event) {
        if (!session.active || session.closing || !event ||
            !session.peerPromises.has(event.peerId)) return;
        sendSocket({
          v: PROTOCOL_VERSION,
          type: "signal",
          to: session.peerSignalTargets.get(event.peerId) || event.peerId,
          signal: wireSignal(event.signal),
        });
      },
      onStateChange: function(event) {
        handleTransportState(event);
      },
      onError: function(event) {
        var message = event && event.error && event.error.message ?
          event.error.message : "The browser connection failed.";
        if (session.active) setStatus(message, "error");
      },
    });
  }

  function ensurePeer(peer, socketGeneration, operationGeneration) {
    if (!isCurrentSocketOperation(socketGeneration, operationGeneration)) {
      return Promise.resolve(null);
    }
    if (!peer || typeof peer.peerId !== "string" ||
        typeof peer.identifier !== "string" ||
        (peer.role !== "host" && peer.role !== "guest")) {
      return Promise.reject(new Error("The room returned an invalid peer."));
    }
    if (peer.peerId === session.selfPeerId) return Promise.resolve(null);
    /* Halo uses a host-client star. Guests never need guest-to-guest browser
       transports, even though older room services may announce every member. */
    if (peer.role === session.role) return Promise.resolve(null);
    var existing = session.peerPromises.get(peer.peerId);
    if (existing) return existing;
    var normalizedIdentifier = peer.identifier.toLowerCase();
    var connectedDuplicate = null;
    session.peerIdentifiers.forEach(function(identifier, peerId) {
      if (peerId !== peer.peerId && identifier === normalizedIdentifier) {
        if (session.peerStates.get(peerId) === "connected") {
          connectedDuplicate = peerId;
          return;
        }
        /* A refreshed browser receives a new signaling peer ID but retains its
           Halo network identifier. Replace the stale WebRTC transport before
           registering the new one so both cannot share one virtual address. */
        removePeer(peerId);
      }
    });
    if (connectedDuplicate) {
      session.peerAliases.set(peer.peerId, connectedDuplicate);
      session.peerSignalTargets.set(connectedDuplicate, peer.peerId);
      return session.peerPromises.get(connectedDuplicate) || Promise.resolve(null);
    }
    var rawAdding = transport().addPeer({
      peerId: peer.peerId,
      remoteIdentifier: normalizedIdentifier,
      initiator: session.role === "host",
      polite: session.role !== "host",
      iceServers: session.iceServers,
    });
    var adding = rawAdding.then(function(result) {
      if (!isCurrentSocketOperation(socketGeneration, operationGeneration)) {
        if (session.peerPromises.get(peer.peerId) === adding) removePeer(peer.peerId);
        var error = new Error("Peer registration was canceled.");
        error.haloCanceled = true;
        throw error;
      }
      return result;
    });
    session.peerIdentifiers.set(peer.peerId, normalizedIdentifier);
    session.peerPromises.set(peer.peerId, adding);
    session.peerAliases.set(peer.peerId, peer.peerId);
    session.peerSignalTargets.set(peer.peerId, peer.peerId);
    adding.catch(function() {
      if (session.peerPromises.get(peer.peerId) === adding) {
        session.peerPromises.delete(peer.peerId);
        session.peerIdentifiers.delete(peer.peerId);
        session.peerAliases.delete(peer.peerId);
        session.peerSignalTargets.delete(peer.peerId);
      }
    });
    return adding;
  }

  function removePeer(peerId) {
    var transportPeerId = session.peerAliases.get(peerId) || peerId;
    session.peerAliases.forEach(function(mappedPeerId, signalingPeerId) {
      if (mappedPeerId === transportPeerId) session.peerAliases.delete(signalingPeerId);
    });
    session.peerSignalTargets.delete(transportPeerId);
    session.peerPromises.delete(transportPeerId);
    session.peerIdentifiers.delete(transportPeerId);
    session.peerStates.delete(transportPeerId);
    transport().removePeer(transportPeerId);
    updateAggregateTransportState();
  }

  function updateAggregateTransportState() {
    var values = Array.from(session.peerStates.values());
    var connected = values.filter(function(value) { return value === "connected"; }).length;
    var connecting = values.some(function(value) { return value === "connecting"; });
    var failed = values.some(function(value) { return value === "failed"; });
    session.connectedPeerCount = connected;
    session.transportConnected = connected > 0;
    if (session.transportConnected) setGameTransportState(TRANSPORT_STATE.CONNECTED);
    else if (connecting) setGameTransportState(TRANSPORT_STATE.CONNECTING);
    else if (failed) setGameTransportState(TRANSPORT_STATE.FAILED);
    else setGameTransportState(TRANSPORT_STATE.DISCONNECTED);

    if (session.role === "host") {
      if (connected) {
        setHeader(connectedFriendsLabel(connected), "connected");
        setStatus(connected === 1 ?
          (session.publicLobby ? "A player" : "Your friend") +
            " is connected. Press Start Game in Halo when ready." :
          connectedFriendsLabel(connected) + ". Press Start Game in Halo when ready.");
      } else if (session.active) {
        setHeader(session.publicLobby ? "Waiting for players" : "Waiting for friends", "waiting");
      }
    }
  }

  function handleTransportState(event) {
    if (!session.active || !event || !event.peerId ||
        !session.peerPromises.has(event.peerId)) return;
    session.peerStates.set(event.peerId, event.state);
    updateAggregateTransportState();
    if (event.state === "connected") {
      determineConnectionPath(event.peerId);
      if (session.role === "guest" && !session.gameCommandIssued) {
        try {
          applyPlayerCustomization(session.profile);
          requestGame(COMMAND.JOIN);
          session.gameCommandIssued = true;
          startGamePolling();
          setStatus("Connected. Finding " + (session.publicLobby ? "the game's" : "your friend's") +
            " Halo lobby…");
        } catch (error) {
          fail(error);
        }
      } else if (session.role === "host") {
        global.setTimeout(function() {
          if (elements.dialog.open && session.active) elements.dialog.close();
          var canvas = byId("canvas");
          if (canvas) canvas.focus();
        }, 700);
      }
    } else if (event.state === "connecting" && session.role === "guest") {
      setStatus("Connecting directly to " + hostNoun() + "…");
    } else if (event.state === "failed" && session.role === "guest") {
      fail(new Error(event.detail || "Could not connect to the host."));
    }
  }

  async function determineConnectionPath(peerId) {
    try {
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
      var reports = await transport().getStats(peerId);
      var selected = null;
      reports.forEach(function(report) {
        if (report.type === "candidate-pair" &&
            (report.selected || (report.nominated && report.state === "succeeded"))) {
          selected = report;
        }
      });
      if (!selected) return;
      var local = reports.get(selected.localCandidateId);
      var remote = reports.get(selected.remoteCandidateId);
      session.connectionPath =
        (local && local.candidateType === "relay") ||
        (remote && remote.candidateType === "relay") ? "relay" : "direct";
      syncTelemetryContext();
      telemetry("transport_connected", session.connectionPath);
      elements.detail.textContent = session.connectionPath === "relay" ?
        "Connected through a privacy-compatible relay" :
        "Connected directly peer-to-peer";
    } catch (error) {
      /* Connection-path reporting is diagnostic and never blocks play. */
    }
  }

  async function handleRoomMessage(message, generation, operation) {
    if (!isCurrentSocketOperation(generation, operation)) return;
    if (!message || message.v !== PROTOCOL_VERSION || typeof message.type !== "string") {
      throw new Error("The room service sent an incompatible message.");
    }
    if (message.type === "welcome") {
      session.selfPeerId = message.self && message.self.peerId;
      session.role = message.self && message.self.role;
      syncTelemetryContext();
      updateLocalRoster();
      var peers = Array.isArray(message.peers) ? message.peers : [];
      await Promise.all(peers.map(function(peer) {
        return ensurePeer(peer, generation, operation);
      }));
      return;
    }
    if (message.type === "peer-joined") {
      var joined = normalizedRosterPlayer(message.peer);
      if (joined) {
        session.roster.set(joined.peerId, joined);
        renderRoster();
      }
      await ensurePeer(message.peer, generation, operation);
      return;
    }
    if (message.type === "peer-left") {
      session.roster.delete(message.peerId);
      renderRoster();
      var departedTransportPeerId = session.peerAliases.get(message.peerId) || message.peerId;
      if (session.peerStates.get(departedTransportPeerId) === "connected") {
        session.peerAliases.delete(message.peerId);
        if (session.peerSignalTargets.get(departedTransportPeerId) === message.peerId) {
          session.peerSignalTargets.delete(departedTransportPeerId);
        }
        elements.detail.textContent =
          "Gameplay is still connected directly; the room link closed.";
        return;
      }
      removePeer(departedTransportPeerId);
      if (session.role === "guest" && message.reason === "host-disconnected") {
        fail(new Error("The host closed the room."));
      }
      return;
    }
    if (message.type === "wager") {
      applyWagerView(message.wager);
      return;
    }
    if (message.type === "waiting") {
      if (session.role === "host" && typeof message.from === "string") lobby.waitingPeers.set(message.from, Date.now());
      return;
    }
    if (message.type === "match") {
      /* The host's match status: the lobby's countdown. */
      session.matchInfo = {
        state: message.state,
        startsIn: typeof message.startsIn === "number" ? message.startsIn : null,
        receivedAt: Date.now(),
      };
      return;
    }
    if (message.type === "roster") {
      replaceRoster(message.players);
      return;
    }
    if (message.type === "signal") {
      var transportPeerId = session.peerAliases.get(message.from) || message.from;
      var peerPromise = session.peerPromises.get(transportPeerId);
      if (!peerPromise) {
        /* A rejected guest can have another frame already in flight. It must
           not turn a peer-scoped failure into destruction of the host room. */
        if (session.role === "host") return;
        throw new Error("A signal arrived from an unknown host.");
      }
      try {
        await peerPromise;
        if (!isCurrentSocketOperation(generation, operation)) return;
        await transport().handleSignal(transportPeerId, transportSignal(message.signal));
      } catch (error) {
        if (!isCurrentSocketOperation(generation, operation)) return;
        removePeer(transportPeerId);
        if (session.role === "guest") throw error;
        setStatus("A guest sent invalid connection data and was disconnected.", "error");
      }
      return;
    }
    if (message.type === "error") {
      if (session.role === "host" &&
          (message.code === "PEER_NOT_FOUND" ||
           message.code === "SIGNAL_ROUTE_FORBIDDEN" ||
           message.code === "SIGNAL_DIRECTION_INVALID")) {
        /* A late or rejected guest signal is peer-scoped. The private host
           lobby remains usable for a fresh connection. */
        return;
      }
      throw new Error(message.message || "The private room reported an error.");
    }
    /* pong and future optional messages need no action. */
  }

  function websocketUrl(value) {
    var service = new URL(apiBase());
    var url = new URL(value, service);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    var expectedProtocol = service.protocol === "https:" ? "wss:" : "ws:";
    if (url.protocol !== expectedProtocol || url.host !== service.host) {
      throw new Error("The room returned an invalid WebSocket URL.");
    }
    return url.href;
  }

  function stopHeartbeat() {
    if (session.heartbeatTimer) global.clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = 0;
  }

  function startHeartbeat(generation) {
    stopHeartbeat();
    session.heartbeatTimer = global.setInterval(function() {
      if (generation !== session.socketGeneration || !session.active) return;
      try {
        sendSocket({ v: PROTOCOL_VERSION, type: "ping", nonce: String(Date.now()) });
      } catch (error) {
        /* The close event owns reconnect behavior. */
      }
    }, HEARTBEAT_MILLISECONDS);
  }

  function openSocket(socketUrl, operation) {
    return new Promise(function(resolve, reject) {
      var generation = ++session.socketGeneration;
      var socket;
      try {
        socket = new WebSocket(websocketUrl(socketUrl));
      } catch (error) {
        reject(error);
        return;
      }
      session.socket = socket;
      var settled = false;
      var pendingMessageCount = 0;
      var messageChain = Promise.resolve();
      session.messageChain = messageChain;
      var timeout = global.setTimeout(function() {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error("The private room took too long to connect."));
        }
      }, 12000);
      socket.onopen = function() {
        if (!isCurrentSocketOperation(generation, operation)) {
          global.clearTimeout(timeout);
          if (!settled) {
            settled = true;
            reject(new Error("The room connection was canceled."));
          }
          socket.close();
          return;
        }
        global.clearTimeout(timeout);
        try {
          sendSocket({
            v: PROTOCOL_VERSION,
            type: "profile",
            profile: session.profile,
          });
        } catch (error) {
          settled = true;
          socket.close();
          reject(error);
          return;
        }
        settled = true;
        session.reconnectAttempts = 0;
        startHeartbeat(generation);
        resolve();
      };
      socket.onmessage = function(event) {
        if (!isCurrentSocketOperation(generation, operation) || typeof event.data !== "string") return;
        pendingMessageCount++;
        if (pendingMessageCount > MAX_PENDING_SIGNALING_MESSAGES) {
          socket.close(1008, "Too many pending signaling messages");
          fail(new Error("The room sent too many connection messages."));
          return;
        }
        var message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          pendingMessageCount--;
          if (isCurrentSocketOperation(generation, operation)) {
            fail(new Error("The private room sent malformed data."));
          }
          return;
        }
        messageChain = messageChain.then(function() {
          return handleRoomMessage(message, generation, operation);
        }).catch(function(error) {
          if (isCurrentSocketOperation(generation, operation)) fail(error);
        }).finally(function() {
          pendingMessageCount--;
        });
        session.messageChain = messageChain;
      };
      socket.onerror = function() {
        if (!settled) {
          global.clearTimeout(timeout);
          settled = true;
          reject(new Error("The private room WebSocket could not connect."));
        }
      };
      socket.onclose = function() {
        if (!settled) {
          global.clearTimeout(timeout);
          settled = true;
          reject(new Error("The room connection closed before it was ready."));
          return;
        }
        if (generation !== session.socketGeneration ||
            operation !== session.operationGeneration) return;
        stopHeartbeat();
        if (session.transportConnected && session.role !== "host") {
          elements.detail.textContent =
            "Gameplay is still connected directly; restoring the room link…";
        }
        if (session.active && !session.closing) scheduleReconnect();
      };
    });
  }

  async function createSession(ticket, turnstileToken) {
    var body = {
      protocolVersion: PROTOCOL_VERSION,
      buildId: buildId(),
      identifier: localIdentifier(),
    };
    /* A public room's guests hold no ticket. */
    if (ticket) body.ticket = ticket;
    if (wallet.token) body.walletToken = wallet.token;
    if (turnstileToken) body.turnstileToken = turnstileToken;
    return fetchJson("/v1/rooms/" + encodeURIComponent(session.room.id) + "/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  function scheduleReconnect() {
    if (!session.active || session.closing || session.reconnectTimer) return;
    var operation = session.operationGeneration;
    var delay = Math.min(8000, 500 * Math.pow(2, session.reconnectAttempts++));
    session.reconnectTimer = global.setTimeout(function() {
      session.reconnectTimer = 0;
      if (operation !== session.operationGeneration || !session.active) return;
      reconnect(operation).catch(function(error) {
        if (operation !== session.operationGeneration) return;
        if (session.transportConnected) {
          elements.detail.textContent = "Gameplay is connected; room recovery is still retrying.";
          scheduleReconnect();
        /* A failed WebSocket upgrade can leave its 30-second server-side
           reservation in place. Keep retrying long enough to outlive it. */
        } else if (session.reconnectAttempts < 7) {
          scheduleReconnect();
        } else {
          fail(error);
        }
      });
    }, delay);
  }

  async function reconnect(operation) {
    if (!session.transportConnected) {
      /* The replacement signaling session gets a new peer ID. Any WebRTC
         negotiation that never connected belongs to the old identity and
         must be rebuilt so the host produces a fresh offer. */
      Array.from(session.peerPromises.keys()).forEach(removePeer);
    }
    var result = await createSession(session.roomTicket);
    requireCurrentOperation(operation);
    if (Array.isArray(result.iceServers)) session.iceServers = result.iceServers;
    configureTransport(session.iceServers);
    await openSocket(result.session.websocketUrl, operation);
    requireCurrentOperation(operation);
    elements.detail.textContent = session.connectionPath === "relay" ?
      "Connected through a relay" : "Connected peer-to-peer";
  }

  function validateRoomResponse(result) {
    if (!result || result.v !== PROTOCOL_VERSION || !result.room ||
        !result.session || !result.session.websocketUrl ||
        !result.session.peerId) {
      throw new Error("The room service returned an incomplete response.");
    }
  }

  function isTurnstileRejection(error) {
    return error && error.haloStatus === 403 && error.haloCode === "TURNSTILE_REJECTED";
  }

  async function recoverTurnstile(action, invite) {
    resetTurnstile();
    await leave(false);
    showDialog();
    if (action === "join_room") showJoinConfirmation(invite);
    else if (action === "quick_join") showJoinConfirmation(null, true);
    else showSetup();
    setVerificationState(
      "error",
      "We couldn't verify you this time. Try again — you won't need to refresh.");
    setBusy(false);
  }

  async function host(value, turnstileToken) {
    if (!session.runtimeReady) throw new Error("Halo is still starting.");
    var settings = normalizeHostSettings(value);
    var profile = readPlayerProfile();
    saveHostSettings(settings);
    savePlayerProfile(profile);
    await leave(false);
    var operation = ++session.operationGeneration;
    session.active = true;
    session.role = "host";
    syncTelemetryContext();
    session.hostSettings = settings;
    session.closing = false;
    renderRoster();
    showDialog();
    showProgress();
    setBusy(true);
    setHeader("Opening room…", "waiting");
    setStatus("Preparing " + hostSettingsLabel() + "…");
    var recoveredVerification = false;
    try {
      var roomRequest = {
        protocolVersion: PROTOCOL_VERSION,
        buildId: buildId(),
        capacity: ROOM_CAPACITY,
        identifier: localIdentifier(),
      };
      if (turnstileToken) roomRequest.turnstileToken = turnstileToken;
      var result = await fetchJson("/v1/rooms", {
        method: "POST",
        body: JSON.stringify(roomRequest),
      });
      requireCurrentOperation(operation);
      await completeHostSetup(result, settings, profile, operation);
    } catch (error) {
      if (operation === session.operationGeneration && (!error || !error.haloCanceled)) {
        if (isTurnstileRejection(error)) {
          recoveredVerification = true;
          await recoverTurnstile("create_room");
        } else {
          fail(error);
        }
      }
    } finally {
      if (!recoveredVerification) resetTurnstile();
      if (operation === session.operationGeneration) setBusy(false);
    }
  }

  /* The host's side of a room the service just created for it, whether
     through the wizard or because quick join found no open game. */
  async function completeHostSetup(result, settings, profile, operation) {
    var normalized = {
      v: result.v,
      room: result.room,
      session: result.host && result.host.session,
    };
    validateRoomResponse(normalized);
    session.room = result.room;
    session.roomTicket = result.host.ticket;
    session.selfPeerId = result.host.session.peerId;
    updateLocalRoster();
    session.inviteCode = result.invite && result.invite.code;
    if (!session.inviteCode) throw new Error("The room did not return an invite.");
    session.inviteUrl = result.invite && result.invite.url ?
      result.invite.url : makeInviteUrl(session.inviteCode);
    showInvite();
    session.iceServers = Array.isArray(result.iceServers) ? result.iceServers : [];
    configureTransport(session.iceServers);
    await openSocket(result.host.session.websocketUrl, operation);
    requireCurrentOperation(operation);
    applyPlayerCustomization(profile);
    if (session.dedicated || session.lobbyDriver) {
      requestDedicatedHost(settings, session.dedicated || session.lobbyDriver);
    } else {
      requestConfiguredHost(settings);
    }
    session.gameCommandIssued = true;
    startGamePolling();
    startRoomRenewal();
    setHeader("Preparing lobby…", "waiting");
    setStatus("Opening Halo's lobby with " + hostSettingsLabel() + "…");
  }

  /* A guest's side of a session the service minted, from an invite or from
     quick join. */
  async function completeGuestJoin(result, operation) {
    validateRoomResponse(result);
    session.room = result.room;
    session.selfPeerId = result.session.peerId;
    updateLocalRoster();
    session.iceServers = Array.isArray(result.iceServers) ? result.iceServers : [];
    configureTransport(session.iceServers);
    await openSocket(result.session.websocketUrl, operation);
    requireCurrentOperation(operation);
    setGameTransportState(TRANSPORT_STATE.CONNECTING);
  }

  function stopRoomRenewal() {
    if (session.renewTimer) global.clearInterval(session.renewTimer);
    session.renewTimer = 0;
  }

  function startRoomRenewal() {
    stopRoomRenewal();
    var operation = session.operationGeneration;
    session.renewTimer = global.setInterval(function() {
      if (operation !== session.operationGeneration || !session.active ||
          session.role !== "host" || !session.room || !session.roomTicket) {
        return;
      }
      renewRoom(operation).catch(function() {
        /* The room keeps its current expiry; the next renewal retries. */
      });
    }, ROOM_RENEW_MILLISECONDS);
  }

  /* Pushes the room's expiry back and, for a dedicated host, publishes the
     lobby it is on now. */
  function renewRoom(operation, lobby) {
    var body = { ticket: session.roomTicket };
    if (lobby) body.lobby = { mapIndex: lobby.mapIndex, modeIndex: lobby.modeIndex };
    return fetchJson("/v1/rooms/" + encodeURIComponent(session.room.id) + "/renew", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify(body),
    }).then(function(result) {
      if (operation === session.operationGeneration && result && result.room) {
        session.room = result.room;
      }
      return result;
    });
  }

  /* JSON headers, with the dedicated host's credential when it has one. */
  function requestHeaders() {
    var headers = { "Content-Type": "application/json" };
    if (session.dedicated && session.dedicated.serviceToken) {
      headers.Authorization = "Bearer " + session.dedicated.serviceToken;
    }
    return headers;
  }

  function normalizeRotation(value) {
    var entries = Array.isArray(value) && value.length ? value : [DEFAULT_PUBLIC_LOBBY];
    return entries.map(function(entry) {
      var settings = normalizeHostSettings(entry);
      return { mapIndex: settings.mapIndex, modeIndex: settings.modeIndex };
    });
  }

  function positiveInteger(value, fallback, maximum) {
    var number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > maximum) return fallback;
    return number;
  }

  /* A dedicated host: the page runs on a server (services/dedicated-host)
     with the service credential, keeps a public room open, and lets Halo's
     driver (web_online_ui.c) start and restart games. The rotation advances
     after each game. */
  async function hostDedicated(config) {
    config = config || {};
    if (!session.runtimeReady) throw new Error("Halo is still starting.");
    var serviceToken = String(config.serviceToken || "");
    if (!serviceToken) throw new Error("A dedicated host needs the service credential.");
    var rotation = normalizeRotation(config.rotation);
    var profile = normalizePlayerProfile({
      name: config.name || DEDICATED_DEFAULTS.name,
      style: config.style || DEDICATED_DEFAULTS.style,
    });
    await leave(false);
    var operation = ++session.operationGeneration;
    session.active = true;
    session.role = "host";
    session.publicLobby = true;
    session.dedicated = {
      serviceToken: serviceToken,
      rotation: rotation,
      index: 0,
      minimumPlayers: positiveInteger(config.minimumPlayers, DEDICATED_DEFAULTS.minimumPlayers, 127) || 1,
      countdownSeconds: positiveInteger(config.countdownSeconds, DEDICATED_DEFAULTS.countdownSeconds, 255),
      postgameSeconds: positiveInteger(config.postgameSeconds, DEDICATED_DEFAULTS.postgameSeconds, 255),
      gamesPlayed: 0,
      lastMatchState: MATCH_STATE.NONE,
    };
    syncTelemetryContext();
    session.closing = false;
    session.profile = profile;
    writePlayerProfile(profile);
    var settings = normalizeHostSettings(rotation[0]);
    session.hostSettings = settings;
    renderRoster();
    showProgress();
    setBusy(true);
    setHeader("Opening public game…", "waiting");
    setStatus("Preparing the dedicated lobby with " + hostSettingsLabel() + "…");
    try {
      var result = await fetchJson("/v1/rooms", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          buildId: buildId(),
          capacity: ROOM_CAPACITY,
          identifier: localIdentifier(),
          visibility: "public",
          dedicated: true,
          lobby: { mapIndex: settings.mapIndex, modeIndex: settings.modeIndex },
        }),
      });
      requireCurrentOperation(operation);
      await completeHostSetup(result, settings, profile, operation);
      setStatus("Dedicated lobby open on " + hostSettingsLabel() + ".");
    } catch (error) {
      if (operation === session.operationGeneration && (!error || !error.haloCanceled)) fail(error);
      throw error;
    } finally {
      if (operation === session.operationGeneration) setBusy(false);
    }
  }

  /* After each game, the next map and mode of the rotation, told to Halo for
     the lobby that comes back and to the room service for the directory. */
  function advanceRotation() {
    var dedicated = session.dedicated;
    if (!dedicated || !session.room) return;
    dedicated.gamesPlayed++;
    dedicated.index = (dedicated.index + 1) % dedicated.rotation.length;
    var next = dedicated.rotation[dedicated.index];
    try {
      if (!wasmFunction("platform_web_online_set_next_game")(next.mapIndex, next.modeIndex)) return;
    } catch (error) {
      return;
    }
    try {
      session.hostSettings = normalizeHostSettings(next);
    } catch (error) {
      /* The rotation was validated when it was set. */
    }
    renewRoom(session.operationGeneration, next).catch(function() {
      /* The directory keeps the previous lobby until the next renewal. */
    });
  }

  function pollDedicated() {
    var dedicated = session.dedicated;
    if (!dedicated) return;
    var matchState;
    try {
      matchState = wasmFunction("platform_web_online_get_match_state")();
    } catch (error) {
      return;
    }
    session.matchState = matchState;
    if (matchState !== dedicated.lastMatchState) {
      telemetry("dedicated_" + (MATCH_STATE_NAMES[matchState] || "unknown"), "online");
      /* The report has come up: the game just ended. */
      if (matchState === MATCH_STATE.POSTGAME) advanceRotation();
      dedicated.lastMatchState = matchState;
    }
  }

  /* What the server's supervisor watches. */
  function dedicatedStatus() {
    var players = 0;
    try {
      players = wasmFunction("platform_web_online_get_player_count")();
    } catch (error) {
      players = 0;
    }
    return {
      active: session.active,
      dedicated: !!session.dedicated,
      role: session.role,
      roomId: session.room ? session.room.id : null,
      roomExpiresAt: session.room ? session.room.expiresAt || null : null,
      gameState: session.gameCommandIssued ? gameState() : GAME_STATE.IDLE,
      matchState: MATCH_STATE_NAMES[session.matchState] || "none",
      players: players,
      connectedPeers: session.connectedPeerCount,
      lobby: session.hostSettings ?
        { mapIndex: session.hostSettings.mapIndex, modeIndex: session.hostSettings.modeIndex,
          label: hostSettingsLabel() } : null,
      rotationIndex: session.dedicated ? session.dedicated.index : 0,
      gamesPlayed: session.dedicated ? session.dedicated.gamesPlayed : 0,
    };
  }

  /* Quick join: the service seats this browser in the open public game, or
     makes it the host of a new one when nobody is playing. */
  async function quickJoin(turnstileToken) {
    if (!session.runtimeReady) {
      showDialog();
      showJoinConfirmation(null, true);
      return;
    }
    var profile = readPlayerProfile();
    savePlayerProfile(profile);
    await leave(false);
    var operation = ++session.operationGeneration;
    var recoveredVerification = false;
    session.active = true;
    /* Provisional: the service's answer decides. */
    session.role = "guest";
    session.publicLobby = true;
    syncTelemetryContext();
    session.closing = false;
    session.profile = profile;
    writePlayerProfile(profile);
    renderRoster();
    showDialog();
    showProgress();
    setBusy(true);
    setHeader("Finding a game…", "waiting");
    setStatus("Looking for an open public game…");
    try {
      var request = {
        protocolVersion: PROTOCOL_VERSION,
        buildId: buildId(),
        identifier: localIdentifier(),
      };
      if (turnstileToken) request.turnstileToken = turnstileToken;
      if (wallet.token) request.walletToken = wallet.token;
      var result = await fetchJson("/v1/quickjoin", {
        method: "POST",
        body: JSON.stringify(request),
      });
      requireCurrentOperation(operation);
      if (result && result.role === "host") {
        session.role = "host";
        session.lobbyDriver = PLAYER_HOST_DRIVER;
        syncTelemetryContext();
        var lobby = result.room && result.room.lobby ? result.room.lobby : DEFAULT_PUBLIC_LOBBY;
        var settings = normalizeHostSettings(lobby);
        session.hostSettings = settings;
        await completeHostSetup(result, settings, profile, operation);
        setStatus("Nobody was playing yet, so you're hosting " + hostSettingsLabel() +
          ". Players who press Join multiplayer will land here.");
      } else if (result && result.role === "guest") {
        session.roomTicket = null;
        await completeGuestJoin(result, operation);
        setStatus("Game found. Connecting to the host…");
      } else {
        throw new Error("The room service returned an unexpected answer.");
      }
    } catch (error) {
      if (operation === session.operationGeneration && (!error || !error.haloCanceled)) {
        if (isTurnstileRejection(error)) {
          recoveredVerification = true;
          await recoverTurnstile("quick_join");
        } else {
          fail(error);
        }
      }
    } finally {
      if (!recoveredVerification) resetTurnstile();
      if (operation === session.operationGeneration) setBusy(false);
    }
  }

  async function join(value, turnstileToken, matchmade) {
    if (!session.runtimeReady) {
      showDialog();
      showJoinConfirmation(value);
      return;
    }
    var profile = readPlayerProfile();
    savePlayerProfile(profile);
    await leave(false);
    var operation = ++session.operationGeneration;
    var invite;
    var recoveredVerification = false;
    try {
      invite = parseInvite(value);
    } catch (error) {
      fail(error);
      return;
    }
    session.active = true;
    session.role = "guest";
    /* (known now, so the lobby stays up while the session is made) */
    session.matchmade = !!matchmade;
    session.publicLobby = session.matchmade;
    syncTelemetryContext();
    session.closing = false;
    session.room = { id: invite.roomId };
    session.roomTicket = invite.ticket;
    session.profile = profile;
    writePlayerProfile(profile);
    showDialog();
    showProgress();
    setBusy(true);
    setHeader("Joining friend…", "waiting");
    setStatus("Opening your friend's private room…");
    try {
      var result = await createSession(invite.ticket, turnstileToken);
      requireCurrentOperation(operation);
      /* A matchmade match's room is private (only its players hold the
         invite), but it plays in the public lobby's screens. */
      session.matchmade = !!matchmade;
      session.publicLobby = session.matchmade || !!(result && result.room && result.room.visibility === "public");
      await completeGuestJoin(result, operation);
      setStatus("Room found. Connecting directly to " + hostNoun() + "…");
    } catch (error) {
      if (operation === session.operationGeneration && (!error || !error.haloCanceled)) {
        if (isTurnstileRejection(error)) {
          recoveredVerification = true;
          await recoverTurnstile("join_room", value);
        } else {
          fail(error);
        }
      }
    } finally {
      if (!recoveredVerification) resetTurnstile();
      if (operation === session.operationGeneration) setBusy(false);
    }
  }

  function startGamePolling() {
    if (session.gamePollTimer) return;
    session.gamePollTimer = global.setInterval(pollGame, GAME_POLL_MILLISECONDS);
  }

  function stopGamePolling() {
    if (session.gamePollTimer) global.clearInterval(session.gamePollTimer);
    session.gamePollTimer = 0;
  }

  function pollGame() {
    if (!session.active || !session.runtimeReady || !session.gameCommandIssued) return;
    var state;
    try {
      state = gameState();
    } catch (error) {
      return;
    }
    elements.dialog.dataset.gameState = String(state);
    if (session.dedicated) pollDedicated();
    if (state === GAME_STATE.ERROR) {
      fail(new Error(GAME_ERRORS[gameError()] || "Halo could not enter the online lobby."));
      return;
    }
    if (session.role === "host") {
      if (state === GAME_STATE.HOSTING) {
        if (!session.hostWasReady) showInvite();
        session.hostWasReady = true;
        setHeader(session.connectedPeerCount ?
          connectedFriendsLabel(session.connectedPeerCount) :
          (session.publicLobby ? "Waiting for players" : "Waiting for friends"),
          session.connectedPeerCount ? "connected" : "waiting");
        setStatus(session.connectedPeerCount ?
          connectedFriendsLabel(session.connectedPeerCount) + ". " + hostSettingsLabel() +
            " is ready — press Start Game in Halo." :
          session.publicLobby ?
            hostSettingsLabel() + " is open to everyone — players who press Join multiplayer land here." :
            hostSettingsLabel() + " is ready — send the invite link to your friends.");
      } else if (state === GAME_STATE.WAITING) {
        setStatus("Waiting for Halo's main menu…");
      } else if (state === GAME_STATE.HOST_STARTING) {
        setStatus("Opening Halo's multiplayer lobby…");
      } else if (session.hostWasReady && state === GAME_STATE.IDLE) {
        leave(true);
      }
      return;
    }
    if (state === GAME_STATE.WAITING) {
      setStatus("Waiting for Halo's main menu…");
    } else if (state === GAME_STATE.JOIN_SEARCHING) {
      setStatus("Connected. Finding " + (session.publicLobby ? "the game's" : "your friend's") +
        " Halo lobby…");
    } else if (state === GAME_STATE.JOIN_CONNECTING) {
      setStatus("Halo found the lobby. Joining…");
    } else if (state === GAME_STATE.JOINED) {
      session.guestWasJoined = true;
      setHeader(session.publicLobby ? "In the public game" : "Connected to friend", "connected");
      setStatus("You're in the lobby.");
      global.setTimeout(function() {
        if (elements.dialog.open && session.active) elements.dialog.close();
        var canvas = byId("canvas");
        if (canvas) canvas.focus();
      }, 700);
    } else if (session.guestWasJoined && state === GAME_STATE.IDLE) {
      leave(true);
    }
  }

  function resetSessionState() {
    session.active = false;
    session.matchmade = false;
    session.role = null;
    session.room = null;
    session.roomTicket = null;
    session.inviteCode = null;
    session.inviteUrl = null;
    session.selfPeerId = null;
    session.iceServers = [];
    session.socket = null;
    session.reconnectAttempts = 0;
    session.gameCommandIssued = false;
    session.transportConnected = false;
    session.connectedPeerCount = 0;
    session.connectionPath = null;
    session.peerPromises.clear();
    session.peerIdentifiers.clear();
    session.peerStates.clear();
    session.peerAliases.clear();
    session.peerSignalTargets.clear();
    session.roster.clear();
    session.messageChain = Promise.resolve();
    session.hostWasReady = false;
    session.hostSettings = null;
    session.guestWasJoined = false;
    session.pendingInvite = null;
    session.pendingQuick = false;
    session.publicLobby = false;
    session.dedicated = null;
    session.lobbyDriver = null;
    session.matchInfo = null;
    session.matchState = MATCH_STATE.NONE;
    session.wizardStep = "map";
    syncTelemetryContext();
    renderRoster();
  }

  async function leave(returnToSetup) {
    session.operationGeneration++;
    if (session.leavePromise) return session.leavePromise;
    session.leavePromise = (async function() {
      session.closing = true;
      var pendingWork = [session.messageChain].concat(Array.from(session.peerPromises.values()));
      if (session.role === "host" && session.room && session.roomTicket) {
        /* Awaited with the rest, so a host that is shutting down closes its
           room before it exits instead of stranding its players. */
        pendingWork.push(fetchJson("/v1/rooms/" + encodeURIComponent(session.room.id), {
          method: "DELETE",
          body: JSON.stringify({ ticket: session.roomTicket }),
        }).catch(function() {
          /* The room expires automatically if revocation cannot reach the service. */
        }));
      }
      stopHeartbeat();
      stopGamePolling();
      stopRoomRenewal();
      if (session.reconnectTimer) global.clearTimeout(session.reconnectTimer);
      session.reconnectTimer = 0;
      session.socketGeneration++;
      if (session.socket) {
        try { session.socket.close(1000, "left room"); } catch (error) { /* closed */ }
      }
      if (global.HaloWebTransport) global.HaloWebTransport.disconnectAll();
      await Promise.allSettled(pendingWork);
      /* A peer registration can finish after the first disconnectAll(). Clear
         it before a replacement room is allowed to start. */
      if (global.HaloWebTransport) global.HaloWebTransport.disconnectAll();
      if (session.runtimeReady && session.gameCommandIssued) {
        try { requestGame(COMMAND.CANCEL); } catch (error) { /* runtime shutting down */ }
      }
      try { setGameTransportState(TRANSPORT_STATE.DISCONNECTED); } catch (error) { /* runtime unavailable */ }
      resetSessionState();
      setHeader("Play online", "offline");
      elements.detail.textContent = "Private invite room · gameplay connects peer-to-peer when possible";
      if (returnToSetup !== false) {
        showSetup();
        setBusy(false);
      }
    })();
    try {
      await session.leavePromise;
    } finally {
      session.leavePromise = null;
      session.closing = false;
    }
  }

  function fail(error) {
    var message = error && error.message ? error.message : "Online play failed.";
    if (lobby.wantsPlay) {
      telemetry("online_error", "online");
      if (message === GAME_ERRORS[5]) lobby.rejoinAttempts = 0;
      leave(false).then(function() { scheduleRejoin(message); });
      return;
    }
    telemetry("online_error", "online");
    var wasActive = session.active;
    leave(false).then(function() {
      showDialog();
      showSetup();
      setStatus(message, "error");
      setBusy(false);
    });
    if (!wasActive) {
      showDialog();
      showSetup();
      setStatus(message, "error");
    }
  }

  async function copyInvite() {
    var value = session.inviteUrl;
    if (!value) return;
    var copied = false;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch (error) {
      elements.inviteLink.focus();
      elements.inviteLink.select();
      try {
        copied = typeof document.execCommand === "function" &&
          document.execCommand("copy") === true;
      } catch (fallbackError) {
        copied = false;
      }
    }
    if (!copied) {
      elements.copy.textContent = "Copy link";
      if (elements.copyStatus) {
        elements.copyStatus.textContent = "Link selected — press ⌘/Ctrl+C to copy.";
        elements.copyStatus.hidden = false;
      }
      return;
    }
    if (elements.copyStatus) elements.copyStatus.hidden = true;
    elements.copy.textContent = "Copied!";
    global.setTimeout(function() { elements.copy.textContent = "Copy link"; }, 1400);
  }

  function attachEvents() {
    ["keydown", "keyup", "keypress"].forEach(function(type) {
      elements.dialog.addEventListener(type, containDialogKeyboardEvent);
      elements.playerSidebar.addEventListener(type, containDialogKeyboardEvent);
    });
    attachPickerEvents(elements.mapOptions, "halo-map-choice", elements.map);
    attachPickerEvents(elements.modeOptions, "halo-mode-choice", elements.mode);
    elements.button.addEventListener("click", function() {
      if (session.active && session.role === "host" && session.hostWasReady) {
        showInvite();
        if (elements.inviteLink) elements.inviteLink.focus();
        return;
      }
      showDialog();
      if (!session.active && session.pendingInvite) showJoinConfirmation(session.pendingInvite);
      else if (!session.active) showSetup();
      else showProgress();
    });
    elements.close.addEventListener("click", function() { elements.dialog.close(); });
    elements.dialog.addEventListener("cancel", function(event) {
      event.preventDefault();
      elements.dialog.close();
    });
    elements.hostForm.addEventListener("submit", function(event) {
      event.preventDefault();
      if (session.wizardStep === "map" && elements.stepMap) {
        try {
          validatedIndex(elements.map.value, LAST_MAP_INDEX, elements.map, "map");
          setWizardStep("mode");
          setStatus("");
        } catch (error) {
          setStatus(error.message, "error");
        }
        return;
      }
      try {
        host(undefined, consumeTurnstile("create_room")).catch(fail);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
    if (elements.mapNext) {
      elements.mapNext.addEventListener("click", function() {
        try {
          validatedIndex(elements.map.value, LAST_MAP_INDEX, elements.map, "map");
          setWizardStep("mode");
          setStatus("");
        } catch (error) {
          setStatus(error.message, "error");
        }
      });
    }
    if (elements.modeBack) {
      elements.modeBack.addEventListener("click", function() {
        setWizardStep("map");
        setStatus("");
      });
    }
    elements.joinForm.addEventListener("submit", function(event) {
      event.preventDefault();
      try {
        var invite = parseInvite(elements.code.value);
        showDialog();
        showJoinConfirmation(invite.code);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
    if (elements.quickJoin) {
      elements.quickJoin.addEventListener("click", function() {
        showDialog();
        showJoinConfirmation(null, true);
      });
    }
    if (elements.joinProfile) {
      elements.joinProfile.addEventListener("click", function() {
        var quick = session.pendingQuick;
        var invite = session.pendingInvite;
        if (!quick && !invite) {
          setStatus("That invite is no longer available.", "error");
          return;
        }
        try {
          readPlayerProfile();
        } catch (error) {
          setStatus(error.message, "error");
          return;
        }
        try {
          if (quick) quickJoin(consumeTurnstile("join_room")).catch(fail);
          else join(invite, consumeTurnstile("join_room")).catch(fail);
        } catch (error) {
          setStatus(error.message, "error");
        }
      });
    }
    if (elements.verificationRetry) {
      elements.verificationRetry.addEventListener("click", function() {
        var action = elements.dialog && elements.dialog.dataset.view === "join" ?
          "join_room" : "create_room";
        setStatus("");
        renderTurnstile(action, true);
      });
    }
    var updateProfilePreview = function() {
      try {
        var profile = readPlayerProfile();
        session.profile = profile;
        renderPlayerProfilePreview(profile);
        try {
          global.localStorage.setItem(PLAYER_PROFILE_STORAGE_KEY, JSON.stringify(profile));
        } catch (error) { /* Persistence is optional. */ }
      } catch (error) {
        if (elements.profilePreviewName && elements.playerName) {
          elements.profilePreviewName.textContent = elements.playerName.value || "Player";
        }
      }
    };
    if (elements.playerName) elements.playerName.addEventListener("input", updateProfilePreview);
    if (elements.styleOptions) elements.styleOptions.addEventListener("change", updateProfilePreview);
    elements.copy.addEventListener("click", function() {
      copyInvite().catch(function() {
        elements.inviteLink.focus();
        elements.inviteLink.select();
        if (elements.copyStatus) {
          elements.copyStatus.textContent = "Link selected — press ⌘/Ctrl+C to copy.";
          elements.copyStatus.hidden = false;
        }
      });
    });
    elements.leaveHost.addEventListener("click", function() { leave(true).catch(fail); });
    elements.cancel.addEventListener("click", function() { leave(true).catch(fail); });
  }


  /* ---------- The matchmaking lobby */

  function lobbyElement(id) {
    return lobby.elements[id] || (lobby.elements[id] = byId(id));
  }

  function clientState() {
    try {
      var fn = global.Module && global.Module._platform_web_online_get_client_state;
      return typeof fn === "function" ? fn() : CLIENT_STATE.NONE;
    } catch (error) {
      return CLIENT_STATE.NONE;
    }
  }

  function hostMatchState() {
    try {
      var fn = global.Module && global.Module._platform_web_online_get_match_state;
      return typeof fn === "function" ? fn() : MATCH_STATE.NONE;
    } catch (error) {
      return MATCH_STATE.NONE;
    }
  }

  function currentProfile() {
    if (session.profile) return session.profile;
    try { return readPlayerProfile(); } catch (error) { return { name: generatedPlayerName(), style: "sage", emblem: chosenEmblem() }; }
  }

  function startQuickPlay() {
    lobby.error = null;
    if (!session.runtimeReady) return;
    try {
      savePlayerProfile(currentProfile());
    } catch (error) {
      /* An invalid edit keeps the last good profile. */
    }
    enqueueForMatch();
  }

  /* ---------- matchmaking (services/signaling/src/matchmaker.ts)

     Play queues this machine (and wallet) for a playlist. The page polls
     its ticket every second; the matchmaker groups players, gives the match
     a server, and the poll returns the server's invite once its room is
     open. Matches are accepted automatically. */

  var QUEUE_POLL_MILLISECONDS = 1000;
  /* what Play queues for (services/signaling/src/matchmaker.ts, PLAYLISTS) */
  var DEFAULT_PLAYLIST = "team";

  async function enqueueForMatch() {
    if (lobby.queue) return;
    if (partyView()) {
      if (partyLeader() && lobbyKind() === "matchmaking") startParty();
      else lobby.wantsPlay = false;
      return;
    }
    var queue = { id: null, state: "joining", queued: 0, playlist: selectedPlaylist().id, polledAt: 0 };
    lobby.queue = queue;
    try {
      var request = {
        protocolVersion: PROTOCOL_VERSION,
        buildId: buildId(),
        identifier: localIdentifier(),
        playlist: queue.playlist,
        playerKey: playerKey(),
      };
      if (WALLET_ENABLED && wallet.token) request.walletToken = wallet.token;
      var result = await fetchJson("/v1/queue", { method: "POST", body: JSON.stringify(request) });
      if (lobby.queue !== queue) return;
      applyTicket(result.ticket);
    } catch (error) {
      if (lobby.queue !== queue) return;
      lobby.queue = null;
      lobby.started = false;
      if (error && (error.haloCode === "STAKE_NOT_READY" || error.haloCode === "WALLET_SIGN_IN_REQUIRED")) {
        /* a wagered playlist this wallet cannot stake in yet */
        lobby.wantsPlay = false;
        refreshWallet();
        openLoadUp(error.message);
        return;
      }
      scheduleRejoin(error && error.message ? error.message : "Could not join the queue.");
    }
  }

  function applyTicket(ticket) {
    var queue = lobby.queue;
    if (!queue || !ticket) return;
    queue.id = ticket.id;
    queue.state = ticket.state;
    queue.queued = ticket.queued;
    queue.waited = ticket.waitedSeconds;
    if (typeof ticket.matches === "number") lobby.matches = ticket.matches;
    queue.match = ticket.match || null;
    if (ticket.state === "ready" && ticket.match && ticket.match.inviteCode && !queue.joined && !session.active) {
      queue.joined = true;
      /* a free match after a wagered one: the old wager stays only as the
         lobby's result card */
      if (ticket.match.wager) startWager(ticket.match);
      else lobby.wager = null;
      join(ticket.match.inviteCode, null, true).catch(function(error) { fail(error); });
      return;
    }
    if ((ticket.state === "ended" || ticket.state === "cancelled" || ticket.state === "expired") && !session.active) {
      /* the match is over or never happened: back in the queue, if still
         wanted */
      lobby.queue = null;
      lobby.started = false;
    }
  }

  function pollQueue() {
    var queue = lobby.queue;
    if (!queue || !queue.id || queue.polling || session.active) return;
    if (Date.now() - queue.polledAt < QUEUE_POLL_MILLISECONDS) return;
    queue.polling = true;
    queue.polledAt = Date.now();
    fetchJson("/v1/queue/" + encodeURIComponent(queue.id), { method: "GET" })
      .then(function(result) { if (lobby.queue === queue) applyTicket(result.ticket); })
      .catch(function(error) {
        if (lobby.queue === queue && error && /unknown or has expired/.test(error.message || "")) {
          lobby.queue = null;
          lobby.started = false;
        }
      })
      .then(function() { queue.polling = false; });
  }

  function cancelQueue() {
    var queue = lobby.queue;
    lobby.queue = null;
    if (queue && queue.id && queue.state === "queued") {
      fetchJson("/v1/queue/" + encodeURIComponent(queue.id), { method: "DELETE" }).catch(function() {});
    }
  }

  /* ---------- playlists (services/signaling/src/matchmaker.ts, GET
     /v1/playlists): what the lobby offers, with who is searching and
     playing; until the service answers, this copy */
  var PLAYLIST_STORAGE_KEY = "halo-playlist";
  var FALLBACK_PLAYLISTS = [
    { id: "team", label: "Team Doubles", description: "Two on two Team Slayer.", minimum: 2, maximum: 4, teams: true,
      maps: [0, 6, 4], modes: [1, 1, 1], searching: 0, playing: 0 },
    { id: "ffa", label: "Rumble Pit", description: "Free-for-all Slayer.", minimum: 2, maximum: 8, teams: false,
      maps: [5, 4, 3, 6], modes: [0, 0, 0, 0], searching: 0, playing: 0 },
  ];
  var PLAYLIST_REFRESH_MILLISECONDS = 5000;

  function playlists() {
    return lobby.playlists && lobby.playlists.length ? lobby.playlists : FALLBACK_PLAYLISTS;
  }

  function playlistById(id) {
    var list = playlists();
    for (var index = 0; index < list.length; index++) if (list[index].id === id) return list[index];
    return null;
  }

  /* the playlist Find match queues for: the player's pick, kept */
  function selectedPlaylist() {
    if (!lobby.playlist) {
      try { lobby.playlist = global.localStorage.getItem(PLAYLIST_STORAGE_KEY); } catch (error) { lobby.playlist = null; }
    }
    return playlistById(lobby.playlist) || playlistById(DEFAULT_PLAYLIST) || playlists()[0];
  }

  function teamSize(playlist) {
    if (playlist.teams) {
      var side = Math.floor(playlist.maximum / 2);
      return playlist.minimum === playlist.maximum || side <= 2 ? side + " on " + side : "Up to " + side + " on " + side;
    }
    return playlist.maximum === 2 ? "One on one" : "Up to " + playlist.maximum + " players, free-for-all";
  }

  function playlistCounts(playlist) {
    var parts = [];
    if (playlist.searching) parts.push(playlist.searching + " searching");
    if (playlist.playing) parts.push(playlist.playing + " playing");
    return parts.length ? parts.join(" · ") : "Nobody searching yet";
  }

  function refreshPlaylists() {
    if (lobby.playlistsBusy || Date.now() - (lobby.playlistsAt || 0) < PLAYLIST_REFRESH_MILLISECONDS) return;
    lobby.playlistsBusy = true;
    lobby.playlistsAt = Date.now();
    fetchJson("/v1/playlists", { method: "GET" })
      .then(function(result) {
        if (result && Array.isArray(result.playlists)) lobby.playlists = result.playlists;
        renderPlaylistDialog();
      })
      .catch(function() { /* the next refresh tries again */ })
      .then(function() { lobby.playlistsBusy = false; });
  }

  function choosePlaylist(id) {
    if (!playlistById(id) || id === selectedPlaylist().id) return;
    if (partyView() && !partyLeader()) return;
    if (partyView()) configureParty({ playlist: id });
    lobby.playlist = id;
    try { global.localStorage.setItem(PLAYLIST_STORAGE_KEY, id); } catch (error) { /* this load only */ }
    /* searching already: search the new playlist instead */
    if (lobby.queue && !session.active) {
      cancelQueue();
      lobby.started = false;
    }
  }

  function renderPlaylistDialog() {
    var dialog = lobbyElement("playlist-dialog");
    if (!dialog || !dialog.open) return;
    var focused = playlistById(lobby.playlistFocus) || selectedPlaylist();
    var options = lobbyElement("playlist-options");
    var signature = playlists().map(function(playlist) {
      return playlist.id + ":" + playlist.searching + ":" + playlist.playing;
    }).join("|") + "#" + focused.id;
    if (options.dataset.signature !== signature) {
      options.dataset.signature = signature;
      options.replaceChildren.apply(options, playlists().map(function(playlist) {
        var option = document.createElement("button");
        option.type = "button";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", playlist.id === focused.id ? "true" : "false");
        option.append(playlist.label);
        var count = document.createElement("small");
        count.textContent = playlist.searching ? playlist.searching + " searching" : "";
        if (playlist.wager && !playlist.searching) {
          count.className = "wager";
          count.textContent = "\u25ce " + formatSol(playlist.wager.stake);
        }
        option.appendChild(count);
        option.addEventListener("click", function() {
          lobby.playlistFocus = playlist.id;
          renderPlaylistDialog();
        });
        option.addEventListener("dblclick", function() {
          choosePlaylist(playlist.id);
          dialog.close();
        });
        return option;
      }));
    }
    lobbyElement("playlist-detail-name").textContent = focused.label;
    lobbyElement("playlist-detail-size").textContent = teamSize(focused);
    lobbyElement("playlist-detail-description").textContent = focused.description;
    var wagerLine = lobbyElement("playlist-detail-wager");
    wagerLine.hidden = !focused.wager;
    wagerLine.textContent = !focused.wager ? "" : "\u25ce " + formatSol(focused.wager.stake) + " SOL buy-in · " +
      (focused.wager.mode === "team" ? "the winning team takes the pot" :
        formatSol(focused.wager.perKill) + " SOL a kill") + " · 5% fee on winnings";
    lobbyElement("playlist-detail-counts").textContent = playlistCounts(focused);
    var maps = lobbyElement("playlist-detail-maps");
    if (maps.dataset.playlist !== focused.id) {
      maps.dataset.playlist = focused.id;
      maps.replaceChildren.apply(maps, focused.maps.map(function(mapIndex, index) {
        var figure = document.createElement("figure");
        var image = document.createElement("img");
        image.src = "assets/ui/maps/" + (MAP_SLUGS[mapIndex] || "blood-gulch") + ".png";
        image.alt = "";
        var caption = document.createElement("figcaption");
        caption.textContent = (selectedLabel(elements.map, mapIndex) || "") + " · " +
          (selectedLabel(elements.mode, focused.modes[index]) || "");
        figure.appendChild(image);
        figure.appendChild(caption);
        return figure;
      }));
    }
    lobbyElement("playlist-dialog-select").textContent =
      focused.id === selectedPlaylist().id ? "Selected" : "Select " + focused.label;
  }

  /* ---------- parties (services/signaling/src/party.ts)

     Friends together in the lobby, by a six-letter code (or a link with
     #party=CODE). Every member's page polls the party each second; the
     leader picks the lobby (matchmaking with a playlist, or a custom game
     with a map and game type) and starts it, which gives every member a
     ticket that their page then follows as its own. After the match, the
     party is still together. */

  var PARTY_STORAGE_KEY = "halo-party";
  var PARTY_POLL_MILLISECONDS = 1000;

  function partyMember() {
    var profile = currentProfile();
    var member = {
      playerKey: playerKey(),
      identifier: localIdentifier(),
      profile: { name: profile.name, style: profile.style },
    };
    if (validEmblem(profile.emblem)) member.profile.emblem = profile.emblem;
    if (WALLET_ENABLED && wallet.token) member.walletToken = wallet.token;
    return member;
  }

  function partyView() {
    return lobby.party && lobby.party.view ? lobby.party.view : null;
  }

  function partyLeader() {
    var view = partyView();
    return !view || view.leader;
  }

  /* the lobby shown: the party's, or this player's own pick */
  function lobbyKind() {
    var view = partyView();
    return view ? view.lobby : (lobby.kind || "matchmaking");
  }

  function setPartyStatus(text, tone) {
    var status = lobbyElement("party-status");
    if (!status) return;
    status.textContent = text || "";
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  }

  function rememberParty(code) {
    try {
      if (code) global.localStorage.setItem(PARTY_STORAGE_KEY, code);
      else global.localStorage.removeItem(PARTY_STORAGE_KEY);
    } catch (error) { /* this visit only */ }
  }

  function inviteLink(code) {
    var base = global.location.origin + global.location.pathname;
    return base + "#party=" + encodeURIComponent(code);
  }

  function applyParty(view) {
    if (!view) return;
    if (!lobby.party || lobby.party.code !== view.code) lobby.party = { code: view.code, adopted: null, polledAt: 0 };
    lobby.party.view = view;
    rememberParty(view.code);
    adoptPartyActivity(view);
    renderPartyDialog();
  }

  /* The party started something: this member follows their own ticket in
     it. The leader stopping a search drops it. */
  function adoptPartyActivity(view) {
    var activity = view.activity;
    var party = lobby.party;
    if (activity && activity.ticket && activity.id !== party.adopted && !session.active) {
      party.adopted = activity.id;
      if (lobby.queue && lobby.queue.id !== activity.ticket) cancelQueue();
      lobby.error = null;
      lobby.queue = { id: activity.ticket, state: activity.kind === "custom" ? "assigning" : "queued", queued: 0,
        playlist: activity.playlist, polledAt: 0, party: true };
      /* matchmaking searches again after each match, as alone; a custom
         game comes back to the lobby */
      lobby.wantsPlay = activity.kind === "queue";
      lobby.started = true;
      return;
    }
    if (!activity && party.adopted && lobby.queue && lobby.queue.party && lobby.queue.state === "queued") {
      lobby.queue = null;
      lobby.wantsPlay = false;
      lobby.started = false;
      party.adopted = null;
    }
  }

  async function partyRequest(action, extra) {
    var body = partyMember();
    if (extra) Object.keys(extra).forEach(function(key) { body[key] = extra[key]; });
    var path = action === "create" ? "/v1/parties" : "/v1/parties/" + encodeURIComponent(lobby.party.code) + "/" + action;
    return fetchJson(path, { method: "POST", body: JSON.stringify(body) });
  }

  async function createParty() {
    if (!session.runtimeReady) {
      setPartyStatus("Halo is still loading. Try again in a moment.");
      return;
    }
    setPartyStatus("Starting your party…");
    try {
      var settings = { buildId: buildId(), lobby: lobbyKind(), playlist: selectedPlaylist().id,
        mapIndex: lobby.customMap || 0, modeIndex: lobby.customMode === undefined ? 1 : lobby.customMode };
      var result = await partyRequest("create", settings);
      lobby.party = null;
      applyParty(result.party);
      setPartyStatus("");
    } catch (error) {
      setPartyStatus((error && error.message) || "Couldn't start a party.", "error");
    }
  }

  async function joinParty(code) {
    code = String(code || "").trim().toUpperCase();
    if (!session.runtimeReady) {
      lobby.pendingParty = { code: code, fromLink: true };
      setPartyStatus("Halo is loading; you'll join " + code + " as soon as it's ready.");
      return;
    }
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      setPartyStatus("A party code is six letters and numbers.", "error");
      return;
    }
    if (lobby.party && lobby.party.code === code) return;
    if (lobby.party) await leaveParty();
    setPartyStatus("Joining " + code + "…");
    try {
      lobby.party = { code: code, adopted: null, polledAt: 0 };
      var result = await partyRequest("join");
      applyParty(result.party);
      setPartyStatus("");
      var dialog = lobbyElement("party-dialog");
      if (dialog && dialog.open) dialog.close();
    } catch (error) {
      lobby.party = null;
      rememberParty(null);
      setPartyStatus((error && error.message) || "Couldn't join that party.", "error");
      openPartyDialog();
    }
  }

  async function leaveParty() {
    var party = lobby.party;
    if (!party) return;
    lobby.party = null;
    rememberParty(null);
    if (lobby.queue && lobby.queue.party && !session.active) {
      lobby.queue = null;
      lobby.wantsPlay = false;
      lobby.started = false;
    }
    try {
      await fetchJson("/v1/parties/" + encodeURIComponent(party.code) + "/leave", {
        method: "POST", body: JSON.stringify({ playerKey: playerKey() }),
      });
    } catch (error) { /* it times out anyway */ }
    renderPartyDialog();
  }

  function pollParty() {
    if (!session.runtimeReady) return;
    var pending = lobby.pendingParty;
    if (pending) {
      lobby.pendingParty = null;
      if (pending.fromLink) {
        joinParty(pending.code);
      } else {
        lobby.party = { code: pending.code, adopted: null, polledAt: Date.now() };
        partyRequest("join").then(function(result) { applyParty(result.party); }).catch(function() {
          lobby.party = null;
          rememberParty(null);
        });
      }
      return;
    }
    var party = lobby.party;
    if (!party || party.polling || Date.now() - party.polledAt < PARTY_POLL_MILLISECONDS) return;
    party.polling = true;
    party.polledAt = Date.now();
    partyRequest("poll")
      .then(function(result) { if (lobby.party === party) applyParty(result.party); })
      .catch(function(error) {
        var code = error && error.haloCode;
        if (lobby.party === party && (code === "PARTY_NOT_FOUND" || code === "PARTY_NOT_MEMBER")) {
          lobby.party = null;
          rememberParty(null);
          lobby.error = "You're no longer in that party.";
        }
      })
      .then(function() { party.polling = false; });
  }

  async function configureParty(settings) {
    if (!lobby.party) return;
    try {
      applyParty((await partyRequest("settings", settings)).party);
    } catch (error) {
      lobby.error = (error && error.message) || "Couldn't change the party's settings.";
    }
  }

  /* The leader starts the party's search or custom game. */
  async function startParty() {
    if (!lobby.party || lobby.party.starting) return;
    lobby.party.starting = true;
    lobby.error = null;
    try {
      applyParty((await partyRequest("start")).party);
    } catch (error) {
      lobby.wantsPlay = false;
      lobby.started = false;
      if (error && error.haloCode === "STAKE_NOT_READY" && error.message.indexOf(wallet.name || "\u0000") === 0) {
        openLoadUp(error.message);
      }
      lobby.error = (error && error.message) || "Couldn't start.";
    } finally {
      if (lobby.party) lobby.party.starting = false;
    }
  }

  async function stopParty() {
    if (!lobby.party) return;
    try {
      applyParty((await partyRequest("stop")).party);
    } catch (error) { /* the next poll shows where things stand */ }
  }

  function openPartyDialog() {
    var dialog = lobbyElement("party-dialog");
    if (!dialog) return;
    renderPartyDialog();
    if (!dialog.open) dialog.showModal();
  }

  function renderPartyDialog() {
    var inParty = !!partyView();
    var out = lobbyElement("party-out");
    var into = lobbyElement("party-in");
    if (out) out.hidden = inParty;
    if (into) into.hidden = !inParty;
    var code = lobbyElement("party-code");
    if (code && inParty && code.textContent !== partyView().code) code.textContent = partyView().code;
  }

  /* Halo 3's choosers: a game type or a map for the custom game. */
  function openChooser(kind) {
    var dialog = lobbyElement("choice-dialog");
    var select = kind === "map" ? elements.map : elements.mode;
    if (!dialog || !select) return;
    var current = kind === "map" ? currentCustomMap() : currentCustomMode();
    lobbyElement("choice-dialog-title").textContent = kind === "map" ? "Map" : "Game";
    var options = lobbyElement("choice-options");
    options.replaceChildren.apply(options, Array.prototype.map.call(select.options, function(option) {
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", Number(option.value) === current ? "true" : "false");
      button.textContent = option.textContent;
      button.addEventListener("click", function() {
        var index = Number(option.value);
        if (kind === "map") lobby.customMap = index;
        else lobby.customMode = index;
        if (partyView() && partyLeader()) {
          configureParty(kind === "map" ? { mapIndex: index } : { modeIndex: index });
        }
        dialog.close();
      });
      return button;
    }));
    dialog.showModal();
  }

  function currentCustomMap() {
    var view = partyView();
    return view ? view.mapIndex : (lobby.customMap || 0);
  }

  function currentCustomMode() {
    var view = partyView();
    return view ? view.modeIndex : (lobby.customMode === undefined ? 1 : lobby.customMode);
  }

  /* the lobby's left column for its kind: matchmaking or custom games */
  function renderLobbyKind() {
    var custom = lobbyKind() === "custom";
    var view = partyView();
    var setText = function(id, text) {
      var element = lobbyElement(id);
      if (element && element.textContent !== text) element.textContent = text;
    };
    var show = function(id, visible) {
      var element = lobbyElement(id);
      if (element && element.hidden === visible) element.hidden = !visible;
    };
    setText("lobby-title", custom ? "Custom games lobby" : "Matchmaking lobby");
    setText("lobby-network", view ? "Online (Party)" : "Online");
    show("lobby-party-code", !!view);
    if (view) setText("lobby-party-code-text", view.code);
    show("lobby-playlist-open", !custom);
    show("lobby-game-open", custom);
    show("lobby-map-open", custom);
    setText("lobby-game", selectedLabel(elements.mode, currentCustomMode()) || "Slayer");
    setText("lobby-map", selectedLabel(elements.map, currentCustomMap()) || "Battle Creek");
    setText("lobby-options", custom ? "Edit Game Options" : "Edit Matchmaking Options");
    var leaderOnly = !!view && !view.leader;
    ["lobby-switch", "lobby-playlist-open", "lobby-game-open", "lobby-map-open", "lobby-options"].forEach(function(id) {
      var element = lobbyElement(id);
      if (element) element.disabled = leaderOnly;
    });
  }

  function queueStatus() {
    var queue = lobby.queue;
    var label = (playlistById(queue.playlist) || { label: queue.playlist }).label;
    if (queue.state === "joining") return { text: "Joining the " + label + " queue…" };
    if (queue.state === "queued") {
      var others = Math.max(0, (queue.queued || 1) - 1);
      return { text: "Searching for " + label + " players… " +
        (others === 0 ? "nobody else is queued yet." : others + (others === 1 ? " other player" : " other players") + " queued.") };
    }
    var staking = queue.match && queue.match.wager && queue.match.wager.escrow === "locking";
    if (queue.playlist === "custom") {
      return { text: queue.state === "ready" ? "Joining your custom game…" : "Setting up a server for your custom game…" };
    }
    if (queue.state === "assigning") {
      return { text: staking ? "Match found. Locking everyone's stakes on Solana…" : "Match found. Setting up a server…" };
    }
    if (queue.state === "ready") {
      return { text: staking ? "Match found. Locking everyone's stakes on Solana…" : "Match found. Joining the server…" };
    }
    return { text: "Searching for players…" };
  }

  function scheduleRejoin(message) {
    if (!lobby.wantsPlay) return;
    if (lobby.rejoinTimer) return;
    if (lobby.rejoinAttempts >= LOBBY_REJOIN_ATTEMPTS) {
      lobby.wantsPlay = false;
      lobby.rejoinAttempts = 0;
      lobby.error = message || "Could not reach a game.";
      return;
    }
    lobby.rejoinAttempts++;
    lobby.rejoinTimer = global.setTimeout(function() {
      lobby.rejoinTimer = 0;
      if (lobby.wantsPlay && !session.active) startQuickPlay();
    }, 1500 + 1000 * lobby.rejoinAttempts);
  }

  function refreshListing() {
    if (lobby.listingBusy || Date.now() - lobby.listingAt < LOBBY_LISTING_MILLISECONDS) return;
    lobby.listingBusy = true;
    lobby.listingAt = Date.now();
    fetchJson("/v1/lobbies?buildId=" + encodeURIComponent(buildId()), { method: "GET" })
      .then(function(result) {
        lobby.listing = result && Array.isArray(result.lobbies) ? result.lobbies : [];
      })
      .catch(function() { /* The next refresh tries again. */ })
      .then(function() { lobby.listingBusy = false; });
  }

  /* The room quick join would pick: the first listed (fullest dedicated). */
  function listedRoom() {
    return lobby.listing && lobby.listing.length ? lobby.listing[0] : null;
  }

  function listedPlayerCount() {
    return (lobby.listing || []).reduce(function(total, room) { return total + (room.players || 0); }, 0);
  }

  function lobbyStatus(state) {
    if (lobby.error && !session.active) return { text: lobby.error, tone: "error" };
    if (lobby.queue && !session.active) return queueStatus();
    if (!session.runtimeReady) {
      var label = byId("loading-label");
      var text = (label && label.textContent) || "Loading Halo…";
      return { text: lobby.wantsPlay ? text + " You'll join as soon as it's ready." : text };
    }
    if (lobby.rejoinTimer) return { text: "Connection lost. Reconnecting…" };
    if (!session.active) return { text: "Ready" };
    if (!session.room || !session.selfPeerId) return { text: "Finding a game…" };
    if (session.role === "host") {
      var match = hostMatchState();
      if (match === MATCH_STATE.COUNTDOWN) return { text: "Players are in. The match is about to start…" };
      if (match === MATCH_STATE.POSTGAME) return { text: "Match over. The next one starts shortly." };
      if (match === MATCH_STATE.LOBBY) return { text: "Nobody else is playing yet. Anyone who presses Play lands here, and the match starts as soon as they do." };
      return { text: "Opening the game…" };
    }
    if (!session.transportConnected) return { text: "Connecting to the game…" };
    var info = session.matchInfo;
    if (state === CLIENT_STATE.PREGAME && info && info.state === "countdown") {
      return { text: "Get ready." };
    }
    if ((state === CLIENT_STATE.SEARCHING || state === CLIENT_STATE.JOINING) &&
        ((info && info.state === "ingame") ||
        (lobby.searchingSince && Date.now() - lobby.searchingSince > 4000))) {
      return { text: "Every server is in a match. You'll move to the first one that opens, or join this one's next match." };
    }
    if (state === CLIENT_STATE.SEARCHING || state === CLIENT_STATE.JOINING) return { text: "Joining the match…" };
    if (state === CLIENT_STATE.PREGAME && info && info.state === "lobby") {
      return { text: session.matchmade ? "Waiting for the other players to connect…" :
        "Waiting for another player. The countdown starts when someone joins." };
    }
    if (state === CLIENT_STATE.PREGAME) return { text: "In the lobby. The match starts automatically." };
    if (state === CLIENT_STATE.POSTGAME) return { text: "Match over. The next one starts shortly." };
    return { text: "Joining the match…" };
  }

  function renderLobbyPlayers() {
    var list = lobbyElement("lobby-players");
    if (!list || typeof document.createElement !== "function") return;
    var players = Array.from(session.roster.values());
    /* A dedicated server is in the room but not in the match: it has no
       player, so it is not listed. */
    if (session.room && session.room.dedicated) {
      players = players.filter(function(player) { return player.role !== "host"; });
    }
    /* Halo 3's roster: you, then open slots up to the playlist's size while
       the matchmaker looks for players */
    var playlist = (lobby.queue && playlistById(lobby.queue.playlist)) || selectedPlaylist();
    var slots = 0;
    var party = partyView();
    var maximum = lobbyKind() === "custom" ? 16 : playlist.maximum;
    if (!session.active && party) {
      /* the party, its leader starred */
      players = party.members.map(function(member) {
        return { peerId: "party:" + member.id, role: "guest", self: member.self, leader: member.leader,
          profile: { name: member.name, style: member.style, emblem: member.emblem === null ? undefined : member.emblem } };
      });
      if (lobby.queue && lobbyKind() !== "custom") slots = Math.max(0, playlist.maximum - players.length);
    } else if (!session.active) {
      players = [{ peerId: "self", role: "guest", profile: currentProfile(), self: true }];
      if (lobby.queue) slots = playlist.maximum - 1;
    } else if (session.matchmade) {
      slots = Math.max(0, ((lobby.queue && lobby.queue.match && lobby.queue.match.players) || players.length) - players.length);
    }
    var count = lobbyElement("lobby-count");
    var total = players.length;
    var searching = !!(lobby.queue && !session.active && lobby.queue.state !== "assigning" && lobby.queue.state !== "ready");
    if (count) {
      /* Halo 3's "1 Player (16 max)" */
      var countText = total + (total === 1 ? " Player" : " Players") + " (" + maximum + " max)";
      if (count.textContent !== countText) count.textContent = countText;
    }
    var signature = players.map(function(player) {
      return player.peerId + (player.leader ? "*" : "") + ":" + (player.profile ? player.profile.name + "/" + player.profile.style + "/" +
        player.profile.emblem : "") + "/" + (player.matches !== undefined ? player.matches : lobby.matches);
    }).join("|") + "#" + session.selfPeerId + "#" + slots + (searching ? "s" : "");
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!players.length) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = session.active ? "Connecting…" : "Nobody here yet. Press Play.";
      list.appendChild(empty);
      return;
    }
    players.sort(function(left, right) {
      return left.role === right.role ? 0 : (left.role === "host" ? -1 : 1);
    });
    players.forEach(function(player) {
      var profile = player.profile || {
        name: playerFallbackName(player),
        style: player.peerId === session.selfPeerId ? currentProfile().style : "sage",
      };
      var row = document.createElement("li");
      row.dataset.style = profile.style;
      var self = player.self || player.peerId === session.selfPeerId;
      if (self) row.className = "self";
      row.appendChild(emblemElement(validEmblem(profile.emblem) ? profile.emblem :
        textHash(profile.name) % EMBLEM_COUNT));
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = profile.name;
      var role = document.createElement("span");
      role.className = "role";
      role.textContent = player.peerId === session.selfPeerId ? "You" : (player.role === "host" ? "Host" : "");
      row.appendChild(name);
      if (player.leader) {
        var star = document.createElement("span");
        star.className = "leader";
        star.title = "Party leader";
        star.textContent = "\u2605";
        row.appendChild(star);
      }
      row.appendChild(role);
      var matches = typeof player.matches === "number" ? player.matches :
        (self && typeof lobby.matches === "number" ? lobby.matches : null);
      if (matches !== null) row.appendChild(rankElement(matches));
      list.appendChild(row);
    });
    for (var slot = 0; slot < slots; slot++) {
      var open = document.createElement("li");
      open.className = "slot" + (searching ? " searching" : "");
      open.textContent = searching ? "Searching…" : "Connecting…";
      list.appendChild(open);
    }
  }

  function renderLobbyGame() {
    var playlist = (lobby.queue && playlistById(lobby.queue.playlist)) || selectedPlaylist();
    var found = lobby.queue && lobby.queue.match;
    var settings = (session.room && session.room.lobby) || session.hostSettings || found ||
      { mapIndex: playlist.maps[0], modeIndex: playlist.modes[0] };
    var playlistLabel = lobbyElement("lobby-playlist");
    if (playlistLabel && playlistLabel.textContent !== playlist.label) playlistLabel.textContent = playlist.label;
    var description = lobbyElement("lobby-playlist-description");
    var party = partyView();
    var line = party ? "This party is open to friends. Code " + party.code + "." :
      lobbyKind() === "custom" ? "Custom games are for parties. Press Friends to start one." : playlist.description;
    if (description && description.textContent !== line) description.textContent = line;
    var counts = lobbyElement("lobby-playlist-counts");
    var countText = teamSize(playlist) + " · " + playlistCounts(playlist);
    if (counts && counts.textContent !== countText) counts.textContent = countText;
    /* everyone searching or playing, across the playlists */
    var online = playlists().reduce(function(sum, entry) {
      return sum + (entry.searching || 0) + (entry.playing || 0);
    }, 0) + (lobby.queue || session.active ? 0 : 1);
    /* a party waiting in the lobby is online too */
    if (partyView() && !lobby.queue && !session.active) online = Math.max(online, partyView().members.length);
    var onlineText = online + (online === 1 ? " Gamer Online" : " Gamers Online");
    var onlineElement = lobbyElement("lobby-online");
    if (onlineElement && onlineElement.textContent !== onlineText) onlineElement.textContent = onlineText;
    var mapIndex = Number(settings.mapIndex);
    var modeIndex = Number(settings.modeIndex);
    var mapName = selectedLabel(elements.map, mapIndex) || "Blood Gulch";
    var modeName = selectedLabel(elements.mode, modeIndex) || "Slayer";
    var mapLabel = lobbyElement("lobby-map-name");
    if (mapLabel && mapLabel.dataset.key !== mapIndex + ":" + modeIndex) {
      mapLabel.dataset.key = mapIndex + ":" + modeIndex;
      mapLabel.textContent = mapName;
      lobbyElement("lobby-mode").textContent = modeName;
      lobbyElement("lobby-map-caption").textContent = modeName + " on " + mapName;
      lobbyElement("lobby-map-image").src = "assets/ui/maps/" + (MAP_SLUGS[mapIndex] || "blood-gulch") + ".png";
    }
    var plate = lobbyElement("lobby-nameplate");
    var profile = currentProfile();
    if (plate && (plate.dataset.style !== profile.style || lobbyElement("lobby-nameplate-name").textContent !== profile.name)) {
      plate.dataset.style = profile.style;
      lobbyElement("lobby-nameplate-name").textContent = profile.name;
    }
  }

  function setLobbyVisible(visible) {
    var element = lobbyElement("lobby");
    if (!element) return;
    if (visible) {
      element.hidden = false;
      element.classList.remove("fading");
      document.body.dataset.lobby = "open";
      if (document.pointerLockElement && typeof document.exitPointerLock === "function") {
        document.exitPointerLock();
      }
      /* The match's fullscreen covers only the game; the lobby needs the page. */
      if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
        document.exitFullscreen().catch(function() {});
      }
    } else if (!element.hidden) {
      document.body.dataset.lobby = "closed";
      element.classList.add("fading");
      global.setTimeout(function() {
        if (document.body.dataset.lobby === "closed") element.hidden = true;
      }, 350);
    }
  }

  function deploy() {
    var prompt = lobbyElement("lobby-deploy");
    if (prompt) prompt.hidden = true;
    lobby.deployed = true;
    /* Only the mouse: a fullscreen request would spend the click's user
       activation, and Chrome then refuses the pointer lock. The game already
       fills the window. */
    var focus = byId("focus");
    if (focus) focus.click();
  }

  function mouseCaptured() {
    return document.pointerLockElement === byId("canvas");
  }

  /* The host's side: guests trying to join a running match say so (a
     "waiting" note every few seconds). Once the match has run a minute,
     wrap it up so the next one includes them. Connections that never say
     so (an old tab, a stuck client) cannot cut matches short. */
  function restartForWaitingPlayers() {
    if (!session.active || session.role !== "host" || !session.publicLobby) return;
    if (!(session.dedicated || session.lobbyDriver)) return;
    var now = Date.now();
    var waiting = 0;
    lobby.waitingPeers.forEach(function(at, peerId) {
      if (now - at > WAITING_NOTE_EXPIRY_MILLISECONDS) lobby.waitingPeers.delete(peerId);
      else waiting++;
    });
    if (hostMatchState() !== MATCH_STATE.INGAME) {
      lobby.matchSince = 0;
      return;
    }
    if (!lobby.matchSince) lobby.matchSince = now;
    if (waiting > 0 && now - lobby.matchSince >= MINIMUM_MATCH_MILLISECONDS) {
      lobby.waitingPeers.clear();
      lobby.matchSince = now;
      try { global.Module._platform_web_online_request_restart(); } catch (error) { /* older build */ }
    }
  }

  /* The guest's side: say so while trying to get into a running match. */
  function announceWaiting(state) {
    if (!session.active || session.role !== "guest" || !session.publicLobby || !session.transportConnected) return;
    if (state !== CLIENT_STATE.SEARCHING && state !== CLIENT_STATE.JOINING) {
      lobby.joiningSince = 0;
      return;
    }
    var now = Date.now();
    if (!lobby.joiningSince) lobby.joiningSince = now;
    if (now - lobby.joiningSince < 3000 || now - lobby.waitingSentAt < 3000) return;
    lobby.waitingSentAt = now;
    try { sendSocket({ v: PROTOCOL_VERSION, type: "waiting" }); } catch (error) { /* next tick */ }
  }

  var MATCH_STATE_WIRE = Object.freeze({ 1: "lobby", 2: "countdown", 3: "ingame", 4: "postgame" });

  /* The host tells its guests where the match is: on a change, and every few
     seconds so a newcomer learns it promptly. */
  function broadcastMatch() {
    if (!session.active || session.role !== "host" || !(session.dedicated || session.lobbyDriver)) return;
    var state = MATCH_STATE_WIRE[hostMatchState()];
    if (!state) return;
    var startsIn = null;
    if (state === "countdown") {
      try { startsIn = global.Module._platform_web_online_get_countdown_remaining(); } catch (error) { startsIn = null; }
      if (startsIn < 0) startsIn = null;
    }
    var key = state + ":" + startsIn;
    if (key === lobby.sentMatch && Date.now() - lobby.sentMatchAt < 3000) return;
    lobby.sentMatch = key;
    lobby.sentMatchAt = Date.now();
    var message = { v: PROTOCOL_VERSION, type: "match", state: state };
    if (startsIn !== null) message.startsIn = startsIn;
    try { sendSocket(message); } catch (error) { /* The next tick retries. */ }
  }

  /* Seconds until the match starts, as this browser knows it, or null. */
  function countdownSeconds() {
    if (!session.active) return null;
    if (session.role === "host") {
      if (hostMatchState() !== MATCH_STATE.COUNTDOWN) return null;
      try {
        var left = global.Module._platform_web_online_get_countdown_remaining();
        return left >= 0 ? left : null;
      } catch (error) {
        return null;
      }
    }
    var info = session.matchInfo;
    if (!info || info.state !== "countdown" || info.startsIn === null) return null;
    return Math.max(0, Math.ceil(info.startsIn - (Date.now() - info.receivedAt) / 1000));
  }

  /* A guest seated on a server mid-match (quick join found none in its
     lobby) moves when another server opens: the running match is never
     cut short for it. */
  function moveToOpenServer(state) {
    var info = session.matchInfo;
    var waiting = session.active && session.role === "guest" && session.publicLobby &&
      (state === CLIENT_STATE.SEARCHING || state === CLIENT_STATE.JOINING) &&
      info && info.state === "ingame";
    if (!waiting) {
      lobby.busySince = 0;
      return;
    }
    if (!lobby.busySince) lobby.busySince = Date.now();
    if (Date.now() - lobby.busySince < 8000) return;
    if (session.matchmade) {
      /* this match started without us (we loaded too late): queue again */
      lobby.busySince = 0;
      leave(false).then(function() { scheduleRejoin("The match started without you."); });
      return;
    }
    refreshListing();
    var open = (lobby.listing || []).some(function(room) {
      return room.dedicated && (room.matchState === "lobby" || room.matchState === "countdown") &&
        room.players < room.capacity;
    });
    if (!open || Date.now() - (lobby.movedAt || 0) < 20000) return;
    lobby.movedAt = Date.now();
    lobby.busySince = 0;
    leave(false).then(function() { scheduleRejoin("Could not reach an open server."); });
  }

  function tickLobby() {
    pollQueue();
    pollParty();
    if (document.body.dataset.lobby === "open") refreshPlaylists();
    moveToOpenServer(clientState());
    restartForWaitingPlayers();
    broadcastMatch();
    reportHostKills();
    var state = clientState();
    announceWaiting(state);
    if (session.active && session.transportConnected && state === CLIENT_STATE.SEARCHING) {
      if (!lobby.searchingSince) lobby.searchingSince = Date.now();
    } else {
      lobby.searchingSince = 0;
    }
    var publicPlay = !session.active || session.publicLobby;
    var inMatch = session.active && session.publicLobby && state === CLIENT_STATE.INGAME &&
      (session.role === "host" || session.transportConnected);

    /* A guest whose host vanished still shows the old lobby; start over. */
    if (lobby.wantsPlay && session.active && session.role === "guest" && !session.transportConnected &&
        (state === CLIENT_STATE.PREGAME || state === CLIENT_STATE.INGAME || state === CLIENT_STATE.POSTGAME)) {
      if (!lobby.staleSince) lobby.staleSince = Date.now();
      if (Date.now() - lobby.staleSince > LOBBY_STALE_MILLISECONDS) {
        lobby.staleSince = 0;
        leave(false).then(function() { scheduleRejoin("Lost the connection to the game."); });
      }
    } else {
      lobby.staleSince = 0;
    }
    if (session.active && (state === CLIENT_STATE.PREGAME || state === CLIENT_STATE.INGAME)) lobby.rejoinAttempts = 0;
    if (lobby.wantsPlay && session.runtimeReady && !session.active && !lobby.rejoinTimer && !session.leavePromise &&
        !lobby.error && !lobby.started) {
      lobby.started = true;
      startQuickPlay();
    }
    if (session.active) lobby.started = false;

    var prompt = lobbyElement("lobby-deploy");
    if (!publicPlay) {
      setLobbyVisible(false);
      if (prompt) prompt.hidden = true;
      return;
    }
    tickWager();
    renderWallet(inMatch);
    renderLobbyKind();
    if (inMatch) {
      setLobbyVisible(false);
      /* Whenever the mouse is free during a match, one click takes it back. */
      if (prompt) {
        var free = !mouseCaptured();
        if (free && lobby.deployed && prompt.dataset.mode !== "resume") {
          prompt.dataset.mode = "resume";
          prompt.firstChild.textContent = "Click to resume";
        } else if (!lobby.deployed && prompt.dataset.mode !== "start") {
          prompt.dataset.mode = "start";
          prompt.firstChild.textContent = "Match found";
        }
        prompt.hidden = !free;
      }
      return;
    }
    lobby.deployed = false;
    if (prompt) prompt.hidden = true;
    setLobbyVisible(true);
    if (!session.active) refreshListing();

    var countdown = lobbyElement("lobby-countdown");
    var seconds = countdownSeconds();
    if (countdown) {
      countdown.hidden = seconds === null;
      var number = lobbyElement("lobby-countdown-seconds");
      if (seconds !== null && number && number.textContent !== String(seconds)) number.textContent = String(seconds);
    }
    var status = lobbyStatus(state);
    var statusElement = lobbyElement("lobby-status");
    if (statusElement && statusElement.textContent !== status.text) statusElement.textContent = status.text;
    if (statusElement) {
      if (status.tone) statusElement.dataset.tone = status.tone;
      else delete statusElement.dataset.tone;
    }
    var play = lobbyElement("lobby-play");
    if (play) {
      var leaving = session.active || lobby.wantsPlay;
      play.dataset.mode = leaving ? "leave" : "play";
      var partyNow = partyView();
      var customLobby = lobbyKind() === "custom";
      var partyBusy = !!(lobby.queue && lobby.queue.party);
      var waiting = !!partyNow && !partyNow.leader && !session.active && !partyBusy;
      play.textContent = session.active ? "Leave match" :
        waiting ? "Waiting for the party leader" :
        customLobby ? (partyBusy ? "Starting the game…" : "Start game") :
        lobby.wantsPlay || partyBusy ? "Stop searching" : "Start matchmaking";
      play.disabled = waiting || (customLobby && partyBusy && !session.active);
      if (waiting || (customLobby && partyBusy)) play.dataset.mode = "wait";
    }
    renderLobbyGame();
    renderLobbyPlayers();
  }

  function renderLobbyColors() {
    var colors = lobbyElement("lobby-colors");
    if (!colors || typeof document.createElement !== "function") return;
    var style = currentProfile().style;
    if (!colors.firstChild) {
      PLAYER_STYLES.forEach(function(name) {
        var swatch = document.createElement("button");
        swatch.type = "button";
        swatch.dataset.style = name;
        swatch.title = name;
        swatch.setAttribute("aria-label", name);
        swatch.addEventListener("click", function() {
          var profile = currentProfile();
          savePlayerProfile({ name: profile.name, style: name, emblem: chosenEmblem() });
          sendProfileUpdate();
          renderLobbyColors();
        });
        colors.appendChild(swatch);
      });
    }
    Array.prototype.forEach.call(colors.children, function(swatch) {
      swatch.setAttribute("aria-pressed", swatch.dataset.style === style ? "true" : "false");
    });
    renderLobbyEmblems();
  }

  function renderLobbyEmblems() {
    var grid = lobbyElement("lobby-emblems");
    if (!grid || typeof document.createElement !== "function") return;
    var chosen = chosenEmblem();
    if (!grid.firstChild) {
      for (var index = 0; index < EMBLEM_COUNT; index++) {
        (function(emblem) {
          var button = document.createElement("button");
          button.type = "button";
          button.setAttribute("aria-label", "Emblem " + (emblem + 1));
          button.appendChild(emblemElement(emblem));
          button.addEventListener("click", function() {
            try { global.localStorage.setItem(EMBLEM_STORAGE_KEY, String(emblem)); } catch (error) { /* this load only */ }
            var profile = currentProfile();
            savePlayerProfile({ name: profile.name, style: profile.style, emblem: emblem });
            sendProfileUpdate();
            renderLobbyEmblems();
          });
          grid.appendChild(button);
        })(index);
      }
    }
    Array.prototype.forEach.call(grid.children, function(button, index) {
      button.setAttribute("aria-pressed", index === chosen ? "true" : "false");
    });
    /* the plates in the player's armor colour */
    grid.dataset.style = currentProfile().style;
    renderSpartanShowcase();
  }

  function renderSpartanShowcase(typedName) {
    var showcase = lobbyElement("spartan-showcase");
    if (!showcase) return;
    var profile = currentProfile();
    var name = typedName !== undefined ? typedName : profile.name;
    showcase.dataset.style = profile.style;
    var image = lobbyElement("spartan-showcase-image");
    if (image.dataset.style !== profile.style) {
      image.src = "assets/ui/spartan/" + profile.style + ".png?art=2";
      image.dataset.style = profile.style;
    }
    lobbyElement("spartan-showcase-name").textContent = name || " ";
    var holder = lobbyElement("spartan-showcase-emblem");
    var emblem = validEmblem(profile.emblem) ? profile.emblem : chosenEmblem();
    if (holder.dataset.emblem !== String(emblem)) {
      holder.dataset.emblem = String(emblem);
      holder.replaceChildren(emblemElement(emblem));
    }
  }

  function sendProfileUpdate() {
    if (!session.active || !session.profile) return;
    try {
      sendSocket({ v: PROTOCOL_VERSION, type: "profile", profile: session.profile });
    } catch (error) {
      /* The next connection sends it. */
    }
  }


  /* ---------- Wallets (the wager experiment, Solana devnet)

     Sign-in with a Solana wallet through the Wallet Standard (Phantom,
     Solflare, Backpack, ...). The room service checks the signature, holds
     the balance, and moves the wager between wallets on each kill a
     dedicated server reports. A wallet player plays under the wallet's
     short name. */

  var WALLET_STORAGE_KEY = "halo.web.wallet.v1";
  var WALLET_CHAIN = "solana:devnet";
  var LAMPORTS_PER_SOL = 1000000000;
  var BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var wallet = {
    standard: [],
    provider: null,
    account: null,
    address: null,
    token: null,
    name: null,
    onchainLamports: null,
    enabled: false,
    /* the player's vault in the escrow program (GET /v1/escrow) */
    vault: null,
    playSession: null,
    busy: false,
    status: "",
    tone: null,
  };

  function base58(bytes) {
    var zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    var digits = [];
    for (var index = zeros; index < bytes.length; index++) {
      var carry = bytes[index];
      for (var digit = 0; digit < digits.length; digit++) {
        carry += digits[digit] << 8;
        digits[digit] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    var text = "";
    for (var zero = 0; zero < zeros; zero++) text += "1";
    for (var position = digits.length - 1; position >= 0; position--) text += BASE58_ALPHABET[digits[position]];
    return text;
  }

  function fromBase64(text) {
    var binary = global.atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function formatSol(lamports) {
    return (lamports / LAMPORTS_PER_SOL).toFixed(3);
  }

  /* "+0.019" / "\u22120.010" / "0.000" */
  function formatSigned(lamports) {
    if (lamports > 0) return "+" + formatSol(lamports);
    if (lamports < 0) return "\u2212" + formatSol(-lamports);
    return formatSol(0);
  }

  function walletHeaders() {
    var headers = { "Content-Type": "application/json" };
    if (wallet.token) headers.Authorization = "Bearer " + wallet.token;
    return headers;
  }

  function setWalletStatus(text, tone) {
    wallet.status = text || "";
    wallet.tone = tone || null;
  }

  /* The Wallet Standard: wallets announce themselves to the page. */
  function registerStandardWallets() {
    var wallets = Array.prototype.slice.call(arguments);
    wallets.forEach(function(candidate) {
      var features = candidate && candidate.features;
      if (!features || !features["standard:connect"] || !features["solana:signMessage"] ||
          !(features["solana:signTransaction"] || features["solana:signAndSendTransaction"])) return;
      if (wallet.standard.indexOf(candidate) < 0) wallet.standard.push(candidate);
    });
    return function() {};
  }

  function discoverWallets() {
    if (typeof global.addEventListener !== "function" || typeof global.CustomEvent !== "function") return;
    var api = { register: registerStandardWallets };
    global.addEventListener("wallet-standard:register-wallet", function(event) {
      try { event.detail(api); } catch (error) { /* a broken wallet is skipped */ }
    });
    try {
      global.dispatchEvent(new global.CustomEvent("wallet-standard:app-ready", { detail: api }));
    } catch (error) {
      /* No wallets. */
    }
  }

  function preferredWallet() {
    var named = function(name) {
      return wallet.standard.find(function(candidate) { return /phantom/i.test(candidate.name); });
    };
    return named() || wallet.standard[0] || null;
  }

  async function connectProvider(silent) {
    var provider = wallet.provider || preferredWallet();
    if (!provider) return null;
    var result = await provider.features["standard:connect"].connect(silent ? { silent: true } : undefined);
    var accounts = (result && result.accounts) || provider.accounts || [];
    var account = wallet.address ?
      accounts.find(function(candidate) { return candidate.address === wallet.address; }) || accounts[0] :
      accounts[0];
    if (!account) return null;
    wallet.provider = provider;
    wallet.account = account;
    return account;
  }

  function applyWalletSummary(summary) {
    if (!summary) return;
    wallet.address = summary.wallet || wallet.address;
    wallet.name = summary.name || wallet.name;
    /* a vault summary (/v1/escrow) */
    if (typeof summary.enabled === "boolean") {
      wallet.enabled = summary.enabled;
      wallet.vault = summary.vault || null;
      wallet.playSession = summary.session || null;
      if (summary.walletLamports === null || typeof summary.walletLamports === "number") {
        wallet.onchainLamports = summary.walletLamports;
      }
    }
    if (wallet.name) {
      /* A wallet plays under its own short name. */
      var profile = currentProfile();
      if (profile.name !== wallet.name) {
        try { savePlayerProfile({ name: wallet.name, style: profile.style }); } catch (error) { /* keep */ }
      }
    }
  }

  function saveWallet() {
    try {
      if (wallet.token) {
        global.localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify({ token: wallet.token, address: wallet.address }));
      } else {
        global.localStorage.removeItem(WALLET_STORAGE_KEY);
      }
    } catch (error) {
      /* Sign-in lasts the visit. */
    }
  }

  async function refreshWallet() {
    if (!wallet.token || wallet.refreshing) return;
    wallet.refreshing = true;
    try {
      applyWalletSummary(await fetchJson("/v1/escrow", { method: "GET", headers: walletHeaders() }));
    } catch (error) {
      if (error && error.haloCode === "WALLET_SIGN_IN_REQUIRED") signOutWallet();
    } finally {
      wallet.refreshing = false;
    }
  }

  async function restoreWallet() {
    var saved = null;
    try { saved = JSON.parse(global.localStorage.getItem(WALLET_STORAGE_KEY)); } catch (error) { saved = null; }
    if (!saved || typeof saved.token !== "string") return;
    wallet.token = saved.token;
    wallet.address = saved.address || null;
    try {
      applyWalletSummary(await fetchJson("/v1/escrow", { method: "GET", headers: walletHeaders() }));
    } catch (error) {
      if (error && error.haloCode === "WALLET_SIGN_IN_REQUIRED") {
        wallet.token = null;
        wallet.address = null;
        saveWallet();
      }
    }
  }

  async function signInWithWallet() {
    if (wallet.busy) return;
    if (!preferredWallet()) {
      setWalletStatus("No Solana wallet found. Install Phantom (or another Solana wallet), then reload.", "error");
      return;
    }
    wallet.busy = true;
    setWalletStatus("Approve the connection in your wallet…");
    try {
      var account = await connectProvider(false);
      if (!account) throw new Error("The wallet shared no account.");
      wallet.address = account.address;
      var challenge = await fetchJson("/v1/auth/challenge", {
        method: "POST",
        body: JSON.stringify({ wallet: account.address }),
      });
      setWalletStatus("Sign the message in your wallet to sign in…");
      var signed = await wallet.provider.features["solana:signMessage"].signMessage({
        account: account,
        message: new TextEncoder().encode(challenge.message),
      });
      var output = Array.isArray(signed) ? signed[0] : signed;
      var result = await fetchJson("/v1/auth/verify", {
        method: "POST",
        body: JSON.stringify({ wallet: account.address, nonce: challenge.nonce, signature: base58(output.signature) }),
      });
      wallet.token = result.token;
      applyWalletSummary(result);
      saveWallet();
      await refreshWallet();
      setWalletStatus("Signed in as " + wallet.name + ".");
    } catch (error) {
      setWalletStatus((error && error.message) || "Wallet sign-in failed.", "error");
    } finally {
      wallet.busy = false;
    }
  }

  function signOutWallet() {
    wallet.token = null;
    wallet.address = null;
    wallet.account = null;
    wallet.name = null;
    wallet.vault = null;
    wallet.playSession = null;
    saveWallet();
    setWalletStatus("Signed out.");
  }

  /* ---------- the vault (services/escrow; services/signaling/src/vault.ts)

     Load up is one wallet prompt: open the vault (the first time), deposit,
     and approve a day's play session, which lets the game stake up to
     SESSION_LIMIT_LAMPORTS of the vault in matches. Withdraw sends the free
     balance back to the wallet. The Worker builds each transaction; the
     wallet signs and sends it. */

  var LOAD_UP_CHOICES = [50000000, 100000000, 250000000];
  var SESSION_LIMIT_LAMPORTS = 500000000;

  function playSessionLeft() {
    var session_ = wallet.playSession;
    return session_ ? Math.max(0, session_.limit - session_.spent) : 0;
  }

  /* Why this wallet cannot stake `stake` yet, or null when it can. */
  function stakeBlocker(stake) {
    if (!wallet.token) return "Connect a wallet to play for SOL.";
    if (!wallet.enabled) return "Playing for SOL is not set up on this server.";
    if (!wallet.vault || wallet.vault.free < stake) return "Load up your vault to play for SOL.";
    if (!wallet.playSession || playSessionLeft() < stake) return "Approve a new play session to keep playing for SOL.";
    return null;
  }

  /* The wallet signs; the Worker sends it to the game's cluster, whatever
     network the wallet itself is set to (Phantom on mainnet would send a
     devnet transaction to mainnet, where it fails). */
  async function signAndSend(transaction) {
    var account = wallet.account || await connectProvider(true) || await connectProvider(false);
    if (!account) throw new Error("Reconnect your wallet.");
    var signer = wallet.provider.features["solana:signTransaction"];
    if (signer) {
      var signed = await signer.signTransaction({ account: account, chain: WALLET_CHAIN, transaction: fromBase64(transaction) });
      var signedOutput = Array.isArray(signed) ? signed[0] : signed;
      var bytes = signedOutput.signedTransaction;
      var binary = "";
      for (var index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
      var submitted = await fetchJson("/v1/escrow/submit", {
        method: "POST",
        headers: walletHeaders(),
        body: JSON.stringify({ transaction: global.btoa(binary) }),
      });
      return submitted.signature;
    }
    var sent = await wallet.provider.features["solana:signAndSendTransaction"].signAndSendTransaction({
      account: account,
      chain: WALLET_CHAIN,
      transaction: fromBase64(transaction),
    });
    var output = Array.isArray(sent) ? sent[0] : sent;
    return base58(output.signature);
  }

  /* Waits (up to a minute) for the vault to show a change. */
  async function awaitVault(changed) {
    for (var attempt = 0; attempt < 30; attempt++) {
      await new Promise(function(resolve) { global.setTimeout(resolve, 2000); });
      await refreshWallet();
      if (changed()) return true;
    }
    return false;
  }

  async function loadUp(deposit) {
    if (wallet.busy || !wallet.token) return false;
    wallet.busy = true;
    var before = wallet.vault ? wallet.vault.free : -1;
    try {
      setWalletStatus(deposit > 0 ? "Approve the " + formatSol(deposit) + " SOL load-up in your wallet…" :
        "Approve the play session in your wallet…");
      var prepared = await fetchJson("/v1/escrow/load", {
        method: "POST",
        headers: walletHeaders(),
        body: JSON.stringify({ deposit: deposit, limit: SESSION_LIMIT_LAMPORTS }),
      });
      await signAndSend(prepared.transaction);
      setWalletStatus("Sent. Waiting for Solana to confirm…");
      var done = await awaitVault(function() {
        return !!wallet.playSession && (deposit === 0 || (wallet.vault && wallet.vault.free > before));
      });
      setWalletStatus(done ? "Loaded up. You're ready to play for SOL." :
        "Still confirming; your balance updates when it does.", done ? null : "error");
      return done;
    } catch (error) {
      setWalletStatus((error && error.message) || "The load-up failed.", "error");
      return false;
    } finally {
      wallet.busy = false;
    }
  }

  async function withdrawVault() {
    if (wallet.busy || !wallet.token || !wallet.vault || wallet.vault.free <= 0) return;
    wallet.busy = true;
    var before = wallet.vault.free;
    try {
      setWalletStatus("Approve the withdrawal in your wallet…");
      var prepared = await fetchJson("/v1/escrow/withdraw", {
        method: "POST",
        headers: walletHeaders(),
        body: JSON.stringify({ lamports: "all" }),
      });
      await signAndSend(prepared.transaction);
      setWalletStatus("Sent. Waiting for Solana to confirm…");
      var done = await awaitVault(function() { return wallet.vault && wallet.vault.free < before; });
      setWalletStatus(done ? "Withdrawn to your wallet." : "Still confirming; your balance updates when it does.");
    } catch (error) {
      setWalletStatus((error && error.message) || "The withdrawal failed.", "error");
    } finally {
      wallet.busy = false;
    }
  }

  /* The load-up modal: connect, then pick an amount. `reason` says why it
     opened (a wagered playlist the wallet cannot stake in yet). */
  function openLoadUp(reason) {
    lobbyElement("wallet-gate").hidden = false;
    lobby.loadUpReason = reason || null;
    setWalletStatus("");
    renderLoadUp();
  }

  function renderLoadUp() {
    var gate = lobbyElement("wallet-gate");
    if (!gate || gate.hidden) return;
    var connect = lobbyElement("wallet-gate-connect");
    var amounts = lobbyElement("wallet-gate-amounts");
    var renew = lobbyElement("wallet-gate-renew");
    connect.hidden = !!wallet.token;
    connect.disabled = wallet.busy;
    amounts.hidden = !wallet.token;
    Array.prototype.forEach.call(amounts.querySelectorAll("button"), function(button) {
      var lamports = Number(button.dataset.lamports);
      button.disabled = wallet.busy || (wallet.onchainLamports !== null && wallet.onchainLamports < lamports + 5000000);
    });
    /* a funded vault whose session ran out needs only a new session */
    var needsSessionOnly = !!wallet.token && !!wallet.vault && wallet.vault.free > 0 && playSessionLeft() <= 0;
    renew.hidden = !needsSessionOnly;
    renew.disabled = wallet.busy;
    var reason = lobbyElement("wallet-gate-reason");
    /* why it opened, kept current: connecting answers "connect a wallet" */
    var wagered = selectedPlaylist().wager;
    var text = lobby.loadUpReason ? (wagered ? stakeBlocker(wagered.stake) || "" : "") : "";
    if (reason.textContent !== text) reason.textContent = text;
    var funds = lobbyElement("wallet-gate-funds");
    var fundsText = wallet.token && wallet.onchainLamports !== null ?
      "Your wallet: " + formatSol(wallet.onchainLamports) + " SOL" +
        (wallet.onchainLamports < LOAD_UP_CHOICES[0] + 5000000 ? " — get devnet SOL at faucet.solana.com" : "") : "";
    if (funds.textContent !== fundsText) funds.textContent = fundsText;
  }

  function renderWallet(inMatch) {
    if (!WALLET_ENABLED) return;
    var out = lobbyElement("lobby-wallet-out");
    var signedIn = lobbyElement("lobby-wallet-in");
    var chip = lobbyElement("lobby-wallet-chip");
    if (out) out.hidden = !!wallet.token;
    if (chip) chip.hidden = !wallet.token;
    if (signedIn) signedIn.hidden = !wallet.token || !lobby.walletOpen;
    if (chip) chip.setAttribute("aria-expanded", wallet.token && lobby.walletOpen ? "true" : "false");
    var setText = function(id, text) {
      var element = lobbyElement(id);
      if (element && element.textContent !== text) element.textContent = text;
    };
    setText("lobby-wallet-name", wallet.name || "");
    setText("lobby-wallet-chip-name", wallet.name || "");
    setText("lobby-wallet-chip-balance", wallet.vault ? formatSol(wallet.vault.free) : "0.000");
    var vault = wallet.vault;
    setText("lobby-wallet-balance", (vault ? formatSol(vault.free) : "0.000") + " SOL");
    var lockedRow = lobbyElement("lobby-wallet-locked-row");
    if (lockedRow) lockedRow.hidden = !(vault && vault.locked > 0);
    setText("lobby-wallet-locked", vault ? formatSol(vault.locked) + " SOL" : "");
    setText("lobby-wallet-onchain", wallet.onchainLamports === null ? "…" : formatSol(wallet.onchainLamports) + " SOL");
    var sessionText = "No play session";
    if (wallet.playSession) {
      var hours = Math.max(0, Math.round((wallet.playSession.expiresAt * 1000 - Date.now()) / 3600000));
      sessionText = "Session: " + formatSol(wallet.playSession.spent) + " of " + formatSol(wallet.playSession.limit) +
        " staked · " + hours + "h left";
    }
    setText("lobby-wallet-session", sessionText);
    var load = lobbyElement("lobby-wallet-load");
    if (load) load.disabled = wallet.busy || !wallet.enabled;
    var withdraw = lobbyElement("lobby-wallet-withdraw");
    if (withdraw) withdraw.disabled = wallet.busy || !vault || vault.free <= 0;
    var gate = lobbyElement("wallet-gate");
    var gateOpen = gate && !gate.hidden;
    ["lobby-wallet-status", "wallet-gate-status"].forEach(function(id) {
      var status = lobbyElement(id);
      if (!status) return;
      /* The modal speaks while it is open; the corner otherwise. */
      var text = (id === "wallet-gate-status") === !!gateOpen ? wallet.status : "";
      if (status.textContent !== text) status.textContent = text;
      if (wallet.tone) status.dataset.tone = wallet.tone;
      else delete status.dataset.tone;
    });
    renderLoadUp();
    renderWagerResult();
    var nameInput = lobbyElement("lobby-name");
    if (nameInput) nameInput.disabled = !!wallet.token;
    /* in a wagered match: this player's running total, by the HUD */
    var hud = lobbyElement("hud-balance");
    if (hud) {
      var mine = inMatch && lobby.wager && !lobby.wager.done ? myWagerLine() : null;
      hud.hidden = !mine;
      if (mine && lobby.wager.mode === "team") {
        /* pot against pot: nothing moves until the winner is known */
        setText("hud-balance-amount", formatSol(lobby.wager.stake) + " in");
        if (hud.dataset.tone !== "even") hud.dataset.tone = "even";
        setText("hud-balance-note", "team pot " + formatSol(lobby.wager.view.pot) + " · winners take it");
      } else if (mine) {
        setText("hud-balance-amount", formatSigned(mine.net));
        var tone = mine.spent ? "spent" : mine.net > 0 ? "up" : mine.net < 0 ? "down" : "even";
        if (hud.dataset.tone !== tone) hud.dataset.tone = tone;
        setText("hud-balance-note", mine.spent ? "playing for pride" : "pot " + formatSol(lobby.wager.view.pot));
      }
    }
  }

  /* ---------- the wagered match (services/signaling/src/wager.ts)

     While a wagered match runs, the room sends each kill's new balances
     ("wager" messages); after it, the lobby follows the match until it is
     settled (or void) on chain and shows the result. */

  function myWagerLine() {
    var wager = lobby.wager;
    var name = (session.profile && session.profile.name) || wallet.name;
    if (!wager || !wager.view || !name) return null;
    for (var index = 0; index < wager.view.players.length; index++) {
      if (wager.view.players[index].name === name) return wager.view.players[index];
    }
    return null;
  }

  function startWager(match) {
    lobby.wager = {
      matchId: match.id,
      stake: match.wager.stake,
      perKill: match.wager.perKill,
      mode: match.wager.mode || "bounty",
      label: (playlistById(lobby.queue && lobby.queue.playlist) || { label: "Wagered match" }).label,
      view: null,
      done: false,
      polledAt: 0,
    };
    lobby.wagerResult = null;
  }

  function applyWagerView(view) {
    if (!lobby.wager || !view || view.matchId !== lobby.wager.matchId) return;
    lobby.wager.view = view;
    publishWagerTable();
  }

  /* The scoreboard's SOL column (port/web/src/web_online_ui.c): each
     player's name and running total, and the pot, written where the game
     reads them; an empty table outside a wagered match. */
  var WAGER_TABLE_ROWS = 16;
  function writeAscii(base, offset, text, size) {
    for (var index = 0; index < size; index++) {
      var code = index < text.length ? text.charCodeAt(index) : 0;
      HEAPU8[base + offset + index] = index === size - 1 || code > 127 ? 0 : code;
    }
  }

  function publishWagerTable() {
    var commit = global.Module && global.Module._platform_web_wager_commit;
    var base = wasmNumber("platform_web_wager_staging", 0);
    if (typeof commit !== "function" || !base || typeof HEAPU8 === "undefined") return;
    var view = session.active && lobby.wager && !lobby.wager.done ? lobby.wager.view : null;
    var key = view ? JSON.stringify(view.players.map(function(player) { return [player.name, player.balance]; })) : "";
    if (lobby.wagerTableKey === key) return;
    lobby.wagerTableKey = key;
    if (!view) {
      commit(0);
      return;
    }
    var players = view.players.slice(0, WAGER_TABLE_ROWS);
    players.forEach(function(player, index) {
      writeAscii(base, index * 24, player.name, 12);
      /* a team match: each player's stake in the pot; a bounty match: their
         running total */
      writeAscii(base, index * 24 + 12, view.mode === "team" ? formatSol(view.stake) :
        player.balance <= 0 ? "spent" : formatSigned(player.net), 12);
    });
    /* the pot, under the SOL column (Halo clips each column at the next) */
    writeAscii(base, WAGER_TABLE_ROWS * 24, formatSol(view.pot), 48);
    commit(players.length);
  }

  /* During the match: the balances, every few seconds (each kill's
     "wager" message updates them sooner). After it: follow the match to its
     settlement, every couple of seconds for up to three minutes. */
  function tickWager() {
    var wager = lobby.wager;
    if (!wager || wager.done || wager.polling) return;
    if (session.active) {
      wager.joined = true;
      wager.endedAt = 0;
      if (Date.now() - wager.polledAt < 5000) return;
      wager.polling = true;
      wager.polledAt = Date.now();
      fetchJson("/v1/wagers/" + encodeURIComponent(wager.matchId), { method: "GET" })
        .then(function(result) { applyWagerView(result.wager); })
        .catch(function() { /* the next tick tries again */ })
        .then(function() { wager.polling = false; });
      return;
    }
    /* not in it yet: the match is still being joined */
    if (!wager.joined) return;
    publishWagerTable();
    if (!wager.endedAt) wager.endedAt = Date.now();
    if (Date.now() - wager.polledAt < 2000) return;
    if (Date.now() - wager.endedAt > 180000) {
      wager.done = true;
      return;
    }
    wager.polling = true;
    wager.polledAt = Date.now();
    fetchJson("/v1/wagers/" + encodeURIComponent(wager.matchId), { method: "GET" })
      .then(function(result) {
        applyWagerView(result.wager);
        var state = result.wager && result.wager.state;
        if (state === "settled" || state === "void" || state === "failed") {
          wager.done = true;
          lobby.wagerResult = { label: wager.label, view: result.wager, line: myWagerLine() };
          refreshWallet();
        }
      })
      .catch(function() { /* the next tick tries again */ })
      .then(function() { wager.polling = false; });
  }

  function explorerLink(signature, cluster) {
    return "https://explorer.solana.com/tx/" + encodeURIComponent(signature) +
      (cluster && cluster !== "mainnet-beta" && cluster !== "mainnet" ? "?cluster=" + encodeURIComponent(cluster) : "");
  }

  function renderWagerResult() {
    var box = lobbyElement("lobby-wager-result");
    if (!box) return;
    var result = lobby.wagerResult;
    var pending = lobby.wager && lobby.wager.joined && !lobby.wager.done && !session.active && lobby.wager.endedAt;
    var key = result ? result.view.matchId + ":" + result.view.state : pending ? "pending:" + lobby.wager.matchId : "";
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.hidden = !key;
    box.replaceChildren();
    if (pending) {
      box.dataset.tone = "even";
      box.append(lobby.wager.label + ": settling on Solana…");
      return;
    }
    if (!result) return;
    var view = result.view;
    var line = result.line;
    var title = document.createElement("strong");
    var detail = document.createElement("small");
    if (view.state === "settled" && line) {
      var won = (line.payout === null ? line.balance : line.payout) - view.stake;
      title.textContent = formatSigned(won) + " SOL";
      box.dataset.tone = won > 0 ? "up" : won < 0 ? "down" : "even";
      var teamLine = view.mode === "team" && view.winningTeam !== null ?
        (view.winningTeam === 0 ? "Red" : "Blue") + " team won · " : "";
      detail.append(result.label + " · " + teamLine + line.kills + " kills, " + line.deaths + " deaths · ");
    } else if (view.state === "void") {
      title.textContent = "Stake returned";
      box.dataset.tone = "even";
      detail.append(result.label + " didn't finish, so everyone got their stake back · ");
    } else {
      title.textContent = "Stakes not locked";
      box.dataset.tone = "even";
      detail.append(result.label + " was called off before it started; nothing was staked.");
    }
    var signature = view.signatures && (view.signatures.settle || view.signatures["void"]);
    if (signature) {
      var link = document.createElement("a");
      link.href = explorerLink(signature, view.cluster);
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = (view.state === "settled" ? "Settled" : "Returned") + " on Solana ✓";
      detail.appendChild(link);
    }
    box.append(title, detail);
  }

  /* A dedicated host reports every kill (by the players' names) so the
     room service moves the wager between their wallets. */
  function reportHostKills() {
    if (!session.active || session.role !== "host" || !session.dedicated) return;
    var sequence = wasmNumber("platform_web_host_kill_sequence", 0);
    if (lobby.hostKillsSeen === undefined || lobby.hostKillsSeen > sequence) lobby.hostKillsSeen = sequence;
    if (sequence === lobby.hostKillsSeen || typeof HEAPU8 === "undefined") return;
    var base = wasmNumber("platform_web_host_kills", 0);
    if (!base) return;
    var readName = function(offset) {
      var text = "";
      for (var index = 0; index < 12; index++) {
        var code = HEAPU8[offset + index];
        if (!code) break;
        text += String.fromCharCode(code);
      }
      return text;
    };
    /* At most the last 32 are kept. */
    if (sequence - lobby.hostKillsSeen > 32) lobby.hostKillsSeen = sequence - 32;
    while (lobby.hostKillsSeen < sequence) {
      var slot = base + (lobby.hostKillsSeen % 32) * 24;
      var killer = readName(slot);
      var victim = readName(slot + 12);
      lobby.hostKillsSeen++;
      if (!killer || !victim) continue;
      try {
        sendSocket({ v: PROTOCOL_VERSION, type: "kill", killer: killer, victim: victim });
      } catch (error) {
        /* The socket is reconnecting; this kill goes unreported. */
      }
    }
  }

  /* ---------- Bounties: in a wagered match, "+0.010 SOL" over the body of
     each kill this player makes the moment it happens (the bounty the room
     then moves), and "\u22120.010" on their own death. */

  var KILL_REWARD_UNIT = "SOL";
  var KILL_POP_MILLISECONDS = 1700;
  var DEATH_POP_MILLISECONDS = 2600;

  /* the bounty a kill or death pops, or null outside a wagered match */
  function bountyLamports() {
    /* a team match's money follows only its result */
    if (!session.active || !lobby.wager || lobby.wager.done || lobby.wager.mode === "team") return null;
    return lobby.wager.perKill || null;
  }
  var killPops = { last: -1, lastDeath: -1, active: [] };

  function makePop(className, text) {
    var element = document.createElement("div");
    element.className = className;
    var label = document.createElement("span");
    label.textContent = text;
    var unit = document.createElement("small");
    unit.textContent = KILL_REWARD_UNIT;
    label.appendChild(unit);
    element.appendChild(label);
    return element;
  }

  function wasmNumber(name, fallback) {
    try {
      var fn = global.Module && global.Module["_" + name];
      return typeof fn === "function" ? fn() : fallback;
    } catch (error) {
      return fallback;
    }
  }

  /* Where the game's picture is on the page: it is drawn at its own shape,
     centered in the canvas. */
  function gamePictureRect() {
    var canvas = byId("canvas");
    if (!canvas || typeof canvas.getBoundingClientRect !== "function") return null;
    var box = canvas.getBoundingClientRect();
    var aspect = wasmNumber("platform_web_screen_width", 640) / 480;
    var width = Math.min(box.width, box.height * aspect);
    var height = width / aspect;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width: width, height: height };
  }

  function placeKillPop(pop, now) {
    var rect = gamePictureRect();
    if (!rect) return;
    if (pop.death) {
      /* The death cam: centered, a little above the middle. */
      pop.element.style.left = (rect.left + 0.5 * rect.width) + "px";
      pop.element.style.top = (rect.top + 0.42 * rect.height) + "px";
      return;
    }
    /* The body while it is on screen; otherwise above the crosshair. */
    var onScreen = wasmNumber("platform_web_kill_sequence", 0) === pop.sequence &&
      wasmNumber("platform_web_kill_on_screen", 0) === 1;
    if (onScreen) {
      pop.x = wasmNumber("platform_web_kill_x", 5000) / 10000;
      pop.y = wasmNumber("platform_web_kill_y", 4000) / 10000;
    } else if (pop.x === undefined) {
      pop.x = 0.5;
      pop.y = 0.4;
    }
    pop.element.style.left = (rect.left + pop.x * rect.width) + "px";
    pop.element.style.top = (rect.top + pop.y * rect.height) + "px";
  }

  function tickKillPops(now) {
    var sequence = wasmNumber("platform_web_kill_sequence", 0);
    var container = byId("kill-pops");
    var bounty = bountyLamports();
    if (killPops.last < 0) killPops.last = sequence;
    if (sequence !== killPops.last && container && typeof document.createElement === "function") {
      killPops.last = sequence;
      if (bounty !== null) {
        var element = makePop("kill-pop", formatSigned(bounty));
        container.appendChild(element);
        killPops.active.push({ element: element, sequence: sequence, born: now });
      }
    }
    var deaths = wasmNumber("platform_web_death_sequence", 0);
    if (killPops.lastDeath < 0) killPops.lastDeath = deaths;
    if (deaths !== killPops.lastDeath && container && typeof document.createElement === "function") {
      killPops.lastDeath = deaths;
      var mine = myWagerLine();
      /* nothing left to lose: no pop */
      if (bounty !== null && !(mine && mine.balance <= 0)) {
        var deathElement = makePop("kill-pop death", formatSigned(-bounty));
        container.appendChild(deathElement);
        killPops.active.push({ element: deathElement, death: true, born: now });
      }
    }
    killPops.active = killPops.active.filter(function(pop) {
      if (now - pop.born > (pop.death ? DEATH_POP_MILLISECONDS : KILL_POP_MILLISECONDS)) {
        if (pop.element.parentNode) pop.element.parentNode.removeChild(pop.element);
        return false;
      }
      placeKillPop(pop, now);
      return true;
    });
    if (typeof global.requestAnimationFrame === "function") global.requestAnimationFrame(tickKillPops);
  }

  function installLobby() {
    var root = lobbyElement("lobby");
    if (!root || lobby.installed) return;
    lobby.installed = true;
    root.addEventListener("keydown", function(event) { event.stopPropagation(); });
    lobbyElement("lobby-play").addEventListener("click", function() {
      var custom = lobbyKind() === "custom";
      var view = partyView();
      if (!session.active) {
        /* a custom game is a party's */
        if (custom && !view) {
          setPartyStatus("Custom games are for parties: start one and invite your friends.");
          openPartyDialog();
          return;
        }
        /* in a party, the leader starts and stops */
        if (view && !view.leader) return;
        if (view && (lobby.wantsPlay || (lobby.queue && lobby.queue.party))) {
          lobby.wantsPlay = false;
          lobby.started = false;
          if (lobby.queue && lobby.queue.state === "queued") stopParty();
          return;
        }
        if (view && custom) {
          startParty();
          return;
        }
      }
      /* a wagered playlist: load up first, if the vault cannot stake yet */
      var wagered = custom ? null : selectedPlaylist().wager;
      if (WALLET_ENABLED && wagered && !session.active && !lobby.wantsPlay) {
        var blocker = stakeBlocker(wagered.stake);
        if (blocker) {
          openLoadUp(blocker);
          return;
        }
      }
      if (session.active || lobby.wantsPlay) {
        lobby.wantsPlay = false;
        cancelQueue();
        lobby.error = null;
        if (lobby.rejoinTimer) global.clearTimeout(lobby.rejoinTimer);
        lobby.rejoinTimer = 0;
        lobby.rejoinAttempts = 0;
        leave(false);
        return;
      }
      lobby.wantsPlay = true;
      lobby.error = null;
      lobby.started = false;
    });
    /* the playlist picker */
    var playlistDialog = lobbyElement("playlist-dialog");
    /* Halo 3's lights of the world at night: where its cities are */
    var lights = lobbyElement("lobby-world-lights");
    if (lights && !lights.firstChild) {
      [[17, 34], [19, 31], [22, 36], [24, 33], [26, 30], [21, 41], [15, 38], [12, 30], [28, 35], [25, 45],
        [31, 64], [33, 74], [29, 58], [47, 28], [49, 25], [51, 30], [53, 27], [46, 33], [55, 33], [57, 30],
        [50, 45], [53, 55], [57, 70], [63, 42], [67, 47], [71, 40], [74, 35], [77, 33], [79, 38], [83, 31],
        [81, 45], [76, 52], [84, 76], [88, 79], [86, 70], [60, 36], [44, 36], [18, 45], [35, 70], [70, 55]]
        .forEach(function(point, index) {
          var light = document.createElement("i");
          light.style.left = point[0] + "%";
          light.style.top = point[1] + "%";
          light.style.animationDelay = (index % 7) * 0.55 + "s";
          lights.appendChild(light);
        });
    }
    lobbyElement("lobby-options").addEventListener("click", function() {
      if (lobbyKind() === "custom") openChooser("mode");
      else lobbyElement("lobby-playlist-open").click();
    });
    lobbyElement("lobby-switch").addEventListener("click", function() {
      if (session.active || lobby.queue) return;
      var next = lobbyKind() === "custom" ? "matchmaking" : "custom";
      lobby.kind = next;
      if (partyView()) configureParty({ lobby: next });
    });
    lobbyElement("lobby-game-open").addEventListener("click", function() { openChooser("mode"); });
    lobbyElement("lobby-map-open").addEventListener("click", function() { openChooser("map"); });
    lobbyElement("lobby-party-code").addEventListener("click", openPartyDialog);
    lobbyElement("choice-dialog-close").addEventListener("click", function() { lobbyElement("choice-dialog").close(); });
    lobbyElement("party-dialog-close").addEventListener("click", function() { lobbyElement("party-dialog").close(); });
    lobbyElement("party-create").addEventListener("click", function() { createParty(); });
    lobbyElement("party-join-form").addEventListener("submit", function(event) {
      event.preventDefault();
      joinParty(lobbyElement("party-join-code").value);
    });
    lobbyElement("party-leave").addEventListener("click", function() {
      leaveParty();
      setPartyStatus("You left the party.");
    });
    lobbyElement("party-copy").addEventListener("click", function() {
      var view = partyView();
      if (!view) return;
      var link = inviteLink(view.code);
      var done = function() { setPartyStatus("Invite link copied. Send it to your friends."); };
      try {
        global.navigator.clipboard.writeText(link).then(done, function() { setPartyStatus(link); });
      } catch (error) {
        setPartyStatus(link);
      }
    });
    lobbyElement("party-dialog").addEventListener("keydown", function(event) { event.stopPropagation(); });
    lobbyElement("choice-dialog").addEventListener("keydown", function(event) { event.stopPropagation(); });
    /* a party link (#party=CODE), or the party this browser was in */
    var partyHash = /(?:^#|&)party=([A-Za-z0-9]{6})/.exec(global.location.hash || "");
    var savedParty = null;
    try { savedParty = global.localStorage.getItem(PARTY_STORAGE_KEY); } catch (error) { savedParty = null; }
    /* joined once the game is up: a member carries its network identity */
    if (partyHash) {
      try { global.history.replaceState(null, "", global.location.pathname + global.location.search); } catch (error) { /* keep */ }
      lobby.pendingParty = { code: partyHash[1].toUpperCase(), fromLink: true };
    } else if (savedParty) {
      lobby.pendingParty = { code: savedParty, fromLink: false };
    }
    lobbyElement("lobby-playlist-open").addEventListener("click", function() {
      lobby.playlistFocus = selectedPlaylist().id;
      playlistDialog.showModal();
      lobby.playlistsAt = 0;
      refreshPlaylists();
      renderPlaylistDialog();
    });
    lobbyElement("playlist-dialog-close").addEventListener("click", function() { playlistDialog.close(); });
    lobbyElement("playlist-dialog-select").addEventListener("click", function() {
      choosePlaylist(lobby.playlistFocus || selectedPlaylist().id);
      playlistDialog.close();
    });
    playlistDialog.addEventListener("click", function(event) {
      if (event.target === playlistDialog) playlistDialog.close();
    });
    playlistDialog.addEventListener("keydown", function(event) { event.stopPropagation(); });
    /* the Spartan modal: name, armor and emblem, with a preview */
    var spartanDialog = lobbyElement("spartan-dialog");
    var closeSpartan = function() { if (spartanDialog.open) spartanDialog.close(); };
    lobbyElement("lobby-spartan-toggle").addEventListener("click", function() {
      lobbyElement("lobby-name").value = currentProfile().name;
      renderLobbyColors();
      spartanDialog.showModal();
    });
    lobbyElement("spartan-dialog-close").addEventListener("click", closeSpartan);
    lobbyElement("spartan-dialog-done").addEventListener("click", closeSpartan);
    spartanDialog.addEventListener("click", function(event) {
      /* a click on the backdrop closes it */
      if (event.target === spartanDialog) closeSpartan();
    });
    spartanDialog.addEventListener("keydown", function(event) { event.stopPropagation(); });
    lobbyElement("lobby-name").addEventListener("input", function(event) {
      renderSpartanShowcase(event.target.value);
    });
    lobbyElement("lobby-name").addEventListener("change", function(event) {
      try {
        savePlayerProfile(normalizePlayerProfile({ name: event.target.value, style: currentProfile().style }));
        sendProfileUpdate();
      } catch (error) {
        event.target.value = currentProfile().name;
      }
    });
    discoverWallets();
    if (WALLET_ENABLED) restoreWallet();
    global.setInterval(function() {
      if (WALLET_ENABLED && document.body.dataset.lobby === "open") refreshWallet();
    }, 15000);
    lobbyElement("lobby-wallet-connect").addEventListener("click", function() { signInWithWallet(); });
    /* loaded up for a wagered playlist: search right away */
    var playIfReady = function(loaded) {
      var wagered = selectedPlaylist().wager;
      if (!loaded || !wagered || stakeBlocker(wagered.stake) || session.active || lobby.wantsPlay) return;
      lobbyElement("wallet-gate").hidden = true;
      lobby.wantsPlay = true;
      lobby.error = null;
      lobby.started = false;
    };
    /* already loaded up (a returning player): connecting is enough */
    lobbyElement("wallet-gate-connect").addEventListener("click", function() {
      signInWithWallet().then(function() { playIfReady(true); });
    });
    Array.prototype.forEach.call(lobbyElement("wallet-gate-amounts").querySelectorAll("button"), function(button) {
      button.addEventListener("click", function() { loadUp(Number(button.dataset.lamports)).then(playIfReady); });
    });
    lobbyElement("wallet-gate-renew").addEventListener("click", function() { loadUp(0).then(playIfReady); });
    lobbyElement("wallet-gate-close").addEventListener("click", function() {
      lobbyElement("wallet-gate").hidden = true;
    });
    lobbyElement("lobby-wallet-load").addEventListener("click", function() {
      lobby.walletOpen = false;
      openLoadUp(null);
    });
    lobbyElement("lobby-wallet-chip").addEventListener("click", function(event) {
      event.stopPropagation();
      lobby.walletOpen = !lobby.walletOpen;
      renderWallet(false);
    });
    lobbyElement("lobby-wallet-in").addEventListener("click", function(event) { event.stopPropagation(); });
    document.addEventListener("click", function() {
      if (lobby.walletOpen) {
        lobby.walletOpen = false;
        renderWallet(false);
      }
    });
    lobbyElement("lobby-wallet-withdraw").addEventListener("click", function() { withdrawVault(); });
    lobbyElement("lobby-wallet-signout").addEventListener("click", signOutWallet);
    lobbyElement("lobby-friends").addEventListener("click", function() {
      setPartyStatus("");
      openPartyDialog();
    });
    var prompt = lobbyElement("lobby-deploy");
    prompt.addEventListener("click", deploy);
    prompt.addEventListener("keydown", function(event) {
      if (event.key === "Enter" || event.key === " ") deploy();
    });
    setLobbyVisible(true);
    tickLobby();
    global.setInterval(tickLobby, LOBBY_TICK_MILLISECONDS);
    if (typeof global.requestAnimationFrame === "function") global.requestAnimationFrame(tickKillPops);
  }

  /* Halo admits nobody to a match already started, so leaving the page
     mid-match is for good: the browser asks first, and the refresh keys do
     nothing while a match is on. */
  function inMatch() {
    if (!session.active) return false;
    var state = clientState();
    return state === CLIENT_STATE.PREGAME || state === CLIENT_STATE.INGAME || state === CLIENT_STATE.POSTGAME;
  }

  function guardMatchFromRefresh() {
    global.addEventListener("beforeunload", function(event) {
      if (!inMatch()) return;
      event.preventDefault();
      /* (older browsers show the dialog only for a returnValue) */
      event.returnValue = "";
    });
    global.addEventListener("keydown", function(event) {
      var refresh = event.key === "F5" ||
        ((event.metaKey || event.ctrlKey) && (event.key === "r" || event.key === "R"));
      if (refresh && inMatch()) event.preventDefault();
    }, true);
  }

  function initialize() {
    if (!WALLET_ENABLED) document.body.dataset.wallet = "off";
    guardMatchFromRefresh();
    collectElements();
    restoreHostSettings();
    restorePlayerProfile();
    attachEvents();
    renderRoster();
    setBusy(false);
    installLobby();
    session.pendingInvite = takeInviteFromLocation();
    if (session.pendingInvite) {
      showDialog();
      showJoinConfirmation(session.pendingInvite);
    }
  }

  global.HaloOnline = Object.freeze({
    runtimeReady: function() {
      session.runtimeReady = true;
      setBusy(false);
      try {
        transport();
      } catch (error) {
        fail(error);
        return;
      }
      if (session.pendingInvite) {
        showJoinConfirmation(session.pendingInvite);
      }
    },
    isRuntimeReady: function() { return session.runtimeReady; },
    host: host,
    join: join,
    quickJoin: quickJoin,
    hostDedicated: hostDedicated,
    dedicatedStatus: dedicatedStatus,
    leave: function() { return leave(true); },
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})(typeof window !== "undefined" ? window : null);
