package plugin

import "strings"

// Plugin API v1 route patterns have two kinds of segment: a plain segment,
// which matches only itself, and a {name} parameter, which matches any one
// segment. That grammar is small enough to compare route shapes exactly
// instead of probing a router with sample paths.

// RouteSegments splits a pattern into its segments.
func RouteSegments(pattern string) []string {
	return strings.Split(strings.TrimPrefix(pattern, "/"), "/")
}

// IsRouteParameter reports whether a segment is a {name} parameter.
func IsRouteParameter(segment string) bool {
	return strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}")
}

// RouteShape is a pattern with every parameter name removed, so /a/{id} and
// /a/{name} have the same shape. Two routes with one shape are the same route.
func RouteShape(pattern string) string {
	segments := RouteSegments(pattern)
	for index, segment := range segments {
		if IsRouteParameter(segment) {
			segments[index] = "{}"
		}
	}
	return "/" + strings.Join(segments, "/")
}

// RoutePatternsOverlap reports whether some path matches both patterns: they
// have the same number of segments and, at every position, the segments are
// equal or at least one of them is a parameter. /a/{id} overlaps /a/install,
// and /a/{id} overlaps /a/{name}.
func RoutePatternsOverlap(a, b string) bool {
	left, right := RouteSegments(a), RouteSegments(b)
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] && !IsRouteParameter(left[index]) && !IsRouteParameter(right[index]) {
			return false
		}
	}
	return true
}
