package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/audit"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

func (s *server) listPlugins(w http.ResponseWriter, r *http.Request) {
	catalog, err := s.plugins.Catalog(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": catalog})
}

// listPluginStore serves the normalized plugin store: every plugin source
// Studio can browse, joined with this installation's state. Readable by any
// signed-in account. In this release every entry is compiled into the
// release; marketplace and custom entries join this list later.
func (s *server) listPluginStore(w http.ResponseWriter, r *http.Request) {
	store, err := s.plugins.Store(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": store})
}

// getPluginStoreEntry serves one store entry. Unknown package IDs answer 404
// plugin_not_found.
func (s *server) getPluginStoreEntry(w http.ResponseWriter, r *http.Request) {
	entry, err := s.plugins.StoreEntry(r.Context(), chi.URLParam(r, "packageId"))
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": entry})
}

// refreshMarketplaceCatalog refreshes the official Tilecast marketplace
// now and answers with its cache status. The full error stays in the
// server log and the cache row; the API answers a generic failure while
// the cached listings keep serving.
func (s *server) refreshMarketplaceCatalog(w http.ResponseWriter, r *http.Request) {
	if err := s.marketplace.Refresh(r.Context()); err != nil {
		s.logger.Error("marketplace refresh failed", "error", err, "path", r.URL.Path)
		_ = audit.Record(r.Context(), s.db, audit.Event{
			Action: "marketplace.refresh_failed", ResourceType: "marketplace_catalog",
			Summary: "Marketplace catalog refresh failed",
		})
		writeError(w, http.StatusBadGateway, "marketplace_refresh_failed", "Tilecast could not refresh the marketplace catalog.")
		return
	}
	cached, err := s.marketplace.Cached(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	_ = audit.Record(r.Context(), s.db, audit.Event{
		Action: "marketplace.refreshed", ResourceType: "marketplace_catalog",
		Summary:  "Marketplace catalog refreshed",
		Metadata: map[string]any{"listings": len(cached.Document.Listings)},
	})
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"marketplace": plugins.MarketplaceSnapshotFrom(cached, time.Now()).Status,
	}})
}

// installPlugin records a release-owned plugin as installed. The first
// installation answers 201; repeating it answers 200 with the same current
// representation.
func (s *server) installPlugin(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	item, created, err := s.plugins.Install(r.Context(), chi.URLParam(r, "pluginId"), user.ID)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"data": item})
}

// removePlugin deletes an installation record. It never deletes plugin data:
// while the plugin still owns resources the answer is 409 plugin_in_use with
// what remains.
func (s *server) removePlugin(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	user := principal.User
	if err := s.plugins.Remove(r.Context(), chi.URLParam(r, "pluginId"), user.ID); err != nil {
		s.writePluginError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// getPluginAutomation serves a known, installed plugin's resolved automation
// document. Operator clients dispatch generic commands on it without naming
// the plugin in their own source. Unknown plugins answer 404
// plugin_not_found, known-but-uninstalled ones 409 plugin_not_installed,
// and plugins with no automation mapping 404 plugin_automation_not_found.
func (s *server) getPluginAutomation(w http.ResponseWriter, r *http.Request) {
	document, err := s.plugins.Automation(r.Context(), chi.URLParam(r, "pluginId"))
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": json.RawMessage(document)})
}

func (s *server) dependencyGraph(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	screens, err := s.devices.ListScreensForUser(r.Context(), principal.User.ID, principal.User.Role)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	screenIDs := make([]uuid.UUID, 0, len(screens))
	for _, screen := range screens {
		screenIDs = append(screenIDs, screen.ID)
	}
	graph, err := s.plugins.DependencyGraph(r.Context(), screenIDs)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": graph})
}

func (s *server) writePluginError(w http.ResponseWriter, r *http.Request, err error) {
	plugins.WriteError(w, r, err, s.logger)
}
