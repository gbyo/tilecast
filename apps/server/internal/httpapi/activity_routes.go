package httpapi

import (
	"net/http"
	"strings"
)

func (s *server) activityRoutes(next http.Handler) http.Handler {
	if s.db != nil {
		go s.runActivityRetentionWorker()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/login" || r.URL.Path == "/api/v1/auth/logout" {
			s.auditAuthentication(next, w, r)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/player/heartbeat" {
			s.requireDevice(http.HandlerFunc(s.playerHeartbeatWithActivity)).ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/player/liveness" {
			s.requireDevice(http.HandlerFunc(s.playerLivenessWithActivity)).ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/player/telemetry" {
			s.requireDevice(http.HandlerFunc(s.ingestTelemetry)).ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/player/activity-events" {
			s.requireDevice(http.HandlerFunc(s.ingestPlayerActivityWithCleanup)).ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/v1/activity/") && r.URL.Path != "/api/v1/activity" {
			next.ServeHTTP(w, r)
			return
		}
		var handler http.Handler
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/overview":
			handler = http.HandlerFunc(s.activityOverview)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/uptime":
			handler = http.HandlerFunc(s.activityUptime)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/proof-of-play":
			handler = http.HandlerFunc(s.listProofOfPlay)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/proof-of-play/summary":
			handler = http.HandlerFunc(s.proofOfPlaySummary)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/proof-of-play/export.csv":
			handler = s.requireRoles("owner", "administrator")(http.HandlerFunc(s.exportProofOfPlay))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/screen-events":
			handler = s.requireRoles("owner", "administrator")(http.HandlerFunc(s.listScreenEvents))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/audit":
			handler = http.HandlerFunc(s.listAuditActivity)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/audit/export.csv":
			handler = s.requireRoles("owner", "administrator")(http.HandlerFunc(s.exportAuditActivity))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/timeline") && strings.HasPrefix(r.URL.Path, "/api/v1/activity/screens/"):
			handler = http.HandlerFunc(s.screenTimeline)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/telemetry") && strings.HasPrefix(r.URL.Path, "/api/v1/activity/screens/"):
			handler = s.requireRoles("owner", "administrator")(http.HandlerFunc(s.screenTelemetry))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v1/activity/screens/"):
			handler = http.HandlerFunc(s.screenActivity)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/compliance":
			handler = http.HandlerFunc(s.playbackCompliance)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/incidents":
			handler = http.HandlerFunc(s.listIncidents)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/incidents/analytics":
			handler = http.HandlerFunc(s.incidentAnalytics)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v1/activity/incidents/"):
			handler = http.HandlerFunc(s.getIncident)
		// Acting on an incident changes operational state, so it needs the same
		// privilege and CSRF protection as every other administrative change.
		case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/api/v1/activity/incidents/"):
			handler = s.requireRoles("owner", "administrator")(s.requireCSRF(http.HandlerFunc(s.updateIncident)))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/activity/retention":
			handler = s.requireRoles("owner", "administrator")(http.HandlerFunc(s.getActivityRetention))
		case r.Method == http.MethodPatch && r.URL.Path == "/api/v1/activity/retention":
			handler = s.requireRoles("owner", "administrator")(s.requireCSRF(http.HandlerFunc(s.updateActivityRetention)))
		default:
			writeError(w, http.StatusNotFound, "activity_route_not_found", "Activity endpoint was not found.")
			return
		}
		// Activity reads take the read scope; incident updates change
		// operational state and take the write scope on top of the role.
		scope := "read"
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			scope = "write"
		}
		s.requireUser(s.requireScope(scope)(handler)).ServeHTTP(w, r)
	})
}
