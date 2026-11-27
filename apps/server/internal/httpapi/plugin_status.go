package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/plugindelivery"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// The operational status of a Plugin Manifest API 3 plugin, and the Owner
// actions on its parked deliveries (docs/plugin-delivery.md). Reading needs
// plugins.use. A retry or a discard needs the Owner-reserved
// plugins.deliveries.manage: a retry runs plugin code again, and a discard
// loses the work for good.

func (s *server) getPluginStatus(w http.ResponseWriter, r *http.Request) {
	status, err := s.plugins.Status(r.Context(), chi.URLParam(r, "pluginId"))
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": status})
}

func (s *server) retryPluginDelivery(w http.ResponseWriter, r *http.Request) {
	s.parkedDeliveryAction(w, r, s.plugins.RetryDelivery)
}

func (s *server) discardPluginDelivery(w http.ResponseWriter, r *http.Request) {
	s.parkedDeliveryAction(w, r, s.plugins.DiscardDelivery)
}

type parkedDeliveryOperation func(ctx context.Context, pluginID string, id, userID uuid.UUID) (plugindelivery.Parked, error)

func (s *server) parkedDeliveryAction(w http.ResponseWriter, r *http.Request, operation parkedDeliveryOperation) {
	userID, ok := s.actingUser(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "deliveryId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "plugin_delivery_not_found", "The parked delivery was not found.")
		return
	}
	item, err := operation(r.Context(), chi.URLParam(r, "pluginId"), id, userID)
	if errors.Is(err, plugins.ErrDeliveryNotParked) {
		writeError(w, http.StatusNotFound, "plugin_delivery_not_found", "The parked delivery was not found.")
		return
	}
	if err != nil {
		s.writePluginError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": item})
}
