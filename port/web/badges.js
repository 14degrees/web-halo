/* Badges beside a player's name (services/signaling/src/badges.ts): the
   links they chose to show, verified. The room puts them on its roster and
   chat lines, and the party on its members and chat lines, from the wallet
   each player signed in with, so a page can't name its own. Shown in the
   lobby's player list, the room's player sidebar, the scoreboard, the
   carnage report and the lobby chat. online_client.js and chat.js draw
   them; this file is the model and the drawing, so it can be tested on its
   own.

   - fomo: a fomo wallet the player proved. With a handle an admin
     confirmed, it opens their fomo.family profile; without one it reads
     "fomo wallet" and links nowhere.
   - X: the account the player proved with a post; it opens their x.com
     profile.

   Links open in a new tab without handing this page to it (noopener). */

;(function installHaloBadges(global) {
  "use strict";

  if (!global || global.HaloBadges) return;

  /* the server's patterns (fomo_handle.ts, x.ts) */
  var FOMO_HANDLE = /^[A-Za-z0-9_.]{1,30}$/;
  var X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

  /* A player's links as a message carries them, checked, or null when
     there are none. */
  function normalize(value) {
    if (!value || typeof value !== "object") return null;
    var out = {};
    var fomo = value.fomo;
    if (fomo && typeof fomo === "object") {
      out.fomo = { handle: typeof fomo.handle === "string" && FOMO_HANDLE.test(fomo.handle) ? fomo.handle : null };
    }
    var x = value.x;
    if (x && typeof x === "object" && typeof x.handle === "string" && X_HANDLE.test(x.handle)) {
      out.x = { handle: x.handle };
    }
    return out.fomo || out.x ? out : null;
  }

  /* what a badge shows and where it goes */
  function badges(links) {
    var list = [];
    if (!links) return list;
    if (links.fomo) {
      list.push(links.fomo.handle ? {
        kind: "fomo", text: "fomo", title: "@" + links.fomo.handle + " on fomo",
        href: "https://fomo.family/profile/" + encodeURIComponent(links.fomo.handle),
      } : { kind: "fomo", text: "fomo", title: "fomo wallet", href: null });
    }
    if (links.x) {
      list.push({
        kind: "x", text: "𝕏", title: "@" + links.x.handle + " on X",
        href: "https://x.com/" + encodeURIComponent(links.x.handle),
      });
    }
    return list;
  }

  /* a short, stable form for a list's signature */
  function key(links) {
    return badges(links).map(function(badge) { return badge.kind + ":" + (badge.href || ""); }).join(",");
  }

  /* The badges as one element to put after a name, or null when there are
     none. A click opens the profile and goes no further (a row or a name
     under it may have its own click). */
  function element(links) {
    var list = badges(links);
    if (!list.length || typeof document === "undefined" || typeof document.createElement !== "function") return null;
    var holder = document.createElement("span");
    holder.className = "player-badges";
    list.forEach(function(badge) {
      var node = document.createElement(badge.href ? "a" : "span");
      node.className = "player-badge player-badge-" + badge.kind;
      node.textContent = badge.text;
      node.title = badge.title;
      if (badge.href) {
        node.href = badge.href;
        node.target = "_blank";
        node.rel = "noopener noreferrer";
        if (typeof node.addEventListener === "function") {
          node.addEventListener("click", function(event) { if (event && event.stopPropagation) event.stopPropagation(); });
        }
      }
      holder.appendChild(node);
    });
    return holder;
  }

  /* the links of everyone on a roster, by the name they play under (the
     scoreboard's and the carnage report's) */
  function byName(roster) {
    var out = {};
    if (!roster || typeof roster.forEach !== "function") return out;
    roster.forEach(function(entry) {
      if (entry && entry.links && entry.profile && entry.profile.name) out[entry.profile.name] = entry.links;
    });
    return out;
  }

  global.HaloBadges = Object.freeze({
    normalize: normalize,
    badges: badges,
    key: key,
    element: element,
    byName: byName,
  });
})(typeof window !== "undefined" ? window : null);
