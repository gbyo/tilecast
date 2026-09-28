package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

const alertBase = "/alerts/nws"

func (s *Service) Routes(router plugin.Router) {
	router.Handle(http.MethodGet, alertBase, plugin.AccessViewer, s.handleSettings)
	router.Handle(http.MethodGet, alertBase+"/zones", plugin.AccessViewer, s.handleZones)
	router.Handle(http.MethodPut, alertBase+"/monitor", plugin.AccessManager, s.handleMonitor)
	router.HandleWithRateLimit(http.MethodPost, alertBase+"/poll", plugin.AccessManager, plugin.RateLimitOperations, s.handlePoll)
	router.Handle(http.MethodPost, alertBase+"/rules", plugin.AccessManager, s.handleCreateRule)
	router.Handle(http.MethodPut, alertBase+"/rules/{id}", plugin.AccessManager, s.handleUpdateRule)
	router.Handle(http.MethodDelete, alertBase+"/rules/{id}", plugin.AccessManager, s.handleDeleteRule)
}

func (s *Service) settings(ctx *http.Request) (map[string]any, error) {
	monitor, err := s.Monitor(ctx.Context())
	if err != nil {
		return nil, err
	}
	rules, err := s.Rules(ctx.Context())
	if err != nil {
		return nil, err
	}
	active, err := s.Activations(ctx.Context())
	if err != nil {
		return nil, err
	}
	return map[string]any{"monitor": monitor, "rules": rules, "activeAlerts": active}, nil
}

func (s *Service) handleSettings(w http.ResponseWriter, r *http.Request) error {
	settings, err := s.settings(r)
	if err != nil {
		return err
	}
	plugin.WriteData(w, http.StatusOK, settings)
	return nil
}

func (s *Service) handleZones(w http.ResponseWriter, r *http.Request) error {
	area := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("area")))
	zones, err := s.Zones(r.Context(), area)
	if errors.Is(err, ErrValidation) {
		return &plugin.APIError{Status: 422, Code: "alert_area_invalid", Message: err.Error()}
	}
	if err != nil {
		return &plugin.APIError{Status: 502, Code: "nws_zones_unavailable", Message: "Tilecast could not retrieve NWS counties and forecast zones."}
	}
	plugin.WriteData(w, http.StatusOK, map[string]any{"items": zones})
	return nil
}

func (s *Service) handleMonitor(w http.ResponseWriter, r *http.Request) error {
	var input struct {
		Enabled             bool     `json:"enabled"`
		Areas               []string `json:"areas"`
		Zones               []string `json:"zones"`
		PollIntervalSeconds int      `json:"pollIntervalSeconds"`
	}
	if err := plugin.DecodeJSON(w, r, &input); err != nil {
		return err
	}
	principal, _ := plugin.PrincipalFrom(r.Context())
	monitor, err := s.UpdateMonitor(r.Context(), input.Enabled, input.Areas, input.Zones, input.PollIntervalSeconds, principal.UserID)
	if errors.Is(err, ErrValidation) {
		return &plugin.APIError{Status: 422, Code: "alert_monitor_invalid", Message: err.Error()}
	}
	if err != nil {
		return err
	}
	plugin.WriteData(w, http.StatusOK, monitor)
	return nil
}

func (s *Service) handlePoll(w http.ResponseWriter, r *http.Request) error {
	if err := s.Poll(r.Context()); err != nil {
		if errors.Is(err, plugin.ErrNotInstalled) {
			return err
		}
		return &plugin.APIError{Status: 502, Code: "nws_poll_failed", Message: "Tilecast could not retrieve active NWS alerts."}
	}
	return s.handleSettings(w, r)
}

func (s *Service) handleCreateRule(w http.ResponseWriter, r *http.Request) error {
	return s.saveRule(w, r, uuid.Nil)
}
func (s *Service) handleUpdateRule(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	return s.saveRule(w, r, id)
}

func (s *Service) saveRule(w http.ResponseWriter, r *http.Request, id uuid.UUID) error {
	var input RuleInput
	if err := plugin.DecodeJSON(w, r, &input); err != nil {
		return err
	}
	principal, _ := plugin.PrincipalFrom(r.Context())
	rule, err := s.SaveRule(r.Context(), id, input, principal.UserID)
	if errors.Is(err, ErrValidation) {
		return &plugin.APIError{Status: 422, Code: "alert_rule_invalid", Message: err.Error()}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return &plugin.APIError{Status: 404, Code: "alert_rule_not_found", Message: "NWS alert rule was not found."}
	}
	if err != nil {
		return err
	}
	status := http.StatusOK
	if id == uuid.Nil {
		status = http.StatusCreated
	}
	plugin.WriteData(w, status, rule)
	return nil
}

func (s *Service) handleDeleteRule(w http.ResponseWriter, r *http.Request) error {
	id, err := plugin.PathUUID(r, "id")
	if err != nil {
		return err
	}
	principal, _ := plugin.PrincipalFrom(r.Context())
	if err = s.DeleteRule(r.Context(), id, principal.UserID); errors.Is(err, pgx.ErrNoRows) {
		return &plugin.APIError{Status: 404, Code: "alert_rule_not_found", Message: "NWS alert rule was not found."}
	} else if err != nil {
		return err
	}
	plugin.WriteData(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
	return nil
}
