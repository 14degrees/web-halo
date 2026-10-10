/* The path from loading to playing: what the page shows between a click
   and the first frame of a match (port/web/online_client.js calls update()
   every tick; this file is the model and the drawing, so it can be tested
   on its own).

   - the boot: while Halo downloads and starts, the landing repeats the
     loading panel's words and bar (shell.html's #loading-label and
     #progress), so the loading screen runs on into the landing
   - a matchmade match, in the lobby: the steps from a found match to
     playing (match found, server, joining, map), with a bar and an
     estimate while a server starts (services/signaling/src/matchmaker.ts:
     a queued ticket's serverStarting, then the match's assigning state)
   - a multiplayer map loading in a game: a bar with the map's name and
     how far it is (platform_web_map_load_progress), wherever the lobby is
     not showing it already

   The estimates are typical times, not promises: a bar that has run past
   its estimate slows and waits rather than filling. With reduced motion
   the bars still fill, but nothing pulses and the menu films stay still. */

;(function installHaloLoading(global) {
  "use strict";

  if (!global || global.HaloLoading) return;

  /* the steps a matchmade player sees, in order */
  var STEPS = ["Match found", "Server", "Joining", "Map"];

  /* typical seconds for each stage: a machine's boot and the game server's
     registration (the autoscaler, matchmaker.ts), a server opening its
     room (heartbeats every 2 s; ASSIGNING_TIMEOUT_MS is 30 s), locking the
     stakes on Solana, and connecting to the room */
  var ESTIMATES = Object.freeze({ boot: 45, open: 8, stake: 20, join: 6 });

  /* the game's map files, by platform_web_map_load_index
     (port/web/src/web_platform.c, map_files); the first ten are the
     campaign's, which shell.html's campaign bar shows */
  var MAP_FILES = [
    "a10", "a30", "a50", "b30", "b40", "c10", "c20", "c40", "d20", "d40",
    "beavercreek", "bloodgulch", "boardingaction", "carousel", "chillout", "damnation",
    "hangemhigh", "longest", "prisoner", "putput", "ratrace", "sidewinder", "ui", "wizard",
  ];
  var CAMPAIGN_MAPS = 10;
  var MAP_TITLES = Object.freeze({
    beavercreek: "Battle Creek", bloodgulch: "Blood Gulch", boardingaction: "Boarding Action",
    carousel: "Derelict", chillout: "Chill Out", damnation: "Damnation", hangemhigh: "Hang 'Em High",
    longest: "Longest", prisoner: "Prisoner", putput: "Chiron TL-34", ratrace: "Rat Race",
    sidewinder: "Sidewinder", wizard: "Wizard",
  });

  /* a multiplayer map loading, from the game's progress and index; null
     for none, a campaign mission, or the menu's own map */
  function mapLoad(progress, index) {
    if (typeof progress !== "number" || !(progress >= 0) || typeof index !== "number") return null;
    if (index < CAMPAIGN_MAPS || index >= MAP_FILES.length) return null;
    var title = MAP_TITLES[MAP_FILES[index]];
    if (!title) return null;
    return { title: title, progress: Math.max(0, Math.min(1, progress)) };
  }

  /* a timed stage: a bar that reaches 90% at its estimate and then slows,
     and the seconds left by the estimate (0 once past it) */
  function timed(elapsedSeconds, estimate) {
    var elapsed = Math.max(0, elapsedSeconds);
    return {
      progress: Math.min(0.97, 1 - Math.exp(-2.3 * elapsed / estimate)),
      eta: Math.max(0, Math.ceil(estimate - elapsed)),
    };
  }

  /* The stage from the ticket, the session and the map: its key (a change
     restarts its clock), its step, its words, and how far along it is.
     input: { queue: { state, serverStarting, staking, custom } | null,
     session: { active, connected } | null, map: mapLoad() | null } */
  function stage(input) {
    var queue = input && input.queue;
    var session = input && input.session;
    var map = input && input.map;
    if (session && session.active) {
      if (map) {
        return { key: "map", step: 3, label: "Loading " + map.title, detail: "",
          progress: map.progress, estimate: 0 };
      }
      if (!session.connected) {
        return { key: "join", step: 2, label: "Joining the server",
          detail: "Connecting to the match.", progress: null, estimate: ESTIMATES.join };
      }
      return null;
    }
    if (!queue) return null;
    if (queue.state === "queued" && queue.serverStarting) {
      return { key: "boot", step: 1, label: "Starting a server",
        detail: "Every server is busy, so a new one is starting. This usually takes under a minute.",
        progress: null, estimate: ESTIMATES.boot };
    }
    if ((queue.state === "assigning" || queue.state === "ready") && queue.staking) {
      return { key: "stake", step: 1, label: "Locking stakes",
        detail: "Every player's stake goes into escrow on Solana before the match opens.",
        progress: null, estimate: ESTIMATES.stake };
    }
    if (queue.state === "assigning") {
      return { key: "open", step: 1, label: queue.custom ? "Setting up your custom game" : "Starting the server",
        detail: "The server is opening a private room for your match.", progress: null, estimate: ESTIMATES.open };
    }
    if (queue.state === "ready") {
      return { key: "join", step: 2, label: "Joining the server",
        detail: "Connecting to the match.", progress: null, estimate: ESTIMATES.join };
    }
    return null;
  }

  /* A stage with its clock: each new key starts again from now. The view
     adds the bar's fraction and the estimate's seconds left. */
  function tracker() {
    var current = null;
    var since = 0;
    return {
      update: function(input, now) {
        var next = stage(input);
        if (!next) {
          current = null;
          return null;
        }
        if (!current || current.key !== next.key) since = now;
        current = next;
        var view = { key: next.key, step: next.step, label: next.label, detail: next.detail,
          progress: next.progress, eta: null };
        if (next.progress === null && next.estimate) {
          var clock = timed((now - since) / 1000, next.estimate);
          view.progress = clock.progress;
          view.eta = clock.eta;
        }
        return view;
      },
    };
  }

  /* the words beside the bar: a percentage, or the estimate's seconds */
  function valueText(view) {
    if (!view) return "";
    if (view.eta === null) return Math.round(view.progress * 100) + "%";
    return view.eta > 0 ? "About " + view.eta + " s" : "Almost there";
  }

  /* ---------- the drawing: a meter (.halo-meter, shell.html) built inside
     its container the first time, then only its text and bar change */

  function part(parent, tag, className) {
    var node = document.createElement(tag);
    node.className = className;
    parent.appendChild(node);
    return node;
  }

  function build(container, withSteps) {
    if (container.haloMeter) return container.haloMeter;
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
    var meter = {};
    if (withSteps) {
      meter.steps = part(container, "ol", "halo-steps");
      meter.steps.setAttribute("aria-hidden", "true");
      meter.stepItems = STEPS.map(function(name) {
        var item = part(meter.steps, "li", "");
        item.textContent = name;
        return item;
      });
    }
    var head = part(container, "div", "halo-meter-head");
    /* the words are the live region; the numbers change too often to read out */
    meter.label = part(head, "span", "halo-meter-label");
    meter.value = part(head, "span", "halo-meter-value");
    meter.value.setAttribute("aria-hidden", "true");
    meter.bar = part(container, "progress", "halo-meter-bar");
    meter.bar.max = 100;
    meter.detail = part(container, "p", "halo-meter-detail");
    container.haloMeter = meter;
    return meter;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  /* draws a view ({ label, detail, progress (0..1, or null for a bar that
     only waits), value, step }) into a container, or hides it for null */
  function draw(container, view, withSteps) {
    if (!container) return;
    if (!view) {
      if (!container.hidden) container.hidden = true;
      return;
    }
    var meter = build(container, withSteps);
    if (container.hidden) container.hidden = false;
    if (!meter) return;
    setText(meter.label, view.label);
    setText(meter.value, view.value || "");
    setText(meter.detail, view.detail || "");
    if (meter.detail) meter.detail.hidden = !view.detail;
    if (view.progress === null || view.progress === undefined) {
      meter.bar.removeAttribute("value");
      meter.bar.setAttribute("aria-label", view.label);
    } else {
      var percent = Math.round(view.progress * 100);
      if (meter.bar.value !== percent) meter.bar.value = percent;
      meter.bar.setAttribute("aria-label", view.label);
    }
    if (meter.stepItems) {
      meter.stepItems.forEach(function(item, index) {
        var state = index < view.step ? "done" : index === view.step ? "current" : "next";
        if (item.dataset.state !== state) item.dataset.state = state;
      });
    }
  }

  /* ---------- the page */

  var page = { tracker: tracker(), motionWatched: false };

  function byId(id) {
    return typeof document !== "undefined" && typeof document.getElementById === "function" ?
      document.getElementById(id) : null;
  }

  function moduleNumber(name) {
    try {
      var fn = global.Module && global.Module["_" + name];
      return typeof fn === "function" ? Number(fn()) : null;
    } catch (error) {
      return null;
    }
  }

  /* reduced motion: the menu films hold still (their first frame shows) */
  function watchMotion() {
    if (page.motionWatched) return;
    page.motionWatched = true;
    if (typeof global.matchMedia !== "function" || typeof document.querySelectorAll !== "function") return;
    var query = global.matchMedia("(prefers-reduced-motion: reduce)");
    var apply = function() {
      Array.prototype.forEach.call(document.querySelectorAll("video.lobby-film"), function(film) {
        if (query.matches) {
          film.removeAttribute("autoplay");
          if (typeof film.pause === "function") film.pause();
        } else if (film.paused && typeof film.play === "function") {
          film.play().catch(function() {});
        }
      });
    };
    apply();
    if (typeof query.addEventListener === "function") query.addEventListener("change", apply);
  }

  /* While Halo starts, the landing shows the loading panel's own words and
     bar under its Loading Halo; null once it has started. */
  function bootView(runtimeReady) {
    if (runtimeReady) return null;
    var label = byId("loading-label");
    var bar = byId("progress");
    var text = (label && label.textContent) || "Loading Halo…";
    var known = bar && !bar.hidden && bar.max > 0;
    return { label: text, detail: "", step: 0,
      progress: known ? Math.max(0, Math.min(1, bar.value / bar.max)) : null,
      value: known ? Math.round(100 * bar.value / bar.max) + "%" : "" };
  }

  /* Every tick (online_client.js): context is { runtimeReady, queue, session,
     lobbyOpen }, as stage() takes them; lobbyOpen says the lobby (#lobby)
     is on screen, where its panel shows the map's load. */
  function update(context, now) {
    var at = typeof now === "number" ? now : Date.now();
    watchMotion();
    var ready = !!(context && context.runtimeReady);
    var inSession = !!(context && context.session && context.session.active);
    var map = inSession ? mapLoad(moduleNumber("platform_web_map_load_progress"),
      moduleNumber("platform_web_map_load_index")) : null;
    var view = page.tracker.update({
      queue: context && context.queue, session: context && context.session, map: map,
    }, at);
    var lobbyOpen = !!(context && context.lobbyOpen);
    var lobbyView = view && lobbyOpen ? view : null;
    if (lobbyView) lobbyView.value = valueText(view);
    draw(byId("lobby-progress"), lobbyView, true);
    /* outside the lobby (the landing's Quick Play, the game): the map's bar alone */
    var mapView = map && !lobbyOpen ? { label: "Loading " + map.title, detail: "", step: 3,
      progress: map.progress, value: Math.round(map.progress * 100) + "%" } : null;
    draw(byId("map-loading"), mapView, false);
    draw(byId("landing-boot"), bootView(ready), false);
    return view;
  }

  global.HaloLoading = Object.freeze({
    STEPS: STEPS,
    ESTIMATES: ESTIMATES,
    mapLoad: mapLoad,
    timed: timed,
    stage: stage,
    tracker: tracker,
    valueText: valueText,
    draw: draw,
    update: update,
  });
})(typeof window !== "undefined" ? window : this);
