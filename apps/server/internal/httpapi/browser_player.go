package httpapi

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

const browserPlayerCookie = "__Host-tilecast_player"

func browserSlotOf(r *http.Request) (uuid.UUID, error) {
	value := r.Header.Get("X-Tilecast-Player-Slot")
	if value == "" {
		value = r.URL.Query().Get("browserSlot")
	}
	return uuid.Parse(value)
}

func browserCookieOf(r *http.Request) (*http.Cookie, error) {
	slot, err := browserSlotOf(r)
	if err != nil {
		return nil, err
	}
	return r.Cookie(browserPlayerCookie + "_" + slot.String())
}

func (s *server) browserOrigin(r *http.Request) string {
	if configured, err := url.Parse(s.publicURL); err == nil && configured.Scheme == "https" && configured.Host != "" {
		return "https://" + configured.Host
	}
	if r.TLS != nil {
		return "https://" + r.Host
	}
	return ""
}

func (s *server) browserRequestAllowed(r *http.Request) bool {
	origin := s.browserOrigin(r)
	if origin == "" {
		return false
	}
	if supplied := r.Header.Get("Origin"); supplied != "" {
		return supplied == origin && r.Header.Get("Sec-Fetch-Site") != "cross-site"
	}
	// Cookie-authenticated reads require browser fetch metadata. Mutations
	// require Origin even when SameSite already excludes cross-site requests.
	return (r.Method == http.MethodGet || r.Method == http.MethodHead) && r.Header.Get("Sec-Fetch-Site") == "same-origin"
}

func (s *server) browserBoundary(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), display-capture=(), geolocation=()")
		if !s.browserRequestAllowed(r) {
			writeError(w, http.StatusForbidden, "browser_origin_required", "Browser Player requires a same-origin HTTPS connection.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func browserPlayerRoute(path string) bool {
	switch path {
	case "/api/v1/player/heartbeat", "/api/v1/player/socket", "/api/v1/player/manifest", "/api/v1/player/config", "/api/v1/player/commands", "/api/v1/player/activity-events", "/api/v1/player/telemetry", "/api/v1/player/liveness":
		return true
	}
	return strings.HasPrefix(path, "/api/v1/player/assets/") || strings.HasPrefix(path, "/api/v1/player/span-panels/") ||
		strings.HasPrefix(path, "/api/v1/player/browser/") ||
		strings.HasPrefix(path, "/api/v1/player/packages/") ||
		strings.HasPrefix(path, "/api/v1/player/commands/") && (strings.HasSuffix(path, "/acknowledge") || strings.HasSuffix(path, "/result"))
}

func (s *server) authenticateBrowserRequest(w http.ResponseWriter, r *http.Request) (devices.DevicePrincipal, bool) {
	if !browserPlayerRoute(r.URL.Path) || !s.browserRequestAllowed(r) {
		writeError(w, http.StatusUnauthorized, "browser_session_required", "A Browser Player session is required.")
		return devices.DevicePrincipal{}, false
	}
	cookie, err := browserCookieOf(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "browser_session_required", "A Browser Player session is required.")
		return devices.DevicePrincipal{}, false
	}
	principal, session, err := s.devices.AuthenticateBrowser(r.Context(), cookie.Value)
	if err != nil {
		s.writeDeviceError(w, r, err)
		return devices.DevicePrincipal{}, false
	}
	slot, err := browserSlotOf(r)
	if err != nil || session.SlotID != slot {
		writeError(w, http.StatusUnauthorized, "browser_session_required", "A Browser Player session is required.")
		return devices.DevicePrincipal{}, false
	}
	w.Header().Set("Cache-Control", "no-store")
	return principal, true
}

func writeBrowserSession(w http.ResponseWriter, session devices.BrowserSession, status int) {
	http.SetCookie(w, &http.Cookie{
		Name: browserPlayerCookie + "_" + session.SlotID.String(), Value: session.SessionSecret, Path: "/",
		Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode,
		Expires: session.ExpiresAt, MaxAge: int(devices.BrowserSessionLifetime.Seconds()),
	})
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]any{"data": session})
}

func (s *server) browserRecover(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SlotID               uuid.UUID                   `json:"slotId"`
		ServerInstallationID string                      `json:"serverInstallationId"`
		RecoverySecret       string                      `json:"recoverySecret"`
		Registration         devices.BrowserRegistration `json:"registration"`
		Metadata             devices.DeviceMetadata      `json:"metadata"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	identity, err := s.devices.Identity(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if body.ServerInstallationID != identity.InstallationID {
		s.writeDeviceError(w, r, devices.ErrWrongInstallation)
		return
	}
	session, err := s.devices.RecoverBrowser(r.Context(), body.SlotID, body.RecoverySecret, body.Registration, body.Metadata)
	if err != nil {
		s.writeDeviceError(w, r, err)
		return
	}
	writeBrowserSession(w, session, http.StatusCreated)
}

func (s *server) browserEnroll(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PairingSessionID uuid.UUID                   `json:"pairingSessionId"`
		EnrollmentToken  string                      `json:"enrollmentToken"`
		Registration     devices.BrowserRegistration `json:"registration"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	session, err := s.devices.EnrollBrowser(r.Context(), body.PairingSessionID, body.EnrollmentToken, body.Registration)
	if err != nil {
		s.writeDeviceError(w, r, err)
		return
	}
	writeBrowserSession(w, session, http.StatusCreated)
}

func (s *server) browserChallenge(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SlotID    uuid.UUID `json:"slotId"`
		BindingID uuid.UUID `json:"bindingId"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	challenge, err := s.devices.BrowserChallenge(r.Context(), body.SlotID, body.BindingID)
	if err != nil {
		s.writeDeviceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": challenge})
}

func (s *server) browserRenew(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SlotID    uuid.UUID `json:"slotId"`
		BindingID uuid.UUID `json:"bindingId"`
		Nonce     string    `json:"nonce"`
		Signature string    `json:"signature"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	session, err := s.devices.RenewBrowserSession(r.Context(), body.SlotID, body.BindingID, body.Nonce, body.Signature)
	if err != nil {
		s.writeDeviceError(w, r, err)
		return
	}
	writeBrowserSession(w, session, http.StatusOK)
}

func (s *server) browserSession(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "" {
		writeError(w, http.StatusUnauthorized, "browser_session_required", "A Browser Player session is required.")
		return
	}
	cookie, err := browserCookieOf(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "browser_session_required", "A Browser Player session is required.")
		return
	}
	_, session, err := s.devices.AuthenticateBrowser(r.Context(), cookie.Value)
	if err != nil {
		s.writeDeviceError(w, r, err)
		return
	}
	slot, err := browserSlotOf(r)
	if err != nil || session.SlotID != slot {
		writeError(w, http.StatusUnauthorized, "browser_session_required", "A Browser Player session is required.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": session})
}

func (s *server) createBrowserSlot(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string     `json:"name"`
		LocationID  *uuid.UUID `json:"locationId"`
		RoomName    string     `json:"roomName"`
		RoomNumber  string     `json:"roomNumber"`
		Description string     `json:"description"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, _ := principalOf(r)
	launch, err := s.devices.CreateBrowserSlot(r.Context(), principal.User.ID, devices.PairingApproval{Name: body.Name, LocationID: body.LocationID, RoomName: body.RoomName, RoomNumber: body.RoomNumber, Description: body.Description})
	if err != nil {
		s.writeDeviceError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{"data": launch})
}

func (s *server) getBrowserSlot(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	slot, err := s.devices.BrowserSlot(r.Context(), id)
	if err != nil {
		s.writeDeviceError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"data": slot})
}

func (s *server) setBrowserRecovery(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, _ := principalOf(r)
	launch, err := s.devices.SetBrowserRecovery(r.Context(), id, principal.User.ID, body.Enabled)
	if err != nil {
		s.writeDeviceError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"data": launch})
}

// Player reads only its own current Server selection. There is no browser
// schedule evaluator and no administrator inspection parameter.
func (s *server) browserSelection(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(deviceContextKey).(devices.DevicePrincipal)
	inspection, err := s.playbackPlan.Inspect(r.Context(), principal.ScreenID, nil)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": inspection.Response()})
}

// Keep the browser-specific registrations together; ordinary Player routes
// retain their existing handlers and domain services.
func (s *server) mountBrowserPlayer(api chi.Router) {
	api.Route("/player/browser", func(browser chi.Router) {
		browser.Use(s.browserBoundary)
		browser.With(s.pairingRateLimit).Post("/recover", s.browserRecover)
		browser.With(s.pairingRateLimit).Post("/enroll", s.browserEnroll)
		browser.With(s.authRateLimit).Post("/challenge", s.browserChallenge)
		browser.With(s.authRateLimit).Post("/renew", s.browserRenew)
		browser.Get("/session", s.browserSession)
		browser.With(s.requireDevice).Get("/selection", s.browserSelection)
	})
}
