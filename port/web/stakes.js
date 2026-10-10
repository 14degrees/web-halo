/* Stakes the player picks (services/signaling/src/matchmaker.ts,
   STAKE_TIERS): what a stake means before anyone commits to it, and the
   pickers that set it. online_client.js runs them; this file is the model
   and the drawing, so it can be tested on its own.

   - A playlist for SOL offers a few stake tiers. A search only matches
     players at the same stake, so each tier is a queue of its own: the
     picker shows who is searching at each, and the few tiers keep the
     queues from splitting too thin.
   - A bounty playlist's kill takes a fifth of the stake from the victim.
   - Team Stakes (and every custom game for SOL) pays the winners the
     losers' stakes less the fee: the team share split evenly, the rest at
     kill pool / kill target a kill. Until the result a kill's worth is a
     projection with even teams (services/signaling/src/wager.ts,
     stakesProjection), so it reads "about".
   - A party's custom game for SOL: the leader sets the stake, kill target
     and team share; every member accepts them before anything is staked. */

;(function installHaloStakes(global) {
  "use strict";

  if (!global || global.HaloStakes) return;

  var LAMPORTS_PER_SOL = 1000000000;
  var DEFAULT_FEE_BPS = 500;
  /* the game types played in two teams (the matchmaker's TEAM_MODES) */
  var TEAM_MODES = [1, 2, 6, 7];
  /* the custom game's choices: kill targets, and team shares in basis points */
  var KILL_TARGETS = [10, 25, 50, 100];
  var TEAM_SHARES = [0, 2500, 5000, 10000];

  /* lamports as SOL, as few places as it needs: 0.05, 0.1, 0.0014 */
  function sol(lamports) {
    var value = Number(lamports) / LAMPORTS_PER_SOL;
    if (!isFinite(value)) return "0";
    return String(Number(value.toFixed(value !== 0 && Math.abs(value) < 0.01 ? 4 : 3)));
  }

  /* wager.ts's stakesProjection: a kill's worth and a winner's even share
     with `players` in even groups */
  function projection(stakes, players, feeBps) {
    var fee = typeof feeBps === "number" ? feeBps : DEFAULT_FEE_BPS;
    var winners = stakes.groups > 0 ? Math.max(1, Math.floor(players / stakes.groups)) : 1;
    var forfeited = stakes.stake * Math.max(0, players - winners);
    var prize = forfeited - Math.floor(forfeited * fee / 10000);
    var teamShare = Math.floor(prize * stakes.teamShareBps / 10000);
    return {
      perKill: Math.floor((prize - teamShare) / stakes.killTarget),
      floor: Math.floor(teamShare / winners),
      prize: prize,
      winners: winners,
    };
  }

  /* What a wager means, for the player before they commit: the stake, a
     kill's worth and the rest in a line. `players` is the match's size
     (a projection assumes it full). */
  function terms(wager, players, feeBps) {
    if (!wager) return null;
    var fee = typeof feeBps === "number" ? feeBps : DEFAULT_FEE_BPS;
    var feeText = (fee / 100) + "% fee on winnings";
    if (wager.mode !== "team" || !wager.stakes) {
      return {
        stake: wager.stake,
        perKill: wager.perKill,
        line: "◎ " + sol(wager.stake) + " SOL stake · ◎ " + sol(wager.perKill) + " a kill · " + feeText,
        detail: "Each kill takes ◎ " + sol(wager.perKill) + " from the victim's stake; you keep what you hold at the end.",
      };
    }
    var size = Math.max(2, players || 2);
    var projected = projection(wager.stakes, size, fee);
    var groups = wager.stakes.groups > 0 ? "your team" : "you";
    return {
      stake: wager.stake,
      perKill: projected.perKill,
      line: "◎ " + sol(wager.stake) + " SOL stake · about ◎ " + sol(projected.perKill) + " a kill · " + feeText,
      detail: "If " + groups + " win" + (groups === "you" ? "" : "s") + ": your stake back, an even " +
        (wager.stakes.teamShareBps / 100) + "% of the prize, and about ◎ " + sol(projected.perKill) +
        " a kill (the kill pool over " + wager.stakes.killTarget + " kills). If " + groups +
        (groups === "you" ? " lose" : " loses") + ", the stake is gone.",
    };
  }

  /* a custom game's wager from the party's terms (the matchmaker's
     customWager) */
  function customWager(customStakes, modeIndex) {
    if (!customStakes) return null;
    return {
      stake: customStakes.stake, perKill: 0, mode: "team",
      stakes: {
        stake: customStakes.stake, killTarget: customStakes.killTarget, teamShareBps: customStakes.teamShareBps,
        groups: TEAM_MODES.indexOf(Number(modeIndex)) >= 0 ? 2 : 0,
      },
    };
  }

  /* the tier among `tiers` at `stake`, else the first */
  function tierAt(tiers, stake) {
    if (!tiers || !tiers.length) return null;
    for (var index = 0; index < tiers.length; index++) if (tiers[index].stake === stake) return tiers[index];
    return null;
  }

  /* ---------- the drawing */

  function element(documentRef, tag, className, text) {
    var node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* A row of choices: each { value, label, note }, the one at `selected`
     marked. `onPick(value)`; disabled for a member who may only look. */
  function renderChoices(container, choices, selected, onPick, disabled) {
    if (!container) return;
    var documentRef = container.ownerDocument || global.document;
    var signature = JSON.stringify([choices, selected, !!disabled]);
    if (container.dataset && container.dataset.signature === signature) return;
    if (container.dataset) container.dataset.signature = signature;
    var buttons = choices.map(function(choice) {
      var button = element(documentRef, "button", "stake-choice");
      button.type = "button";
      button.setAttribute("aria-pressed", choice.value === selected ? "true" : "false");
      button.disabled = !!disabled;
      button.appendChild(element(documentRef, "strong", "", choice.label));
      if (choice.note) button.appendChild(element(documentRef, "small", "", choice.note));
      button.addEventListener("click", function() { if (!disabled) onPick(choice.value); });
      return button;
    });
    container.replaceChildren.apply(container, buttons);
  }

  /* A playlist's tiers: the stake, a kill's worth, and who is searching. */
  function tierChoices(tiers, players, feeBps) {
    return (tiers || []).map(function(tier) {
      var described = terms(tier, players, feeBps);
      return {
        value: tier.stake,
        label: "◎ " + sol(tier.stake),
        note: (tier.mode === "team" ? "~" : "") + "◎ " + sol(described.perKill) + "/kill" +
          (tier.searching ? " · " + tier.searching + " searching" : ""),
      };
    });
  }

  /* A custom game's stake (Free, or a tier), kill target and team share. */
  function customChoices(tiers) {
    return {
      stake: [{ value: null, label: "Free", note: "no SOL" }].concat((tiers || []).map(function(stake) {
        return { value: stake, label: "◎ " + sol(stake), note: "each" };
      })),
      killTarget: KILL_TARGETS.map(function(target) { return { value: target, label: String(target), note: "kills" }; }),
      teamShare: TEAM_SHARES.map(function(share) { return { value: share, label: (share / 100) + "%", note: "even" }; }),
    };
  }

  global.HaloStakes = {
    sol: sol,
    projection: projection,
    terms: terms,
    customWager: customWager,
    tierAt: tierAt,
    tierChoices: tierChoices,
    customChoices: customChoices,
    renderChoices: renderChoices,
    KILL_TARGETS: KILL_TARGETS,
    TEAM_SHARES: TEAM_SHARES,
  };
})(typeof window !== "undefined" ? window : null);
