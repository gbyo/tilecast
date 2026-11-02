package httpapi

import (
	"net/http"
	"strings"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

type activityDispatchRoute struct {
	method       string
	contractPath string
	device       bool
	// capability is what a management route needs; device routes leave it
	// empty and authenticate the Player credential instead.
	capability auth.Capability
	handler    http.Handler
}

// activityDispatchPathMatches matches the OpenAPI-style path templates used by
// the dispatcher registry. Keeping the template as the matcher means dispatch
// behavior and contract parity cannot drift into separate route lists.
func activityDispatchPathMatches(pattern, path string) bool {
	patternParts := strings.Split(pattern, "/")
	pathParts := strings.Split(path, "/")
	if len(patternParts) != len(pathParts) {
		return false
	}
	for i, patternPart := range patternParts {
		if strings.HasPrefix(patternPart, "{") && strings.HasSuffix(patternPart, "}") {
			if pathParts[i] == "" {
				return false
			}
			continue
		}
		if patternPart != pathParts[i] {
			return false
		}
	}
	return true
}

// activityDispatchRoutes is the single route registry for endpoints that
// activityRoutes serves directly rather than delegating to the Chi router.
// TestRouteContractParity reads this same registry, so adding or changing a
// dispatched method/path must also be represented in the OpenAPI contract.
func (s *server) activityDispatchRoutes() []activityDispatchRoute {
	return []activityDispatchRoute{
		{method: http.MethodPost, contractPath: "/api/v1/player/heartbeat", device: true, handler: http.HandlerFunc(s.playerHeartbeatWithActivity)},
		{method: http.MethodPost, contractPath: "/api/v1/player/liveness", device: true, handler: http.HandlerFunc(s.playerLivenessWithActivity)},
		{method: http.MethodPost, contractPath: "/api/v1/player/telemetry", device: true, handler: http.HandlerFunc(s.ingestTelemetry)},
		{method: http.MethodPost, contractPath: "/api/v1/player/activity-events", device: true, handler: http.HandlerFunc(s.ingestPlayerActivityWithCleanup)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/overview", capability: auth.CapActivityRead, handler: http.HandlerFunc(s.activityOverview)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/uptime", capability: auth.CapActivityRead, handler: http.HandlerFunc(s.activityUptime)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/proof-of-play", capability: auth.CapActivityRead, handler: http.HandlerFunc(s.listProofOfPlay)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/proof-of-play/summary", capability: auth.CapActivityRead, handler: http.HandlerFunc(s.proofOfPlaySummary)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/proof-of-play/export.csv", capability: auth.CapActivityManage, handler: http.HandlerFunc(s.exportProofOfPlay)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/screen-events", capability: auth.CapActivityManage, handler: http.HandlerFunc(s.listScreenEvents)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/audit", capability: auth.CapActivityAudit, handler: http.HandlerFunc(s.listAuditActivity)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/audit/export.csv", capability: auth.CapActivityManage, handler: http.HandlerFunc(s.exportAuditActivity)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/screens/{id}/timeline", capability: auth.CapActivityRead, handler: http.HandlerFunc(s.screenTimeline)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/screens/{id}/telemetry", capability: auth.CapActivityManage, handler: http.HandlerFunc(s.screenTelemetry)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/screens/{id}", capability: auth.CapActivityRead, handler: http.HandlerFunc(s.screenActivity)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/compliance", capability: auth.CapActivityRead, handler: http.HandlerFunc(s.playbackCompliance)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/incidents", capability: auth.CapActivityRead, handler: http.HandlerFunc(s.listIncidents)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/incidents/analytics", capability: auth.CapActivityRead, handler: http.HandlerFunc(s.incidentAnalytics)},
		{method: http.MethodGet, contractPath: "/api/v1/activity/incidents/{id}", capability: auth.CapActivityRead, handler: http.HandlerFunc(s.getIncident)},
		{method: http.MethodPatch, contractPath: "/api/v1/activity/incidents/{id}", capability: auth.CapActivityManage, handler: s.requireCSRF(http.HandlerFunc(s.updateIncident))},
		{method: http.MethodGet, contractPath: "/api/v1/activity/retention", capability: auth.CapActivityManage, handler: http.HandlerFunc(s.getActivityRetention)},
		{method: http.MethodPatch, contractPath: "/api/v1/activity/retention", capability: auth.CapActivityManage, handler: s.requireCSRF(http.HandlerFunc(s.updateActivityRetention))},
	}
}

func (s *server) activityRoutes(next http.Handler) http.Handler {
	if s.db != nil {
		go s.runActivityRetentionWorker()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/login" || r.URL.Path == "/api/v1/auth/logout" {
			s.auditAuthentication(next, w, r)
			return
		}
		for _, route := range s.activityDispatchRoutes() {
			if r.Method != route.method || !activityDispatchPathMatches(route.contractPath, r.URL.Path) {
				continue
			}
			handler := route.handler
			if route.device {
				handler = s.requireDevice(handler)
			} else {
				// Activity reads take the read scope; incident and retention updates
				// change operational state and take the write scope on top of the role.
				scope := "read"
				if r.Method != http.MethodGet && r.Method != http.MethodHead {
					scope = "write"
				}
				handler = s.requireUser(s.requireCapability(route.capability)(s.requireScope(scope)(handler)))
			}
			handler.ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/v1/activity/") && r.URL.Path != "/api/v1/activity" {
			next.ServeHTTP(w, r)
			return
		}
		writeError(w, http.StatusNotFound, "activity_route_not_found", "Activity endpoint was not found.")
	})
}
