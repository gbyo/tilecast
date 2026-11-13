package livestream

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

type watchLiveFixture struct {
	Codec              string `json:"codec"`
	MaxAccessUnitBytes int    `json:"maxAccessUnitBytes"`
	MaxMJPEGFrameBytes int    `json:"maxMjpegFrameBytes"`
	TCLSv2HeaderBytes  int    `json:"tclsV2HeaderBytes"`
	Profiles           []struct {
		ID                  string `json:"id"`
		Code                byte   `json:"code"`
		Transport           string `json:"transport"`
		MaxWidth            int    `json:"maxWidth"`
		MaxHeight           int    `json:"maxHeight"`
		FPS                 int    `json:"fps"`
		FrameIntervalMillis int    `json:"frameIntervalMillis"`
		TargetBitrate       int    `json:"targetBitrate"`
	} `json:"profiles"`
	Selection []struct {
		Name     string   `json:"name"`
		Viewer   []string `json:"viewer"`
		Player   []string `json:"player"`
		Selected string   `json:"selected"`
	} `json:"selection"`
	TCLSv2 struct {
		Valid []struct {
			Name            string `json:"name"`
			SessionID       string `json:"sessionId"`
			Profile         string `json:"profile"`
			Sequence        uint64 `json:"sequence"`
			TimestampMicros uint64 `json:"timestampMicros"`
			Width           int    `json:"width"`
			Height          int    `json:"height"`
			Keyframe        bool   `json:"keyframe"`
			PayloadHex      string `json:"payloadHex"`
			PacketHex       string `json:"packetHex"`
		} `json:"valid"`
		Invalid []struct {
			Name       string `json:"name"`
			Keyframe   bool   `json:"keyframe"`
			PayloadHex string `json:"payloadHex"`
		} `json:"invalid"`
	} `json:"tclsV2"`
}

func loadFixture(t *testing.T) watchLiveFixture {
	t.Helper()
	raw, err := os.ReadFile("../../../../packages/player-contracts/fixtures/watch-live.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture watchLiveFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func mustHex(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestProfilesMatchTheSharedCorpus(t *testing.T) {
	fixture := loadFixture(t)
	if fixture.Codec != H264Codec || fixture.MaxAccessUnitBytes != MaxAccessUnitBytes ||
		fixture.MaxMJPEGFrameBytes != MaxFrameBytes || fixture.TCLSv2HeaderBytes != TCLSv2HeaderBytes {
		t.Fatalf("constants drifted from the fixture: %+v", fixture)
	}
	if len(fixture.Profiles) != len(Profiles) {
		t.Fatalf("profile count %d, fixture %d", len(Profiles), len(fixture.Profiles))
	}
	for index, want := range fixture.Profiles {
		got := Profiles[index]
		if got.ID != want.ID || got.Code != want.Code || string(got.Transport) != want.Transport ||
			got.MaxWidth != want.MaxWidth || got.MaxHeight != want.MaxHeight || got.FPS != want.FPS ||
			int(got.FrameInterval.Milliseconds()) != want.FrameIntervalMillis || got.TargetBitrate != want.TargetBitrate {
			t.Fatalf("profile %d drifted: %+v vs %+v", index, got, want)
		}
	}
}

func TestSelectionCorpus(t *testing.T) {
	for _, testCase := range loadFixture(t).Selection {
		t.Run(testCase.Name, func(t *testing.T) {
			service := NewService(nil)
			screenID := uuid.New()
			service.Start(screenID, testCase.Viewer)
			player := testCase.Player
			if len(player) == 1 && player[0] == "legacy:edge-540p10" {
				player = LegacyEdgeProfiles()
			}
			selected := service.SelectProfile(screenID, player, nil)
			if selected.Profile != testCase.Selected {
				t.Fatalf("selected %q, want %q", selected.Profile, testCase.Selected)
			}
			profile, _, _ := profileByID(testCase.Selected)
			if selected.Transport != profile.Transport || selected.MaxWidth != profile.MaxWidth ||
				selected.FrameIntervalMillis != int(profile.FrameInterval.Milliseconds()) || selected.TargetBitrate != profile.TargetBitrate {
				t.Fatalf("session does not expose the selected profile: %+v", selected)
			}
			if (profile.Transport == TransportH264) != (selected.Codec == H264Codec) {
				t.Fatalf("codec %q for transport %s", selected.Codec, profile.Transport)
			}
		})
	}
}

func TestTCLSv2Corpus(t *testing.T) {
	fixture := loadFixture(t)
	for _, vector := range fixture.TCLSv2.Valid {
		packet := mustHex(t, vector.PacketHex)
		sessionID := uuid.MustParse(vector.SessionID)
		profile, _, _ := profileByID(vector.Profile)
		encoded := EncodeChunk(sessionID, profile.Code, vector.Sequence, vector.TimestampMicros, vector.Width, vector.Height, vector.Keyframe, mustHex(t, vector.PayloadHex))
		if !bytes.Equal(encoded, packet) {
			t.Fatalf("%s: encoded %x", vector.Name, encoded)
		}
		chunk, err := ParseChunk(packet)
		if err != nil {
			t.Fatalf("%s: %v", vector.Name, err)
		}
		if chunk.SessionID != sessionID || chunk.Sequence != vector.Sequence || chunk.TimestampMicros != vector.TimestampMicros ||
			chunk.Width != vector.Width || chunk.Height != vector.Height || chunk.Keyframe != vector.Keyframe || chunk.ProfileCode != profile.Code {
			t.Fatalf("%s: parsed %+v", vector.Name, chunk)
		}
	}
	for _, vector := range fixture.TCLSv2.Invalid {
		if err := ValidateAccessUnit(mustHex(t, vector.PayloadHex), vector.Keyframe); !errors.Is(err, ErrInvalidFrame) {
			t.Fatalf("%s: accepted (%v)", vector.Name, err)
		}
	}
}

var (
	testKey   = []byte{0, 0, 0, 1, 0x67, 0x42, 0, 0x28, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1, 0x65, 0x88, 0x84}
	testDelta = []byte{0, 0, 1, 0x41, 0x88, 0xa0}
)

func packet(sessionID uuid.UUID, code byte, sequence uint64, keyframe bool) []byte {
	payload := testDelta
	if keyframe {
		payload = testKey
	}
	return EncodeChunk(sessionID, code, sequence, sequence*66_666, 960, 540, keyframe, payload)
}

func TestParseChunkRejectsMalformedHeaders(t *testing.T) {
	sessionID := uuid.New()
	valid := packet(sessionID, 2, 1, true)
	mutate := func(change func([]byte) []byte) []byte {
		return change(bytes.Clone(valid))
	}
	cases := map[string][]byte{
		"truncated":                valid[:TCLSv2HeaderBytes],
		"version 1":                mutate(func(p []byte) []byte { p[4] = 1; return p }),
		"version 3":                mutate(func(p []byte) []byte { p[4] = 3; return p }),
		"MJPEG code":               mutate(func(p []byte) []byte { p[5] = 0; return p }),
		"unknown code":             mutate(func(p []byte) []byte { p[5] = 9; return p }),
		"reserved flag":            mutate(func(p []byte) []byte { p[6] |= 0x02; return p }),
		"reserved byte":            mutate(func(p []byte) []byte { p[7] = 1; return p }),
		"nil session":              mutate(func(p []byte) []byte { copy(p[8:24], make([]byte, 16)); return p }),
		"length too long":          mutate(func(p []byte) []byte { p[47]++; return p }),
		"length too short":         mutate(func(p []byte) []byte { p[47]--; return p }),
		"odd width":                EncodeChunk(sessionID, 2, 1, 0, 959, 540, true, testKey),
		"too wide":                 EncodeChunk(sessionID, 2, 1, 0, 1280, 720, true, testKey),
		"tiny":                     EncodeChunk(sessionID, 2, 1, 0, 8, 8, true, testKey),
		"keyframe flag on a delta": EncodeChunk(sessionID, 2, 1, 0, 960, 540, true, testDelta),
		"oversized access unit": EncodeChunk(sessionID, 1, 1, 0, 1280, 720, false,
			append(bytes.Clone(testDelta), make([]byte, MaxAccessUnitBytes)...)),
	}
	for name, candidate := range cases {
		if _, err := ParseChunk(candidate); !errors.Is(err, ErrInvalidFrame) {
			t.Errorf("%s: accepted (%v)", name, err)
		}
	}
	if _, err := ParseChunk(EncodeChunk(sessionID, 1, 1, 0, 1280, 720, true, testKey)); err != nil {
		t.Fatalf("720p keyframe for the 720p profile rejected: %v", err)
	}
}

func h264Session(t *testing.T, service *Service, screenID uuid.UUID, profiles ...string) Session {
	t.Helper()
	viewer := []string{ProfileH264720p15, ProfileH264540p15, ProfileH264540p10, ProfileMJPEG540p10, ProfileMJPEG360p8}
	service.Start(screenID, viewer)
	selected := service.SelectProfile(screenID, profiles, nil)
	if selected.Transport != TransportH264 {
		t.Fatalf("expected H.264, got %+v", selected)
	}
	return selected
}

func publish(t *testing.T, service *Service, screenID uuid.UUID, raw []byte) error {
	t.Helper()
	chunk, err := ParseChunk(raw)
	if err != nil {
		t.Fatal(err)
	}
	return service.PublishChunk(screenID, chunk)
}

func TestH264ViewersStartAtAnIDR(t *testing.T) {
	service := NewService(nil)
	screenID := uuid.New()
	session := h264Session(t, service, screenID, ProfileH264540p15)

	// Deltas before any keyframe are not decodable and are refused.
	if err := publish(t, service, screenID, packet(session.ID, 2, 1, false)); !errors.Is(err, ErrAwaitingKeyframe) {
		t.Fatalf("leading delta: %v", err)
	}
	early, cancelEarly, err := service.SubscribeH264(screenID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer cancelEarly()
	for sequence := uint64(2); sequence <= 4; sequence++ {
		if err := publish(t, service, screenID, packet(session.ID, 2, sequence, sequence == 2)); err != nil {
			t.Fatal(err)
		}
	}
	// A viewer joining mid-GOP gets the buffered GOP from its IDR.
	late, cancelLate, err := service.SubscribeH264(screenID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer cancelLate()
	for name, subscription := range map[string]*H264Subscription{"early": early, "late": late} {
		chunks := subscription.Take()
		if len(chunks) != 3 || !chunks[0].Keyframe || chunks[0].Sequence != 2 || chunks[2].Sequence != 4 {
			t.Fatalf("%s viewer got %d chunks starting %+v", name, len(chunks), chunks)
		}
	}
	// The relay mirror must not alias the WebSocket read buffer.
	raw := packet(session.ID, 2, 5, false)
	if err := publish(t, service, screenID, raw); err != nil {
		t.Fatal(err)
	}
	raw[TCLSv2HeaderBytes+4] ^= 0xff
	if chunks := late.Take(); len(chunks) != 1 || chunks[0].Payload()[4] != testDelta[4] {
		t.Fatalf("relayed chunk aliases the input: %+v", chunks)
	}
	if current := service.Current(screenID); current.FrameSequence != 4 || current.LastFrameAt == nil {
		t.Fatalf("health hints not recorded: %+v", current)
	}
}

func TestH264SequenceGapsAndTimestamps(t *testing.T) {
	service := NewService(nil)
	screenID := uuid.New()
	session := h264Session(t, service, screenID, ProfileH264540p15)
	viewer, cancel, _ := service.SubscribeH264(screenID, session.ID)
	defer cancel()
	if err := publish(t, service, screenID, packet(session.ID, 2, 10, true)); err != nil {
		t.Fatal(err)
	}
	if err := publish(t, service, screenID, packet(session.ID, 2, 10, false)); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("repeated sequence accepted: %v", err)
	}
	backwards := EncodeChunk(session.ID, 2, 11, 1, 960, 540, false, testDelta)
	if err := publish(t, service, screenID, backwards); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("backwards timestamp accepted: %v", err)
	}
	// Sequence 11 never arrived: 12 depends on it.
	if err := publish(t, service, screenID, packet(session.ID, 2, 12, false)); !errors.Is(err, ErrAwaitingKeyframe) {
		t.Fatalf("delta after a gap accepted: %v", err)
	}
	if err := publish(t, service, screenID, packet(session.ID, 2, 13, false)); !errors.Is(err, ErrAwaitingKeyframe) {
		t.Fatalf("delta while waiting accepted: %v", err)
	}
	if chunks := viewer.Take(); len(chunks) != 0 {
		t.Fatalf("viewer kept chunks across a lost dependency: %d", len(chunks))
	}
	if err := publish(t, service, screenID, packet(session.ID, 2, 20, true)); err != nil {
		t.Fatalf("keyframe after a gap refused: %v", err)
	}
	if err := publish(t, service, screenID, packet(session.ID, 2, 21, false)); err != nil {
		t.Fatal(err)
	}
	if chunks := viewer.Take(); len(chunks) != 2 || !chunks[0].Keyframe || chunks[0].Sequence != 20 {
		t.Fatalf("viewer did not resume at the keyframe: %+v", chunks)
	}
	resized := EncodeChunk(session.ID, 2, 22, 22*66_666, 640, 360, false, testDelta)
	if err := publish(t, service, screenID, resized); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("dimension change without a keyframe accepted: %v", err)
	}
}

func TestSlowViewerDropsToTheNextKeyframe(t *testing.T) {
	service := NewService(nil)
	screenID := uuid.New()
	session := h264Session(t, service, screenID, ProfileH264540p15)
	slow, cancel, _ := service.SubscribeH264(screenID, session.ID)
	defer cancel()
	sequence := uint64(1)
	if err := publish(t, service, screenID, packet(session.ID, 2, sequence, true)); err != nil {
		t.Fatal(err)
	}
	// The viewer never reads. Its queue stays bounded and never holds a
	// delta whose predecessor it dropped.
	for range MaxViewerChunks * 3 {
		sequence++
		if err := publish(t, service, screenID, packet(session.ID, 2, sequence, false)); err != nil {
			t.Fatal(err)
		}
		service.mu.Lock()
		if len(slow.queue.chunks) > MaxViewerChunks || slow.queue.bytes > MaxViewerBytes {
			t.Fatalf("viewer queue grew to %d chunks", len(slow.queue.chunks))
		}
		if len(slow.queue.chunks) > 0 && !slow.queue.chunks[0].Keyframe {
			t.Fatal("viewer queue starts with a delta")
		}
		service.mu.Unlock()
	}
	if chunks := slow.Take(); len(chunks) != 0 {
		t.Fatalf("overflowed viewer kept %d chunks", len(chunks))
	}
	sequence++
	if err := publish(t, service, screenID, packet(session.ID, 2, sequence, true)); err != nil {
		t.Fatal(err)
	}
	if chunks := slow.Take(); len(chunks) != 1 || !chunks[0].Keyframe {
		t.Fatalf("viewer did not resume at the keyframe: %+v", chunks)
	}
}

func TestGOPJoinBufferIsBounded(t *testing.T) {
	service := NewService(nil)
	screenID := uuid.New()
	session := h264Session(t, service, screenID, ProfileH264540p15)
	connected, cancel, _ := service.SubscribeH264(screenID, session.ID)
	defer cancel()
	sequence := uint64(1)
	_ = publish(t, service, screenID, packet(session.ID, 2, sequence, true))
	for range MaxGOPChunks + 10 {
		sequence++
		if err := publish(t, service, screenID, packet(session.ID, 2, sequence, false)); err != nil {
			t.Fatal(err)
		}
		_ = connected.Take() // a connected viewer keeps up and keeps receiving
		service.mu.Lock()
		gop := service.sessions[screenID].gop
		service.mu.Unlock()
		if len(gop.chunks) > MaxGOPChunks || gop.bytes > MaxGOPBytes {
			t.Fatalf("GOP grew to %d chunks", len(gop.chunks))
		}
	}
	sequence++
	_ = publish(t, service, screenID, packet(session.ID, 2, sequence, false))
	if chunks := connected.Take(); len(chunks) != 1 {
		t.Fatalf("connected viewer stopped receiving after the join buffer overflowed: %d", len(chunks))
	}
	joiner, cancelJoiner, _ := service.SubscribeH264(screenID, session.ID)
	defer cancelJoiner()
	if chunks := joiner.Take(); len(chunks) != 0 {
		t.Fatalf("joiner started inside an overflowed GOP: %d chunks", len(chunks))
	}
}

func TestProfileMismatchAndDowngradeNeverUpgrade(t *testing.T) {
	service := NewService(nil)
	screenID := uuid.New()
	all := []string{ProfileH264720p15, ProfileH264540p15, ProfileH264540p10, ProfileMJPEG540p10, ProfileMJPEG360p8}
	session := h264Session(t, service, screenID, all...)
	if session.Profile != ProfileH264720p15 || session.ProfileGeneration != 0 || session.MaxFrameBytes != MaxAccessUnitBytes {
		t.Fatalf("unexpected first selection: %+v", session)
	}
	jpeg := Frame{CapturedAt: time.Now(), Width: 640, Height: 360, JPEG: []byte{0xff, 0xd8, 1, 0xff, 0xd9}}
	if err := service.Publish(screenID, session.ID, jpeg); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("JPEG accepted for an H.264 session: %v", err)
	}
	if err := publish(t, service, screenID, packet(session.ID, 2, 1, true)); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("540p chunk accepted for a 720p session: %v", err)
	}
	if _, _, err := service.Subscribe(screenID, session.ID); !errors.Is(err, ErrWrongTransport) {
		t.Fatalf("MJPEG relay opened for an H.264 session: %v", err)
	}
	viewer, cancel, err := service.SubscribeH264(screenID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	if again := service.SelectProfile(screenID, all, nil); again.Profile != ProfileH264720p15 || again.ProfileGeneration != 0 {
		t.Fatalf("an unchanged poll changed the session: %+v", again)
	}

	// The Player degrades: it stops listing 720p for this session.
	degraded := service.SelectProfile(screenID, all[1:], nil)
	if degraded.Profile != ProfileH264540p15 || degraded.ProfileGeneration != 1 || degraded.MaxWidth != 960 {
		t.Fatalf("downgrade did not select 540p15: %+v", degraded)
	}
	select {
	case <-viewer.Changed:
	default:
		t.Fatal("a profile change did not end the relay request")
	}
	if err := publish(t, service, screenID, EncodeChunk(session.ID, 1, 2, 0, 1280, 720, true, testKey)); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("a chunk for the old profile was accepted after the change: %v", err)
	}
	// Listing 720p again never upgrades the same session.
	if again := service.SelectProfile(screenID, all, nil); again.Profile != ProfileH264540p15 || again.ProfileGeneration != 1 {
		t.Fatalf("session upgraded: %+v", again)
	}
	// Degrading out of H.264 lands on MJPEG.
	mjpeg := service.SelectProfile(screenID, all[3:], nil)
	if mjpeg.Profile != ProfileMJPEG540p10 || mjpeg.Transport != TransportMJPEG || mjpeg.Codec != "" || mjpeg.ProfileGeneration != 2 || mjpeg.MaxFrameBytes != MaxFrameBytes {
		t.Fatalf("downgrade to MJPEG: %+v", mjpeg)
	}
	if err := service.Publish(screenID, session.ID, jpeg); err != nil {
		t.Fatalf("JPEG refused after the downgrade: %v", err)
	}
	// A new session probes the best profile again.
	fresh := h264Session(t, service, screenID, all...)
	if fresh.Profile != ProfileH264720p15 || fresh.ProfileGeneration != 0 {
		t.Fatalf("new session inherited the downgrade: %+v", fresh)
	}
}

func TestH264EndsWithTheSession(t *testing.T) {
	service := NewService(nil)
	now := time.Now().UTC()
	service.now = func() time.Time { return now }
	screenID := uuid.New()
	session := h264Session(t, service, screenID, ProfileH264540p15)
	viewer, cancel, _ := service.SubscribeH264(screenID, session.ID)
	defer cancel()
	_ = publish(t, service, screenID, packet(session.ID, 2, 1, true))

	replacement := h264Session(t, service, screenID, ProfileH264540p15)
	select {
	case <-viewer.Done:
	default:
		t.Fatal("replacement did not end the old viewer")
	}
	if err := publish(t, service, screenID, packet(session.ID, 2, 2, true)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stale-session chunk accepted: %v", err)
	}
	if _, _, err := service.SubscribeH264(screenID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old viewer re-subscribed: %v", err)
	}
	now = now.Add(LeaseDuration + time.Second)
	if err := publish(t, service, screenID, packet(replacement.ID, 2, 1, true)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired-session chunk accepted: %v", err)
	}
	service.mu.Lock()
	remaining := len(service.sessions)
	service.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("expired session kept its GOP in memory")
	}
}

func TestDegradationHintAppliesOnlyToItsSession(t *testing.T) {
	service := NewService(nil)
	screenID := uuid.New()
	all := []string{ProfileH264720p15, ProfileH264540p15, ProfileH264540p10, ProfileMJPEG540p10, ProfileMJPEG360p8}
	session := h264Session(t, service, screenID, all...)
	stale := &Degradation{SessionID: uuid.New(), Profile: ProfileH264720p15}
	if kept := service.SelectProfile(screenID, all, stale); kept.Profile != ProfileH264720p15 {
		t.Fatalf("a hint for another session lowered this one: %+v", kept)
	}
	hint := &Degradation{SessionID: session.ID, Profile: ProfileH264720p15}
	if lowered := service.SelectProfile(screenID, all, hint); lowered.Profile != ProfileH264540p15 || lowered.ProfileGeneration != 1 {
		t.Fatalf("hint ignored: %+v", lowered)
	}
	hint.Profile = ProfileH264540p10
	if lowered := service.SelectProfile(screenID, all, hint); lowered.Profile != ProfileMJPEG540p10 || lowered.Transport != TransportMJPEG {
		t.Fatalf("degrading out of 540p10 must land on MJPEG: %+v", lowered)
	}
	hint.Profile = ProfileMJPEG360p8
	if floor := service.SelectProfile(screenID, all, hint); floor.Profile != ProfileMJPEG360p8 {
		t.Fatalf("the legacy profile is the floor: %+v", floor)
	}
	// A replacement session probes the best profile again even if the
	// Player's first poll still carries the old session's hint.
	fresh := service.Start(screenID, all)
	if probed := service.SelectProfile(screenID, all, &Degradation{SessionID: session.ID, Profile: ProfileH264720p15}); probed.ID != fresh.ID || probed.Profile != ProfileH264720p15 {
		t.Fatalf("a stale hint lowered a new lease: %+v", probed)
	}
}
