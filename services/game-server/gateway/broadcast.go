package main

// The broadcast: a match as a spectator receives it, recorded by the game
// while anyone watches it through the CDN (source/networking/
// network_server_message_handler.c), in chunks of two seconds. The room
// says when someone is watching ({"type":"broadcast","on":true}); the
// gateway tells the game ('B'), joins the chunk's pieces the game sends
// ('C'), and puts each chunk on the signaling Worker, compressed, which
// keeps it in R2 for viewers (services/signaling/src/broadcast.ts).

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

// chunkAssembly joins the pieces of the chunk the game is sending.
type chunkAssembly struct {
	mu       sync.Mutex
	sequence uint32
	pieces   [][]byte
	received int
}

// add takes one piece ('C' sequence:u32 piece:u16 pieces:u16 bytes) and
// returns the whole chunk once its last piece is in.
func (a *chunkAssembly) add(packet []byte) (uint32, []byte, bool) {
	if len(packet) < 8 {
		return 0, nil, false
	}
	sequence := binary.LittleEndian.Uint32(packet[0:])
	piece := int(binary.LittleEndian.Uint16(packet[4:]))
	count := int(binary.LittleEndian.Uint16(packet[6:]))
	if count == 0 || piece >= count {
		return 0, nil, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pieces == nil || a.sequence != sequence || len(a.pieces) != count {
		a.sequence = sequence
		a.pieces = make([][]byte, count)
		a.received = 0
	}
	if a.pieces[piece] == nil {
		a.pieces[piece] = append([]byte(nil), packet[8:]...)
		a.received++
	}
	if a.received < count {
		return 0, nil, false
	}
	chunk := bytes.Join(a.pieces, nil)
	a.pieces = nil
	return sequence, chunk, true
}

func (link *gameLink) setBroadcast(on bool) error {
	value := byte(0)
	if on {
		value = 1
	}
	return link.write([]byte{'B', value})
}

func (s *server) gameBroadcast(sequence uint32, chunk []byte) {
	go s.room.uploadChunk(sequence, chunk)
}

// uploadChunk puts a chunk, compressed, on the Worker for the room's viewers.
func (r *room) uploadChunk(sequence uint32, chunk []byte) {
	r.mu.Lock()
	roomID := r.id
	r.mu.Unlock()
	if roomID == "" {
		return
	}
	var compressed bytes.Buffer
	writer, _ := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	_, _ = writer.Write(chunk)
	_ = writer.Close()
	compressedSize := compressed.Len()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPut,
		fmt.Sprintf("%s/v1/broadcast/%s/%d", r.config.SignalingURL, roomID, sequence), &compressed)
	if err != nil {
		return
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Content-Encoding", "gzip")
	request.Header.Set("Authorization", "Bearer "+r.config.ServiceToken)
	request.Header.Set("Origin", r.config.Origin)
	response, err := r.client.Do(request)
	if err != nil {
		log.Printf("broadcast: chunk %d not uploaded: %v", sequence, err)
		return
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		log.Printf("broadcast: chunk %d refused: %d %s", sequence, response.StatusCode, body)
		return
	}
	if sequence == 1 || sequence%30 == 0 {
		log.Printf("broadcast: chunk %d up (%d bytes, %d compressed)", sequence, len(chunk), compressedSize)
	}
}
