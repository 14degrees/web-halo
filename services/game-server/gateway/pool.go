package main

/* Pool mode (HALO_MODE=pool): the server takes matches from the matchmaker
(services/signaling/src/matchmaker.ts) instead of keeping an open lobby.

It registers, then heartbeats every two seconds; the heartbeat's answer
carries its assignment: a playlist, a map and the machines of the players.
It hosts that match in a private room, admits only those machines, and
starts when all of them are in. Past the load deadline it starts with
whoever came, if that is two or more, and otherwise voids the match. When
the match ends it reports the end and exits, so the next match gets a fresh
game process (start-servers starts it again and it registers anew). */

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"time"
)

const (
	poolHeartbeatEvery = 2 * time.Second
	// how long the assigned players have to connect and load
	poolLoadDeadline = 45 * time.Second
	// a match everyone has left ends after this long, whatever the game does
	poolEmptyLimit = 30 * time.Second
	// and every match ends by this long after it went live (the playlists
	// are ten minutes)
	poolMatchLimit = 12 * time.Minute
)

type assignment struct {
	MatchID   string   `json:"matchId"`
	Playlist  string   `json:"playlist"`
	MapIndex  int      `json:"mapIndex"`
	ModeIndex int      `json:"modeIndex"`
	Roster    []string `json:"roster"`
}

type poolMatch struct {
	assignment
	readyAt   time.Time
	started   bool
	liveAt    time.Time
	emptyAt   time.Time
	lowered   bool
	endedAt   time.Time
	endReason string
}

func (s *server) poolRegister(ctx context.Context) (string, error) {
	var result struct {
		ServerID string `json:"serverId"`
	}
	for attempt := 0; ; attempt++ {
		callContext, cancel := context.WithTimeout(ctx, 15*time.Second)
		err := s.room.api(callContext, http.MethodPost, "/v1/pool/servers",
			map[string]any{"buildId": s.config.BuildID}, &result)
		cancel()
		if err == nil && result.ServerID != "" {
			return result.ServerID, nil
		}
		if attempt >= 5 || ctx.Err() != nil {
			return "", fmt.Errorf("register with the matchmaker: %w", err)
		}
		time.Sleep(time.Duration(attempt+1) * time.Second)
	}
}

var errDropped = errors.New("the matchmaker no longer knows this server")

func (s *server) poolHeartbeat(ctx context.Context, serverID string) (*assignment, error) {
	s.mu.Lock()
	status := s.status
	s.mu.Unlock()
	var result struct {
		Assignment *assignment `json:"assignment"`
	}
	callContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	err := s.room.api(callContext, http.MethodPost, "/v1/pool/servers/"+url.PathEscape(serverID)+"/heartbeat",
		map[string]any{"matchState": stateName(status.Match), "players": status.Players}, &result)
	if err != nil {
		var refusal *apiError
		if errors.As(err, &refusal) && refusal.status == http.StatusNotFound {
			return nil, errDropped
		}
		return nil, err
	}
	return result.Assignment, nil
}

func (s *server) poolReport(serverID, matchID, action string, body map[string]any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var result map[string]any
	return s.room.api(ctx, http.MethodPost,
		"/v1/pool/servers/"+url.PathEscape(serverID)+"/matches/"+url.PathEscape(matchID)+"/"+action, body, &result)
}

// hostAssignment sets the game up for its match and opens the private room
// the players' invite leads to.
func (s *server) hostAssignment(ctx context.Context, serverID, identifier string, match *poolMatch,
	roomDone chan<- error) error {
	roster := map[string]bool{}
	for _, machine := range match.Roster {
		roster[toLower(machine)] = true
	}
	s.peers.setAllowed(func(machine string) bool { return roster[toLower(machine)] })
	if err := s.link.hostDedicated(match.MapIndex, match.ModeIndex, len(match.Roster),
		s.config.MatchCountdownSeconds, s.config.PostgameSeconds); err != nil {
		return err
	}
	lobby := lobbySettings{MapIndex: match.MapIndex, ModeIndex: match.ModeIndex}
	openContext, cancel := context.WithTimeout(ctx, 30*time.Second)
	socketURL, err := s.room.open(openContext, identifier, lobby, "private")
	cancel()
	if err != nil {
		return fmt.Errorf("open the match's room: %w", err)
	}
	go func() { roomDone <- s.keepRoom(ctx, identifier, socketURL) }()
	s.room.mu.Lock()
	roomID, invite := s.room.id, s.room.invite
	s.room.mu.Unlock()
	if err := s.poolReport(serverID, match.MatchID, "ready", map[string]any{
		"roomId": roomID, "inviteCode": invite,
	}); err != nil {
		return fmt.Errorf("report the room: %w", err)
	}
	match.readyAt = time.Now()
	log.Printf("match %s: %s on map %d for %d players", shortID(match.MatchID), match.Playlist,
		match.MapIndex, len(match.Roster))
	return nil
}

func (s *server) runPool(ctx context.Context, identifier string, gameDone, linkDone <-chan error) error {
	serverID, err := s.poolRegister(ctx)
	if err != nil {
		_ = s.link.stop()
		return err
	}
	log.Printf("in the pool as %s", shortID(serverID))
	var match *poolMatch
	roomDone := make(chan error, 1)
	end := func(reason string) {
		if match == nil || match.endReason != "" {
			return
		}
		match.endReason = reason
		match.endedAt = time.Now()
		if err := s.poolReport(serverID, match.MatchID, "end", map[string]any{"reason": reason}); err != nil {
			log.Printf("report the end: %v", err)
		}
		log.Printf("match %s ended: %s", shortID(match.MatchID), reason)
	}
	finish := func(reason string, err error) error {
		end(reason)
		_ = s.link.stop()
		s.peers.closeAll()
		return err
	}
	ticker := time.NewTicker(poolHeartbeatEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return finish("void: server stopping", nil)
		case err := <-gameDone:
			return finish("void: the game stopped", fmt.Errorf("the game stopped: %v", err))
		case err := <-linkDone:
			return finish("void: the game link failed", fmt.Errorf("game link: %w", err))
		case err := <-roomDone:
			return finish("void: the room link failed", err)
		case <-ticker.C:
		}

		given, err := s.poolHeartbeat(ctx, serverID)
		if errors.Is(err, errDropped) {
			return finish("void: dropped by the matchmaker", err)
		}
		if err != nil {
			log.Printf("heartbeat: %v", err)
		}
		if match == nil && given != nil {
			match = &poolMatch{assignment: *given}
			if err := s.hostAssignment(ctx, serverID, identifier, match, roomDone); err != nil {
				return finish("void: "+err.Error(), err)
			}
		}
		if match == nil {
			continue
		}

		s.mu.Lock()
		status := s.status
		s.mu.Unlock()
		switch {
		case match.endReason != "":
			/* the scores show for the postgame, then the next match gets a
			   fresh server */
			if time.Since(match.endedAt) > time.Duration(s.config.PostgameSeconds+3)*time.Second {
				return finish("", nil)
			}
		case status.Match == matchIngame:
			if !match.started {
				match.started = true
				match.liveAt = time.Now()
			}
			/* the game's own ending can fail to fire on a server with no
			   player of its own: the gateway holds the limits too */
			if status.Players == 0 {
				if match.emptyAt.IsZero() {
					match.emptyAt = time.Now()
				} else if time.Since(match.emptyAt) > poolEmptyLimit {
					end("finished: everyone left")
				}
			} else {
				match.emptyAt = time.Time{}
			}
			if match.endReason == "" && time.Since(match.liveAt) > poolMatchLimit {
				end("finished: time limit")
			}
		case match.started && (status.Match == matchPostgame || status.Match == matchLobby):
			end("finished")
		case !match.started && time.Since(match.readyAt) > poolLoadDeadline:
			/* the load deadline: start with whoever came, or call it off */
			if status.Players >= 2 && !match.lowered {
				match.lowered = true
				log.Printf("load deadline: starting with %d of %d players", status.Players, len(match.Roster))
				_ = s.link.setMinimumPlayers(status.Players)
			} else if status.Players < 2 && time.Since(match.readyAt) > poolLoadDeadline+5*time.Second {
				end("void: players did not load")
			}
		}
	}
}
