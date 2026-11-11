package httpapi

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/livestream"
)

const liveStreamBoundary = "tilecastframe"

func (s *server) startLiveStream(w http.ResponseWriter, r *http.Request) {
	screenID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	// An older Studio sends no body: it can only consume MJPEG.
	var request struct {
		AcceptProfiles []string `json:"acceptProfiles"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSONLimit(w, r, &request, 4096); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
			return
		}
		if len(request.AcceptProfiles) > livestream.MaxProfileList {
			writeError(w, http.StatusBadRequest, "invalid_request", "acceptProfiles lists too many profiles.")
			return
		}
	}
	session := s.liveStreams.Start(screenID, request.AcceptProfiles)
	writeJSON(w, http.StatusCreated, map[string]any{"data": session})
}

func (s *server) renewLiveStream(w http.ResponseWriter, r *http.Request) {
	screenID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	sessionID, ok := urlUUID(w, r, "sessionId")
	if !ok {
		return
	}
	session, err := s.liveStreams.Renew(screenID, sessionID)
	if err != nil {
		s.writeLiveStreamError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": session})
}

func (s *server) endLiveStream(w http.ResponseWriter, r *http.Request) {
	screenID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	sessionID, ok := urlUUID(w, r, "sessionId")
	if !ok {
		return
	}
	if err := s.liveStreams.End(screenID, sessionID); err != nil {
		s.writeLiveStreamError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) playerLiveStreamSession(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	profiles, ok := playerLiveStreamProfiles(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_request", "The Watch Live profile list is invalid.")
		return
	}
	degraded, ok := playerLiveStreamDegradation(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_request", "The Watch Live degradation is invalid.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s.liveStreams.SelectProfile(principal.ScreenID, profiles, degraded)})
}

// playerLiveStreamDegradation reads the optional degradedSession and
// degradedProfile pair: the Player could not sustain that profile for that
// session.
func playerLiveStreamDegradation(r *http.Request) (*livestream.Degradation, bool) {
	query := r.URL.Query()
	session, profile := query.Get("degradedSession"), query.Get("degradedProfile")
	if session == "" && profile == "" {
		return nil, true
	}
	sessionID, err := uuid.Parse(session)
	if err != nil || len(profile) == 0 || len(profile) > 32 {
		return nil, false
	}
	return &livestream.Degradation{SessionID: sessionID, Profile: profile}, true
}

// playerLiveStreamProfiles reads the Player's repeated `profile` query
// values. No value means a Player that predates negotiation (the legacy
// profile); the retired `captureProfile=edge-540p10` means an older Edge
// Player that captures 960x540 MJPEG.
func playerLiveStreamProfiles(r *http.Request) ([]string, bool) {
	query := r.URL.Query()
	values := query["profile"]
	if len(values) > livestream.MaxProfileList {
		return nil, false
	}
	for _, value := range values {
		if len(value) == 0 || len(value) > 32 {
			return nil, false
		}
	}
	if len(values) > 0 {
		return values, true
	}
	if query.Get("captureProfile") == "edge-540p10" {
		return livestream.LegacyEdgeProfiles(), true
	}
	return nil, true
}

func (s *server) watchLiveStream(w http.ResponseWriter, r *http.Request) {
	screenID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	sessionID, ok := urlUUID(w, r, "sessionId")
	if !ok {
		return
	}
	subscription, cancel, err := s.liveStreams.Subscribe(screenID, sessionID)
	if err != nil {
		s.writeLiveStreamError(w, r, err)
		return
	}
	defer cancel()

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming_unavailable", "This server cannot relay a live stream.")
		return
	}
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary="+liveStreamBoundary)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	expiryCheck := time.NewTicker(time.Second)
	defer expiryCheck.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-subscription.Done:
			return
		case <-subscription.Changed:
			return
		case <-expiryCheck.C:
			current := s.liveStreams.Current(screenID)
			if !current.Active || current.ID != sessionID {
				return
			}
		case frame := <-subscription.Frames:
			if _, err := fmt.Fprintf(w,
				"--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\nX-Tilecast-Captured-At: %s\r\n\r\n",
				liveStreamBoundary, len(frame.JPEG), frame.CapturedAt.Format(time.RFC3339Nano)); err != nil {
				return
			}
			if _, err := w.Write(frame.JPEG); err != nil {
				return
			}
			if _, err := w.Write([]byte("\r\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// h264ViewerWriteTimeout ends a Studio request whose connection accepts no
// bytes for this long. Short of that, a slow viewer's bounded queue drops
// to the next keyframe instead of growing.
const h264ViewerWriteTimeout = 10 * time.Second

// watchLiveStreamH264 relays TCLS version 2 packets to Studio as
// `application/vnd.tilecast.live-h264`: each record is a big-endian u32
// length followed by the packet exactly as the Player sent it. The first
// record is always a keyframe with its SPS and PPS.
func (s *server) watchLiveStreamH264(w http.ResponseWriter, r *http.Request) {
	screenID, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	sessionID, ok := urlUUID(w, r, "sessionId")
	if !ok {
		return
	}
	subscription, cancel, err := s.liveStreams.SubscribeH264(screenID, sessionID)
	if err != nil {
		s.writeLiveStreamError(w, r, err)
		return
	}
	defer cancel()
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming_unavailable", "This server cannot relay a live stream.")
		return
	}
	controller := http.NewResponseController(w)
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("Content-Type", "application/vnd.tilecast.live-h264")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	expiryCheck := time.NewTicker(time.Second)
	defer expiryCheck.Stop()
	var length [4]byte
	for {
		select {
		case <-r.Context().Done():
			return
		case <-subscription.Done:
			return
		case <-subscription.Changed:
			return
		case <-expiryCheck.C:
			current := s.liveStreams.Current(screenID)
			if !current.Active || current.ID != sessionID {
				return
			}
		case <-subscription.Ready:
			for _, chunk := range subscription.Take() {
				_ = controller.SetWriteDeadline(time.Now().Add(h264ViewerWriteTimeout))
				binary.BigEndian.PutUint32(length[:], uint32(len(chunk.Packet)))
				if _, err := w.Write(length[:]); err != nil {
					return
				}
				if _, err := w.Write(chunk.Packet); err != nil {
					return
				}
			}
			flusher.Flush()
		}
	}
}

func (s *server) writeLiveStreamError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, livestream.ErrReplaced):
		writeError(w, http.StatusConflict, "live_stream_replaced", "Another viewer replaced this live stream session.")
	case errors.Is(err, livestream.ErrWrongTransport):
		writeError(w, http.StatusConflict, "live_stream_transport_changed", "This live stream session uses another transport.")
	case errors.Is(err, livestream.ErrNotFound):
		writeError(w, http.StatusNotFound, "live_stream_not_found", "That live stream is no longer active.")
	case errors.Is(err, livestream.ErrInvalidFrame):
		writeError(w, http.StatusUnprocessableEntity, "invalid_live_stream_frame", "The player sent an invalid live stream frame.")
	default:
		s.internalError(w, r, err)
	}
}
