/* The leaderboard and a player's own record, from the signaling Worker's
   stats store (services/signaling/src/stats.ts).

   Every number shown here is verified: it comes from a dedicated server's
   end-of-match report. Custom and player-hosted games report nothing and
   are not counted, and the page says so wherever it shows a record.

   This file knows nothing of the room or the game. online_client.js hands
   it what it needs through HaloStats.init (the Worker fetch helper, this
   browser's player key, the signed-in wallet) and calls openLeaderboard
   from the lobby's footer and refreshPlayerStats when the Spartan dialog
   opens. */

;(function installHaloStats(global) {
  "use strict";

  if (!global || global.HaloStats) return;

  var PAGE_SIZE = 25;
  var SORTS = Object.freeze([
    { id: "kills", label: "Kills" },
    { id: "wins", label: "Wins" },
    { id: "kd", label: "K/D" },
    { id: "matches", label: "Matches" },
    { id: "net", label: "SOL won" },
  ]);
  var IDENTITY_LABELS = Object.freeze({ username: "Username", wallet: "Wallet", guest: "Guest" });
  var IDENTITY_NOTES = Object.freeze({
    username: "Tied to your username: every wallet you link plays for the same record.",
    wallet: "Tied to your wallet. A username would carry it across all your wallets.",
    guest: "Tied to this browser only. Sign in with a wallet to keep it.",
  });
  var LAMPORTS_PER_SOL = 1000000000;

  var context = null;
  var board = { sort: "kills", offset: 0, total: 0, entries: [], loading: false, error: "" };
  var me = { id: null, player: null, loading: false, error: "", missing: false };

  function byId(id) {
    var document = global.document;
    return document && typeof document.getElementById === "function" ? document.getElementById(id) : null;
  }

  function setText(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
  }

  function make(tag, className, text) {
    var element = global.document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function formatSol(lamports) {
    var sol = lamports / LAMPORTS_PER_SOL;
    var fixed = Math.abs(sol) >= 10 ? sol.toFixed(1) : sol.toFixed(3);
    return (lamports > 0 ? "+" : "") + fixed;
  }

  function formatKd(player) {
    return (typeof player.kd === "number" ? player.kd : player.kills / Math.max(player.deaths, 1)).toFixed(2);
  }

  function identityBadge(identity) {
    var badge = make("span", "stats-identity", IDENTITY_LABELS[identity] || identity);
    badge.dataset.identity = identity;
    badge.title = identity === "guest" ? "A browser that never signed in" :
      identity === "wallet" ? "A signed-in wallet" : "A claimed username";
    return badge;
  }

  function failureText(error, nothing) {
    if (error && error.haloStatus === 404) return nothing;
    return error && error.message ? error.message : "The stats service is unreachable.";
  }

  /* ---------- the leaderboard */

  function renderSorts() {
    var root = byId("leaderboard-sorts");
    if (!root) return;
    if (!root.childNodes.length) {
      SORTS.forEach(function(sort) {
        var button = make("button", "leaderboard-sort", sort.label);
        button.type = "button";
        button.dataset.sort = sort.id;
        button.setAttribute("role", "tab");
        button.addEventListener("click", function() {
          if (board.sort === sort.id) return;
          board.sort = sort.id;
          board.offset = 0;
          loadLeaderboard();
        });
        root.appendChild(button);
      });
    }
    root.childNodes.forEach(function(button) {
      var active = button.dataset.sort === board.sort;
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.classList.toggle("active", active);
    });
  }

  function renderLeaderboard() {
    renderSorts();
    var rows = byId("leaderboard-rows");
    if (rows) {
      rows.replaceChildren.apply(rows, board.entries.map(function(entry) {
        var row = make("tr", entry.id === me.id ? "leaderboard-you" : "");
        row.appendChild(make("td", "leaderboard-rank", String(entry.rank)));
        var who = make("td", "leaderboard-player");
        who.appendChild(make("span", "leaderboard-name", entry.name + (entry.id === me.id ? " (you)" : "")));
        who.appendChild(identityBadge(entry.identity));
        row.appendChild(who);
        row.appendChild(make("td", "num", String(entry.kills)));
        row.appendChild(make("td", "num", String(entry.deaths)));
        row.appendChild(make("td", "num", formatKd(entry)));
        row.appendChild(make("td", "num", entry.wins + "–" + entry.losses));
        row.appendChild(make("td", "num", String(entry.matches)));
        row.appendChild(make("td", "num", entry.wagered > 0 ? formatSol(entry.wagerNet) : "–"));
        return row;
      }));
    }
    var status = byId("leaderboard-status");
    if (board.loading) setText(status, "Loading…");
    else if (board.error) setText(status, board.error);
    else if (!board.entries.length) setText(status, board.offset > 0 ? "No more players." : "Nobody on the board yet: finish a matchmade game.");
    else setText(status, "");
    var first = board.offset + 1;
    var last = board.offset + board.entries.length;
    setText(byId("leaderboard-page"), board.total ? first + "–" + last + " of " + board.total : "");
    var previous = byId("leaderboard-prev");
    var next = byId("leaderboard-next");
    if (previous) previous.disabled = board.loading || board.offset === 0;
    if (next) next.disabled = board.loading || board.offset + PAGE_SIZE >= board.total;
  }

  function loadLeaderboard() {
    if (!context) return Promise.resolve();
    board.loading = true;
    board.error = "";
    renderLeaderboard();
    var path = "/v1/leaderboard?sort=" + board.sort + "&limit=" + PAGE_SIZE + "&offset=" + board.offset;
    return context.fetchJson(path, { method: "GET" }).then(function(result) {
      var view = result && result.leaderboard;
      board.entries = view && Array.isArray(view.entries) ? view.entries : [];
      board.total = view && typeof view.total === "number" ? view.total : board.entries.length;
    }, function(error) {
      board.entries = [];
      board.error = failureText(error, "The leaderboard is not available.");
    }).then(function() {
      board.loading = false;
      renderLeaderboard();
    });
  }

  function openLeaderboard() {
    var dialog = byId("leaderboard-dialog");
    if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    var pending = [loadLeaderboard()];
    /* the player's own line lights up once their record is known */
    if (!me.player && !me.loading) pending.push(refreshPlayerStats());
    return Promise.all(pending).then(function() {});
  }

  function closeLeaderboard() {
    var dialog = byId("leaderboard-dialog");
    if (dialog && dialog.open) dialog.close();
  }

  /* ---------- the player's own record */

  function renderPlayerStats() {
    var root = byId("spartan-stats");
    if (!root) return;
    var identity = byId("spartan-stats-identity");
    var grid = byId("spartan-stats-grid");
    var note = byId("spartan-stats-status");
    var player = me.player;
    if (identity) {
      identity.replaceChildren.apply(identity, player ? [identityBadge(player.identity)] : []);
    }
    if (grid) {
      var cells = player ? [
        ["Matches", String(player.matches)],
        ["Record", player.wins + "–" + player.losses + (player.draws ? "–" + player.draws : "")],
        ["Kills", String(player.kills)],
        ["Deaths", String(player.deaths)],
        ["K/D", formatKd(player)],
        ["Rank", "#" + player.ranks.kills + " by kills"],
      ] : [];
      if (player && player.wagered > 0) cells.push(["SOL", formatSol(player.wagerNet) + " in " + player.wagered + (player.wagered === 1 ? " match" : " matches")]);
      grid.replaceChildren.apply(grid, cells.map(function(cell) {
        var item = make("div", "stats-cell");
        item.appendChild(make("dt", "", cell[0]));
        item.appendChild(make("dd", "", cell[1]));
        return item;
      }));
    }
    if (me.loading) setText(note, "Loading your record…");
    else if (me.missing) setText(note, "No matchmade games on record yet. Only dedicated-server matches count; custom games don't.");
    else if (me.error) setText(note, me.error);
    else if (player) setText(note, "Verified from dedicated-server matches. " + (IDENTITY_NOTES[player.identity] || ""));
  }

  /* who to ask after: the signed-in wallet, else this browser's key */
  function ownLookupId() {
    var wallet = context && typeof context.walletAddress === "function" ? context.walletAddress() : null;
    if (wallet) return wallet;
    return context && typeof context.playerKey === "function" ? context.playerKey() : null;
  }

  function refreshPlayerStats() {
    if (!context) return Promise.resolve();
    var id = ownLookupId();
    if (!id) {
      me.player = null;
      me.missing = true;
      renderPlayerStats();
      return Promise.resolve();
    }
    me.loading = true;
    me.error = "";
    me.missing = false;
    renderPlayerStats();
    var lookUp = function(lookupId) {
      return context.fetchJson("/v1/players/" + encodeURIComponent(lookupId), { method: "GET" });
    };
    return lookUp(id).catch(function(error) {
      /* a wallet with no record yet may still have this browser's guest record */
      var key = context && typeof context.playerKey === "function" ? context.playerKey() : null;
      if (error && error.haloStatus === 404 && key && key !== id) return lookUp(key);
      throw error;
    }).then(function(result) {
      me.player = result && result.player ? result.player : null;
      me.id = me.player ? me.player.id : null;
      me.missing = !me.player;
    }, function(error) {
      me.player = null;
      me.id = null;
      me.missing = !!(error && error.haloStatus === 404);
      me.error = me.missing ? "" : failureText(error, "");
    }).then(function() {
      me.loading = false;
      renderPlayerStats();
      renderLeaderboard();
    });
  }

  /* ---------- wiring */

  function bind(id, type, listener) {
    var element = byId(id);
    if (element && typeof element.addEventListener === "function") element.addEventListener(type, listener);
  }

  function init(options) {
    context = options || null;
    bind("leaderboard-dialog-close", "click", closeLeaderboard);
    bind("leaderboard-refresh", "click", function() { loadLeaderboard(); });
    bind("leaderboard-prev", "click", function() {
      if (board.offset === 0) return;
      board.offset = Math.max(0, board.offset - PAGE_SIZE);
      loadLeaderboard();
    });
    bind("leaderboard-next", "click", function() {
      if (board.offset + PAGE_SIZE >= board.total) return;
      board.offset += PAGE_SIZE;
      loadLeaderboard();
    });
    var dialog = byId("leaderboard-dialog");
    if (dialog && typeof dialog.addEventListener === "function") {
      dialog.addEventListener("click", function(event) {
        /* a click on the backdrop closes it */
        if (event.target === dialog) closeLeaderboard();
      });
      dialog.addEventListener("keydown", function(event) { event.stopPropagation(); });
    }
    renderSorts();
    renderPlayerStats();
  }

  global.HaloStats = Object.freeze({
    init: init,
    openLeaderboard: openLeaderboard,
    closeLeaderboard: closeLeaderboard,
    loadLeaderboard: loadLeaderboard,
    refreshPlayerStats: refreshPlayerStats,
    sorts: SORTS,
    pageSize: PAGE_SIZE,
    formatSol: formatSol,
  });
})(typeof window !== "undefined" ? window : null);
