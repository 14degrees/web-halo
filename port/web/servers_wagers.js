/* The dashboard's "Held wagers" panel (servers.html): Team Stakes matches
   whose stakes wait in escrow for an admin, with Forfeit, Void and Extend
   over the Worker's admin routes (docs/wagers.md, "Held matches").

   The admin token never lives in this file or the page: the operator
   pastes it, and it is kept in sessionStorage (this tab only) until they
   sign out or the Worker rejects it. Every call is a bearer request, so
   the Worker answers the browser's preflight on /v1/admin/ too. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HaloHeldWagers = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TOKEN_KEY = "halo-admin-token";
  const REFRESH_MS = 10000;
  const NOTE_LIMIT = 500;
  const HOURS_LIMIT = 168;
  const ACTIONS = {
    forfeit: {
      label: "Forfeit",
      title: "Forfeit the dropped team",
      explain: "Pays the settlement proposed when the match was held: the team that dropped out loses its stakes.",
    },
    void: {
      label: "Void",
      title: "Void the match",
      explain: "Returns every player's stake with no fee.",
    },
    extend: {
      label: "Extend",
      title: "Extend the hold",
      explain: "Moves the deadline later, never past the ceiling (an hour before the players can reclaim their stakes).",
    },
  };

  /* ---------- storage: sessionStorage may be missing or throw */

  function readToken(storage) {
    try { return (storage && storage.getItem(TOKEN_KEY)) || null; } catch (error) { return null; }
  }

  function writeToken(storage, token) {
    try {
      if (token) storage.setItem(TOKEN_KEY, token);
      else storage.removeItem(TOKEN_KEY);
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ---------- formatting */

  function sol(lamports) {
    if (typeof lamports !== "number" || !Number.isFinite(lamports)) return "–";
    const value = lamports / 1e9;
    return (Number.isInteger(value * 1000) ? value.toFixed(3) : value.toFixed(4).replace(/0$/, "")) + " SOL";
  }

  function span(milliseconds) {
    const minutes = Math.floor(Math.abs(milliseconds) / 60000);
    if (minutes < 1) return "under a minute";
    if (minutes < 60) return minutes + " min";
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + " h " + String(minutes % 60).padStart(2, "0") + " min";
    return Math.floor(hours / 24) + " d " + (hours % 24) + " h";
  }

  function when(at, now) {
    if (typeof at !== "number") return "–";
    const date = new Date(at);
    const relative = at >= now ? "in " + span(at - now) : span(now - at) + " ago";
    return date.toLocaleString() + " (" + relative + ")";
  }

  function groupLabel(index, config, players) {
    if (config && config.groups === 0) return players[index] ? players[index].name : "player " + (index + 1);
    if (!config || config.groups === 2) return index === 0 ? "Red" : index === 1 ? "Blue" : "Team " + (index + 1);
    return "Team " + (index + 1);
  }

  function describeHistory(entry, config, players) {
    const detail = entry.detail || {};
    switch (entry.action) {
      case "held":
        return "held: " + (detail.reason || "") +
          (Array.isArray(detail.dropped) && detail.dropped.length ?
            " (dropped: " + detail.dropped.map((index) => groupLabel(index, config, players)).join(", ") + ")" : "");
      case "extended":
        return "extended by " + detail.hours + " h to " + new Date(detail.deadline).toLocaleString() +
          (detail.clamped ? ", clamped at the ceiling" : "") + (detail.note ? ": " + detail.note : "");
      case "decided":
        return "decided: " + detail.action + (detail.note ? ": " + detail.note : "");
      case "expired":
        return "expired: " + (detail.outcome || "forfeit");
      default:
        return entry.action + (detail.note ? ": " + detail.note : "");
    }
  }

  /* ---------- the panel */

  function mount(options) {
    const container = options.container;
    if (!container) return null;
    const doc = options.document || container.ownerDocument || document;
    const fetchImpl = options.fetch || ((input, init) => fetch(input, init));
    const storage = "storage" in options ? options.storage : (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    const schedule = options.setInterval || ((fn, ms) => setInterval(fn, ms));
    const unschedule = options.clearInterval || ((id) => clearInterval(id));
    const now = options.now || (() => Date.now());
    const signalingUrl = options.signalingUrl;

    const state = {
      token: readToken(storage),
      held: [],
      records: {},
      status: "",
      failed: false,
      /* the status is a refresh failure, cleared by the next good refresh */
      stale: false,
      /* the open form: { matchId, action } */
      form: null,
      busy: false,
      timer: null,
    };

    function element(tag, attributes, children) {
      const node = doc.createElement(tag);
      Object.entries(attributes || {}).forEach(([name, value]) => {
        if (name === "text") node.textContent = value;
        else if (name === "onclick") node.addEventListener("click", value);
        else if (name === "oninput") node.addEventListener("input", value);
        else if (name === "disabled") node.disabled = Boolean(value);
        else node.setAttribute(name, value);
      });
      (children || []).forEach((child) => node.append(child));
      return node;
    }

    function setStatus(text, failed) {
      state.status = text || "";
      state.failed = Boolean(failed);
    }

    async function call(method, path, body) {
      const base = await signalingUrl();
      const headers = { Authorization: "Bearer " + state.token };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetchImpl(base + path, {
        method, headers, cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try { data = await response.json(); } catch (error) { data = null; }
      return { status: response.status, ok: response.ok, data };
    }

    function errorMessage(result, fallback) {
      const error = result.data && result.data.error;
      return (error && error.message) || fallback + " (" + result.status + ")";
    }

    function signOut(message, failed) {
      state.token = null;
      state.held = [];
      state.records = {};
      state.form = null;
      writeToken(storage, null);
      setStatus(message || "Signed out.", failed);
      stop();
      render();
    }

    async function signIn(token) {
      const trimmed = (token || "").trim();
      if (!trimmed) {
        setStatus("Paste the admin token first.", true);
        render();
        return;
      }
      state.token = trimmed;
      if (!writeToken(storage, trimmed)) setStatus("The token is kept only in memory: this tab's storage is unavailable.", false);
      else setStatus("", false);
      await refresh();
      if (state.token) start();
    }

    /* The held list, then each match's record (reason, players, history). */
    async function refresh() {
      if (!state.token || state.busy) return;
      state.busy = true;
      try {
        const list = await call("GET", "/v1/admin/wagers/held");
        if (list.status === 401) {
          signOut("The Worker rejected that token. Sign in again.", true);
          return;
        }
        if (!list.ok) throw new Error(errorMessage(list, "The held list failed"));
        const held = Array.isArray(list.data && list.data.held) ? list.data.held : [];
        const records = {};
        for (const row of held) {
          const record = await call("GET", "/v1/admin/wagers/" + encodeURIComponent(row.matchId));
          if (record.status === 401) {
            signOut("The Worker rejected that token. Sign in again.", true);
            return;
          }
          records[row.matchId] = record.ok ? record.data : null;
        }
        state.held = held;
        state.records = records;
        if (state.stale) setStatus("", false);
        state.stale = false;
        if (state.form && !held.some((row) => row.matchId === state.form.matchId)) state.form = null;
      } catch (error) {
        setStatus(error.message || String(error), true);
        state.stale = true;
      } finally {
        state.busy = false;
      }
      render();
    }

    function start() {
      if (state.timer === null) state.timer = schedule(() => { if (!state.form && !state.busy) refresh(); }, REFRESH_MS);
    }

    function stop() {
      if (state.timer !== null) unschedule(state.timer);
      state.timer = null;
    }

    async function submit(matchId, action, note, hours) {
      const trimmed = (note || "").trim();
      if (!trimmed || trimmed.length > NOTE_LIMIT) {
        setStatus("A note of 1 to " + NOTE_LIMIT + " characters is required.", true);
        render();
        return;
      }
      if (action === "extend" && !(hours > 0 && hours <= HOURS_LIMIT)) {
        setStatus("Hours must be above 0 and at most " + HOURS_LIMIT + ".", true);
        render();
        return;
      }
      state.busy = true;
      render();
      let result;
      try {
        result = action === "extend" ?
          await call("POST", "/v1/admin/wagers/" + encodeURIComponent(matchId) + "/hold", { hours, note: trimmed }) :
          await call("POST", "/v1/admin/wagers/" + encodeURIComponent(matchId) + "/decide", { action, note: trimmed });
      } catch (error) {
        state.busy = false;
        setStatus(error.message || String(error), true);
        render();
        return;
      }
      state.busy = false;
      if (result.status === 401) {
        signOut("The Worker rejected the token; nothing was changed. Sign in again.", true);
        return;
      }
      if (result.status === 409) {
        state.form = null;
        setStatus("Match " + matchId + " is no longer held; nothing was changed.", true);
      } else if (!result.ok) {
        setStatus(errorMessage(result, "The Worker refused the " + action), true);
        render();
        return;
      } else if (action === "extend") {
        state.form = null;
        const extended = result.data || {};
        setStatus("Match " + matchId + " is held until " + new Date(extended.deadline).toLocaleString() +
          (extended.clamped ? " (clamped at the ceiling)" : "") + ".", false);
      } else {
        state.form = null;
        setStatus("Match " + matchId + ": " + action + " recorded; the stakes are being " +
          (action === "void" ? "returned" : "paid") + ".", false);
      }
      await refresh();
    }

    /* ---------- rendering */

    function signInForm() {
      const input = element("input", {
        type: "password", autocomplete: "off", spellcheck: "false", placeholder: "Admin token", "aria-label": "Admin token",
      });
      const button = element("button", { type: "button", text: "Sign in", onclick: () => signIn(input.value) });
      return element("div", { class: "admin-signin" }, [
        element("p", { class: "meta", text: "Deciding a held wager needs the Worker's admin token. It stays in this tab (sessionStorage) until you sign out or close the tab, and is sent only to the signaling Worker." }),
        element("div", { class: "admin-row" }, [input, button]),
      ]);
    }

    function statusLine() {
      if (!state.status) return [];
      return [element("p", { class: state.failed ? "error admin-status" : "admin-status", text: state.status })];
    }

    function actionForm(row, record) {
      const form = state.form;
      const action = ACTIONS[form.action];
      const hours = element("input", { type: "number", min: "1", max: String(HOURS_LIMIT), step: "1", value: "6", "aria-label": "Hours" });
      const note = element("textarea", { rows: "2", maxlength: String(NOTE_LIMIT), placeholder: "Note for the log (required)", "aria-label": "Note" });
      const confirm = element("button", {
        type: "button", class: "admin-confirm", disabled: true,
        text: "Confirm " + action.label.toLowerCase(),
        onclick: () => submit(row.matchId, form.action, note.value, Number(hours.value)),
      });
      note.addEventListener("input", () => { confirm.disabled = state.busy || note.value.trim().length === 0; });
      const cancel = element("button", { type: "button", text: "Cancel", onclick: () => { state.form = null; render(); } });
      const summary = form.action === "forfeit" && record && record.settlement ?
        " Winners share " + sol(record.settlement.payouts.reduce((sum, value) => sum + value, 0)) +
        " after a " + sol(record.settlement.fee) + " fee." : "";
      return element("div", { class: "admin-form" }, [
        element("p", { class: "admin-form-title", text: action.title + " · match " + row.matchId }),
        element("p", { class: "meta", text: action.explain + summary }),
        ...(form.action === "extend" ? [element("label", { class: "admin-row" }, [element("span", { text: "Hours" }), hours])] : []),
        note,
        element("div", { class: "admin-row" }, [confirm, cancel]),
      ]);
    }

    function playerRows(record) {
      const view = record.view;
      const config = record.config;
      const byName = {};
      ((record.result && record.result.players) || []).forEach((player) => { byName[player.name] = player; });
      const payouts = record.settlement ? record.settlement.payouts : null;
      const head = element("tr", {}, ["Player", "Team", "Kills", "Deaths", "Staked", "Forfeit pays"].map((text) => element("th", { text })));
      const rows = view.players.map((player, index) => {
        const result = byName[player.name];
        const team = result ? groupLabel(result.team, config, view.players) : "–";
        return element("tr", {}, [
          element("td", { text: player.name + " · " + player.wallet.slice(0, 4) + "…" + player.wallet.slice(-4) }),
          element("td", { text: team + (result && result.quit ? " (quit)" : "") }),
          element("td", { text: String(player.kills) }),
          element("td", { text: String(player.deaths) }),
          element("td", { text: sol(player.balance) }),
          element("td", { text: payouts ? sol(payouts[index]) : "–" }),
        ].map((cell) => cell));
      });
      return element("table", { class: "admin-players" }, [element("thead", {}, [head]), element("tbody", {}, rows)]);
    }

    function card(row) {
      const record = state.records[row.matchId];
      const hold = record && record.hold;
      const config = record && record.config;
      const players = record ? record.view.players : [];
      const current = now();
      const dropped = (hold ? hold.dropped : []).map((index) => groupLabel(index, config, players)).join(", ");
      const limit = row.limit !== null && row.limit !== undefined ? row.limit : hold && hold.limit;
      const rows = [
        ["Reason", (hold && hold.reason) || row.reason || "–"],
        ["Dropped", dropped || "–"],
        ["Held since", when(hold ? hold.since : row.since, current)],
        ["Deadline", when(hold ? hold.deadline : row.deadline, current) + " · forfeits by itself then"],
        ["Ceiling", limit ? when(limit, current) : "not read from the chain yet"],
        ["Stakes", record ? sol(record.view.stake) + " each · pot " + sol(record.view.pot) + " · fee " + (record.view.feeBps / 100) + "%" : "–"],
        ["Rules", config ? "kill target " + config.killTarget + " · " + (config.teamShareBps / 100) + "% split evenly · " +
          (config.groups === 0 ? "free for all" : config.groups + " teams") : "–"],
      ];
      const list = element("dl", { class: "rows" });
      rows.forEach(([label, value]) => list.append(element("dt", { text: label }), element("dd", { text: value })));
      const history = hold && hold.history.length ?
        element("ol", { class: "admin-history" }, hold.history.map((entry) =>
          element("li", { text: new Date(entry.at).toLocaleString() + " · " + entry.by + " · " + describeHistory(entry, config, players) }))) :
        element("p", { class: "meta", text: "No history." });
      const open = state.form && state.form.matchId === row.matchId;
      const buttons = element("div", { class: "admin-row" }, Object.keys(ACTIONS).map((action) => element("button", {
        type: "button", class: "admin-action admin-" + action, text: ACTIONS[action].label,
        disabled: state.busy || (open && state.form.action === action),
        onclick: () => { state.form = { matchId: row.matchId, action }; render(); },
      })));
      return element("article", { class: "card admin-held", "data-match": row.matchId }, [
        element("div", { class: "body" }, [
          element("div", { class: "title" }, [
            element("span", { class: "dot", style: "background:var(--countdown)" }),
            element("span", { text: "Match " + row.matchId + (row.playlist ? " · " + row.playlist : "") }),
          ]),
          element("div", { class: "meta", text: record ? "" : "The match's record could not be read." }),
          list,
          ...(record ? [playerRows(record)] : []),
          history,
          buttons,
          ...(open ? [actionForm(row, record)] : []),
        ]),
      ]);
    }

    function render() {
      if (!state.token) {
        container.replaceChildren(signInForm(), ...statusLine());
        return;
      }
      const bar = element("div", { class: "admin-row admin-bar" }, [
        element("span", { class: "meta", text: "Signed in with the admin token · refreshes every " + (REFRESH_MS / 1000) + " s" }),
        element("button", { type: "button", text: "Refresh", disabled: state.busy, onclick: () => refresh() }),
        element("button", { type: "button", class: "admin-signout", text: "Sign out", onclick: () => signOut("Signed out; the token was removed from this tab.", false) }),
      ]);
      const cards = state.held.length ? state.held.map(card) :
        [element("div", { class: "empty", text: "No wagers are held." })];
      container.replaceChildren(bar, ...statusLine(), element("div", { class: "grid admin-grid" }, cards));
    }

    render();
    if (state.token) {
      refresh();
      start();
    }
    return { refresh, signIn, signOut, submit, state };
  }

  return { mount, sol, span, when, groupLabel, describeHistory, TOKEN_KEY, REFRESH_MS, NOTE_LIMIT, HOURS_LIMIT };
});
