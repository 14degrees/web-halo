package main

/* The game's end of the gateway: one SOCK_SEQPACKET socket to halo-server,
one message per packet, as port/server/src/server_link.c describes. */

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
)

const (
	frameMinimum   = 12
	frameMaximum   = 12 + 16*1024
	identifierSize = 6
)

// gameStatus is the lobby driver's state ('M').
type gameStatus struct {
	Match     int // 0 none, 1 lobby, 2 countdown, 3 ingame, 4 postgame
	Countdown int // seconds until the start while counting down, else -1
	Players   int
	Client    int
	Online    int
}

// gameEvents is what the game tells the gateway.
type gameEvents interface {
	gameHello(identifier string)
	gameFrame(address uint32, reliable bool, frame []byte)
	gameStatus(status gameStatus)
	gameKill(killer, victim string)
}

type gameLink struct {
	conn    *net.UnixConn
	send    sync.Mutex
	events  gameEvents
	pending sync.Map // key -> chan uint32 (add-peer answers)
	nextKey uint32
	keyLock sync.Mutex
}

func listenForGame(path string) (*net.UnixListener, error) {
	_ = os.Remove(path)
	return net.ListenUnix("unixpacket", &net.UnixAddr{Name: path, Net: "unixpacket"})
}

func (link *gameLink) write(packet []byte) error {
	link.send.Lock()
	defer link.send.Unlock()
	_, err := link.conn.Write(packet)
	return err
}

// run reads the game's messages until the link closes.
func (link *gameLink) run() error {
	buffer := make([]byte, 1+4+1+frameMaximum+64)
	for {
		length, err := link.conn.Read(buffer)
		if err != nil {
			return err
		}
		if length == 0 {
			return errors.New("the game closed the link")
		}
		packet := buffer[:length]
		switch packet[0] {
		case 'I':
			if length == 1+identifierSize {
				link.events.gameHello(fmt.Sprintf("%x", packet[1:]))
			}
		case 'A':
			if length == 9 {
				key := binary.LittleEndian.Uint32(packet[1:])
				if waiter, ok := link.pending.LoadAndDelete(key); ok {
					waiter.(chan uint32) <- binary.LittleEndian.Uint32(packet[5:])
				}
			}
		case 'F':
			if length >= 6+frameMinimum {
				frame := make([]byte, length-6)
				copy(frame, packet[6:])
				link.events.gameFrame(binary.LittleEndian.Uint32(packet[1:]), packet[5] != 0, frame)
			}
		case 'M':
			if length == 8 {
				link.events.gameStatus(gameStatus{
					Match:     int(packet[1]),
					Countdown: int(int16(binary.LittleEndian.Uint16(packet[2:]))),
					Players:   int(binary.LittleEndian.Uint16(packet[4:])),
					Client:    int(int8(packet[6])),
					Online:    int(packet[7]),
				})
			}
		case 'K':
			if length == 1+24 {
				link.events.gameKill(cString(packet[1:13]), cString(packet[13:25]))
			}
		}
	}
}

func cString(bytes []byte) string {
	for index, value := range bytes {
		if value == 0 {
			return string(bytes[:index])
		}
	}
	return string(bytes)
}

// addPeer registers a remote machine with the game and returns its virtual
// address, or 0 when the game has none free.
func (link *gameLink) addPeer(identifier []byte) (uint32, error) {
	link.keyLock.Lock()
	link.nextKey++
	key := link.nextKey
	link.keyLock.Unlock()
	answer := make(chan uint32, 1)
	link.pending.Store(key, answer)
	packet := make([]byte, 1+4+identifierSize)
	packet[0] = 'P'
	binary.LittleEndian.PutUint32(packet[1:], key)
	copy(packet[5:], identifier)
	if err := link.write(packet); err != nil {
		link.pending.Delete(key)
		return 0, err
	}
	return <-answer, nil
}

func (link *gameLink) removePeer(address uint32) error {
	packet := make([]byte, 5)
	packet[0] = 'R'
	binary.LittleEndian.PutUint32(packet[1:], address)
	return link.write(packet)
}

func (link *gameLink) setPeerOpen(address uint32, open bool) error {
	packet := make([]byte, 6)
	packet[0] = 'S'
	binary.LittleEndian.PutUint32(packet[1:], address)
	if open {
		packet[5] = 1
	}
	return link.write(packet)
}

func (link *gameLink) frame(address uint32, reliable bool, frame []byte) error {
	packet := make([]byte, 6+len(frame))
	packet[0] = 'F'
	binary.LittleEndian.PutUint32(packet[1:], address)
	if reliable {
		packet[5] = 1
	}
	copy(packet[6:], frame)
	return link.write(packet)
}

func (link *gameLink) hostDedicated(mapIndex, modeIndex, minimum, countdown, postgame int) error {
	return link.write([]byte{'H', byte(mapIndex), byte(modeIndex), byte(minimum), byte(countdown), byte(postgame)})
}

func (link *gameLink) setNextGame(mapIndex, modeIndex int) error {
	return link.write([]byte{'G', byte(mapIndex), byte(modeIndex)})
}

// setMinimumPlayers changes the players the lobby waits for.
func (link *gameLink) setMinimumPlayers(minimum int) error {
	return link.write([]byte{'m', byte(minimum)})
}

func (link *gameLink) requestRestart() error {
	return link.write([]byte{'X'})
}

func (link *gameLink) stop() error {
	return link.write([]byte{'Q'})
}
