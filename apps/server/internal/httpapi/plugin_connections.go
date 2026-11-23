package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// Host-owned connections of Plugin Manifest API 3 plugins. The handlers
// decode, call the plugin host, and write the API model. Reading needs
// plugins.use; every change, consents included, needs plugins.manage, the
// capability that also writes the settings and instances that reference a
// connection.

const maxConnectionBodyBytes = 8 << 10

func (s *server) connectionTarget(w http.ResponseWriter, r *http.Request) (string, uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "connectionId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "plugin_connection_not_found", "The connection was not found.")
		return "", uuid.Nil, false
	}
	return chi.URLParam(r, "pluginId"), id, true
}

func (s *server) actingUser(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return uuid.Nil, false
	}
	return principal.User.ID, true
}

func (s *server) listPluginConnections(w http.ResponseWriter, r *http.Request) {
	items, err := s.plugins.ListConnections(r.Context(), chi.URLParam(r, "pluginId"))
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items, "total": len(items)}})
}

func (s *server) getPluginConnection(w http.ResponseWriter, r *http.Request) {
	pluginID, id, ok := s.connectionTarget(w, r)
	if !ok {
		return
	}
	item, err := s.plugins.GetConnection(r.Context(), pluginID, id)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) createPluginConnection(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	var write plugins.ConnectionWrite
	if err := decodeJSONLimit(w, r, &write, maxConnectionBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "The request body is not valid JSON for this operation.")
		return
	}
	item, err := s.plugins.CreateConnection(r.Context(), chi.URLParam(r, "pluginId"), userID, write)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": item})
}

func (s *server) updatePluginConnection(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	pluginID, id, ok := s.connectionTarget(w, r)
	if !ok {
		return
	}
	var write plugins.ConnectionWrite
	if err := decodeJSONLimit(w, r, &write, maxConnectionBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "The request body is not valid JSON for this operation.")
		return
	}
	item, err := s.plugins.UpdateConnection(r.Context(), pluginID, id, userID, write)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) setPluginConnectionConsents(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	pluginID, id, ok := s.connectionTarget(w, r)
	if !ok {
		return
	}
	var write plugins.ConsentWrite
	if err := decodeJSONLimit(w, r, &write, maxConnectionBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "The request body is not valid JSON for this operation.")
		return
	}
	item, err := s.plugins.SetConsents(r.Context(), pluginID, id, userID, write)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) deletePluginConnection(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	pluginID, id, ok := s.connectionTarget(w, r)
	if !ok {
		return
	}
	if err := s.plugins.DeleteConnection(r.Context(), pluginID, id, userID); err != nil {
		s.writePluginError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// OAuth 2.0 connections. Start and disconnect are ordinary Studio
// mutations. The callback is the provider's redirect: the session cookie is
// SameSite=Strict and does not arrive on that cross-site navigation, so the
// callback changes nothing and only returns the fixed Studio page of the
// connection. That page completes the attempt with the session and the CSRF
// token. The single-use state, bound to the plugin, the connection, and the
// operator, protects the completion.

func (s *server) startPluginConnectionOAuth(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	pluginID, id, ok := s.connectionTarget(w, r)
	if !ok {
		return
	}
	authorization, err := s.plugins.StartOAuth(r.Context(), pluginID, id, userID)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"authorizationUrl": authorization}})
}

func (s *server) pluginConnectionOAuthCallback(w http.ResponseWriter, r *http.Request) {
	location := s.plugins.OAuthCallbackPage(chi.URLParam(r, "pluginId"), chi.URLParam(r, "connectionId"), r.URL.Query())
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, location, http.StatusSeeOther)
}

func (s *server) completePluginConnectionOAuth(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	pluginID, id, ok := s.connectionTarget(w, r)
	if !ok {
		return
	}
	var callback plugins.OAuthCallback
	if err := decodeJSONLimit(w, r, &callback, maxConnectionBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "The request body is not valid JSON for this operation.")
		return
	}
	item, err := s.plugins.CompleteOAuth(r.Context(), pluginID, id, userID, callback)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) disconnectPluginConnectionOAuth(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	pluginID, id, ok := s.connectionTarget(w, r)
	if !ok {
		return
	}
	item, err := s.plugins.DisconnectOAuth(r.Context(), pluginID, id, userID)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}
