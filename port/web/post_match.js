/* The post-match lobby: the carnage report, a vote for the next game, a
   timer and the choice to stay or leave, shown in the lobby after every
   public match (port/web/online_client.js runs it; this file is the model
   and the drawing, so it can be tested on its own).

   Who plays next, and where the vote goes:

   - a matchmade match: its server leaves the pool when the match ends, so
     the players who stay queue again when the timer runs out, each with the
     vote's winner on their ticket; the matchmaker plays the plurality's
     game (services/signaling/src/vote.ts). The votes are kept on the ended
     match's tickets, so everyone's poll shows the tally.
   - a party: the same, through the leader, who starts the party again
     (its custom game with the winner's map, or its playlist with the
     winner on every ticket). A member who leaves leaves the party.
   - a player-hosted public room: the host's game comes back to its lobby
     and starts the next match on its own. Guests send their pick to the
     host through the room; the host tallies, tells everyone, and sets the
     winner as the next game. A guest who leaves leaves the room.
   - a match for SOL: nothing is staked again unless the player presses
     Play again; when the timer runs out without that, they stay in the
     lobby, out of the queue. */

;(function installHaloPostMatch(global) {
  "use strict";

  if (!global || global.HaloPostMatch) return;

  var MAP_COUNT = 13;
  var OFFERS = 3;

  /* The games offered for the next match, the same on every player's page
     with no message between them: a playlist offers the three rotation
     entries after the one just played; anything else (a custom game, a
     player-hosted room) offers the map just played and the next two maps
     in the same game type. */
  function offers(played, rotation) {
    var list = [];
    var seen = {};
    var push = function(mapIndex, modeIndex) {
      var key = mapIndex + ":" + modeIndex;
      if (seen[key] || list.length >= OFFERS) return;
      seen[key] = true;
      list.push([mapIndex, modeIndex]);
    };
    var maps = rotation && Array.isArray(rotation.maps) ? rotation.maps : null;
    var modes = rotation && Array.isArray(rotation.modes) ? rotation.modes : null;
    if (maps && modes && maps.length && maps.length === modes.length) {
      var at = -1;
      for (var index = 0; index < maps.length; index++) {
        if (maps[index] === played.mapIndex && modes[index] === played.modeIndex) { at = index; break; }
      }
      for (var step = 1; step <= maps.length && list.length < OFFERS; step++) {
        var entry = (at + step) % maps.length;
        push(maps[entry], modes[entry]);
      }
      /* a rotation of one: the next match is that game again */
      if (!list.length) push(maps[0], modes[0]);
      return list;
    }
    for (var offset = 0; offset < OFFERS; offset++) {
      push((played.mapIndex + offset) % MAP_COUNT, played.modeIndex);
    }
    return list;
  }

  /* the index of a game among the offers, or -1 */
  function offerIndex(list, mapIndex, modeIndex) {
    for (var index = 0; index < list.length; index++) {
      if (list[index][0] === mapIndex && list[index][1] === modeIndex) return index;
    }
    return -1;
  }

  /* The matchmaker's tally ([{mapIndex, modeIndex, votes}]) as votes per
     offer. */
  function tally(list, votes) {
    var counts = list.map(function() { return 0; });
    (votes || []).forEach(function(entry) {
      var index = offerIndex(list, entry.mapIndex, entry.modeIndex);
      if (index >= 0) counts[index] += entry.votes;
    });
    return counts;
  }

  /* The winning offer (the first of equals), or null when nobody voted. */
  function winner(list, counts) {
    var best = -1;
    for (var index = 0; index < list.length; index++) {
      if (counts[index] > 0 && (best < 0 || counts[index] > counts[best])) best = index;
    }
    return best < 0 ? null : list[best];
  }

  /* The report's rows from the game's scoreboard (platform_web_scoreboard:
     name, team, score, kills, deaths, quit) with, in a match for SOL, each
     player's money from the wager's view: in place order, a team's players
     under their team. */
  function rows(board, wager, stake) {
    if (!board || !Array.isArray(board.players)) return [];
    var money = {};
    if (wager && Array.isArray(wager.players)) {
      wager.players.forEach(function(player) {
        var settled = wager.state === "settled";
        var payout = player.payout === null || player.payout === undefined ? player.balance : player.payout;
        money[player.name] = {
          settled: settled,
          /* what they took home over their stake, once settled; in a bounty
             match their running total meanwhile */
          net: settled ? payout - (typeof stake === "number" ? stake : wager.stake) : player.net,
          killShare: player.killShare,
          evenShare: player.evenShare,
        };
      });
    }
    var players = board.players.map(function(row) {
      return {
        name: row[0], team: row[1], score: row[2], kills: row[3], deaths: row[4], quit: !!row[5],
        self: row[0] === board.self, money: money[row[0]] || null,
      };
    });
    var byScore = function(left, right) {
      return left.quit - right.quit || right.score - left.score || right.kills - left.kills || left.name.localeCompare(right.name);
    };
    var out = [];
    if (board.teams) {
      var teams = [{ index: 0, name: "Red Team", score: board.red }, { index: 1, name: "Blue Team", score: board.blue }];
      teams.sort(function(left, right) { return right.score - left.score || left.index - right.index; });
      teams.forEach(function(team, order) {
        var place = order > 0 && team.score === teams[0].score ? 1 : order + 1;
        out.push({ team: team.index, name: team.name, score: team.score, place: place, header: true });
        players.filter(function(player) { return player.team === team.index; }).sort(byScore)
          .forEach(function(player) { player.place = place; out.push(player); });
      });
      /* anyone on neither team (a spectator's slot) last */
      players.filter(function(player) { return player.team !== 0 && player.team !== 1; }).sort(byScore)
        .forEach(function(player) { out.push(player); });
      return out;
    }
    players.sort(byScore);
    var place = 0;
    players.forEach(function(player, index) {
      if (index === 0 || player.score !== players[index - 1].score) place = index + 1;
      player.place = player.quit ? null : place;
      out.push(player);
    });
    return out;
  }

  function secondsLeft(model, now) {
    return Math.max(0, Math.ceil(model.seconds - (now - model.since) / 1000));
  }

  function solLabel(money) {
    var sign = money.net > 0 ? "+" : money.net < 0 ? "−" : "";
    return sign + (Math.abs(money.net) / 1e9).toFixed(3);
  }

  /* what the status line says */
  function status(model, now) {
    var left = secondsLeft(model, now);
    if (model.stay === false) {
      return model.wagered ? "Match over. Nothing is staked for the next one unless you press Play again." :
        "Match over. You're leaving when the timer runs out.";
    }
    if (model.kind === "hosted") return "Match over. The next one starts in this room when the timer runs out; the vote picks the map.";
    if (model.kind === "guest") return "Match over. You're staying for this room's next match; vote for its map.";
    if (model.kind === "party") {
      return model.leader ? "Match over. Your party plays again when the timer runs out; the vote picks the map." :
        "Match over. Your party plays again when the leader starts it; vote for the map.";
    }
    return "Match over. You're searching again in " + left + " s, with the vote's map first.";
  }

  /* Draw the panel into its elements (an element may be missing: a page
     without the panel draws nothing). `actions` are vote(index), stay()
     and leave(). */
  function render(elements, model, now, names, actions) {
    var root = elements.root;
    if (!root) return;
    if (!model) {
      if (!root.hidden) root.hidden = true;
      root.dataset.key = "";
      return;
    }
    var left = secondsLeft(model, now);
    var reportRows = rows(model.board, model.wagerView, model.wagered ? model.wagered.stake : undefined);
    var key = JSON.stringify([left, model.offers, model.votes, model.myVote, model.stay, model.decided, reportRows,
      model.kind, model.leader, model.wagered]);
    if (root.hidden) root.hidden = false;
    if (root.dataset.key === key) return;
    root.dataset.key = key;
    var canBuild = typeof document !== "undefined" && typeof document.createElement === "function";

    if (elements.timer) elements.timer.textContent = String(left);
    if (elements.title) {
      elements.title.textContent = model.board && model.board.teams ?
        (model.board.red === model.board.blue ? "Tie game" : (model.board.red > model.board.blue ? "Red" : "Blue") + " team wins") :
        "Match over";
    }
    if (elements.board && canBuild) {
      var body = [];
      var hasMoney = reportRows.some(function(row) { return row.money; });
      reportRows.forEach(function(row) {
        var line = document.createElement("tr");
        line.className = row.header ? "pm-team pm-team-" + (row.team === 0 ? "red" : "blue") :
          (row.team === 0 ? "pm-red" : row.team === 1 ? "pm-blue" : "pm-solo") + (row.quit ? " pm-quit" : "") + (row.self ? " pm-self" : "");
        var cells = [row.place === null || row.place === undefined ? (row.quit ? "–" : "") : String(row.place), row.name,
          String(row.score), row.header ? "" : String(row.kills), row.header ? "" : String(row.deaths)];
        if (hasMoney) cells.push(row.header || !row.money ? "" : row.money.settled ? solLabel(row.money) + " SOL" : "settling…");
        cells.forEach(function(text, index) {
          var cell = document.createElement("td");
          cell.textContent = text;
          if (index === 1 && row.self) cell.dataset.self = "true";
          line.appendChild(cell);
        });
        body.push(line);
      });
      elements.board.replaceChildren.apply(elements.board, body);
      if (elements.moneyHead) elements.moneyHead.hidden = !hasMoney;
    }
    if (elements.vote && canBuild) {
      var buttons = model.offers.map(function(offer, index) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "pm-offer";
        if (model.myVote === index) button.dataset.mine = "true";
        var label = document.createElement("span");
        label.textContent = names.map(offer[0]) + " · " + names.mode(offer[1]);
        var count = document.createElement("small");
        var votes = model.votes[index] || 0;
        count.textContent = votes === 1 ? "1 vote" : votes + " votes";
        button.append(label, count);
        button.addEventListener("click", function() { actions.vote(index); });
        return button;
      });
      elements.vote.replaceChildren.apply(elements.vote, buttons);
    }
    if (elements.stay) {
      elements.stay.textContent = model.wagered ?
        (model.stay ? "Playing again for " + (model.wagered.stake / 1e9).toFixed(3) + " SOL" :
          "Play again for " + (model.wagered.stake / 1e9).toFixed(3) + " SOL") :
        model.stay ? "Staying" : "Stay";
      elements.stay.disabled = !!model.stay;
      elements.stay.hidden = model.kind === "party" && !model.leader && !model.wagered;
    }
    if (elements.leave) {
      elements.leave.textContent = model.kind === "party" ? "Leave party" : model.stay === false ? "Leaving…" : "Leave";
      elements.leave.disabled = model.stay === false;
    }
    if (elements.note) elements.note.textContent = status(model, now);
  }

  global.HaloPostMatch = Object.freeze({
    OFFERS: OFFERS,
    offers: offers,
    offerIndex: offerIndex,
    tally: tally,
    winner: winner,
    rows: rows,
    secondsLeft: secondsLeft,
    status: status,
    render: render,
  });
})(typeof window !== "undefined" ? window : null);
