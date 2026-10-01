package main

import (
	"encoding/binary"
	"testing"
)

func TestParseResult(t *testing.T) {
	row := func(name string, team int8, score int32, quit bool) []byte {
		out := make([]byte, 18)
		copy(out, name)
		out[12] = byte(team)
		binary.LittleEndian.PutUint32(out[13:], uint32(score))
		if quit {
			out[17] = 1
		}
		return out
	}
	packet := []byte{1}
	packet = binary.LittleEndian.AppendUint32(packet, 25)
	minusOne := int32(-1)
	packet = binary.LittleEndian.AppendUint32(packet, uint32(minusOne))
	packet = append(packet, 2)
	packet = append(packet, row("22u5..g9tn", 0, 14, false)...)
	packet = append(packet, row("BVUi..GkWz", 1, -1, true)...)

	result, ok := parseResult(packet)
	if !ok || !result.Teams || result.TeamScores != [2]int{25, -1} || len(result.Players) != 2 {
		t.Fatalf("parsed %+v %v", result, ok)
	}
	if result.Players[0] != (resultPlayer{Name: "22u5..g9tn", Team: 0, Score: 14}) ||
		result.Players[1] != (resultPlayer{Name: "BVUi..GkWz", Team: 1, Score: -1, Quit: true}) {
		t.Fatalf("players %+v", result.Players)
	}
	if _, ok := parseResult(packet[:20]); ok {
		t.Fatal("a short result must not parse")
	}
}
