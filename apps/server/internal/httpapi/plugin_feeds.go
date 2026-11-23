package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// Feed datasets of Plugin Manifest API 3 plugins: Studio's generic record
// view and the operator overrides. Reading needs plugins.use; an override
// needs plugins.manage, like every other change to a plugin's data.

const maxFeedOverrideBodyBytes = 16 << 10

func (s *server) listPluginFeeds(w http.ResponseWriter, r *http.Request) {
	items, err := s.plugins.ListFeedDatasets(r.Context(), chi.URLParam(r, "pluginId"))
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"items": items, "total": len(items)}})
}

func feedDatasetTarget(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "datasetId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "plugin_feed_dataset_not_found", "The feed dataset was not found.")
		return uuid.Nil, false
	}
	return id, true
}

func (s *server) listPluginFeedRecords(w http.ResponseWriter, r *http.Request) {
	id, ok := feedDatasetTarget(w, r)
	if !ok {
		return
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	document, err := s.plugins.FeedRecords(r.Context(), chi.URLParam(r, "pluginId"), id, offset, limit)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": document})
}

type feedOverrideWrite struct {
	RecordID string          `json:"recordId"`
	Field    string          `json:"field"`
	Value    json.RawMessage `json:"value"`
}

func (s *server) setPluginFeedOverride(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	id, ok := feedDatasetTarget(w, r)
	if !ok {
		return
	}
	var write feedOverrideWrite
	if err := decodeJSONLimit(w, r, &write, maxFeedOverrideBodyBytes); err != nil || write.RecordID == "" || write.Field == "" || len(write.Value) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_json", "The request body is not valid JSON for this operation.")
		return
	}
	record, err := s.plugins.SetFeedOverride(r.Context(), chi.URLParam(r, "pluginId"), id, write.RecordID, write.Field, write.Value, userID)
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": record})
}
