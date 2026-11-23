package httpapi

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// Inbound plugin webhooks (docs/plugin-webhooks.md).
//
// POST /api/v1/hooks/{pluginId}/{webhookId} is a fourth authentication
// boundary, next to the dashboard cookie, the device credential, and
// integration tokens. It takes no session and no CSRF token: the plugin
// host authenticates each request in the webhook's declared mode. The
// handler passes the connection's own address, never a proxy header, and
// the host never derives the endpoint address from the request.
//
// The token and state routes below /plugins/{pluginId}/webhooks are Studio
// routes: reading needs plugins.use, and creating or revoking a token needs
// plugins.manage.

// webhookAddressLimit bounds the webhook requests of one directly connected
// address, whatever the plugin, before any database work. A provider that
// sends a burst larger than this retries.
const (
	webhookAddressLimit  = 600
	webhookAddressWindow = time.Minute
)

func (s *server) receivePluginWebhook(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.webhookLimiter != nil && !s.webhookLimiter.allow(remoteIP(r.RemoteAddr), time.Now()) {
		w.Header().Set("Retry-After", strconv.Itoa(int(webhookAddressWindow/time.Second)))
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many webhook requests. Try again later.")
		return
	}
	response := s.plugins.ReceiveWebhook(r.Context(), plugins.WebhookRequest{
		PluginID: chi.URLParam(r, "pluginId"), WebhookID: chi.URLParam(r, "webhookId"),
		Method: r.Method, Header: r.Header, Query: r.URL.Query(),
		ContentLength: r.ContentLength, Body: r.Body, RemoteAddr: r.RemoteAddr,
	})
	if response.Allow != "" {
		w.Header().Set("Allow", response.Allow)
	}
	if response.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(response.RetryAfter))
	}
	switch {
	case response.Handshake != nil:
		// The handshake value is the only text the host echoes. It is never
		// HTML and never cached.
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(response.Status)
		_, _ = w.Write(response.Handshake)
	case response.Code != "":
		writeError(w, response.Status, response.Code, response.Message)
	default:
		w.WriteHeader(response.Status)
	}
}

func (s *server) listPluginWebhooks(w http.ResponseWriter, r *http.Request) {
	items, err := s.plugins.Webhooks(r.Context(), chi.URLParam(r, "pluginId"))
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": items})
}

type webhookTokenRequest struct {
	Name string `json:"name"`
}

func (s *server) createPluginWebhookToken(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	var body webhookTokenRequest
	if err := decodeJSONLimit(w, r, &body, 4<<10); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "The request body is not valid JSON for this operation.")
		return
	}
	token, err := s.plugins.CreateWebhookToken(r.Context(), chi.URLParam(r, "pluginId"), chi.URLParam(r, "webhookId"), body.Name, userID)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": token})
}

func (s *server) revokePluginWebhookToken(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "tokenId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "plugin_webhook_token_not_found", "The active webhook token was not found.")
		return
	}
	token, err := s.plugins.RevokeWebhookToken(r.Context(), chi.URLParam(r, "pluginId"), chi.URLParam(r, "webhookId"), id, userID)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": token})
}
