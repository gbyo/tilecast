package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
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

// installPlugin records a release-owned plugin as installed. The first
// installation answers 201; repeating it answers 200 with the same current
// representation.
func (s *server) installPlugin(w http.ResponseWriter, r *http.Request) {
	user := r.Context().Value(sessionContextKey).(auth.Session).User
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
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	if err := s.plugins.Remove(r.Context(), chi.URLParam(r, "pluginId"), user.ID); err != nil {
		s.writePluginError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) dependencyGraph(w http.ResponseWriter, r *http.Request) {
	session := r.Context().Value(sessionContextKey).(auth.Session)
	screens, err := s.devices.ListScreensForUser(r.Context(), session.User.ID, session.User.Role)
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

func (s *server) listBrandBugs(w http.ResponseWriter, r *http.Request) {
	items, err := s.plugins.ListBrandBugs(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items, "total": len(items)}})
}

func (s *server) getBrandBug(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	item, err := s.plugins.GetBrandBug(r.Context(), id)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) createBrandBug(w http.ResponseWriter, r *http.Request) {
	var input plugins.BrandBugInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	item, err := s.plugins.CreateBrandBug(r.Context(), user.ID, input)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": item})
}

func (s *server) updateBrandBug(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var input plugins.BrandBugInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	item, err := s.plugins.UpdateBrandBug(r.Context(), id, user.ID, input)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) deleteBrandBug(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	if err := s.plugins.DeleteBrandBug(r.Context(), id, user.ID); err != nil {
		s.writePluginError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) listNoiseMeters(w http.ResponseWriter, r *http.Request) {
	items, err := s.plugins.ListNoiseMeters(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items, "total": len(items)}})
}

func (s *server) getNoiseMeter(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	item, err := s.plugins.GetNoiseMeter(r.Context(), id)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) createNoiseMeter(w http.ResponseWriter, r *http.Request) {
	var input plugins.NoiseMeterInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	item, err := s.plugins.CreateNoiseMeter(r.Context(), user.ID, input)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": item})
}

func (s *server) updateNoiseMeter(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	var input plugins.NoiseMeterInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	item, err := s.plugins.UpdateNoiseMeter(r.Context(), id, user.ID, input)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}

func (s *server) deleteNoiseMeter(w http.ResponseWriter, r *http.Request) {
	id, ok := urlUUID(w, r, "id")
	if !ok {
		return
	}
	user := r.Context().Value(sessionContextKey).(auth.Session).User
	if err := s.plugins.DeleteNoiseMeter(r.Context(), id, user.ID); err != nil {
		s.writePluginError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) writePluginError(w http.ResponseWriter, r *http.Request, err error) {
	plugins.WriteError(w, r, err, s.logger)
}
