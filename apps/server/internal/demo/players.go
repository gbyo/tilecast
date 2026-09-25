package demo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
)

// The simulator stands in for physical players. It speaks the public player
// protocol over HTTP and WebSocket, with the credential the real enrollment
// path issued, so every server behavior it triggers is the production one:
// presence, heartbeats, manifest invalidation, and the command queue.

const (
	statusInterval = 30 * time.Second
	maxBackoff     = 10 * time.Second
)

// PlayerStatus is what a simulated player has observed, for tests and the
// demo status endpoint.
type PlayerStatus struct {
	ScreenID        uuid.UUID `json:"screenId"`
	ScreenName      string    `json:"screenName"`
	Transport       string    `json:"transport"`
	Connected       bool      `json:"connected"`
	ManifestVersion int64     `json:"manifestVersion"`
	ManifestFetches int       `json:"manifestFetches"`
	CommandsHandled int       `json:"commandsHandled"`
	LastCommand     string    `json:"lastCommand,omitempty"`
	LastError       string    `json:"lastError,omitempty"`
}

// Simulator runs one goroutine per player until Stop.
type Simulator struct {
	baseURL string
	client  *http.Client
	logger  *slog.Logger
	cancel  context.CancelFunc
	wg      sync.WaitGroup

	mu      sync.Mutex
	changed chan struct{}
	status  map[uuid.UUID]*PlayerStatus
	order   []uuid.UUID
}

// StartSimulator begins simulating players against a Tilecast server.
func StartSimulator(parent context.Context, baseURL string, players []Player, logger *slog.Logger) *Simulator {
	ctx, cancel := context.WithCancel(parent)
	s := &Simulator{
		baseURL: strings.TrimRight(baseURL, "/"), client: &http.Client{Timeout: 15 * time.Second}, logger: logger,
		cancel: cancel, changed: make(chan struct{}), status: map[uuid.UUID]*PlayerStatus{},
	}
	for index, player := range players {
		transport := "heartbeat"
		if player.Socket {
			transport = "socket"
		}
		s.status[player.ScreenID] = &PlayerStatus{ScreenID: player.ScreenID, ScreenName: player.ScreenName, Transport: transport}
		s.order = append(s.order, player.ScreenID)
		s.wg.Add(1)
		// Players come online a moment apart, as a real fleet does, rather than
		// all asking for a manifest in the same instant.
		go func(player Player, delay time.Duration) {
			defer s.wg.Done()
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			s.run(ctx, player)
		}(player, time.Duration(index)*150*time.Millisecond)
	}
	return s
}

// Stop ends every simulated player and waits for its connection to close.
func (s *Simulator) Stop() {
	if s == nil {
		return
	}
	s.cancel()
	s.wg.Wait()
}

// Statuses reports every simulated player in seed order.
func (s *Simulator) Statuses() []PlayerStatus {
	if s == nil {
		return []PlayerStatus{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]PlayerStatus, 0, len(s.order))
	for _, id := range s.order {
		result = append(result, *s.status[id])
	}
	return result
}

// AwaitConnected blocks until every simulated player has made contact: a
// socket player has received server.hello, a heartbeat player has had a
// heartbeat accepted.
func (s *Simulator) AwaitConnected(ctx context.Context) error {
	if s == nil {
		return nil
	}
	for {
		s.mu.Lock()
		waiting := []string{}
		for _, id := range s.order {
			if !s.status[id].Connected {
				waiting = append(waiting, s.status[id].ScreenName)
			}
		}
		changed := s.changed
		s.mu.Unlock()
		if len(waiting) == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("simulated players did not connect: %s: %w", strings.Join(waiting, ", "), ctx.Err())
		case <-changed:
		}
	}
}

func (s *Simulator) update(id uuid.UUID, change func(*PlayerStatus)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	change(s.status[id])
	close(s.changed)
	s.changed = make(chan struct{})
}

// errStopPlayer ends a player permanently: its credential was revoked, its
// screen was disabled, or the server is a different installation.
var errStopPlayer = errors.New("simulated player stopped")

func (s *Simulator) run(ctx context.Context, player Player) {
	backoff := time.Second
	for ctx.Err() == nil {
		var err error
		if player.Socket {
			err = s.runSocket(ctx, player)
		} else {
			err = s.runHeartbeat(ctx, player)
		}
		s.update(player.ScreenID, func(status *PlayerStatus) {
			status.Connected = false
			if err != nil && ctx.Err() == nil {
				status.LastError = err.Error()
			}
		})
		if errors.Is(err, errStopPlayer) || ctx.Err() != nil {
			if ctx.Err() == nil {
				s.logger.Info("simulated player stopped", "screen_id", player.ScreenID, "reason", err)
			}
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// verifyInstallation reads the public identity first and refuses to present
// the credential to any other installation, as a real player must.
func (s *Simulator) verifyInstallation(ctx context.Context) error {
	var identity struct {
		InstallationID string `json:"installationId"`
	}
	if err := s.request(ctx, http.MethodGet, "/api/v1/system/identity", "", nil, &identity); err != nil {
		return err
	}
	if identity.InstallationID != InstallationID {
		return fmt.Errorf("%w: server installation identity changed", errStopPlayer)
	}
	return nil
}

func (s *Simulator) runSocket(ctx context.Context, player Player) error {
	if err := s.verifyInstallation(ctx); err != nil {
		return err
	}
	if err := s.syncManifest(ctx, player); err != nil {
		return err
	}
	socketURL := "ws" + strings.TrimPrefix(s.baseURL, "http") + "/api/v1/player/socket"
	connection, response, err := websocket.Dial(ctx, socketURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + player.Credential}},
	})
	if err != nil {
		if response != nil && (response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden) {
			return fmt.Errorf("%w: socket refused with %d", errStopPlayer, response.StatusCode)
		}
		return err
	}
	defer connection.Close(websocket.StatusNormalClosure, "simulated player stopped") //nolint:errcheck

	var writeMu sync.Mutex
	send := func(message any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return wsjson.Write(writeCtx, connection, message)
	}
	sendStatus := func() error {
		return send(map[string]any{"type": "player.status", "payload": s.heartbeat(player)})
	}
	if err = send(map[string]any{"type": "player.hello", "protocolVersion": 1, "playerVersion": player.Device.PlayerVersion}); err != nil {
		return err
	}
	if err = sendStatus(); err != nil {
		return err
	}

	statusCtx, stopStatus := context.WithCancel(ctx)
	defer stopStatus()
	go func() {
		ticker := time.NewTicker(statusInterval)
		defer ticker.Stop()
		for {
			select {
			case <-statusCtx.Done():
				return
			case <-ticker.C:
				if sendStatus() != nil {
					return
				}
			}
		}
	}()

	for {
		var message struct {
			Type string `json:"type"`
		}
		if err = wsjson.Read(ctx, connection, &message); err != nil {
			var closeErr websocket.CloseError
			if errors.As(err, &closeErr) && closeErr.Code == websocket.StatusPolicyViolation {
				return fmt.Errorf("%w: %s", errStopPlayer, closeErr.Reason)
			}
			return err
		}
		switch message.Type {
		case "server.hello":
			s.update(player.ScreenID, func(status *PlayerStatus) { status.Connected, status.LastError = true, "" })
		case "server.ping":
			err = send(map[string]any{"type": "player.pong", "timestamp": time.Now().UTC().Format(time.RFC3339)})
		case "manifest.changed", "takeover.changed":
			if err = s.syncManifest(ctx, player); err == nil {
				err = sendStatus()
			}
		case "config.changed":
			err = s.request(ctx, http.MethodGet, "/api/v1/player/config", player.Credential, nil, nil)
		case "commands.available":
			err = s.handleCommands(ctx, player)
		}
		if err != nil {
			return err
		}
	}
}

// runHeartbeat is the fallback transport a player uses when it cannot hold a
// socket: periodic HTTP heartbeats and command polling. Studio shows such a
// screen as recent rather than online.
func (s *Simulator) runHeartbeat(ctx context.Context, player Player) error {
	if err := s.verifyInstallation(ctx); err != nil {
		return err
	}
	ticker := time.NewTicker(statusInterval)
	defer ticker.Stop()
	for {
		if err := s.syncManifest(ctx, player); err != nil {
			return err
		}
		if err := s.request(ctx, http.MethodPost, "/api/v1/player/heartbeat", player.Credential, s.heartbeat(player), nil); err != nil {
			return err
		}
		s.update(player.ScreenID, func(status *PlayerStatus) { status.Connected, status.LastError = true, "" })
		if err := s.handleCommands(ctx, player); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (s *Simulator) heartbeat(player Player) any {
	s.mu.Lock()
	version := s.status[player.ScreenID].ManifestVersion
	s.mu.Unlock()
	var active *int64
	if version > 0 {
		active = &version
	}
	return heartbeatFor(player.Device, active)
}

// syncManifest downloads the manifest the way a player does and records the
// version it now plays. Media bytes are not downloaded.
func (s *Simulator) syncManifest(ctx context.Context, player Player) error {
	var manifest struct {
		ManifestVersion int64 `json:"manifestVersion"`
	}
	if err := s.request(ctx, http.MethodGet, "/api/v1/player/manifest", player.Credential, nil, &manifest); err != nil {
		return err
	}
	s.update(player.ScreenID, func(status *PlayerStatus) {
		status.ManifestVersion = manifest.ManifestVersion
		status.ManifestFetches++
	})
	return nil
}

type playerCommand struct {
	ID      uuid.UUID      `json:"id"`
	Type    string         `json:"type"`
	State   string         `json:"state"`
	Payload map[string]any `json:"payload"`
}

// commandOutcomes are the result codes the Android player reports. Anything
// else is answered the way the Android player answers an unknown command.
var commandOutcomes = map[string][2]string{
	"identify_screen":           {"screen_identified", "Identification overlay displayed"},
	"sync_now":                  {"manifest_sync_started", "Manifest synchronization started"},
	"reload_playback":           {"playback_reloaded", "Playback reloaded"},
	"disable_playback":          {"playback_disabled", "Playback disabled"},
	"enable_playback":           {"playback_enabled", "Playback enabled"},
	"resynchronize_player":      {"player_resynchronized", "Manifest and configuration synchronization completed"},
	"retry_current_item":        {"current_item_retried", "Current item was restarted"},
	"skip_current_item":         {"current_item_skipped", "Player advanced to the next item"},
	"recreate_renderer":         {"renderer_recreated", "Playback renderer was recreated"},
	"recreate_playback_session": {"playback_session_recreated", "Playback session was recreated"},
	"restart_activity":          {"activity_restart_requested", "Player activity restart was requested"},
	"restart_player_process":    {"process_restart_requested", "Controlled player process restart was requested"},
	"retry_player_recovery":     {"player_recovery_retried", "Player recovery was retried"},
	"exit_safe_mode":            {"safe_mode_exited", "Safe mode was cleared"},
}

// handleCommands claims queued commands, acknowledges each, and reports its
// result, which is the full lifecycle Studio displays.
func (s *Simulator) handleCommands(ctx context.Context, player Player) error {
	var queue struct {
		Items []playerCommand `json:"items"`
	}
	if err := s.request(ctx, http.MethodGet, "/api/v1/player/commands", player.Credential, nil, &queue); err != nil {
		return err
	}
	for _, command := range queue.Items {
		if command.State == "pending" || command.State == "delivered" {
			if err := s.request(ctx, http.MethodPost, "/api/v1/player/commands/"+command.ID.String()+"/acknowledge", player.Credential, nil, nil); err != nil {
				return err
			}
		}
		success, code, message := false, "command_unsupported", "Command is not supported"
		if outcome, ok := commandOutcomes[command.Type]; ok {
			success, code, message = true, outcome[0], outcome[1]
		}
		if command.Type == "sync_now" || command.Type == "resynchronize_player" {
			if err := s.syncManifest(ctx, player); err != nil {
				return err
			}
		}
		result := map[string]any{"success": success, "code": code, "message": message}
		if err := s.request(ctx, http.MethodPost, "/api/v1/player/commands/"+command.ID.String()+"/result", player.Credential, result, nil); err != nil {
			return err
		}
		s.update(player.ScreenID, func(status *PlayerStatus) {
			status.CommandsHandled++
			status.LastCommand = command.Type
		})
	}
	return nil
}

func (s *Simulator) request(ctx context.Context, method, path, credential string, body, target any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, s.baseURL+path, reader)
	if err != nil {
		return err
	}
	if credential != "" {
		request.Header.Set("Authorization", "Bearer "+credential)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return fmt.Errorf("%w: %s %s returned %d", errStopPlayer, method, path, response.StatusCode)
	}
	if response.StatusCode >= 300 {
		return fmt.Errorf("%s %s returned %d", method, path, response.StatusCode)
	}
	if target == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&envelope); err != nil {
		return err
	}
	return json.Unmarshal(envelope.Data, target)
}
