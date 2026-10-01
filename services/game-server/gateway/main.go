// Command halo-gateway runs one native Halo dedicated server (halo-server,
// `ninja server`) and connects it to the browsers: it opens the server's
// public room on the signaling Worker, carries the guests' WebRTC
// DataChannels to the game over a local socket, drives the lobby (countdown,
// map rotation), and reports the server's kills to the room. See
// services/game-server/README.md.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var mapNames = []string{
	"beavercreek", "sidewinder", "damnation", "ratrace", "prisoner",
	"hangemhigh", "chillout", "carousel", "boardingaction", "bloodgulch",
	"wizard", "putput", "longest",
}
var modeNames = []string{"slayer", "team_slayer", "ctf", "oddball", "king", "race"}
var matchStateNames = []string{"none", "lobby", "countdown", "ingame", "postgame"}

const (
	matchLobby     = 1
	matchCountdown = 2
	matchIngame    = 3
	matchPostgame  = 4
)

type config struct {
	SignalingURL      string
	Origin            string
	ServiceToken      string
	BuildID           string
	GameBinary        string
	DataRoot          string
	SaveRoot          string
	LinkPath          string
	HostName          string
	Rotation          []lobbySettings
	MinimumPlayers    int
	CountdownSeconds  int
	PostgameSeconds   int
	StatusAddress     string
	UDPHost           string
	UDPPort           int
	PublicIP          string
	RestartForWaiting bool
}

func environment(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func integer(name string, fallback, minimum, maximum int) (int, error) {
	text := os.Getenv(name)
	if text == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(text)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be an integer from %d to %d", name, minimum, maximum)
	}
	return value, nil
}

func indexOf(text string, names []string, kind string) (int, error) {
	text = strings.ToLower(strings.TrimSpace(text))
	if value, err := strconv.Atoi(text); err == nil && value >= 0 && value < len(names) {
		return value, nil
	}
	for index, name := range names {
		if name == strings.ReplaceAll(text, "-", "") || name == strings.ReplaceAll(text, "-", "_") {
			return index, nil
		}
	}
	return 0, fmt.Errorf("unknown %s %q (one of %s)", kind, text, strings.Join(names, ", "))
}

// parseRotation reads "hangemhigh:slayer,bloodgulch" (a map alone plays
// slayer), as services/dedicated-host did.
func parseRotation(text string) ([]lobbySettings, error) {
	if strings.TrimSpace(text) == "" {
		return []lobbySettings{{MapIndex: 9, ModeIndex: 0}}, nil
	}
	var rotation []lobbySettings
	for _, entry := range strings.Split(text, ",") {
		parts := strings.SplitN(entry, ":", 2)
		mapIndex, err := indexOf(parts[0], mapNames, "map")
		if err != nil {
			return nil, err
		}
		modeIndex := 0
		if len(parts) == 2 {
			if modeIndex, err = indexOf(parts[1], modeNames, "mode"); err != nil {
				return nil, err
			}
		}
		rotation = append(rotation, lobbySettings{MapIndex: mapIndex, ModeIndex: modeIndex})
	}
	return rotation, nil
}

func loadConfig() (*config, error) {
	c := &config{
		SignalingURL:      strings.TrimRight(environment("HALO_SIGNALING_URL", ""), "/"),
		Origin:            strings.TrimRight(environment("HALO_GAME_ORIGIN", ""), "/"),
		ServiceToken:      environment("HALO_HOST_SERVICE_TOKEN", ""),
		BuildID:           environment("HALO_BUILD_ID", "web-multiplayer-v1"),
		GameBinary:        environment("HALO_SERVER_BINARY", "/opt/halo/halo-server"),
		DataRoot:          environment("HALO_DATA_ROOT", "/data"),
		SaveRoot:          environment("HALO_SAVE_ROOT", "/tmp/halo-save"),
		LinkPath:          environment("HALO_SERVER_LINK", filepath.Join(os.TempDir(), fmt.Sprintf("halo-link-%d.sock", os.Getpid()))),
		HostName:          environment("HALO_HOST_NAME", "Server"),
		StatusAddress:     environment("HALO_STATUS_ADDRESS", ":"+environment("PORT", "8790")),
		RestartForWaiting: environment("HALO_RESTART_FOR_WAITING", "true") == "true",
	}
	if c.SignalingURL == "" {
		return nil, errors.New("HALO_SIGNALING_URL must name the signaling Worker")
	}
	/* the Worker admits only its game site's pages */
	if c.Origin == "" {
		return nil, errors.New("HALO_GAME_ORIGIN must name the game site (the Worker's ALLOWED_ORIGINS)")
	}
	if len(c.ServiceToken) < 32 {
		return nil, errors.New("HALO_HOST_SERVICE_TOKEN must hold the Worker's HOST_SERVICE_TOKEN")
	}
	var err error
	if c.Rotation, err = parseRotation(os.Getenv("HALO_LOBBY_ROTATION")); err != nil {
		return nil, err
	}
	if c.MinimumPlayers, err = integer("HALO_LOBBY_MIN_PLAYERS", 1, 1, 127); err != nil {
		return nil, err
	}
	if c.CountdownSeconds, err = integer("HALO_LOBBY_COUNTDOWN_SECONDS", 20, 0, 255); err != nil {
		return nil, err
	}
	if c.PostgameSeconds, err = integer("HALO_LOBBY_POSTGAME_SECONDS", 15, 0, 255); err != nil {
		return nil, err
	}
	if c.UDPPort, err = integer("HALO_WEBRTC_UDP_PORT", 0, 0, 65535); err != nil {
		return nil, err
	}
	c.UDPHost = environment("HALO_WEBRTC_UDP_HOST", "")
	c.PublicIP = environment("HALO_PUBLIC_IP", "")
	if c.PublicIP != "" && net.ParseIP(c.PublicIP) == nil {
		return nil, errors.New("HALO_PUBLIC_IP must be an IP address")
	}
	return c, nil
}

// server is one game process and its room.
type server struct {
	config     *config
	link       *gameLink
	room       *room
	peers      *peerSet
	identifier chan string

	mu            sync.Mutex
	status        gameStatus
	rotationIndex int
	gamesPlayed   int
	lastMatch     int
	matchSince    time.Time
	sentMatch     string
	sentMatchAt   time.Time
	started       time.Time
	kills         int
}

func (s *server) gameHello(identifier string) {
	select {
	case s.identifier <- identifier:
	default:
	}
}

func (s *server) gameFrame(address uint32, reliable bool, frame []byte) {
	s.peers.send(address, reliable, frame)
}

func (s *server) gameKill(killer, victim string) {
	s.mu.Lock()
	s.kills++
	s.mu.Unlock()
	log.Printf("kill: %s killed %s", killer, victim)
	if !s.room.send(map[string]any{"type": "kill", "killer": killer, "victim": victim}) {
		log.Printf("kill not reported: the room link is down")
	}
}

func (s *server) gameStatus(status gameStatus) {
	s.mu.Lock()
	previous := s.lastMatch
	s.status = status
	s.lastMatch = status.Match
	if status.Match != matchIngame {
		s.matchSince = time.Time{}
	} else if s.matchSince.IsZero() {
		s.matchSince = time.Now()
	}
	s.mu.Unlock()
	if status.Match != previous {
		log.Printf("match: %s (%d players)", stateName(status.Match), status.Players)
		/* the report has come up: the game just ended */
		if status.Match == matchPostgame {
			s.advanceRotation()
		}
	}
	s.broadcastMatch(status)
	s.restartForWaiting(status)
}

func stateName(state int) string {
	if state >= 0 && state < len(matchStateNames) {
		return matchStateNames[state]
	}
	return "unknown"
}

// broadcastMatch tells the guests where the match is: on a change, and
// every few seconds so a newcomer learns it promptly.
func (s *server) broadcastMatch(status gameStatus) {
	if status.Match < matchLobby || status.Match > matchPostgame {
		return
	}
	message := map[string]any{"type": "match", "state": matchStateNames[status.Match]}
	key := matchStateNames[status.Match]
	if status.Match == matchCountdown && status.Countdown >= 0 {
		message["startsIn"] = status.Countdown
		key += ":" + strconv.Itoa(status.Countdown)
	}
	s.mu.Lock()
	if key == s.sentMatch && time.Since(s.sentMatchAt) < 3*time.Second {
		s.mu.Unlock()
		return
	}
	s.sentMatch, s.sentMatchAt = key, time.Now()
	s.mu.Unlock()
	s.room.send(message)
}

// restartForWaiting ends a match that has run a minute when someone is
// waiting to join (system link admits nobody mid-match). The matchmaker
// replaces this once matches are wagered (docs: no mid-match restarts).
func (s *server) restartForWaiting(status gameStatus) {
	if !s.config.RestartForWaiting || status.Match != matchIngame {
		return
	}
	s.mu.Lock()
	since := s.matchSince
	s.mu.Unlock()
	if since.IsZero() || time.Since(since) < time.Minute || s.room.waitingCount() == 0 {
		return
	}
	s.room.clearWaiting()
	s.mu.Lock()
	s.matchSince = time.Now()
	s.mu.Unlock()
	log.Printf("ending the match for a player waiting to join")
	_ = s.link.requestRestart()
}

func (s *server) advanceRotation() {
	s.mu.Lock()
	s.gamesPlayed++
	s.rotationIndex = (s.rotationIndex + 1) % len(s.config.Rotation)
	next := s.config.Rotation[s.rotationIndex]
	s.mu.Unlock()
	_ = s.link.setNextGame(next.MapIndex, next.ModeIndex)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := s.room.renew(ctx, &next); err != nil {
			log.Printf("renew: %v", err)
		}
	}()
}

func (s *server) statusJSON() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	lobby := s.config.Rotation[s.rotationIndex]
	s.room.mu.Lock()
	roomID, expires := s.room.id, s.room.expiresAt
	linked := s.room.socket != nil
	s.room.mu.Unlock()
	if len(roomID) > 9 {
		roomID = roomID[:9]
	}
	return map[string]any{
		"active":         true,
		"dedicated":      true,
		"native":         true,
		"roomId":         roomID,
		"roomExpiresAt":  expires,
		"roomLinked":     linked,
		"matchState":     stateName(s.status.Match),
		"countdown":      s.status.Countdown,
		"players":        s.status.Players,
		"connectedPeers": s.peers.connectedCount(),
		"lobby": map[string]any{
			"mapIndex": lobby.MapIndex, "modeIndex": lobby.ModeIndex,
			"label": mapNames[lobby.MapIndex] + " " + modeNames[lobby.ModeIndex],
		},
		"rotationIndex": s.rotationIndex,
		"gamesPlayed":   s.gamesPlayed,
		"kills":         s.kills,
		"uptimeSeconds": int(time.Since(s.started).Seconds()),
	}
}

func (s *server) serveStatus() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.statusJSON())
	})
	listener, err := net.Listen("tcp", s.config.StatusAddress)
	if err != nil {
		log.Printf("status: %v", err)
		return
	}
	log.Printf("status on http://%s/", listener.Addr())
	_ = http.Serve(listener, mux)
}

// keepRoom holds the room's WebSocket open, getting a new host session
// whenever it drops, and renews the room before it expires.
func (s *server) keepRoom(ctx context.Context, identifier, firstURL string) error {
	socketURL := firstURL
	failures := 0
	go func() {
		ticker := time.NewTicker(renewEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				renewContext, cancel := context.WithTimeout(ctx, 20*time.Second)
				if err := s.room.renew(renewContext, nil); err != nil {
					log.Printf("renew: %v", err)
				}
				cancel()
			}
		}
	}()
	for {
		started := time.Now()
		err := s.room.connect(ctx, socketURL)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Since(started) > time.Minute {
			failures = 0
		}
		failures++
		if failures > 8 {
			return fmt.Errorf("the room link keeps failing: %w", err)
		}
		delay := time.Duration(500*(1<<min(failures, 4))) * time.Millisecond
		log.Printf("room link closed (%v); reconnecting in %s", err, delay)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
		reopenContext, cancel := context.WithTimeout(ctx, 20*time.Second)
		socketURL, err = s.room.reopen(reopenContext, identifier)
		cancel()
		if err != nil {
			log.Printf("room session: %v", err)
			socketURL = ""
		}
		if socketURL == "" {
			continue
		}
	}
}

func run() error {
	c, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	listener, err := listenForGame(c.LinkPath)
	if err != nil {
		return fmt.Errorf("game link: %w", err)
	}
	defer os.Remove(c.LinkPath)

	s := &server{config: c, identifier: make(chan string, 1), started: time.Now(), lastMatch: -1}
	s.link = &gameLink{events: s}
	s.room = &room{config: c, client: &http.Client{Timeout: 30 * time.Second}, waiting: map[string]time.Time{}}
	s.peers, err = newPeerSet(s.link, func(to string, signal map[string]any) {
		s.room.send(map[string]any{"type": "signal", "to": to, "signal": signal})
	}, func() {}, c.UDPHost, c.UDPPort, c.PublicIP)
	if err != nil {
		return err
	}
	s.room.peers = s.peers
	go s.serveStatus()

	/* the game */
	_ = os.MkdirAll(c.SaveRoot, 0o755)
	game := exec.CommandContext(ctx, c.GameBinary)
	game.Dir = c.DataRoot
	game.Stdout, game.Stderr = os.Stdout, os.Stderr
	game.Env = append(os.Environ(),
		"HALO_SERVER_LINK="+c.LinkPath,
		"HALO_DATA_ROOT="+c.DataRoot,
		"HALO_SAVE_ROOT="+c.SaveRoot,
		"HALO_NULL_RENDERER=1",
		"HALO_NO_AUDIO=1",
		"HALO_NET_ONLINE=false",
		"HALO_UPDATE_AUTO=false",
		"HALO_DISCORD_APPLICATION=",
		"HALO_FULLSCREEN=false",
		"SDL_VIDEODRIVER=dummy",
		"SDL_AUDIODRIVER=dummy",
	)
	if err := game.Start(); err != nil {
		return fmt.Errorf("start %s: %w", c.GameBinary, err)
	}
	gameDone := make(chan error, 1)
	go func() { gameDone <- game.Wait() }()

	accepted := make(chan *net.UnixConn, 1)
	go func() {
		conn, err := listener.AcceptUnix()
		if err == nil {
			accepted <- conn
		}
	}()
	select {
	case conn := <-accepted:
		s.link.conn = conn
	case err := <-gameDone:
		return fmt.Errorf("the game stopped before it linked: %v", err)
	case <-time.After(60 * time.Second):
		return errors.New("the game did not link within a minute")
	}
	linkDone := make(chan error, 1)
	go func() { linkDone <- s.link.run() }()

	var identifier string
	select {
	case identifier = <-s.identifier:
	case err := <-linkDone:
		return fmt.Errorf("game link: %w", err)
	case <-time.After(30 * time.Second):
		return errors.New("the game never said hello")
	}
	log.Printf("game linked: machine %s", identifier)

	first := c.Rotation[0]
	if err := s.link.hostDedicated(first.MapIndex, first.ModeIndex, c.MinimumPlayers, c.CountdownSeconds, c.PostgameSeconds); err != nil {
		return err
	}
	openContext, cancel := context.WithTimeout(ctx, 30*time.Second)
	socketURL, err := s.room.open(openContext, identifier, first)
	cancel()
	if err != nil {
		_ = s.link.stop()
		return fmt.Errorf("open the room: %w", err)
	}
	roomDone := make(chan error, 1)
	go func() { roomDone <- s.keepRoom(ctx, identifier, socketURL) }()

	select {
	case err := <-gameDone:
		s.peers.closeAll()
		return fmt.Errorf("the game stopped: %v", err)
	case err := <-linkDone:
		s.peers.closeAll()
		return fmt.Errorf("game link: %w", err)
	case err := <-roomDone:
		_ = s.link.stop()
		s.peers.closeAll()
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("gateway: ")
	if err := run(); err != nil {
		log.Printf("%v", err)
		os.Exit(1)
	}
}

func toLower(text string) string { return strings.ToLower(text) }

func fmtIPv4(address uint32) string {
	/* the game's addresses are in network order, read as little-endian */
	return fmt.Sprintf("%d.%d.%d.%d", byte(address), byte(address>>8), byte(address>>16), byte(address>>24))
}
