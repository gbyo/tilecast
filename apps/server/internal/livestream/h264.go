package livestream

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

const (
	// TCLSv2HeaderBytes is the fixed TCLS version 2 header length.
	TCLSv2HeaderBytes = 48
	// MaxAccessUnitBytes bounds one H.264 access unit. An IDR with its
	// parameter sets at 1280x720 and 1.5 Mbit/s is normally far smaller.
	MaxAccessUnitBytes = 512 * 1024
	// MaxChunkPacketBytes bounds one TCLS version 2 WebSocket message.
	MaxChunkPacketBytes = TCLSv2HeaderBytes + MaxAccessUnitBytes
	// MaxGOPChunks and MaxGOPBytes bound the one decodable GOP the server
	// keeps per session for joining viewers. A GOP is about one second; a
	// GOP over either bound is dropped and the session waits for a keyframe.
	MaxGOPChunks = 90
	MaxGOPBytes  = 4 * 1024 * 1024
	// MaxViewerChunks and MaxViewerBytes bound what one slow Studio request
	// may have queued. Overflow drops the queue and resumes at a keyframe.
	MaxViewerChunks = 45
	MaxViewerBytes  = 3 * 1024 * 1024

	nalSlice    = 1
	nalIDR      = 5
	nalSPS      = 7
	nalPPS      = 8
	flagKeyMask = 0x01
)

// Chunk is one validated H.264 Annex B access unit and the exact TCLS
// version 2 packet that carried it. Packet is relayed to Studio unchanged.
type Chunk struct {
	SessionID       uuid.UUID
	ProfileCode     byte
	Sequence        uint64
	TimestampMicros uint64
	Width           int
	Height          int
	Keyframe        bool
	Packet          []byte
}

// Payload is the Annex B access unit inside Packet.
func (c Chunk) Payload() []byte { return c.Packet[TCLSv2HeaderBytes:] }

// ParseChunk validates one TCLS version 2 packet without copying it.
func ParseChunk(packet []byte) (Chunk, error) {
	if len(packet) < TCLSv2HeaderBytes+4 || len(packet) > MaxChunkPacketBytes {
		return Chunk{}, fmt.Errorf("%w: TCLS v2 packet size %d is out of range", ErrInvalidFrame, len(packet))
	}
	if !bytes.Equal(packet[:4], frameMagic[:]) || packet[4] != 2 {
		return Chunk{}, fmt.Errorf("%w: unsupported binary header", ErrInvalidFrame)
	}
	profile, ok := profileByCode(packet[5])
	if !ok || profile.Transport != TransportH264 {
		return Chunk{}, fmt.Errorf("%w: unknown profile code", ErrInvalidFrame)
	}
	flags := packet[6]
	if flags&^flagKeyMask != 0 || packet[7] != 0 {
		return Chunk{}, fmt.Errorf("%w: reserved header bits are set", ErrInvalidFrame)
	}
	sessionID, err := uuid.FromBytes(packet[8:24])
	if err != nil || sessionID == uuid.Nil {
		return Chunk{}, fmt.Errorf("%w: invalid session id", ErrInvalidFrame)
	}
	chunk := Chunk{
		SessionID:       sessionID,
		ProfileCode:     packet[5],
		Sequence:        binary.BigEndian.Uint64(packet[24:32]),
		TimestampMicros: binary.BigEndian.Uint64(packet[32:40]),
		Width:           int(binary.BigEndian.Uint16(packet[40:42])),
		Height:          int(binary.BigEndian.Uint16(packet[42:44])),
		Keyframe:        flags&flagKeyMask != 0,
		Packet:          packet,
	}
	if length := binary.BigEndian.Uint32(packet[44:48]); int(length) != len(packet)-TCLSv2HeaderBytes {
		return Chunk{}, fmt.Errorf("%w: payload length does not match the packet", ErrInvalidFrame)
	}
	if chunk.Width < 16 || chunk.Height < 16 || chunk.Width%2 != 0 || chunk.Height%2 != 0 ||
		chunk.Width > profile.MaxWidth || chunk.Height > profile.MaxHeight {
		return Chunk{}, fmt.Errorf("%w: dimensions are outside the profile", ErrInvalidFrame)
	}
	if chunk.TimestampMicros > 1<<53 {
		return Chunk{}, fmt.Errorf("%w: timestamp is out of range", ErrInvalidFrame)
	}
	if err := ValidateAccessUnit(chunk.Payload(), chunk.Keyframe); err != nil {
		return Chunk{}, err
	}
	return chunk, nil
}

// ValidateAccessUnit is a lightweight Annex B check, not a decoder: the
// payload starts with a start code, every NAL header is well formed, a
// keyframe carries SPS and PPS before its IDR slice, and a delta access unit
// carries a non-IDR slice and no IDR slice.
func ValidateAccessUnit(payload []byte, keyframe bool) error {
	if len(payload) < 4 || len(payload) > MaxAccessUnitBytes {
		return fmt.Errorf("%w: access unit size is out of range", ErrInvalidFrame)
	}
	if !bytes.HasPrefix(payload, []byte{0, 0, 1}) && !bytes.HasPrefix(payload, []byte{0, 0, 0, 1}) {
		return fmt.Errorf("%w: access unit does not start with an Annex B start code", ErrInvalidFrame)
	}
	var sps, pps, idr, slice bool
	for offset := 0; offset < len(payload); {
		start := nextStartCode(payload, offset)
		if start < 0 {
			break
		}
		header := start
		if header >= len(payload) {
			return fmt.Errorf("%w: empty NAL unit", ErrInvalidFrame)
		}
		nal := payload[header]
		if nal&0x80 != 0 {
			return fmt.Errorf("%w: NAL forbidden bit is set", ErrInvalidFrame)
		}
		switch nal & 0x1f {
		case nalSPS:
			sps = true
		case nalPPS:
			pps = true
		case nalIDR:
			if !sps || !pps {
				return fmt.Errorf("%w: IDR slice precedes its parameter sets", ErrInvalidFrame)
			}
			idr = true
		case nalSlice:
			slice = true
		}
		offset = header + 1
	}
	if keyframe && (!sps || !pps || !idr) {
		return fmt.Errorf("%w: keyframe lacks SPS, PPS, or an IDR slice", ErrInvalidFrame)
	}
	if !keyframe && (idr || !slice) {
		return fmt.Errorf("%w: delta access unit is not a non-IDR slice", ErrInvalidFrame)
	}
	return nil
}

// nextStartCode returns the index of the NAL header after the next
// 00 00 01 at or after offset, or -1.
func nextStartCode(payload []byte, offset int) int {
	index := bytes.Index(payload[offset:], []byte{0, 0, 1})
	if index < 0 {
		return -1
	}
	return offset + index + 3
}

// EncodeChunk builds a TCLS version 2 packet. Tests and tools use it; the
// server only relays packets it received.
func EncodeChunk(sessionID uuid.UUID, profileCode byte, sequence, timestampMicros uint64, width, height int, keyframe bool, payload []byte) []byte {
	packet := make([]byte, TCLSv2HeaderBytes, TCLSv2HeaderBytes+len(payload))
	copy(packet, frameMagic[:])
	packet[4] = 2
	packet[5] = profileCode
	if keyframe {
		packet[6] = flagKeyMask
	}
	copy(packet[8:24], sessionID[:])
	binary.BigEndian.PutUint64(packet[24:32], sequence)
	binary.BigEndian.PutUint64(packet[32:40], timestampMicros)
	binary.BigEndian.PutUint16(packet[40:42], uint16(width))
	binary.BigEndian.PutUint16(packet[42:44], uint16(height))
	binary.BigEndian.PutUint32(packet[44:48], uint32(len(payload)))
	return append(packet, payload...)
}

// viewerQueue is one Studio H.264 request's bounded queue. It never holds a
// delta access unit whose predecessor it dropped.
type viewerQueue struct {
	chunks  []Chunk
	bytes   int
	waiting bool
	signal  chan struct{}
}

func newViewerQueue(gop []Chunk) *viewerQueue {
	queue := &viewerQueue{signal: make(chan struct{}, 1), waiting: true}
	if len(gop) > 0 && gop[0].Keyframe {
		queue.waiting = false
		queue.chunks = append(queue.chunks, gop...)
		for _, chunk := range gop {
			queue.bytes += len(chunk.Packet)
		}
		queue.wake()
	}
	return queue
}

func (q *viewerQueue) wake() {
	select {
	case q.signal <- struct{}{}:
	default:
	}
}

// push is called with the service lock held.
func (q *viewerQueue) push(chunk Chunk) {
	if q.waiting && !chunk.Keyframe {
		return
	}
	if chunk.Keyframe {
		q.waiting = false
	}
	if len(q.chunks)+1 > MaxViewerChunks || q.bytes+len(chunk.Packet) > MaxViewerBytes {
		q.chunks, q.bytes = nil, 0
		if !chunk.Keyframe {
			q.waiting = true
			return
		}
	}
	q.chunks = append(q.chunks, chunk)
	q.bytes += len(chunk.Packet)
	q.wake()
}

// resync drops everything queued: the next chunk the viewer gets is a keyframe.
func (q *viewerQueue) resync() {
	q.chunks, q.bytes, q.waiting = nil, 0, true
}

// take is called with the service lock held.
func (q *viewerQueue) take() []Chunk {
	chunks := q.chunks
	q.chunks, q.bytes = nil, 0
	return chunks
}

// gopState is the current decodable GOP of an H.264 session, kept only so
// a joining viewer can start at its IDR.
type gopState struct {
	chunks        []Chunk
	bytes         int
	haveSequence  bool
	lastSequence  uint64
	lastTimestamp uint64
	// waiting: the stream lost a dependency; deltas are refused until a keyframe.
	waiting bool
	// overflowed: this GOP outgrew the join buffer. Chunks still reach
	// connected viewers, but a joining viewer waits for the next keyframe.
	overflowed bool
	// width and height of the current GOP's keyframe.
	width, height int
}

func (g *gopState) reset() {
	*g = gopState{waiting: true}
}

// joinable is the buffered GOP a new viewer may start with, or nil.
func (g *gopState) joinable() []Chunk {
	if g.waiting || g.overflowed || len(g.chunks) == 0 || !g.chunks[0].Keyframe {
		return nil
	}
	return g.chunks
}

// ErrAwaitingKeyframe: the stream lost a dependency and refuses delta access
// units until the next keyframe. It is expected after packet loss.
var ErrAwaitingKeyframe = errors.New("live stream is waiting for a keyframe")

var errNeedKeyframe = ErrAwaitingKeyframe

// accept validates sequence, timestamp, and dependency order and records the
// chunk. resync reports that connected viewers lost a dependency.
func (g *gopState) accept(chunk Chunk) (resync bool, err error) {
	if g.haveSequence {
		if chunk.Sequence <= g.lastSequence {
			return false, fmt.Errorf("%w: sequence did not increase", ErrInvalidFrame)
		}
		if chunk.TimestampMicros < g.lastTimestamp {
			return false, fmt.Errorf("%w: timestamp went backwards", ErrInvalidFrame)
		}
	}
	gap := g.haveSequence && chunk.Sequence != g.lastSequence+1
	g.haveSequence = true
	g.lastSequence, g.lastTimestamp = chunk.Sequence, chunk.TimestampMicros
	if chunk.Keyframe {
		g.chunks, g.bytes, g.waiting, g.overflowed = []Chunk{chunk}, len(chunk.Packet), false, false
		g.width, g.height = chunk.Width, chunk.Height
		return false, nil
	}
	if gap && !g.waiting {
		// A delta after a gap depends on a frame the server never saw.
		g.chunks, g.bytes, g.waiting = nil, 0, true
		return true, errNeedKeyframe
	}
	if g.waiting {
		return false, errNeedKeyframe
	}
	if chunk.Width != g.width || chunk.Height != g.height {
		g.chunks, g.bytes, g.waiting = nil, 0, true
		return true, fmt.Errorf("%w: dimensions changed without a keyframe", ErrInvalidFrame)
	}
	if !g.overflowed {
		if len(g.chunks)+1 > MaxGOPChunks || g.bytes+len(chunk.Packet) > MaxGOPBytes {
			g.chunks, g.bytes, g.overflowed = nil, 0, true
		} else {
			g.chunks = append(g.chunks, chunk)
			g.bytes += len(chunk.Packet)
		}
	}
	return false, nil
}
