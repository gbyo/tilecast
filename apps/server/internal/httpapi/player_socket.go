package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/livestream"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
)

type socketMessage struct {
	Type            string          `json:"type"`
	ProtocolVersion int             `json:"protocolVersion,omitempty"`
	PlayerVersion   string          `json:"playerVersion,omitempty"`
	Timestamp       string          `json:"timestamp,omitempty"`
	Payload         json.RawMessage `json:"payload,omitempty"`
}

func heartbeatPayloadInvalidFields(payload json.RawMessage) []string {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return nil
	}
	invalid := make([]string, 0, 1)
	for name, value := range fields {
		single, err := json.Marshal(map[string]json.RawMessage{name: value})
		if err != nil {
			continue
		}
		var heartbeat devices.Heartbeat
		if err := json.Unmarshal(single, &heartbeat); err != nil {
			invalid = append(invalid, name)
		}
	}
	sort.Strings(invalid)
	if len(invalid) > 8 {
		invalid = invalid[:8]
	}
	return invalid
}

func (s *server) playerSocket(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	connection.SetReadLimit(livestream.MaxFrameBytes + 1024)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer connection.Close(websocket.StatusNormalClosure, "connection closed") //nolint:errcheck

	var writeMu sync.Mutex
	send := func(message any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return wsjson.Write(ctx, connection, message)
	}
	unregister := s.devices.RegisterPresenceWithNotifier(principal.ScreenID, func() {
		cancel()
		_ = connection.Close(websocket.StatusPolicyViolation, "credential revoked or screen disabled")
	}, func(message map[string]any) error { return send(message) })
	defer func() {
		if unregister() {
			s.devices.MarkDisconnected(context.Background(), principal.ScreenID)
		}
	}()
	if err := s.devices.MarkConnected(r.Context(), principal.ScreenID, r.RemoteAddr); err != nil {
		return
	}

	if err := send(map[string]any{"type": "server.hello", "protocolVersion": 1, "screenId": principal.ScreenID, "screenName": principal.ScreenName}); err != nil {
		return
	}
	var pendingCommands bool
	_ = s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM player_commands WHERE screen_id=$1 AND state IN ('pending','delivered') AND expires_at>now())`, principal.ScreenID).Scan(&pendingCommands)
	if pendingCommands {
		_ = send(map[string]any{"type": "commands.available"})
	}

	pingDone := make(chan struct{})
	go func() {
		defer close(pingDone)
		pingTicker := time.NewTicker(30 * time.Second)
		commandTicker := time.NewTicker(5 * time.Second)
		defer pingTicker.Stop()
		defer commandTicker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-commandTicker.C:
				var commandsWaiting, commandStuck bool
				if err := s.db.QueryRow(ctx, `SELECT
					EXISTS(SELECT 1 FROM player_commands WHERE screen_id=$1 AND state IN ('pending','delivered','acknowledged','running') AND expires_at>now()),
					EXISTS(SELECT 1 FROM player_commands WHERE screen_id=$1 AND state='pending' AND created_at<=now()-interval '15 seconds' AND expires_at>now())`, principal.ScreenID).Scan(&commandsWaiting, &commandStuck); err != nil {
					continue
				}
				if commandsWaiting {
					if err := send(map[string]any{"type": "commands.available"}); err != nil {
						cancel()
						return
					}
				}
				if commandStuck {
					_ = connection.Close(websocket.StatusNormalClosure, "retry pending commands")
					cancel()
					return
				}
			case timestamp := <-pingTicker.C:
				if err := send(map[string]any{"type": "server.ping", "timestamp": timestamp.UTC().Format(time.RFC3339Nano)}); err != nil {
					cancel()
					return
				}
			}
		}
	}()

	for ctx.Err() == nil {
		messageType, data, err := connection.Read(ctx)
		if err != nil {
			break
		}
		if messageType == websocket.MessageBinary {
			sessionID, frame, parseErr := livestream.ParseBinaryFrame(data)
			if parseErr != nil {
				s.logger.Warn("invalid live stream frame rejected",
					"error", parseErr, "screen_id", principal.ScreenID)
				continue
			}
			if publishErr := s.liveStreams.Publish(principal.ScreenID, sessionID, frame); publishErr != nil &&
				!errors.Is(publishErr, livestream.ErrNotFound) {
				s.logger.Warn("live stream frame rejected",
					"error", publishErr, "screen_id", principal.ScreenID)
			}
			continue
		}
		if messageType != websocket.MessageText {
			continue
		}
		var message socketMessage
		if err := json.Unmarshal(data, &message); err != nil {
			_ = connection.Close(websocket.StatusInvalidFramePayloadData, "invalid JSON message")
			cancel()
			break
		}
		switch message.Type {
		case "player.hello":
			if message.ProtocolVersion != 1 {
				_ = connection.Close(websocket.StatusUnsupportedData, "unsupported protocol version")
				cancel()
			}
		case "player.status":
			s.handleSocketStatus(r, ctx, principal, message.Payload)
		case "player.pong":
			// The open socket itself is the presence signal; pong confirms the peer is processing messages.
		default:
			_ = connection.Close(websocket.StatusUnsupportedData, "unsupported message type")
			cancel()
		}
	}
	cancel()
	<-pingDone
}

func (s *server) handleSocketStatus(r *http.Request, ctx context.Context, principal devices.DevicePrincipal, payload json.RawMessage) {
	snapshot := s.captureHeartbeatActivity(ctx, principal.ScreenID)
	contactRecorded := false

	heartbeat, dropped, err := decodeHeartbeatTolerantly(payload)
	if len(dropped) > 0 {
		// One malformed optional identifier must not cost the lifecycle fields in
		// the same message; the field is discarded, not coerced, and named here.
		s.logger.Warn("player heartbeat optional identifiers dropped over socket",
			"invalid_fields", dropped, "screen_id", principal.ScreenID)
	}
	if err != nil {
		s.logger.Warn("player heartbeat payload rejected over socket",
			"error", "heartbeat payload contains invalid field values",
			"invalid_fields", heartbeatPayloadInvalidFields(payload),
			"screen_id", principal.ScreenID)
		if err := s.devices.MarkHeartbeatContact(ctx, principal.ScreenID, r.RemoteAddr); err != nil {
			s.logger.Warn("player heartbeat contact could not be recorded",
				"error", err, "screen_id", principal.ScreenID)
		} else {
			contactRecorded = true
		}
	} else if err := s.devices.Heartbeat(ctx, principal, heartbeat, r.RemoteAddr); err != nil {
		// Optional metadata validation must remain visible, but the authenticated
		// status message still proves that the connected player is alive.
		s.logger.Warn("player heartbeat rejected over socket",
			"error", err, "screen_id", principal.ScreenID)
		if contactErr := s.devices.MarkHeartbeatContact(ctx, principal.ScreenID, r.RemoteAddr); contactErr != nil {
			s.logger.Warn("player heartbeat contact could not be recorded",
				"error", contactErr, "screen_id", principal.ScreenID)
		} else {
			contactRecorded = true
		}
	} else {
		contactRecorded = true
		// Socket status is the player's normal heartbeat path. Run the same
		// multicast degradation hook as the HTTP fallback so a follower can
		// trigger session-level unicast fallback without waiting for a poll.
		s.fallbackAirplayForScreen(ctx, principal.ScreenID)
		s.advanceCanaryDeploymentsForScreen(ctx, principal.ScreenID)
	}

	if s.playlists != nil {
		statusPayload := []byte(payload)
		if len(dropped) > 0 {
			// Same payload, same dropped identifiers: the remaining playback status
			// is still worth recording.
			if reduced, _, ok := salvageHeartbeatPayload(payload); ok {
				statusPayload = reduced
			}
		}
		var status playlists.PlayerStatus
		if err := json.Unmarshal(statusPayload, &status); err == nil {
			_ = s.playlists.ReportStatus(ctx, principal.ScreenID, status)
		}
	}
	if contactRecorded {
		s.recordHeartbeatActivity(r, principal.ScreenID, snapshot, time.Now().UTC())
	}
}
