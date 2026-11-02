package devices

import (
	"sync"

	"github.com/google/uuid"
)

type PresenceHub struct {
	mu          sync.RWMutex
	connections map[uuid.UUID]presenceConnection
}

type presenceConnection struct {
	token  uuid.UUID
	close  func()
	notify func(map[string]any) error
}

func NewPresenceHub() *PresenceHub {
	return &PresenceHub{connections: make(map[uuid.UUID]presenceConnection)}
}

func (h *PresenceHub) Connect(screenID uuid.UUID, closeConnection func()) func() {
	unregister := h.ConnectWithNotifier(screenID, closeConnection, nil)
	return func() {
		unregister()
	}
}

func (h *PresenceHub) ConnectWithNotifier(screenID uuid.UUID, closeConnection func(), notify func(map[string]any) error) func() bool {
	h.mu.Lock()
	previous := h.connections[screenID]
	token := uuid.New()
	h.connections[screenID] = presenceConnection{token: token, close: closeConnection, notify: notify}
	h.mu.Unlock()
	if previous.close != nil {
		previous.close()
	}
	return func() bool {
		h.mu.Lock()
		removed := false
		if current, ok := h.connections[screenID]; ok && current.token == token {
			delete(h.connections, screenID)
			removed = true
		}
		h.mu.Unlock()
		return removed
	}
}

func (h *PresenceHub) Notify(screenID uuid.UUID, message map[string]any) bool {
	h.mu.RLock()
	notify := h.connections[screenID].notify
	h.mu.RUnlock()
	return notify != nil && notify(message) == nil
}

func (h *PresenceHub) Connected(screenID uuid.UUID) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.connections[screenID]
	return ok
}

// PresenceConnected reports whether the screen holds an authenticated socket
// in this process. It lets dashboard handlers derive connectivity without
// duplicating the status thresholds.
func (s *Service) PresenceConnected(screenID uuid.UUID) bool {
	if s.presence == nil {
		return false
	}
	return s.presence.Connected(screenID)
}

func (h *PresenceHub) Disconnect(screenID uuid.UUID) {
	h.mu.RLock()
	closeConnection := h.connections[screenID].close
	h.mu.RUnlock()
	if closeConnection != nil {
		closeConnection()
	}
}
