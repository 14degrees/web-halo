/* The dashboard's "Fomo handles" panel (servers.html): claimed fomo handles
   on profiles with a proven fomo wallet wait here until an admin compares
   the wallet with the masked address on fomo's profile page and confirms or
   rejects the claim; confirmed handles are listed so one can be taken back
   (docs/profiles.md, "fomo handles"). Both go through
   GET /v1/admin/profiles/fomo-handles and POST /v1/admin/profiles/fomo-handle.

   The admin token, its sign-in and the refresh timer are the dashboard's
   admin session (servers_admin.js), shared with the held-wagers panel. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./servers_admin.js"));
  else root.HaloFomoHandles = factory(root.HaloAdmin);
})(typeof self !== "undefined" ? self : this, function (admin) {
  "use strict";

  const { NOTE_LIMIT, when } = admin;
  const ACTIONS = {
    confirm: {
      label: "Confirm",
      title: "Confirm the handle",
      explain: "Only if fomo's profile page shows a masked address that matches the proven fomo wallet. The handle then shows on the profile (when the player shows fomo), and every other profile's claim of it is dropped.",
      verified: true,
      done: "confirmed",
    },
    reject: {
      label: "Reject",
      title: "Reject the claim",
      explain: "Drops the claim from the profile; the player can claim a handle again.",
      verified: false,
      done: "rejected; the claim was dropped",
    },
    revoke: {
      label: "Revoke",
      title: "Revoke the confirmation",
      explain: "Takes the handle off the profile and drops the claim; if the player claims it again it comes back here.",
      verified: false,
      done: "revoked; the claim was dropped",
    },
  };
  const METHODS = {
    fee_payer: "fomo's fee payer paid for this wallet's trades",
    transfer: "a transfer from this wallet to the player's Halo wallet",
    official: "fomo's own lookup",
  };

  /* ---------- formatting */

  function profileUrl(handle) {
    return "https://fomo.family/profile/" + encodeURIComponent(handle);
  }

  function short(wallet) {
    return typeof wallet === "string" && wallet.length > 8 ? wallet.slice(0, 4) + "…" + wallet.slice(-4) : String(wallet || "–");
  }

  function method(name) {
    return METHODS[name] || (name ? name : "unknown");
  }

  function cardCheck(seen) {
    if (seen === true) return "fomo's profile card showed the handle";
    if (seen === false) return "fomo's profile card did not show the handle";
    return "not checked";
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
      pending: [],
      verified: [],
      status: "",
      failed: false,
      /* the status is a refresh failure, cleared by the next good refresh */
      stale: false,
      /* the open form: { profileId, handle, username, action } */
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
        state.pending = [];
        state.verified = [];
        state.form = null;
        setStatus(message, failed);
        timer.stop();
        render();
      },
    });

    async function refresh() {
      if (!state.token || state.busy) return;
      state.busy = true;
      try {
        const list = await session.call("GET", "/v1/admin/profiles/fomo-handles");
        if (list.status === 401) {
          session.signOut("The Worker rejected that token. Sign in again.", true);
          return;
        }
        if (!list.ok) throw new Error(admin.errorMessage(list, "The fomo handle list failed"));
        state.pending = Array.isArray(list.data && list.data.pending) ? list.data.pending : [];
        state.verified = Array.isArray(list.data && list.data.verified) ? list.data.verified : [];
        if (state.stale) setStatus("", false);
        state.stale = false;
        const form = state.form;
        const rows = form && form.action === "revoke" ? state.verified : state.pending;
        if (form && !rows.some((row) => row.profileId === form.profileId && row.handle === form.handle)) state.form = null;
      } catch (error) {
        setStatus(error.message || String(error), true);
        state.stale = true;
      } finally {
        state.busy = false;
      }
      render();
    }

    /* `row` is the listed entry ({ profileId, handle, username }) the admin looked at */
    async function submit(row, action, note) {
      const trimmed = (note || "").trim();
      if (!trimmed || trimmed.length > NOTE_LIMIT) {
        setStatus("A note of 1 to " + NOTE_LIMIT + " characters is required.", true);
        render();
        return;
      }
      const subject = row.username + "'s handle @" + row.handle;
      state.busy = true;
      render();
      let result;
      try {
        result = await session.call("POST", "/v1/admin/profiles/fomo-handle", {
          profileId: row.profileId, handle: row.handle, verified: ACTIONS[action].verified, note: trimmed,
        });
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
      const code = result.data && result.data.error && result.data.error.code;
      if (result.status === 409 || result.status === 404) {
        state.form = null;
        if (code === "FOMO_HANDLE_CHANGED") setStatus(row.username + "'s claim changed since this list was read; nothing was changed. Look again.", true);
        else if (code === "FOMO_HANDLE_TAKEN") setStatus("@" + row.handle + " is already confirmed on another profile; nothing was changed. Revoke it there first.", true);
        else if (code === "FOMO_WALLET_UNPROVEN") setStatus(row.username + " no longer has a proven fomo wallet; nothing was changed.", true);
        else if (code === "FOMO_HANDLE_MISSING" || code === "PROFILE_NOT_FOUND") setStatus(subject + " is gone; nothing was changed.", true);
        else setStatus(admin.errorMessage(result, "The Worker refused the " + action) + " Nothing was changed.", true);
      } else if (!result.ok) {
        /* a 400 (or an outage): the form stays open to try again */
        setStatus(admin.errorMessage(result, "The Worker refused the " + action), true);
        render();
        return;
      } else {
        state.form = null;
        setStatus(subject + ": " + ACTIONS[action].done + ".", false);
      }
      await refresh();
    }

    /* ---------- rendering */

    function link(handle) {
      return element("a", { href: profileUrl(handle), target: "_blank", rel: "noopener noreferrer", text: "fomo.family/profile/" + handle + " ↗" });
    }

    function actionForm(row) {
      const form = state.form;
      const action = ACTIONS[form.action];
      const note = element("textarea", { rows: "2", maxlength: String(NOTE_LIMIT), placeholder: "Note for the log (required)", "aria-label": "Note" });
      const confirm = element("button", {
        type: "button", class: "admin-confirm", disabled: true,
        text: "Confirm " + action.label.toLowerCase(),
        onclick: () => submit(row, form.action, note.value),
      });
      note.addEventListener("input", () => { confirm.disabled = state.busy || note.value.trim().length === 0; });
      const cancel = element("button", { type: "button", text: "Cancel", onclick: () => { state.form = null; render(); } });
      return element("div", { class: "admin-form" }, [
        element("p", { class: "admin-form-title", text: action.title + " · @" + row.handle + " for " + row.username }),
        element("p", { class: "meta", text: action.explain + " Proven fomo wallet: " + row.wallet + "." }),
        note,
        element("div", { class: "admin-row" }, [confirm, cancel]),
      ]);
    }

    function isOpen(row, actions) {
      return state.form && state.form.profileId === row.profileId && state.form.handle === row.handle &&
        actions.includes(state.form.action);
    }

    function actionButton(row, action) {
      return element("button", {
        type: "button", class: "admin-action admin-fomo-" + action, text: ACTIONS[action].label,
        disabled: state.busy || isOpen(row, [action]),
        onclick: () => { state.form = { profileId: row.profileId, handle: row.handle, username: row.username, action }; render(); },
      });
    }

    function pendingCard(row) {
      const current = now();
      const rows = [
        ["Claimed handle", "@" + row.handle],
        ["Claimed", when(row.claimedAt, current)],
        ["Fomo wallet", row.wallet + " (" + short(row.wallet) + ")"],
        ["Proven by", method(row.method)],
        ["Card check", cardCheck(row.handleSeen)],
        ["State", "wallet proven · handle waiting for an admin"],
      ];
      const list = element("dl", { class: "rows" });
      rows.forEach(([label, value]) => list.append(element("dt", { text: label }), element("dd", { text: value })));
      return element("article", { class: "card admin-fomo", "data-profile": row.profileId }, [
        element("div", { class: "body" }, [
          element("div", { class: "title" }, [
            element("span", { class: "dot", style: "background:var(--countdown)" }),
            element("span", { text: row.username + " · @" + row.handle }),
          ]),
          element("p", { class: "meta" }, [
            "Open ", link(row.handle), " and compare the masked address it shows with the fomo wallet below.",
          ]),
          list,
          element("div", { class: "admin-row" }, [actionButton(row, "confirm"), actionButton(row, "reject")]),
          ...(isOpen(row, ["confirm", "reject"]) ? [actionForm(row)] : []),
        ]),
      ]);
    }

    function verifiedTable() {
      if (!state.verified.length) return [element("div", { class: "empty", text: "No handles are confirmed." })];
      const current = now();
      const head = element("tr", {}, ["Player", "Handle", "Confirmed", "Fomo wallet", "Proven by", ""].map((text) => element("th", { text })));
      const rows = state.verified.map((row) => element("tr", { "data-profile": row.profileId }, [
        element("td", { text: row.username }),
        element("td", {}, [link(row.handle)]),
        element("td", { text: when(row.verifiedAt, current) }),
        element("td", { text: short(row.wallet) }),
        element("td", { text: method(row.method) }),
        element("td", {}, [actionButton(row, "revoke")]),
      ]));
      const open = state.verified.find((row) => isOpen(row, ["revoke"]));
      return [
        element("table", { class: "admin-fomo-verified" }, [element("thead", {}, [head]), element("tbody", {}, rows)]),
        ...(open ? [actionForm(open)] : []),
      ];
    }

    function render() {
      if (!state.token) {
        container.replaceChildren(
          admin.signInForm(element, "Confirming a fomo handle needs the Worker's admin token.", signIn),
          ...admin.statusLine(element, state.status, state.failed));
        return;
      }
      const bar = admin.bar(element, state.busy, () => refresh(),
        () => session.signOut("Signed out; the token was removed from this tab.", false));
      const cards = state.pending.length ? state.pending.map(pendingCard) :
        [element("div", { class: "empty", text: "No fomo handles are waiting." })];
      container.replaceChildren(
        bar,
        ...admin.statusLine(element, state.status, state.failed),
        element("h3", { text: "Waiting (" + state.pending.length + ")" }),
        element("div", { class: "grid admin-grid" }, cards),
        element("h3", { text: "Confirmed (" + state.verified.length + ")" }),
        ...verifiedTable(),
      );
    }

    render();
    if (state.token) {
      refresh();
      timer.start();
    }
    return { refresh, signIn, submit, state };
  }

  return { mount, profileUrl, short, method, cardCheck };
});
