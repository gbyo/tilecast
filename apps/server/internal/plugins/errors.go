package plugins

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// WriteError answers a plugin lifecycle or plugin route error with the
// standard error envelope. Plugins return errors; only the host writes them,
// so every plugin answers the same failure the same way.
func WriteError(w http.ResponseWriter, r *http.Request, err error, logger *slog.Logger) {
	var inUse *InUseError
	var explicit *plugin.APIError
	switch {
	case errors.As(err, &explicit):
		body := map[string]any{"code": explicit.Code, "message": explicit.Message}
		if len(explicit.Details) > 0 {
			body["details"] = explicit.Details
		}
		writeJSON(w, explicit.Status, map[string]any{"error": body})
	case errors.As(err, &inUse):
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{
			"code":    "plugin_in_use",
			"message": inUse.Error(),
			"details": map[string]any{"pluginId": inUse.PluginID, "resources": inUse.Resources},
		}})
	case errors.Is(err, ErrPluginNotFound):
		writeErrorCode(w, http.StatusNotFound, "plugin_not_found", "The plugin was not found.")
	case errors.Is(err, ErrPluginNotInstallable):
		writeErrorCode(w, http.StatusConflict, "plugin_not_installable", "This plugin cannot be installed.")
	case errors.Is(err, ErrPluginNotInstalled):
		writeErrorCode(w, http.StatusConflict, "plugin_not_installed", "Install this plugin before configuring it.")
	case errors.Is(err, ErrNotFound):
		writeErrorCode(w, http.StatusNotFound, "plugin_instance_not_found", "The plugin instance was not found.")
	case errors.Is(err, ErrInvalid):
		writeErrorCode(w, http.StatusBadRequest, "invalid_plugin_configuration", err.Error())
	default:
		if logger == nil {
			logger = slog.Default()
		}
		logger.Error("request failed", "error", err, "request_id", middleware.GetReqID(r.Context()), "path", r.URL.Path)
		writeErrorCode(w, http.StatusInternalServerError, "internal_error", "Tilecast could not complete the request.")
	}
}

func writeErrorCode(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
