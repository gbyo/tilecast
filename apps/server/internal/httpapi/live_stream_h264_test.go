package httpapi

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/livestream"
)

var (
	h264Key   = []byte{0, 0, 0, 1, 0x67, 0x42, 0, 0x28, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1, 0x65, 0x88, 0x84}
	h264Delta = []byte{0, 0, 1, 0x41, 0x88, 0xa0}
)

func liveStreamTestRouter(s *server, screenID uuid.UUID) http.Handler {
	router := chi.NewRouter()
	router.Post("/screens/{id}/live-stream", s.startLiveStream)
	router.Get("/screens/{id}/live-stream/{sessionId}/h264", s.watchLiveStreamH264)
	router.Get("/screens/{id}/live-stream/{sessionId}/mjpeg", s.watchLiveStream)
	router.Get("/player/live-stream-session", func(w http.ResponseWriter, r *http.Request) {
		principal := devices.DevicePrincipal{ScreenID: screenID, Enabled: true}
		s.playerLiveStreamSession(w, r.WithContext(context.WithValue(r.Context(), deviceContextKey, principal)))
	})
	return router
}

func decodeSession(t *testing.T, body io.Reader) livestream.Session {
	t.Helper()
	var envelope struct {
		Data livestream.Session `json:"data"`
	}
	if err := json.NewDecoder(body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

func TestLiveStreamNegotiationOverHTTP(t *testing.T) {
	screenID := uuid.New()
	s := &server{liveStreams: livestream.NewService(nil), logger: slog.New(slog.DiscardHandler)}
	router := liveStreamTestRouter(s, screenID)
	start := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/screens/"+screenID.String()+"/live-stream", strings.NewReader(body))
		if body == "" {
			request.ContentLength = 0
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	poll := func(query string) livestream.Session {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/player/live-stream-session"+query, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("poll %q: %d %s", query, response.Code, response.Body)
		}
		return decodeSession(t, response.Body)
	}
	newPlayer := "?profile=h264-720p15&profile=h264-540p15&profile=h264-540p10&profile=mjpeg-540p10&profile=mjpeg-360p8"

	// An older Studio sends no body and gets MJPEG even from a new Player.
	if response := start(""); response.Code != http.StatusCreated {
		t.Fatalf("legacy start: %d %s", response.Code, response.Body)
	}
	if session := poll(newPlayer); session.Profile != livestream.ProfileMJPEG540p10 || session.Transport != livestream.TransportMJPEG {
		t.Fatalf("old Studio and new Player: %+v", session)
	}

	// A new Studio and an older Edge Player (the retired query) stay on MJPEG.
	viewer := `{"acceptProfiles":["h264-720p15","h264-540p15","h264-540p10","mjpeg-540p10","mjpeg-360p8"]}`
	if response := start(viewer); response.Code != http.StatusCreated {
		t.Fatalf("start: %d %s", response.Code, response.Body)
	}
	if session := poll("?captureProfile=edge-540p10"); session.Profile != livestream.ProfileMJPEG540p10 {
		t.Fatalf("new Studio and old Edge Player: %+v", session)
	}
	start(viewer)
	if session := poll(""); session.Profile != livestream.ProfileMJPEG360p8 || session.MaxWidth != 640 {
		t.Fatalf("new Studio and old Player: %+v", session)
	}
	created := start(viewer)
	if pending := decodeSession(t, created.Body); pending.Profile != "" || pending.Transport != livestream.TransportMJPEG {
		t.Fatalf("an unnegotiated lease must look like the legacy profile: %+v", pending)
	}
	session := poll(newPlayer)
	if session.Profile != livestream.ProfileH264720p15 || session.Codec != livestream.H264Codec || session.TargetBitrate != 1_500_000 {
		t.Fatalf("both sides support 720p: %+v", session)
	}

	for name, body := range map[string]string{
		"unknown field": `{"acceptProfiles":[],"extra":true}`,
		"wrong type":    `{"acceptProfiles":"h264-720p15"}`,
		"too many":      `{"acceptProfiles":[` + strings.Repeat(`"x",`, livestream.MaxProfileList) + `"x"]}`,
		"two objects":   `{} {}`,
	} {
		if response := start(body); response.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", name, response.Code)
		}
	}
	tooMany := "?" + strings.Repeat("profile=x&", livestream.MaxProfileList) + "profile=x"
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/player/live-stream-session"+tooMany, nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unbounded Player profile list: %d", response.Code)
	}
}

func readRecord(t *testing.T, body io.Reader) livestream.Chunk {
	t.Helper()
	var length [4]byte
	if _, err := io.ReadFull(body, length[:]); err != nil {
		t.Fatal(err)
	}
	size := binary.BigEndian.Uint32(length[:])
	if size > livestream.MaxChunkPacketBytes {
		t.Fatalf("record of %d bytes", size)
	}
	packet := make([]byte, size)
	if _, err := io.ReadFull(body, packet); err != nil {
		t.Fatal(err)
	}
	chunk, err := livestream.ParseChunk(packet)
	if err != nil {
		t.Fatal(err)
	}
	return chunk
}

func TestH264RelayEndpoint(t *testing.T) {
	screenID := uuid.New()
	service := livestream.NewService(nil)
	s := &server{liveStreams: service, logger: slog.New(slog.DiscardHandler)}
	server := httptest.NewServer(liveStreamTestRouter(s, screenID))
	defer server.Close()
	session := service.Start(screenID, []string{livestream.ProfileH264540p15, livestream.ProfileMJPEG360p8})
	if selected := service.SelectProfile(screenID, []string{livestream.ProfileH264540p15}, nil); selected.Profile != livestream.ProfileH264540p15 {
		t.Fatalf("selected %+v", selected)
	}
	send := func(sequence uint64, keyframe bool) {
		payload := h264Delta
		if keyframe {
			payload = h264Key
		}
		var rejects rejectLog
		s.handleLiveStreamBinary(screenID, livestream.EncodeChunk(session.ID, 2, sequence, sequence*66_666, 960, 540, keyframe, payload), &rejects)
	}
	send(1, true)
	send(2, false)

	base := server.URL + "/screens/" + screenID.String() + "/live-stream/" + session.ID.String()
	mjpeg, err := http.Get(base + "/mjpeg")
	if err != nil {
		t.Fatal(err)
	}
	mjpeg.Body.Close()
	if mjpeg.StatusCode != http.StatusConflict {
		t.Fatalf("MJPEG relay for an H.264 session: %d", mjpeg.StatusCode)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/h264", nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	for header, want := range map[string]string{
		"Cache-Control":          "no-store, private",
		"Content-Type":           "application/vnd.tilecast.live-h264",
		"X-Content-Type-Options": "nosniff",
		"X-Accel-Buffering":      "no",
	} {
		if got := response.Header.Get(header); got != want {
			t.Errorf("%s = %q", header, got)
		}
	}
	// The joiner starts at the buffered IDR, then follows the live stream.
	if first := readRecord(t, response.Body); !first.Keyframe || first.Sequence != 1 {
		t.Fatalf("first record %+v", first)
	}
	if second := readRecord(t, response.Body); second.Keyframe || second.Sequence != 2 {
		t.Fatalf("second record %+v", second)
	}
	send(3, false)
	if third := readRecord(t, response.Body); third.Sequence != 3 {
		t.Fatalf("third record %+v", third)
	}
	// A downgrade to MJPEG ends the H.264 request.
	service.SelectProfile(screenID, []string{livestream.ProfileMJPEG360p8}, nil)
	if _, err := io.ReadAll(response.Body); err != nil {
		t.Fatalf("relay did not end cleanly: %v", err)
	}
}
