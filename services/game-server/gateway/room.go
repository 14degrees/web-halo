package main

/* The server's room on the signaling Worker (services/signaling): the public,
dedicated room browsers quick-join, its WebSocket, and the HTTP calls that
open and renew it. The messages are the browser host's
(port/web/online_client.js, handleRoomMessage). */

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

const (
	protocolVersion = 1
	roomCapacity    = 128
	heartbeatEvery  = 15 * time.Second // the room's lease on this server (lobby.ts DEDICATED_HOST_LEASE_MS)
	renewEvery      = 50 * time.Minute
)

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type lobbySettings struct {
	MapIndex  int `json:"mapIndex"`
	ModeIndex int `json:"modeIndex"`
}

type sessionDescriptor struct {
	PeerID       string `json:"peerId"`
	WebsocketURL string `json:"websocketUrl"`
}

type roomDescriptor struct {
	ID        string `json:"id"`
	ExpiresAt int64  `json:"expiresAt"`
}

type createRoomResponse struct {
	Host struct {
		Session sessionDescriptor `json:"session"`
		Ticket  string            `json:"ticket"`
	} `json:"host"`
	IceServers []iceServer    `json:"iceServers"`
	Room       roomDescriptor `json:"room"`
	V          int            `json:"v"`
}

type createSessionResponse struct {
	IceServers []iceServer       `json:"iceServers"`
	Room       roomDescriptor    `json:"room"`
	Session    sessionDescriptor `json:"session"`
}

type signalMessage struct {
	Kind        string `json:"kind"`
	Description *struct {
		Type string `json:"type"`
		SDP  string `json:"sdp"`
	} `json:"description,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
}

type roomPeer struct {
	Identifier string `json:"identifier"`
	PeerID     string `json:"peerId"`
	Role       string `json:"role"`
}

type roomMessage struct {
	V       int             `json:"v"`
	Type    string          `json:"type"`
	Self    *roomPeer       `json:"self,omitempty"`
	Peers   []roomPeer      `json:"peers,omitempty"`
	Peer    *roomPeer       `json:"peer,omitempty"`
	PeerID  string          `json:"peerId,omitempty"`
	From    string          `json:"from,omitempty"`
	Signal  json.RawMessage `json:"signal,omitempty"`
	Code    string          `json:"code,omitempty"`
	Message string          `json:"message,omitempty"`
}

type room struct {
	config    *config
	client    *http.Client
	mu        sync.Mutex
	id        string
	ticket    string
	expiresAt int64
	socket    *websocket.Conn
	selfID    string
	peers     *peerSet
	waiting   map[string]time.Time
}

func (r *room) api(ctx context.Context, method, path string, body any, out any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, method, r.config.SignalingURL+path, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+r.config.ServiceToken)
	request.Header.Set("Origin", r.config.Origin)
	response, err := r.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if response.StatusCode/100 != 2 {
		return fmt.Errorf("%s %s: %d %s", method, path, response.StatusCode, strings.TrimSpace(string(data)))
	}
	return json.Unmarshal(data, out)
}

// open creates the public dedicated room for this machine.
func (r *room) open(ctx context.Context, identifier string, lobby lobbySettings) (string, error) {
	var result createRoomResponse
	err := r.api(ctx, http.MethodPost, "/v1/rooms", map[string]any{
		"protocolVersion": protocolVersion,
		"buildId":         r.config.BuildID,
		"capacity":        roomCapacity,
		"identifier":      identifier,
		"visibility":      "public",
		"dedicated":       true,
		"lobby":           lobby,
	}, &result)
	if err != nil {
		return "", err
	}
	if result.Room.ID == "" || result.Host.Ticket == "" || result.Host.Session.WebsocketURL == "" {
		return "", errors.New("the room service returned an incomplete room")
	}
	r.mu.Lock()
	r.id = result.Room.ID
	r.ticket = result.Host.Ticket
	r.expiresAt = result.Room.ExpiresAt
	r.selfID = result.Host.Session.PeerID
	r.mu.Unlock()
	r.peers.setICEServers(result.IceServers)
	log.Printf("room %s… open (%d ICE servers)", shortID(result.Room.ID), len(result.IceServers))
	return result.Host.Session.WebsocketURL, nil
}

// reopen gets a new host session in the same room after the WebSocket drops.
func (r *room) reopen(ctx context.Context, identifier string) (string, error) {
	r.mu.Lock()
	id, ticket := r.id, r.ticket
	r.mu.Unlock()
	var result createSessionResponse
	err := r.api(ctx, http.MethodPost, "/v1/rooms/"+url.PathEscape(id)+"/sessions", map[string]any{
		"protocolVersion": protocolVersion,
		"buildId":         r.config.BuildID,
		"identifier":      identifier,
		"ticket":          ticket,
	}, &result)
	if err != nil {
		return "", err
	}
	r.peers.setICEServers(result.IceServers)
	r.mu.Lock()
	r.selfID = result.Session.PeerID
	r.mu.Unlock()
	return result.Session.WebsocketURL, nil
}

// renew pushes the room's expiry back and publishes the lobby it is on.
func (r *room) renew(ctx context.Context, lobby *lobbySettings) error {
	r.mu.Lock()
	id, ticket := r.id, r.ticket
	r.mu.Unlock()
	body := map[string]any{"ticket": ticket}
	if lobby != nil {
		body["lobby"] = lobby
	}
	var result struct {
		Room roomDescriptor `json:"room"`
	}
	if err := r.api(ctx, http.MethodPost, "/v1/rooms/"+url.PathEscape(id)+"/renew", body, &result); err != nil {
		return err
	}
	r.mu.Lock()
	if result.Room.ExpiresAt != 0 {
		r.expiresAt = result.Room.ExpiresAt
	}
	r.mu.Unlock()
	return nil
}

func (r *room) websocketURL(value string) (string, error) {
	service, err := url.Parse(r.config.SignalingURL)
	if err != nil {
		return "", err
	}
	target, err := service.Parse(value)
	if err != nil {
		return "", err
	}
	switch target.Scheme {
	case "http":
		target.Scheme = "ws"
	case "https":
		target.Scheme = "wss"
	}
	if target.Host != service.Host {
		return "", errors.New("the room returned a WebSocket on another host")
	}
	return target.String(), nil
}

// connect opens the room's WebSocket and handles its messages until it
// closes.
func (r *room) connect(ctx context.Context, socketURL string) error {
	address, err := r.websocketURL(socketURL)
	if err != nil {
		return err
	}
	dialContext, cancel := context.WithTimeout(ctx, 12*time.Second)
	socket, _, err := websocket.Dial(dialContext, address, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{r.config.Origin}},
	})
	cancel()
	if err != nil {
		return err
	}
	socket.SetReadLimit(1 << 20)
	r.mu.Lock()
	r.socket = socket
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		if r.socket == socket {
			r.socket = nil
		}
		r.mu.Unlock()
		socket.CloseNow()
	}()
	r.send(map[string]any{"type": "profile", "profile": map[string]string{
		"name": r.config.HostName, "style": "white",
	}})
	heartbeat := time.NewTicker(heartbeatEvery)
	defer heartbeat.Stop()
	readErr := make(chan error, 1)
	go func() {
		for {
			_, data, err := socket.Read(ctx)
			if err != nil {
				readErr <- err
				return
			}
			var message roomMessage
			if err := json.Unmarshal(data, &message); err != nil || message.V != protocolVersion {
				readErr <- errors.New("the room sent an incompatible message")
				return
			}
			r.handle(message)
		}
	}()
	for {
		select {
		case err := <-readErr:
			return err
		case <-heartbeat.C:
			r.send(map[string]any{"type": "ping", "nonce": fmt.Sprint(time.Now().UnixMilli())})
		case <-ctx.Done():
			socket.Close(websocket.StatusNormalClosure, "server stopping")
			return ctx.Err()
		}
	}
}

// send writes a message to the room, when its WebSocket is up.
func (r *room) send(message map[string]any) bool {
	message["v"] = protocolVersion
	data, err := json.Marshal(message)
	if err != nil {
		return false
	}
	r.mu.Lock()
	socket := r.socket
	r.mu.Unlock()
	if socket == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return socket.Write(ctx, websocket.MessageText, data) == nil
}

func (r *room) handle(message roomMessage) {
	switch message.Type {
	case "welcome":
		for _, peer := range message.Peers {
			r.ensure(peer)
		}
	case "peer-joined":
		if message.Peer != nil {
			r.ensure(*message.Peer)
		}
	case "peer-left":
		r.peers.left(message.PeerID)
	case "signal":
		var signal signalMessage
		if err := json.Unmarshal(message.Signal, &signal); err != nil {
			return
		}
		if err := r.peers.handleSignal(message.From, signal); err != nil {
			log.Printf("peer %s: bad signal: %v", message.From, err)
			r.peers.remove(message.From, "invalid connection data")
		}
	case "waiting":
		if message.From != "" {
			r.mu.Lock()
			r.waiting[message.From] = time.Now()
			r.mu.Unlock()
		}
	case "error":
		/* a late or rejected guest signal is the guest's problem, not the
		   room's */
		if message.Code != "PEER_NOT_FOUND" && message.Code != "SIGNAL_ROUTE_FORBIDDEN" &&
			message.Code != "SIGNAL_DIRECTION_INVALID" {
			log.Printf("room error %s: %s", message.Code, message.Message)
		}
	}
}

func (r *room) ensure(peer roomPeer) {
	r.mu.Lock()
	self := r.selfID
	r.mu.Unlock()
	if peer.Role != "guest" || peer.PeerID == self {
		return
	}
	go r.peers.ensure(peer.PeerID, peer.Identifier)
}

// waitingCount is how many guests asked to join in the last ten seconds.
func (r *room) waitingCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for id, at := range r.waiting {
		if time.Since(at) > 10*time.Second {
			delete(r.waiting, id)
		} else {
			count++
		}
	}
	return count
}

func (r *room) clearWaiting() {
	r.mu.Lock()
	r.waiting = map[string]time.Time{}
	r.mu.Unlock()
}

func shortID(id string) string {
	if len(id) > 9 {
		return id[:9]
	}
	return id
}
