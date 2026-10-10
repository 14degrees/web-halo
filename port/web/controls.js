/* Controls: the player's key bindings, the dialog that changes them, the
   page's key legends, and short tips the first time a player is in a match.

   The game reads its keyboard and mouse through a key map
   (port/linux/src/xinput_sdl.c): two inputs per action, each a scancode, a
   mouse button or the wheel. This file keeps the player's choices in the
   browser and hands every slot to the game thread through
   platform_web_set_key_binding (atomics it reads on the next input poll),
   when the runtime comes up and on every change, so a rebind is felt
   mid-match. Keys are kept by KeyboardEvent.code, the physical key, which is
   what SDL reads too, so a binding means the same key on any layout.

   A few keys are not the player's to bind: Esc (the menu), F1 (the scores
   too), Enter and Backspace (the menus' A and B), Y (chat.js's composer),
   backquote (the console) and F12 (the mouse). Ctrl and the Windows or
   Command key make browser shortcuts with other keys (Ctrl+W closes the
   tab), so they are refused too.

   Tips: one line at a time over the game, during a match, naming the
   player's own keys. Each goes once it has been shown for a while, once the
   player does what it says, or when they close it; it is then remembered
   and not shown again. The dialog can turn them off or show them again. */

;(function installHaloControls(global) {
  "use strict";

  if (!global || global.HaloControls) return;

  var BINDINGS_STORAGE_KEY = "halo.web.key-bindings.v1";
  var TIPS_STORAGE_KEY = "halo.web.tips.v1";
  var SLOTS = 2;

  /* the key map's actions, in its order (xinput_sdl.c, KEY_ACTION_*): the
     index is what platform_web_set_key_binding takes */
  var ACTIONS = [
    { id: "moveForward", label: "Move forward", group: "Movement", defaults: ["KeyW", null] },
    { id: "moveBack", label: "Move back", group: "Movement", defaults: ["KeyS", null] },
    { id: "moveLeft", label: "Strafe left", group: "Movement", defaults: ["KeyA", null] },
    { id: "moveRight", label: "Strafe right", group: "Movement", defaults: ["KeyD", null] },
    { id: "jump", label: "Jump", group: "Movement", defaults: ["Space", null] },
    { id: "melee", label: "Melee", group: "Combat", defaults: ["KeyF", "Mouse4"] },
    { id: "action", label: "Reload / action", group: "Combat", defaults: ["KeyE", "KeyR"] },
    { id: "switchWeapon", label: "Switch weapon", group: "Combat", defaults: ["KeyQ", "Wheel"] },
    { id: "flashlight", label: "Flashlight", group: "Other", defaults: ["KeyT", null] },
    { id: "switchGrenade", label: "Switch grenades", group: "Combat", defaults: ["KeyX", null] },
    { id: "grenade", label: "Throw grenade", group: "Combat", defaults: ["KeyG", "Mouse3"] },
    { id: "fire", label: "Fire", group: "Combat", defaults: ["Mouse1", null] },
    { id: "crouch", label: "Crouch", group: "Movement", defaults: ["KeyC", null] },
    { id: "zoom", label: "Zoom", group: "Combat", defaults: ["KeyZ", "Mouse2"] },
    { id: "dpadUp", label: "D-pad up", group: "Other", defaults: ["ArrowUp", null] },
    { id: "dpadDown", label: "D-pad down", group: "Other", defaults: ["ArrowDown", null] },
    { id: "dpadLeft", label: "D-pad left", group: "Other", defaults: ["ArrowLeft", null] },
    { id: "dpadRight", label: "D-pad right", group: "Other", defaults: ["ArrowRight", null] },
    { id: "scores", label: "Scoreboard", group: "Other", defaults: ["Tab", null] },
  ];
  var ACTION_INDEX = {};
  ACTIONS.forEach(function(action, index) { ACTION_INDEX[action.id] = index; });
  var GROUPS = ["Movement", "Combat", "Other"];

  /* the key map's inputs (xinput_sdl.c, KEY_INPUT_*) */
  var INPUT_NONE = -1;
  var INPUT_MOUSE_BUTTON = 1000;
  var INPUT_WHEEL = 1100;

  /* KeyboardEvent.code to SDL scancode (the USB HID usage) */
  var SCANCODES = (function() {
    var table = {
      Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
      BracketLeft: 47, BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53,
      Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
      PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75, Delete: 76,
      End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83,
      NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88,
      Numpad0: 98, NumpadDecimal: 99, IntlBackslash: 100, ContextMenu: 101,
      ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
      ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
    };
    var letter;
    for (letter = 0; letter < 26; letter++) table["Key" + String.fromCharCode(65 + letter)] = 4 + letter;
    for (letter = 1; letter <= 9; letter++) table["Digit" + letter] = 29 + letter;
    table.Digit0 = 39;
    for (letter = 1; letter <= 12; letter++) table["F" + letter] = 57 + letter;
    for (letter = 1; letter <= 9; letter++) table["Numpad" + letter] = 88 + letter;
    return Object.freeze(table);
  })();

  /* not the player's to bind, and why */
  var RESERVED = Object.freeze({
    Escape: "Esc always opens the menu.",
    F1: "F1 always shows the scores.",
    Enter: "Enter is the menus' select key.",
    NumpadEnter: "Enter is the menus' select key.",
    Backspace: "Backspace is the menus' back key.",
    KeyY: "Y opens chat.",
    Backquote: "` opens the console.",
    F12: "F12 frees and captures the mouse.",
  });
  var BROWSER_SHORTCUT_KEYS = Object.freeze({
    ControlLeft: true, ControlRight: true, MetaLeft: true, MetaRight: true,
  });
  /* the keys the dialog lists as fixed (chat.js owns Y) */
  var FIXED_KEYS = [
    { key: "Esc", label: "Menu" },
    { key: "F1", label: "Scoreboard" },
    { key: "Y", label: "Chat" },
    { key: "Enter / Backspace", label: "Select / back in menus" },
  ];

  var state = {
    /* action id -> [input name or null, ...] */
    bindings: null,
    tips: null,
    listening: null,
    note: null,
    tip: null,
    tipTimer: 0,
    tipStartedAt: 0,
    inGameSince: 0,
    lastTipEndedAt: 0,
    tickTimer: 0,
    runtimeReady: false,
    /* until when the rest of a bound mouse press is swallowed */
    swallowUntil: 0,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  /* ---------- inputs: KeyboardEvent.code names, Mouse1-5 and Wheel */

  function mouseName(button) {
    /* MouseEvent.button: 0 left, 1 middle, 2 right, 3 back, 4 forward;
       SDL_BUTTON_*: 1 left, 2 middle, 3 right, 4 X1, 5 X2 */
    return "Mouse" + (button + 1);
  }

  function validInput(name) {
    if (typeof name !== "string") return false;
    if (name === "Wheel") return true;
    if (/^Mouse[1-5]$/.test(name)) return true;
    return Object.prototype.hasOwnProperty.call(SCANCODES, name);
  }

  function inputCode(name) {
    if (!name) return INPUT_NONE;
    if (name === "Wheel") return INPUT_WHEEL;
    var mouse = /^Mouse([1-5])$/.exec(name);
    if (mouse) return INPUT_MOUSE_BUTTON + Number(mouse[1]);
    return Object.prototype.hasOwnProperty.call(SCANCODES, name) ? SCANCODES[name] : INPUT_NONE;
  }

  var SHORT_LABELS = Object.freeze({
    Mouse1: "LMB", Mouse2: "MMB", Mouse3: "RMB", Mouse4: "Mouse 4", Mouse5: "Mouse 5", Wheel: "Wheel",
    Space: "Space", Tab: "Tab", CapsLock: "Caps", Minus: "-", Equal: "=", BracketLeft: "[",
    BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".",
    Slash: "/", IntlBackslash: "\\", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←",
    ArrowRight: "→", ShiftLeft: "Shift", ShiftRight: "R-Shift", AltLeft: "Alt",
    AltRight: "R-Alt", PageUp: "PgUp", PageDown: "PgDn", Delete: "Del", Insert: "Ins",
    NumpadDivide: "Num /", NumpadMultiply: "Num *", NumpadSubtract: "Num -", NumpadAdd: "Num +",
    NumpadDecimal: "Num .", PrintScreen: "PrtSc", ScrollLock: "ScrLk", NumLock: "NumLk",
    ContextMenu: "Menu",
  });
  /* the tips' wording: "Click to shoot" reads better than "LMB to shoot" */
  var LONG_LABELS = Object.freeze({
    Mouse1: "Click", Mouse2: "Middle click", Mouse3: "Right click", Mouse4: "Mouse 4",
    Mouse5: "Mouse 5", Wheel: "Mouse wheel",
  });

  function inputLabel(name, long) {
    if (!name) return "";
    if (long && LONG_LABELS[name]) return LONG_LABELS[name];
    if (SHORT_LABELS[name]) return SHORT_LABELS[name];
    var match = /^(?:Key|Digit)(.)$/.exec(name);
    if (match) return match[1];
    match = /^Numpad(\d)$/.exec(name);
    if (match) return "Num " + match[1];
    return name;
  }

  /* ---------- the bindings */

  function defaultBindings() {
    var bindings = {};
    ACTIONS.forEach(function(action) { bindings[action.id] = action.defaults.slice(); });
    return bindings;
  }

  /* anything stored that is unknown, reserved or a second use of an input
     falls back to nothing (and a missing action to its default) */
  function normalizeBindings(saved) {
    var bindings = defaultBindings();
    if (!saved || typeof saved !== "object" || !saved.bindings || typeof saved.bindings !== "object") {
      return bindings;
    }
    var used = {};
    ACTIONS.forEach(function(action) {
      var stored = saved.bindings[action.id];
      if (!Array.isArray(stored)) return;
      var slots = [];
      for (var slot = 0; slot < SLOTS; slot++) {
        var name = stored[slot];
        var usable = validInput(name) && !RESERVED[name] && !BROWSER_SHORTCUT_KEYS[name] && !used[name];
        slots.push(usable ? name : null);
        if (usable) used[name] = true;
      }
      bindings[action.id] = slots;
    });
    /* a default kept for a missing action must not repeat a stored input */
    ACTIONS.forEach(function(action) {
      if (Array.isArray(saved.bindings[action.id])) return;
      bindings[action.id] = bindings[action.id].map(function(name) {
        if (!name || used[name]) return null;
        used[name] = true;
        return name;
      });
    });
    return bindings;
  }

  function bindings() {
    if (state.bindings) return state.bindings;
    var saved = null;
    try { saved = JSON.parse(global.localStorage.getItem(BINDINGS_STORAGE_KEY)); } catch (error) { saved = null; }
    state.bindings = normalizeBindings(saved);
    return state.bindings;
  }

  function saveBindings() {
    try {
      global.localStorage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify({ bindings: bindings() }));
    } catch (error) {
      /* a blocked store keeps the bindings for this visit only */
    }
    applyBindings();
    render();
  }

  /* the action (and slot) an input is bound to, if any */
  function boundTo(name) {
    var current = bindings();
    for (var index = 0; index < ACTIONS.length; index++) {
      var slots = current[ACTIONS[index].id];
      for (var slot = 0; slot < slots.length; slot++) {
        if (slots[slot] === name) return { action: ACTIONS[index], slot: slot };
      }
    }
    return null;
  }

  function actionById(id) {
    return Object.prototype.hasOwnProperty.call(ACTION_INDEX, id) ? ACTIONS[ACTION_INDEX[id]] : null;
  }

  /* why an input cannot be bound, or null */
  function refusal(name) {
    if (!validInput(name)) return "That key can't be used in the game.";
    if (RESERVED[name]) return RESERVED[name];
    if (BROWSER_SHORTCUT_KEYS[name]) {
      return "Ctrl and ⌘/Windows make browser shortcuts with other keys (Ctrl+W closes the tab), so they can't be bound.";
    }
    return null;
  }

  /* binds one slot; an input bound elsewhere moves here, and the note says
     what lost it. Returns { ok, note }. */
  function bind(actionId, slot, name) {
    var action = actionById(actionId);
    if (!action || !(slot >= 0 && slot < SLOTS)) return { ok: false, note: "Unknown control." };
    var current = bindings();
    if (name === null) {
      current[actionId][slot] = null;
      state.note = action.label + " " + (slot === 0 ? "primary" : "secondary") + " key cleared.";
      saveBindings();
      return { ok: true, note: state.note };
    }
    var refused = refusal(name);
    if (refused) {
      state.note = refused;
      render();
      return { ok: false, note: refused };
    }
    var previous = boundTo(name);
    var note = inputLabel(name) + " is now " + action.label + ".";
    if (previous && previous.action.id === actionId && previous.slot === slot) {
      state.note = note;
      render();
      return { ok: true, note: note };
    }
    if (previous) {
      current[previous.action.id][previous.slot] = null;
      if (previous.action.id !== actionId) {
        var left = current[previous.action.id].filter(Boolean);
        note = inputLabel(name) + " moved from " + previous.action.label + " to " + action.label + "." +
          (left.length ? "" : " " + previous.action.label + " has no key now.");
      }
    }
    current[actionId][slot] = name;
    state.note = note;
    saveBindings();
    return { ok: true, note: note };
  }

  function resetBindings() {
    state.bindings = defaultBindings();
    state.note = "Controls are back to the defaults.";
    saveBindings();
  }

  /* hands every slot to the game; nothing to do until the runtime is up,
     and runtimeReady calls it then */
  function applyBindings() {
    if (!state.runtimeReady) return;
    var fn = global.Module && global.Module._platform_web_set_key_binding;
    if (typeof fn !== "function") return;
    var current = bindings();
    try {
      ACTIONS.forEach(function(action, index) {
        for (var slot = 0; slot < SLOTS; slot++) fn(index, slot, inputCode(current[action.id][slot]));
      });
    } catch (error) { /* an older build */ }
  }

  /* the labels of an action's inputs; long for the tips' wording */
  function labels(actionId, long) {
    var slots = bindings()[actionId] || [];
    return slots.filter(Boolean).map(function(name) { return inputLabel(name, long); });
  }

  /* the movement keys as one: "WASD" when they are single letters */
  function moveLabel(ids, joined) {
    var keys = ids.map(function(id) { return labels(id)[0] || "?"; });
    if (ids[0] === "dpadUp" && keys.join("") === "↑↓←→") return "Arrows";
    if (keys.every(function(key) { return key.length === 1 && key !== "?"; })) return keys.join("");
    return keys.join(joined);
  }

  /* ---------- the legends: the Duke overlay and the key tips over the game */

  function legendText(spec, long, preferMouse) {
    var ids = spec.split(/\s+/).filter(Boolean);
    if (ids.length === 4) return moveLabel(ids, long ? " " : "");
    var parts = [];
    ids.forEach(function(id) {
      if (id === "F1") parts.push("F1");
      else if (actionById(id)) parts = parts.concat(long ? labels(id, true).slice(0, 1) : labels(id));
    });
    /* the key tips name one input each; a mouse button where preferMouse */
    if (long && preferMouse && ids.length === 1 && actionById(ids[0])) {
      var mouse = (bindings()[ids[0]] || []).filter(function(name) { return name && !SCANCODES[name]; });
      if (mouse.length) parts = [inputLabel(mouse[0], true)];
    }
    return parts.length ? parts.join(" / ") : "Unbound";
  }

  function renderLegends() {
    if (typeof document.querySelectorAll !== "function") return;
    var duke = byId("duke-legend");
    if (duke && typeof duke.querySelectorAll === "function") {
      Array.prototype.forEach.call(duke.querySelectorAll("[data-controls]"), function(row) {
        var text = legendText(row.dataset.controls, false);
        var value = row.querySelector ? row.querySelector("dd") : null;
        if (value) value.textContent = "- " + text;
        var term = row.querySelector ? row.querySelector("dt") : null;
        if (term && typeof row.setAttribute === "function") {
          row.setAttribute("aria-label", (row.dataset.controlsName || term.textContent) + " - " + text);
        }
      });
    }
    var tips = byId("key-tips");
    if (tips && typeof tips.querySelectorAll === "function") {
      Array.prototype.forEach.call(tips.querySelectorAll("[data-controls]"), function(row) {
        var key = row.querySelector ? row.querySelector("dt") : null;
        if (key) key.textContent = legendText(row.dataset.controls, true, row.dataset.controlsPrefer === "mouse");
      });
    }
  }

  /* ---------- the dialog */

  function renderDialog() {
    var list = byId("controls-list");
    if (list && typeof document.createElement === "function" && typeof list.appendChild === "function") {
      while (list.firstChild) list.removeChild(list.firstChild);
      var current = bindings();
      GROUPS.forEach(function(group) {
        var heading = document.createElement("h3");
        heading.textContent = group;
        list.appendChild(heading);
        ACTIONS.forEach(function(action) {
          if (action.group !== group) return;
          var row = document.createElement("div");
          row.className = "controls-row";
          var name = document.createElement("span");
          name.className = "controls-action";
          name.textContent = action.label;
          row.appendChild(name);
          for (var slot = 0; slot < SLOTS; slot++) {
            var input = current[action.id][slot];
            var listening = !!(state.listening && state.listening.action === action.id && state.listening.slot === slot);
            var cell = document.createElement("span");
            cell.className = "controls-slot";
            var button = document.createElement("button");
            button.type = "button";
            button.className = "controls-key";
            button.dataset.action = action.id;
            button.dataset.slot = String(slot);
            button.dataset.listening = listening ? "true" : "false";
            button.textContent = listening ? "Press a key…" : (input ? inputLabel(input) : "—");
            button.title = listening ? "Press a key, click a mouse button or turn the wheel; Esc cancels" :
              "Change " + action.label + (slot === 0 ? "" : " (second key)");
            cell.appendChild(button);
            if (input && !listening) {
              var clear = document.createElement("button");
              clear.type = "button";
              clear.className = "controls-clear";
              clear.dataset.clearAction = action.id;
              clear.dataset.clearSlot = String(slot);
              clear.title = "Clear";
              clear.setAttribute("aria-label", "Clear " + action.label + " " + inputLabel(input));
              clear.textContent = "×";
              cell.appendChild(clear);
            }
            row.appendChild(cell);
          }
          list.appendChild(row);
        });
      });
      var fixedHeading = document.createElement("h3");
      fixedHeading.textContent = "Fixed";
      list.appendChild(fixedHeading);
      FIXED_KEYS.forEach(function(fixed) {
        var row = document.createElement("div");
        row.className = "controls-row controls-fixed";
        var name = document.createElement("span");
        name.className = "controls-action";
        name.textContent = fixed.label;
        var key = document.createElement("span");
        key.className = "controls-key";
        key.textContent = fixed.key;
        row.appendChild(name);
        row.appendChild(key);
        list.appendChild(row);
      });
    }
    var note = byId("controls-note");
    if (note) {
      note.textContent = state.note || "";
      note.hidden = !state.note;
    }
    var tipsSwitch = byId("controls-tips");
    if (tipsSwitch) tipsSwitch.checked = tipsSettings().enabled;
  }

  function render() {
    renderDialog();
    renderLegends();
  }

  function startListening(actionId, slot) {
    state.listening = { action: actionId, slot: slot };
    state.note = null;
    renderDialog();
    focusListeningButton();
  }

  function focusListeningButton() {
    var list = byId("controls-list");
    if (!list || typeof list.querySelector !== "function") return;
    var button = list.querySelector('.controls-key[data-listening="true"]');
    if (button && typeof button.focus === "function") {
      try { button.focus({ preventScroll: true }); } catch (error) { /* no focus */ }
    }
  }

  function stopListening(name) {
    var listening = state.listening;
    state.listening = null;
    if (name && listening) bind(listening.action, listening.slot, name);
    else renderDialog();
    if (listening) {
      /* back on the button that was rebound, for the keyboard's sake */
      var list = byId("controls-list");
      var button = list && typeof list.querySelector === "function" ?
        list.querySelector('.controls-key[data-action="' + listening.action + '"][data-slot="' + listening.slot + '"]') : null;
      if (button && typeof button.focus === "function") {
        try { button.focus({ preventScroll: true }); } catch (error) { /* no focus */ }
      }
    }
  }

  /* While a slot listens, the next key, mouse button or wheel turn is its
     new input; nothing reaches the game, the page or the dialog (Esc
     cancels instead of closing it). Runs ahead of every other listener. */
  function onCapture(event) {
    var type = event.type;
    if (!state.listening) {
      /* the rest of a mouse press that was just bound: its click must not
         start the slot under the pointer listening again */
      if (state.swallowUntil && Date.now() < state.swallowUntil &&
          (type === "mouseup" || type === "click" || type === "auxclick" || type === "contextmenu")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (type === "click" || type === "auxclick") state.swallowUntil = 0;
      }
      return;
    }
    if (type === "keyup" || type === "keypress") {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (type === "keydown") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.code === "Escape" || event.key === "Escape") {
        stopListening(null);
        return;
      }
      stopListening(event.code || null);
      return;
    }
    if (type === "mousedown") {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.swallowUntil = Date.now() + 1000;
      stopListening(mouseName(event.button));
      return;
    }
    if (type === "wheel") {
      event.preventDefault();
      event.stopImmediatePropagation();
      stopListening("Wheel");
      return;
    }
    if (type === "contextmenu") event.preventDefault();
  }

  function openDialog() {
    var dialog = byId("controls-dialog");
    if (!dialog) return;
    state.note = null;
    state.listening = null;
    renderDialog();
    if (dialog.open) return;
    try {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.open = true;
    } catch (error) {
      dialog.open = true;
    }
  }

  function closeDialog() {
    var dialog = byId("controls-dialog");
    state.listening = null;
    if (dialog && dialog.open && typeof dialog.close === "function") dialog.close();
  }

  function installDialog() {
    var opener = byId("spartan-controls");
    if (opener) opener.addEventListener("click", openDialog);
    var dialog = byId("controls-dialog");
    if (!dialog) return;
    var list = byId("controls-list");
    if (list) {
      list.addEventListener("click", function(event) {
        var target = event.target;
        if (!target || !target.dataset) return;
        if (target.dataset.clearAction) {
          bind(target.dataset.clearAction, Number(target.dataset.clearSlot), null);
          return;
        }
        if (target.dataset.action) startListening(target.dataset.action, Number(target.dataset.slot));
      });
    }
    var reset = byId("controls-reset");
    if (reset) reset.addEventListener("click", resetBindings);
    var done = byId("controls-done");
    if (done) done.addEventListener("click", closeDialog);
    var close = byId("controls-close");
    if (close) close.addEventListener("click", closeDialog);
    var tipsSwitch = byId("controls-tips");
    if (tipsSwitch) {
      tipsSwitch.addEventListener("change", function(event) {
        setTipsEnabled(!!event.target.checked);
      });
    }
    var tipsAgain = byId("controls-tips-again");
    if (tipsAgain) {
      tipsAgain.addEventListener("click", function() {
        resetTips();
        state.note = "The tips will show again in your next match.";
        renderDialog();
      });
    }
    dialog.addEventListener("click", function(event) {
      /* a click on the backdrop closes it */
      if (event.target === dialog && !state.listening) closeDialog();
    });
    dialog.addEventListener("close", function() { state.listening = null; });
    /* the lobby's own keys stay out of it */
    dialog.addEventListener("keydown", function(event) { event.stopPropagation(); });
    ["keydown", "keyup", "keypress", "mousedown", "mouseup", "click", "auxclick", "contextmenu"].forEach(function(type) {
      global.addEventListener(type, onCapture, true);
    });
    global.addEventListener("wheel", onCapture, { capture: true, passive: false });
  }

  /* ---------- tips over the game */

  var TIP_DELAY_MILLISECONDS = 12000; /* after the key overview (online_client.js) */
  var TIP_GAP_MILLISECONDS = 6000;
  var TIP_MILLISECONDS = 9000;
  /* a tip shown less than this long is shown again next time, unless the
     player did what it said or closed it */
  var TIP_SEEN_MILLISECONDS = 3000;
  var TICK_MILLISECONDS = 500;

  function keysOf(id, long) {
    var names = labels(id, long);
    return names.length ? names[0] : null;
  }

  var TIPS = [
    {
      id: "move",
      actions: ["moveForward", "moveBack", "moveLeft", "moveRight", "jump"],
      text: function() {
        return moveLabel(["moveForward", "moveLeft", "moveBack", "moveRight"], " ") + " to move, " +
          (keysOf("jump", true) || "(unbound)") + " to jump, " + (keysOf("crouch", true) || "(unbound)") + " to crouch";
      },
    },
    {
      id: "shoot",
      actions: ["fire"],
      text: function() {
        return (keysOf("fire", true) || "(unbound)") + " to shoot, " + (keysOf("zoom", true) || "(unbound)") + " to zoom";
      },
    },
    {
      id: "grenades",
      actions: ["grenade", "switchGrenade"],
      text: function() {
        return (keysOf("grenade", true) || "(unbound)") + " throws a grenade, " +
          (keysOf("switchGrenade", true) || "(unbound)") + " switches the type";
      },
    },
    {
      id: "melee",
      actions: ["melee"],
      text: function() { return (keysOf("melee", true) || "(unbound)") + " to melee: a hit from behind kills"; },
    },
    {
      id: "reload",
      actions: ["action"],
      text: function() {
        return (keysOf("action", true) || "(unbound)") + " reloads; hold it over a weapon to pick it up, " +
          (keysOf("switchWeapon", true) || "(unbound)") + " switches weapons";
      },
    },
    {
      id: "scores",
      actions: ["scores"],
      text: function() { return "Hold " + (keysOf("scores", true) || "F1") + " for the scoreboard"; },
    },
    {
      id: "chat",
      keys: ["KeyY"],
      text: function() { return "Y to chat with the other players"; },
    },
  ];

  function tipsSettings() {
    if (state.tips) return state.tips;
    var saved = null;
    try { saved = JSON.parse(global.localStorage.getItem(TIPS_STORAGE_KEY)); } catch (error) { saved = null; }
    var settings = { enabled: true, seen: [] };
    if (saved && typeof saved === "object") {
      settings.enabled = saved.enabled !== false;
      if (Array.isArray(saved.seen)) {
        settings.seen = saved.seen.filter(function(id) { return TIPS.some(function(tip) { return tip.id === id; }); });
      }
    }
    state.tips = settings;
    return settings;
  }

  function saveTips() {
    try {
      global.localStorage.setItem(TIPS_STORAGE_KEY, JSON.stringify(tipsSettings()));
    } catch (error) { /* this visit only */ }
  }

  function setTipsEnabled(enabled) {
    tipsSettings().enabled = !!enabled;
    saveTips();
    if (!enabled) hideTip(false);
    renderDialog();
  }

  function resetTips() {
    var settings = tipsSettings();
    settings.seen = [];
    settings.enabled = true;
    saveTips();
  }

  function markSeen(id) {
    var settings = tipsSettings();
    if (settings.seen.indexOf(id) < 0) settings.seen.push(id);
    saveTips();
  }

  function nextTip() {
    var seen = tipsSettings().seen;
    for (var index = 0; index < TIPS.length; index++) {
      if (seen.indexOf(TIPS[index].id) < 0) return TIPS[index];
    }
    return null;
  }

  function context() {
    var online = global.HaloOnline;
    if (!online || !online.chat || typeof online.chat.context !== "function") return { inGame: false };
    try {
      return online.chat.context() || { inGame: false };
    } catch (error) {
      return { inGame: false };
    }
  }

  /* playing: in a match, the mouse captured, nothing of the page's open */
  function playing() {
    if (!context().inGame) return false;
    if (document.body && document.body.dataset &&
        (document.body.dataset.lobby === "open" || document.body.dataset.spectate === "true")) return false;
    var canvas = byId("canvas");
    if (!canvas || document.pointerLockElement !== canvas) return false;
    if (global.HaloChat && typeof global.HaloChat.isComposing === "function" && global.HaloChat.isComposing()) return false;
    return true;
  }

  function showTip(tip) {
    var box = byId("match-tip");
    if (!box) return;
    state.tip = tip;
    state.tipStartedAt = Date.now();
    var text = byId("match-tip-text");
    if (text) text.textContent = tip.text();
    box.dataset.tip = tip.id;
    delete box.dataset.fading;
    box.hidden = false;
  }

  /* done: the player did it, closed it, or it was up long enough */
  function hideTip(done) {
    var box = byId("match-tip");
    var tip = state.tip;
    state.tip = null;
    state.lastTipEndedAt = Date.now();
    if (tip && done) markSeen(tip.id);
    if (!box) return;
    box.hidden = true;
    delete box.dataset.fading;
  }

  function tick() {
    var now = Date.now();
    var settings = tipsSettings();
    var active = settings.enabled && playing();
    if (!active) {
      if (!context().inGame) state.inGameSince = 0;
      if (state.tip) {
        /* the match ended or the page took over: a tip up long enough counts */
        hideTip(now - state.tipStartedAt >= TIP_SEEN_MILLISECONDS);
      }
      return;
    }
    if (!state.inGameSince) state.inGameSince = now;
    if (state.tip) {
      var shown = now - state.tipStartedAt;
      var box = byId("match-tip");
      if (box && shown >= TIP_MILLISECONDS - 800) box.dataset.fading = "true";
      if (shown >= TIP_MILLISECONDS) hideTip(true);
      return;
    }
    if (now - state.inGameSince < TIP_DELAY_MILLISECONDS) return;
    if (state.lastTipEndedAt && now - state.lastTipEndedAt < TIP_GAP_MILLISECONDS) return;
    var tip = nextTip();
    if (tip) showTip(tip);
  }

  /* the player did what the tip says: it has done its job */
  function onPlayerInput(event) {
    var tip = state.tip;
    if (!tip || state.listening) return;
    var name = null;
    if (event.type === "keydown") name = event.code;
    else if (event.type === "mousedown") name = mouseName(event.button);
    else if (event.type === "wheel") name = "Wheel";
    if (!name) return;
    var matched = (tip.keys || []).indexOf(name) >= 0 || (tip.actions || []).some(function(id) {
      return (bindings()[id] || []).indexOf(name) >= 0;
    });
    if (!matched) return;
    /* a moment's grace, so a key already held does not dismiss it unread */
    if (Date.now() - state.tipStartedAt < 1200) return;
    hideTip(true);
  }

  function installTips() {
    var close = byId("match-tip-close");
    if (close) close.addEventListener("click", function() { hideTip(true); });
    ["keydown", "mousedown"].forEach(function(type) {
      global.addEventListener(type, onPlayerInput, true);
    });
    global.addEventListener("wheel", onPlayerInput, { capture: true, passive: true });
    if (!state.tickTimer) state.tickTimer = global.setInterval(tick, TICK_MILLISECONDS);
  }

  /* ---------- the browser's own uses of the bound keys */

  /* While the game has the keyboard, a bound key is the game's: Space must
     not scroll, / and ' must not open Firefox's quick find. The key still
     reaches SDL; only the browser's default action is dropped. */
  function onGameKey(event) {
    if (event.type !== "keydown" || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    var canvas = byId("canvas");
    if (!canvas) return;
    if (document.pointerLockElement !== canvas && document.activeElement !== canvas) return;
    /* (typing in the page, such as chat's composer, keeps its keys) */
    var active = document.activeElement;
    if (active && active !== canvas && typeof active.matches === "function" &&
        active.matches("input, select, textarea, [contenteditable='true']")) return;
    if (document.body && document.body.dataset && document.body.dataset.lobby === "open") return;
    if (!event.code || !boundTo(event.code)) return;
    event.preventDefault();
  }

  /* ---------- wiring */

  function initialize() {
    bindings();
    tipsSettings();
    installDialog();
    installTips();
    global.addEventListener("keydown", onGameKey, false);
    render();
  }

  global.HaloControls = Object.freeze({
    /* shell.html, once the runtime is up: the game gets the bindings */
    runtimeReady: function() {
      state.runtimeReady = true;
      applyBindings();
    },
    actions: function() { return ACTIONS.map(function(action) { return action.id; }); },
    bindings: function() {
      var copy = {};
      var current = bindings();
      Object.keys(current).forEach(function(id) { copy[id] = current[id].slice(); });
      return copy;
    },
    bind: function(actionId, slot, name) { return bind(actionId, slot, name); },
    reset: resetBindings,
    /* "Q", "LMB"; long: "Click" */
    labels: function(actionId, long) { return labels(actionId, long); },
    inputCode: inputCode,
    open: openDialog,
    close: closeDialog,
    tips: Object.freeze({
      enabled: function() { return tipsSettings().enabled; },
      setEnabled: setTipsEnabled,
      reset: resetTips,
      current: function() { return state.tip ? state.tip.id : null; },
      seen: function() { return tipsSettings().seen.slice(); },
      tick: tick,
    }),
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})(typeof window !== "undefined" ? window : null);
