package httpapi

import (
	"errors"
	"net/http"
	"net/mail"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/notify"
)

// notificationStatus tells Studio what this installation can actually do, so
// the interface never offers a control that cannot work. Email needs an SMTP
// relay that only the server operator can configure.
func (s *server) notificationStatus(w http.ResponseWriter, r *http.Request) {
	deliveries, err := s.notifications.RecentDeliveries(r.Context(), 1)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	pendingCount, failedCount, err := s.notifications.DeliveryCounts(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"emailConfigured": s.notifications.EmailConfigured(),
		"emailUnavailableReason": func() string {
			if s.notifications.EmailConfigured() {
				return ""
			}
			return "TILECAST_SMTP_HOST is not set on the server. Webhooks still work."
		}(),
		"pendingCount":       pendingCount,
		"recentFailureCount": failedCount,
		"hasDeliveryHistory": len(deliveries) > 0,
	}})
}

func (s *server) listNotificationDeliveries(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	deliveries, err := s.notifications.RecentDeliveries(r.Context(), limit)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": deliveries})
}

// sendTestNotification mails the signed-in account, and only the signed-in
// account. Allowing an arbitrary address would turn an authenticated Studio
// session into a small open relay.
func (s *server) sendTestNotification(w http.ResponseWriter, r *http.Request) {
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	preferences, err := s.settings.Preferences(r.Context(), principal.User.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	address, _ := preferences.Values["preference.notifications.address"].(string)
	address = strings.TrimSpace(address)
	if address == "" {
		writeError(w, http.StatusBadRequest, "no_address",
			"Set your notification address under My preferences before sending a test.")
		return
	}
	if _, err := mail.ParseAddress(address); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_address", "Your notification address is not a valid email address.")
		return
	}
	if err := s.notifications.SendTest(r.Context(), address); err != nil {
		if errors.Is(err, notify.ErrEmailNotConfigured) {
			writeError(w, http.StatusConflict, "email_not_configured",
				"This server has no SMTP relay configured, so it cannot send email.")
			return
		}
		// The SMTP error is the whole point of a test: it is shown rather than
		// swallowed, so an operator can fix the relay without reading logs.
		writeError(w, http.StatusBadGateway, "send_failed", "The mail server rejected the message: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"sentTo": address}})
}

func (s *server) listNotificationWebhooks(w http.ResponseWriter, r *http.Request) {
	webhooks, err := s.notifications.ListWebhooks(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": webhooks})
}

type notificationWebhookRequest struct {
	Name       string   `json:"name"`
	URL        string   `json:"url"`
	Enabled    *bool    `json:"enabled,omitempty"`
	Categories []string `json:"categories,omitempty"`
}

func (s *server) createNotificationWebhook(w http.ResponseWriter, r *http.Request) {
	var body notificationWebhookRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	webhook, secret, err := s.notifications.CreateWebhook(r.Context(), principal.User.ID, body.Name, body.URL, body.Categories)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_webhook", err.Error())
		return
	}
	// The secret is never logged and never included in audit metadata.
	_, _ = s.db.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,resource_name,result,summary)
		VALUES($1,$2,'notifications.webhook_created','notification_webhook',$3,$4,'success','Notification webhook created')`,
		uuid.New(), principal.User.ID, webhook.ID.String(), webhook.Name)

	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{
		"webhook": webhook,
		// Returned exactly once. There is no endpoint that reads it back.
		"signingSecret": secret,
		"secretNotice":  "Copy this signing secret now. Tilecast does not show it again.",
	}})
}

func (s *server) updateNotificationWebhook(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "The webhook id is not valid.")
		return
	}
	var body notificationWebhookRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	// Default to the stored value. Defaulting to true meant a client updating
	// only the name or URL switched a deliberately disabled receiver back on.
	existing, err := s.notifications.ListWebhooks(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	enabled := true
	for _, webhook := range existing {
		if webhook.ID == id {
			enabled = webhook.Enabled
			break
		}
	}
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	webhook, err := s.notifications.UpdateWebhook(r.Context(), id, body.Name, body.URL, enabled, body.Categories)
	if errors.Is(err, notify.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "That webhook no longer exists.")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_webhook", err.Error())
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	_, _ = s.db.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,resource_name,result,summary)
		VALUES($1,$2,'notifications.webhook_updated','notification_webhook',$3,$4,'success','Notification webhook updated')`,
		uuid.New(), principal.User.ID, webhook.ID.String(), webhook.Name)
	writeJSON(w, http.StatusOK, map[string]any{"data": webhook})
}

func (s *server) deleteNotificationWebhook(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "The webhook id is not valid.")
		return
	}
	if err := s.notifications.DeleteWebhook(r.Context(), id); errors.Is(err, notify.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "That webhook no longer exists.")
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	principal, ok := principalOf(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return
	}
	_, _ = s.db.Exec(r.Context(), `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,result,summary)
		VALUES($1,$2,'notifications.webhook_deleted','notification_webhook',$3,'success','Notification webhook deleted')`,
		uuid.New(), principal.User.ID, id.String())
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) testNotificationWebhook(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "The webhook id is not valid.")
		return
	}
	if err := s.notifications.TestWebhook(r.Context(), id); errors.Is(err, notify.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "That webhook no longer exists or is disabled.")
		return
	} else if err != nil {
		writeError(w, http.StatusBadGateway, "webhook_failed", "The receiver did not accept the test: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"delivered": true}})
}
