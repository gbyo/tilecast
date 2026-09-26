package httpapi

import (
	"fmt"
	"net/http"
	"regexp"
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
	if err = checkPluginRoutes(api, routes); err != nil {
		panic(err)
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

// checkPluginRoutes refuses a plugin route that could answer a path a core
// route already answers. It walks the routes registered so far and compares
// shapes segment by segment, so a plugin /things/{id} collides with a core
// /things/install, and parameter names never matter.
func checkPluginRoutes(api chi.Routes, routes []plugins.Route) error {
	type coreRoute struct{ method, pattern string }
	core := []coreRoute{}
	if err := chi.Walk(api, func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		core = append(core, coreRoute{method: method, pattern: pattern})
		return nil
	}); err != nil {
		return err
	}
	for _, route := range routes {
		for _, existing := range core {
			if existing.method != route.Method {
				continue
			}
			overlap, err := coreRouteOverlaps(existing.pattern, route.Pattern)
			if err != nil {
				return fmt.Errorf("core route %s %s: %w", existing.method, existing.pattern, err)
			}
			if overlap {
				return fmt.Errorf("plugin %s: route %s %s overlaps the core route %s %s",
					route.PluginID, route.Method, route.Pattern, existing.method, existing.pattern)
			}
		}
	}
	return nil
}

// coreRouteOverlaps reports whether some path matches both a core Chi pattern
// and a plugin pattern. Plugin patterns use only plain segments and {name}
// parameters (the SDK enforces it); core patterns may also use Chi's
// {name:regexp} parameters, parameters inside a segment, and a trailing *
// wildcard. The comparison errs toward reporting an overlap.
func coreRouteOverlaps(corePattern, pluginPattern string) (bool, error) {
	coreSegments := plugin.RouteSegments(corePattern)
	pluginSegments := plugin.RouteSegments(pluginPattern)
	for index, segment := range coreSegments {
		if segment == "*" || strings.HasSuffix(segment, "*") && !strings.Contains(segment, "{") {
			// A wildcard matches the rest of the path, whatever it is.
			if index == len(coreSegments)-1 {
				prefix := strings.TrimSuffix(segment, "*")
				if index >= len(pluginSegments) {
					return prefix == "", nil
				}
				pluginSegment := pluginSegments[index]
				return plugin.IsRouteParameter(pluginSegment) || strings.HasPrefix(pluginSegment, prefix), nil
			}
			return true, nil
		}
		if index >= len(pluginSegments) {
			return false, nil
		}
		pluginSegment := pluginSegments[index]
		if plugin.IsRouteParameter(pluginSegment) {
			// A plugin parameter matches any one segment, and every core
			// segment matches at least one.
			continue
		}
		if !strings.Contains(segment, "{") {
			if segment != pluginSegment {
				return false, nil
			}
			continue
		}
		matcher, err := chiSegmentMatcher(segment)
		if err != nil {
			return false, err
		}
		if !matcher.MatchString(pluginSegment) {
			return false, nil
		}
	}
	return len(coreSegments) == len(pluginSegments), nil
}

// chiSegmentMatcher compiles one Chi pattern segment: literal text, {name}
// (any text without a slash), and {name:regexp}.
func chiSegmentMatcher(segment string) (*regexp.Regexp, error) {
	var expression strings.Builder
	expression.WriteString("^")
	for len(segment) > 0 {
		open := strings.IndexByte(segment, '{')
		if open < 0 {
			expression.WriteString(regexp.QuoteMeta(segment))
			break
		}
		expression.WriteString(regexp.QuoteMeta(segment[:open]))
		depth, end := 0, -1
		for index := open; index < len(segment); index++ {
			switch segment[index] {
			case '{':
				depth++
			case '}':
				depth--
			}
			if depth == 0 {
				end = index
				break
			}
		}
		if end < 0 {
			return nil, fmt.Errorf("unbalanced parameter in %q", segment)
		}
		parameter := segment[open+1 : end]
		if _, pattern, found := strings.Cut(parameter, ":"); found {
			expression.WriteString("(?:" + strings.TrimSuffix(strings.TrimPrefix(pattern, "^"), "$") + ")")
		} else {
			expression.WriteString("[^/]+")
		}
		segment = segment[end+1:]
	}
	expression.WriteString("$")
	return regexp.Compile(expression.String())
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
