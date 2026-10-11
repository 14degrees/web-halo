/* The dashboard's "Held wagers" panel (servers.html): Team Stakes matches
   whose stakes wait in escrow for an admin, with Forfeit, Void and Extend
   over the Worker's admin routes (docs/wagers.md, "Held matches").

   The admin token, its sign-in and the refresh timer are the dashboard's
   admin session (servers_admin.js), shared with the other admin panels. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./servers_admin.js"));
  else root.HaloHeldWagers = factory(root.HaloAdmin);
})(typeof self !== "undefined" ? self : this, function (admin) {
  "use strict";

  const { TOKEN_KEY, REFRESH_MS, NOTE_LIMIT, span, when } = admin;
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

  /* ---------- formatting */

  function sol(lamports) {
    if (typeof lamports !== "number" || !Number.isFinite(lamports)) return "–";
    const value = lamports / 1e9;
    return (Number.isInteger(value * 1000) ? value.toFixed(3) : value.toFixed(4).replace(/0$/, "")) + " SOL";
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

  /* `options.session` is the page's shared admin session; without one the
     panel makes its own from the same options (fetch, storage, timers). */
  function mount(options) {
    const container = options.container;
    if (!container) return null;
    const doc = options.document || container.ownerDocument || document;
    const now = options.now || (() => Date.now());
    const session = options.session || admin.session(options);
    const element = admin.builder(doc);

    const state = {
      get token() { return session.token; },
      held: [],
      records: {},
      status: "",
      failed: false,
      /* the status is a refresh failure, cleared by the next good refresh */
      stale: false,
      /* the open form: { matchId, action } */
      form: null,
      busy: false,
    };
    const timer = session.timer(() => { if (!state.form && !state.busy) refresh(); });

    function setStatus(text, failed) {
      state.status = text || "";
      state.failed = Boolean(failed);
    }

    async function signIn(token) {
      if (!(await session.signIn(token))) {
        setStatus("Paste the admin token first.", true);
        render();
      }
    }

    session.subscribe({
      async signedIn(message) {
        setStatus(message, false);
        await refresh();
        if (state.token) timer.start();
      },
      signedOut(message, failed) {
        state.held = [];
        state.records = {};
        state.form = null;
        setStatus(message, failed);
        timer.stop();
        render();
      },
    });

    /* The held list, then each match's record (reason, players, history). */
    async function refresh() {
      if (!state.token || state.busy) return;
      state.busy = true;
      try {
        const list = await session.call("GET", "/v1/admin/wagers/held");
        if (list.status === 401) {
          session.signOut("The Worker rejected that token. Sign in again.", true);
          return;
        }
        if (!list.ok) throw new Error(admin.errorMessage(list, "The held list failed"));
        const held = Array.isArray(list.data && list.data.held) ? list.data.held : [];
        const records = {};
        for (const row of held) {
          const record = await session.call("GET", "/v1/admin/wagers/" + encodeURIComponent(row.matchId));
          if (record.status === 401) {
            session.signOut("The Worker rejected that token. Sign in again.", true);
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
          await session.call("POST", "/v1/admin/wagers/" + encodeURIComponent(matchId) + "/hold", { hours, note: trimmed }) :
          await session.call("POST", "/v1/admin/wagers/" + encodeURIComponent(matchId) + "/decide", { action, note: trimmed });
      } catch (error) {
        state.busy = false;
        setStatus(error.message || String(error), true);
        render();
        return;
      }
      state.busy = false;
      if (result.status === 401) {
        session.signOut("The Worker rejected the token; nothing was changed. Sign in again.", true);
        return;
      }
      if (result.status === 409) {
        state.form = null;
        setStatus("Match " + matchId + " is no longer held; nothing was changed.", true);
      } else if (!result.ok) {
        setStatus(admin.errorMessage(result, "The Worker refused the " + action), true);
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
      return admin.signInForm(element, "Deciding a held wager needs the Worker's admin token.", signIn);
    }

    function statusLine() {
      return admin.statusLine(element, state.status, state.failed);
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
      const bar = admin.bar(element, state.busy, () => refresh(),
        () => session.signOut("Signed out; the token was removed from this tab.", false));
      const cards = state.held.length ? state.held.map(card) :
        [element("div", { class: "empty", text: "No wagers are held." })];
      container.replaceChildren(bar, ...statusLine(), element("div", { class: "grid admin-grid" }, cards));
    }

    render();
    if (state.token) {
      refresh();
      timer.start();
    }
    return { refresh, signIn, signOut: session.signOut, submit, state };
  }

  return { mount, sol, span, when, groupLabel, describeHistory, TOKEN_KEY, REFRESH_MS, NOTE_LIMIT, HOURS_LIMIT };
});
