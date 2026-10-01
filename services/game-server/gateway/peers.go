package main

/* The browsers' WebRTC connections, as library_web_transport.js makes them
on the browser's side: one peer connection per guest, with a reliable,
ordered DataChannel for the game's TCP streams and an unreliable, unordered
one for its datagrams. Each frame is one DataChannel message. The server is
the host: it opens the channels and makes the offers. */

import (
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	reliableLabel   = "halo-reliable-v1"
	unreliableLabel = "halo-unreliable-v1"
	// past this much unsent, a datagram is dropped as the network would
	unreliableHighWater = 256 * 1024
	// past this much unsent, the guest cannot keep up with the game's
	// streams: it is disconnected rather than stall the server
	reliableLimit = 4 * 1024 * 1024
	// the browser's limit on a guest's candidates (REMOTE_CANDIDATE_LIMIT)
	remoteCandidateLimit = 64
	// a guest that never connects is dropped after this long
	connectDeadline = 45 * time.Second
)

type peer struct {
	id         string // signaling peer ID
	identifier string // Halo's 12 hexadecimal digit machine identifier
	address    uint32 // its virtual address in the game
	pc         *webrtc.PeerConnection
	reliable   *webrtc.DataChannel
	unreliable *webrtc.DataChannel
	connected  bool
	removed    bool
	candidates int
	pending    []webrtc.ICECandidateInit
	since      time.Time
	wallet     string
	// the game's frames for this peer, sent by its own goroutine: a send to
	// a dying connection can block, and must never hold up the game link
	out chan outFrame
}

type outFrame struct {
	reliable bool
	data     []byte
}

// a peer this far behind on frames the game sent it is dropped
const outQueueFrames = 1024

type peerSet struct {
	mu        sync.Mutex
	byID      map[string]*peer
	byAddress map[uint32]*peer
	aliases   map[string]string // signaling peer ID -> transport peer ID
	targets   map[string]string // transport peer ID -> where its signals go
	api       *webrtc.API
	ice       []webrtc.ICEServer
	link      *gameLink
	signal    func(to string, signal map[string]any)
	changed   func()
	// which machines may connect (a matchmade match's roster); nil: any
	allowed func(identifier string) bool
}

func (set *peerSet) setAllowed(allowed func(string) bool) {
	set.mu.Lock()
	set.allowed = allowed
	set.mu.Unlock()
}

// newPeerSet makes the WebRTC side. With udpPort, every guest's traffic
// uses that one UDP port (one firewall rule, one published container port);
// with publicIP, the server's candidates carry that address, as a machine
// behind a 1:1 NAT (a cloud VM, a container) must.
func newPeerSet(link *gameLink, signal func(string, map[string]any), changed func(),
	udpHost string, udpPort int, publicIP string) (*peerSet, error) {
	settings := webrtc.SettingEngine{}
	if udpPort > 0 {
		/* udpHost: the address to receive on, where the platform needs one
		   (Fly.io answers only from fly-global-services) */
		bind := &net.UDPAddr{Port: udpPort}
		if udpHost != "" {
			resolved, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(udpHost, fmt.Sprint(udpPort)))
			if err != nil {
				return nil, fmt.Errorf("WebRTC address %s: %w", udpHost, err)
			}
			bind = resolved
		}
		conn, err := net.ListenUDP("udp4", bind)
		if err != nil {
			return nil, fmt.Errorf("WebRTC port %d: %w", udpPort, err)
		}
		settings.SetICEUDPMux(webrtc.NewICEUDPMux(nil, conn))
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	}
	if publicIP != "" {
		settings.SetNAT1To1IPs([]string{publicIP}, webrtc.ICECandidateTypeHost)
	}
	return &peerSet{
		byID:      map[string]*peer{},
		byAddress: map[uint32]*peer{},
		aliases:   map[string]string{},
		targets:   map[string]string{},
		api:       webrtc.NewAPI(webrtc.WithSettingEngine(settings)),
		link:      link,
		signal:    signal,
		changed:   changed,
	}, nil
}

func (set *peerSet) setICEServers(servers []iceServer) {
	set.mu.Lock()
	defer set.mu.Unlock()
	set.ice = set.ice[:0]
	for _, server := range servers {
		set.ice = append(set.ice, webrtc.ICEServer{
			URLs:       server.URLs,
			Username:   server.Username,
			Credential: server.Credential,
		})
	}
}

// ensure makes the connection to a guest the room announced.
func (set *peerSet) ensure(id, identifier string) {
	identifier = toLower(identifier)
	bytes, err := hex.DecodeString(identifier)
	if err != nil || len(bytes) != identifierSize {
		log.Printf("peer %s: invalid identifier %q", id, identifier)
		return
	}
	set.mu.Lock()
	if set.allowed != nil && !set.allowed(identifier) {
		set.mu.Unlock()
		log.Printf("peer %s (%s) refused: not in this match", id, identifier)
		return
	}
	if _, exists := set.byID[set.resolveLocked(id)]; exists {
		set.mu.Unlock()
		return
	}
	/* A guest whose room link came back has a new signaling ID but the same
	   machine: a connected transport carries on under the new ID, a stale
	   one is replaced. */
	for otherID, other := range set.byID {
		if other.identifier != identifier {
			continue
		}
		if other.connected {
			set.aliases[id] = otherID
			set.targets[otherID] = id
			set.mu.Unlock()
			return
		}
		set.removeLocked(otherID, "replaced by the same machine")
	}
	p := &peer{id: id, identifier: identifier, since: time.Now(), out: make(chan outFrame, outQueueFrames)}
	go set.sender(p)
	set.byID[id] = p
	set.aliases[id] = id
	set.targets[id] = id
	ice := append([]webrtc.ICEServer(nil), set.ice...)
	set.mu.Unlock()

	log.Printf("peer %s (%s) joining", id, identifier)
	address, err := set.link.addPeer(bytes)
	if err != nil || address == 0 {
		log.Printf("peer %s: the game has no address for it (%v)", id, err)
		set.remove(id, "no address")
		return
	}
	set.mu.Lock()
	if p.removed {
		set.mu.Unlock()
		_ = set.link.removePeer(address)
		return
	}
	p.address = address
	set.byAddress[address] = p
	set.mu.Unlock()

	pc, err := set.api.NewPeerConnection(webrtc.Configuration{
		ICEServers:   ice,
		BundlePolicy: webrtc.BundlePolicyMaxBundle,
	})
	if err != nil {
		log.Printf("peer %s: %v", id, err)
		set.remove(id, "peer connection failed")
		return
	}
	set.mu.Lock()
	p.pc = pc
	set.mu.Unlock()

	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		set.sendSignal(p, map[string]any{"kind": "candidate", "candidate": candidate.ToJSON()})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateFailed:
			set.remove(p.id, "connection failed")
		case webrtc.PeerConnectionStateClosed:
			set.remove(p.id, "connection closed")
		}
	})
	ordered := false
	retransmits := uint16(0)
	reliable, err := pc.CreateDataChannel(reliableLabel, &webrtc.DataChannelInit{})
	if err == nil {
		var unreliable *webrtc.DataChannel
		unreliable, err = pc.CreateDataChannel(unreliableLabel, &webrtc.DataChannelInit{
			Ordered:        &ordered,
			MaxRetransmits: &retransmits,
		})
		if err == nil {
			set.configure(p, reliable, true)
			set.configure(p, unreliable, false)
		}
	}
	if err != nil {
		log.Printf("peer %s: %v", id, err)
		set.remove(id, "data channels failed")
		return
	}
	offer, err := pc.CreateOffer(nil)
	if err == nil {
		err = pc.SetLocalDescription(offer)
	}
	if err != nil {
		log.Printf("peer %s: offer: %v", id, err)
		set.remove(id, "offer failed")
		return
	}
	set.sendDescription(p)
	log.Printf("peer %s offered at %s", id, addressText(address))
	time.AfterFunc(connectDeadline, func() {
		set.mu.Lock()
		stale := !p.removed && !p.connected
		set.mu.Unlock()
		if stale {
			set.remove(p.id, "never connected")
		}
	})
}

func (set *peerSet) configure(p *peer, channel *webrtc.DataChannel, reliable bool) {
	set.mu.Lock()
	if reliable {
		p.reliable = channel
	} else {
		p.unreliable = channel
	}
	set.mu.Unlock()
	channel.OnOpen(func() { set.syncOpen(p) })
	channel.OnClose(func() { set.remove(p.id, channel.Label()+" closed") })
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		if message.IsString || len(message.Data) < frameMinimum || len(message.Data) > frameMaximum {
			set.remove(p.id, "invalid frame")
			return
		}
		set.mu.Lock()
		address, open := p.address, p.connected
		set.mu.Unlock()
		if !open {
			return
		}
		if err := set.link.frame(address, reliable, message.Data); err != nil {
			log.Printf("game link: %v", err)
		}
	})
}

func (set *peerSet) syncOpen(p *peer) {
	set.mu.Lock()
	ready := !p.removed && !p.connected &&
		p.reliable != nil && p.reliable.ReadyState() == webrtc.DataChannelStateOpen &&
		p.unreliable != nil && p.unreliable.ReadyState() == webrtc.DataChannelStateOpen
	if ready {
		p.connected = true
	}
	address := p.address
	set.mu.Unlock()
	if !ready {
		return
	}
	if err := set.link.setPeerOpen(address, true); err != nil {
		log.Printf("game link: %v", err)
	}
	log.Printf("peer %s (%s) connected as %s", p.id, p.identifier, addressText(address))
	set.changed()
}

func (set *peerSet) sendDescription(p *peer) {
	description := p.pc.LocalDescription()
	if description == nil {
		return
	}
	set.sendSignal(p, map[string]any{
		"kind":        "description",
		"description": map[string]string{"type": description.Type.String(), "sdp": description.SDP},
	})
}

func (set *peerSet) sendSignal(p *peer, signal map[string]any) {
	set.mu.Lock()
	to := set.targets[p.id]
	if to == "" {
		to = p.id
	}
	set.mu.Unlock()
	set.signal(to, signal)
}

func (set *peerSet) resolveLocked(id string) string {
	if transport, ok := set.aliases[id]; ok {
		return transport
	}
	return id
}

// handleSignal applies a guest's answer, offer or candidate.
func (set *peerSet) handleSignal(from string, signal signalMessage) error {
	set.mu.Lock()
	p := set.byID[set.resolveLocked(from)]
	set.mu.Unlock()
	if p == nil || p.pc == nil {
		return nil // a late signal from a guest already gone
	}
	switch signal.Kind {
	case "description":
		if signal.Description != nil {
			log.Printf("peer %s sent its %s", from, signal.Description.Type)
		}
		if signal.Description == nil {
			return errors.New("a description signal without its description")
		}
		description := webrtc.SessionDescription{SDP: signal.Description.SDP}
		switch signal.Description.Type {
		case "answer":
			description.Type = webrtc.SDPTypeAnswer
		case "offer":
			description.Type = webrtc.SDPTypeOffer
			/* the server is the impolite side: a guest offer that collides
			   with ours is ignored */
			if p.pc.SignalingState() != webrtc.SignalingStateStable {
				return nil
			}
		default:
			return errors.New("an unsupported description type")
		}
		if err := p.pc.SetRemoteDescription(description); err != nil {
			return err
		}
		set.mu.Lock()
		pending := p.pending
		p.pending = nil
		set.mu.Unlock()
		for _, candidate := range pending {
			_ = p.pc.AddICECandidate(candidate)
		}
		if description.Type == webrtc.SDPTypeOffer {
			answer, err := p.pc.CreateAnswer(nil)
			if err == nil {
				err = p.pc.SetLocalDescription(answer)
			}
			if err != nil {
				return err
			}
			set.sendDescription(p)
		}
	case "candidate":
		if signal.Candidate == nil {
			return nil
		}
		set.mu.Lock()
		p.candidates++
		tooMany := p.candidates > remoteCandidateLimit
		waiting := p.pc.RemoteDescription() == nil
		if waiting && !tooMany {
			p.pending = append(p.pending, *signal.Candidate)
		}
		set.mu.Unlock()
		if tooMany {
			return errors.New("too many ICE candidates")
		}
		if !waiting {
			return p.pc.AddICECandidate(*signal.Candidate)
		}
	default:
		return errors.New("an unsupported signal")
	}
	return nil
}

// left handles the room's notice that a guest's signaling session ended. A
// connected transport plays on: the room link and the game are separate.
func (set *peerSet) left(id string) {
	set.mu.Lock()
	transport := set.resolveLocked(id)
	p := set.byID[transport]
	delete(set.aliases, id)
	if set.targets[transport] == id {
		delete(set.targets, transport)
	}
	keep := p != nil && p.connected
	set.mu.Unlock()
	if p != nil && !keep {
		set.remove(transport, "left the room")
	}
}

func (set *peerSet) remove(id, why string) {
	set.mu.Lock()
	removed := set.removeLocked(set.resolveLocked(id), why)
	set.mu.Unlock()
	if removed {
		set.changed()
	}
}

func (set *peerSet) removeLocked(id, why string) bool {
	p := set.byID[id]
	if p == nil || p.removed {
		return false
	}
	p.removed = true
	close(p.out)
	delete(set.byID, id)
	for alias, transport := range set.aliases {
		if transport == id {
			delete(set.aliases, alias)
		}
	}
	delete(set.targets, id)
	if p.address != 0 {
		delete(set.byAddress, p.address)
		address := p.address
		go func() { _ = set.link.removePeer(address) }()
	}
	if p.pc != nil {
		pc := p.pc
		go func() { _ = pc.Close() }()
	}
	log.Printf("peer %s (%s) removed: %s", id, p.identifier, why)
	return true
}

// send queues one of the game's frames for its peer; it never blocks.
func (set *peerSet) send(address uint32, reliable bool, frame []byte) {
	/* (under the lock: removal closes the queue) */
	set.mu.Lock()
	defer set.mu.Unlock()
	p := set.byAddress[address]
	if p == nil || !p.connected || p.removed {
		return
	}
	select {
	case p.out <- outFrame{reliable: reliable, data: frame}:
	default:
		if reliable {
			go set.remove(p.id, "cannot keep up with the game")
		}
		/* a datagram is dropped, as the network would */
	}
}

// removeAddress drops the peer at a virtual address (the game could not
// take its traffic).
func (set *peerSet) removeAddress(address uint32, why string) {
	set.mu.Lock()
	p := set.byAddress[address]
	set.mu.Unlock()
	if p != nil {
		set.remove(p.id, why)
	}
}

// sender writes a peer's frames to its DataChannels until it is removed.
func (set *peerSet) sender(p *peer) {
	for frame := range p.out {
		set.mu.Lock()
		channel := p.unreliable
		if frame.reliable {
			channel = p.reliable
		}
		removed := p.removed
		set.mu.Unlock()
		if removed || channel == nil {
			continue
		}
		buffered := channel.BufferedAmount()
		if !frame.reliable && buffered > unreliableHighWater {
			continue
		}
		if frame.reliable && buffered > reliableLimit {
			set.remove(p.id, "cannot keep up with the game")
			continue
		}
		if err := channel.Send(frame.data); err != nil && frame.reliable {
			set.remove(p.id, "send failed: "+err.Error())
		}
	}
}

func (set *peerSet) connectedCount() int {
	set.mu.Lock()
	defer set.mu.Unlock()
	count := 0
	for _, p := range set.byID {
		if p.connected {
			count++
		}
	}
	return count
}

func (set *peerSet) closeAll() {
	set.mu.Lock()
	ids := make([]string, 0, len(set.byID))
	for id := range set.byID {
		ids = append(ids, id)
	}
	for _, id := range ids {
		set.removeLocked(id, "server stopping")
	}
	set.mu.Unlock()
}

func addressText(address uint32) string {
	return fmtIPv4(address)
}
