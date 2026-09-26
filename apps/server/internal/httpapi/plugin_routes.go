package httpapi

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// mountPluginRoutes registers every plugin's dashboard routes. The plugin
// chooses an access level; the host applies the session, enrollment, role,
// and CSRF checks, so a plugin handler never sees an unauthenticated request.
// A route that a core route already answers is a release defect and stops
// startup rather than being silently shadowed.
func (s *server) mountPluginRoutes(api chi.Router) {
	if s.plugins == nil {
		return
	}
	routes, err := s.plugins.Routes()
	if err != nil {
		panic(err)
	}
	for _, route := range routes {
		if err = checkPluginRoute(api, route); err != nil {
			panic(err)
		}
	}
	api.Group(func(group chi.Router) {
		group.Use(s.requireSession)
		group.Use(s.requireEnrollment)
		for _, route := range routes {
			middlewares := []func(http.Handler) http.Handler{}
			unsafe := route.Method != http.MethodGet && route.Method != http.MethodHead
			switch route.Access {
			case plugin.AccessManager:
				middlewares = append(middlewares, s.requireRoles("owner", "administrator"), s.requireCSRF)
			case plugin.AccessSession:
				if unsafe {
					middlewares = append(middlewares, s.requireCSRF)
				}
			}
			group.With(middlewares...).Method(route.Method, route.Pattern, s.pluginHandler(route))
		}
	})
}

// checkPluginRoute refuses a route that a core route would already match. The
// SDK has already limited patterns to plain segments and {name} parameters.
func checkPluginRoute(api chi.Router, route plugins.Route) error {
	sample := []string{}
	for _, segment := range strings.Split(strings.TrimPrefix(route.Pattern, "/"), "/") {
		if strings.HasPrefix(segment, "{") {
			segment = "00000000-0000-0000-0000-000000000000"
		}
		sample = append(sample, segment)
	}
	if api.Match(chi.NewRouteContext(), route.Method, "/"+strings.Join(sample, "/")) {
		return fmt.Errorf("plugin %s: route %s %s is already answered by a core route", route.PluginID, route.Method, route.Pattern)
	}
	return nil
}

func (s *server) pluginHandler(route plugins.Route) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session := r.Context().Value(sessionContextKey).(auth.Session)
		ctx := plugin.WithPrincipal(r.Context(), plugin.Principal{UserID: session.User.ID, Role: session.User.Role})
		if err := route.Handler(w, r.WithContext(ctx)); err != nil {
			s.writePluginError(w, r, err)
		}
	})
}
