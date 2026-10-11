/* The dashboard's admin session (servers.html), shared by its admin panels
   (servers_wagers.js, servers_fomo_handles.js): one pasted token signs every
   panel in and out, bearer calls to the Worker's /v1/admin/ routes, each
   panel's refresh timer, and the sign-in form and status line they draw.

   The admin token never lives in this file or the page: the operator
   pastes it, and it is kept in sessionStorage (this tab only) until they
   sign out or the Worker rejects it. Every call is a bearer request, so
   the Worker answers the browser's preflight on /v1/admin/ too. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HaloAdmin = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TOKEN_KEY = "halo-admin-token";
  const REFRESH_MS = 10000;
  const NOTE_LIMIT = 500;

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

  function errorMessage(result, fallback) {
    const error = result.data && result.data.error;
    return (error && error.message) || fallback + " (" + result.status + ")";
  }

  /* ---------- the session

     A panel subscribes with { signedIn(message), signedOut(message, failed) }:
     signing in (from any panel) awaits every panel's signedIn, and a sign-out
     (the button, or a 401 anywhere) reaches every panel. */
  function session(options) {
    const fetchImpl = options.fetch || ((input, init) => fetch(input, init));
    const storage = "storage" in options ? options.storage : (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    const schedule = options.setInterval || ((fn, ms) => setInterval(fn, ms));
    const unschedule = options.clearInterval || ((id) => clearInterval(id));
    const signalingUrl = options.signalingUrl;
    const panels = [];
    let token = readToken(storage);

    async function call(method, path, body) {
      const base = await signalingUrl();
      const headers = { Authorization: "Bearer " + token };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetchImpl(base + path, {
        method, headers, cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try { data = await response.json(); } catch (error) { data = null; }
      return { status: response.status, ok: response.ok, data };
    }

    /* false (nothing changes) for an empty token */
    async function signIn(value) {
      const trimmed = (value || "").trim();
      if (!trimmed) return false;
      token = trimmed;
      const message = writeToken(storage, trimmed) ? "" : "The token is kept only in memory: this tab's storage is unavailable.";
      await Promise.all(panels.map((panel) => panel.signedIn(message)));
      return true;
    }

    function signOut(message, failed) {
      token = null;
      writeToken(storage, null);
      panels.forEach((panel) => panel.signedOut(message || "Signed out.", failed));
    }

    /* the tick runs every REFRESH_MS while started */
    function timer(tick) {
      let id = null;
      return {
        start() { if (id === null) id = schedule(tick, REFRESH_MS); },
        stop() { if (id !== null) unschedule(id); id = null; },
      };
    }

    return {
      get token() { return token; },
      call, signIn, signOut, timer,
      subscribe(panel) { panels.push(panel); },
    };
  }

  /* ---------- drawing */

  function builder(doc) {
    return function element(tag, attributes, children) {
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
    };
  }

  function signInForm(element, explain, onSignIn) {
    const input = element("input", {
      type: "password", autocomplete: "off", spellcheck: "false", placeholder: "Admin token", "aria-label": "Admin token",
    });
    const button = element("button", { type: "button", text: "Sign in", onclick: () => onSignIn(input.value) });
    return element("div", { class: "admin-signin" }, [
      element("p", { class: "meta", text: explain + " It stays in this tab (sessionStorage) until you sign out or close the tab, and is sent only to the signaling Worker." }),
      element("div", { class: "admin-row" }, [input, button]),
    ]);
  }

  function statusLine(element, status, failed) {
    if (!status) return [];
    return [element("p", { class: failed ? "error admin-status" : "admin-status", text: status })];
  }

  /* the signed-in bar: refresh and sign out */
  function bar(element, busy, onRefresh, onSignOut) {
    return element("div", { class: "admin-row admin-bar" }, [
      element("span", { class: "meta", text: "Signed in with the admin token · refreshes every " + (REFRESH_MS / 1000) + " s" }),
      element("button", { type: "button", text: "Refresh", disabled: busy, onclick: onRefresh }),
      element("button", { type: "button", class: "admin-signout", text: "Sign out", onclick: onSignOut }),
    ]);
  }

  return {
    session, builder, signInForm, statusLine, bar, errorMessage, span, when, readToken, writeToken,
    TOKEN_KEY, REFRESH_MS, NOTE_LIMIT,
  };
});
