package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
)

// Object-level authorization for dashboard routes.
//
// requireCapability says whether the role may do a kind of work at all.
// The rule for which object it may do it to lives in objectRules, keyed by
// method and route pattern, and every rule is decided by internal/authz.
// The dashboard router is wrapped so that registering a route under a
// screen-domain path without a rule stops the Server at startup: a new
// screen route cannot ship with its capability and without its object
// check. Handlers that take their targets from the body declare
// objectHandler and call authz themselves with the same decisions.

type objectKind int

const (
	// objectHandler: the handler decides through authz, because the
	// objects come from the request body or the response is a filtered
	// list. The rule records that the route was reviewed.
	objectHandler objectKind = iota + 1
	objectScreen
	// objectScreenAssignment: an operation a Display Group carries to every
	// member, so the screen's group peers must be reachable too.
	objectScreenAssignment
	objectGroup
	objectGroupMember
	objectSchedule
	objectTakeover
	objectPresentationOverride
	objectAirPlaySession
	objectDeploymentRead
	objectDeployment
	objectPairingReject
	// objectWholeFleet: organization structure that needs the capability
	// and access to every screen.
	objectWholeFleet
)

type objectRule struct {
	kind       objectKind
	capability auth.Capability
	// param is the path parameter that names the object. Defaults to "id".
	param string
	// note says, for objectHandler, how the handler authorizes.
	note string
}

func screenObject(capability auth.Capability) objectRule {
	return objectRule{kind: objectScreen, capability: capability}
}

func handlerObject(capability auth.Capability, note string) objectRule {
	return objectRule{kind: objectHandler, capability: capability, note: note}
}

// screenDomainPrefixes are the paths whose routes act on screens, groups,
// or fleet structure. Every route below them must have an objectRule.
var screenDomainPrefixes = []string{
	"/api/v1/screens",
	"/api/v1/screen-groups",
	"/api/v1/schedules",
	"/api/v1/takeovers",
	"/api/v1/presentation-overrides",
	"/api/v1/presentation-networks",
	"/api/v1/locations",
	"/api/v1/update-deployments",
	"/api/v1/airplay",
	"/api/v1/users/{id}/screen-scopes",
}

func inScreenDomain(pattern string) bool {
	for _, prefix := range screenDomainPrefixes {
		if pattern == prefix || strings.HasPrefix(pattern, prefix+"/") {
			return true
		}
	}
	return false
}

// objectRules is the declared object authorization of every screen-domain
// dashboard route, and of the other routes whose bodies or responses carry
// screens. TestScreenRoutesDeclareObjectAuthorization holds it to the
// registered routes in both directions.
var objectRules = map[string]objectRule{
	"GET /api/v1/screens":                                           handlerObject(auth.CapScreenRead, "lists only screens within the caller's screen access"),
	"GET /api/v1/screens/archive":                                   handlerObject(auth.CapScreenRead, "archived screens have no anchor; a restricted caller sees none"),
	"GET /api/v1/screens/{id}":                                      screenObject(auth.CapScreenRead),
	"GET /api/v1/screens/{id}/player-history":                       screenObject(auth.CapScreenRead),
	"POST /api/v1/screens/{id}/live-stream":                         screenObject(auth.CapScreenRead),
	"POST /api/v1/screens/{id}/live-stream/{sessionId}/renew":       screenObject(auth.CapScreenRead),
	"DELETE /api/v1/screens/{id}/live-stream/{sessionId}":           screenObject(auth.CapScreenRead),
	"GET /api/v1/screens/{id}/live-stream/{sessionId}/mjpeg":        screenObject(auth.CapScreenRead),
	"GET /api/v1/screens/{id}/live-stream/{sessionId}/h264":         screenObject(auth.CapScreenRead),
	"GET /api/v1/screens/{id}/reliability":                          screenObject(auth.CapScreenRead),
	"GET /api/v1/screens/{id}/presentation-network":                 screenObject(auth.CapScreenRead),
	"PUT /api/v1/screens/{id}/presentation-network":                 screenObject(auth.CapScreenManage),
	"DELETE /api/v1/screens/{id}/presentation-network":              screenObject(auth.CapScreenManage),
	"GET /api/v1/screens/{id}/policy":                               screenObject(auth.CapScreenRead),
	"GET /api/v1/screens/{id}/effective-policy":                     screenObject(auth.CapScreenRead),
	"PUT /api/v1/screens/{id}/policy":                               screenObject(auth.CapScreenManage),
	"DELETE /api/v1/screens/{id}/policy":                            screenObject(auth.CapScreenManage),
	"GET /api/v1/screens/{id}/snapshots":                            screenObject(auth.CapScreenRead),
	"GET /api/v1/screens/{id}/snapshots/{snapshotId}/image":         screenObject(auth.CapScreenRead),
	"GET /api/v1/screens/{id}/playlist-assignment":                  screenObject(auth.CapScreenRead),
	"GET /api/v1/screens/{id}/playback-plan":                        screenObject(auth.CapScreenRead),
	"GET /api/v1/screens/{id}/playback-agenda":                      screenObject(auth.CapScreenRead),
	"PUT /api/v1/screens/{id}/playlist-assignment":                  {kind: objectScreenAssignment, capability: auth.CapScreenAssign},
	"DELETE /api/v1/screens/{id}/playlist-assignment":               {kind: objectScreenAssignment, capability: auth.CapScreenAssign},
	"POST /api/v1/screens/bulk/preview":                             handlerObject(auth.CapScreenManage, "authorizes every named screen, all or nothing"),
	"POST /api/v1/screens/bulk/apply":                               handlerObject(auth.CapScreenManage, "authorizes every named screen, all or nothing"),
	"GET /api/v1/screens/bulk/operations":                           handlerObject(auth.CapScreenManage, "fleetops lists only operations whose every screen is reachable"),
	"POST /api/v1/screens/bulk/operations/{id}/undo":                handlerObject(auth.CapScreenManage, "fleetops authorizes every restored screen before claiming the undo"),
	"GET /api/v1/screens/pairing/pending":                           handlerObject(auth.CapScreenPair, "lists only sessions from hardware paired to a reachable screen"),
	"POST /api/v1/screens/browser":                                  handlerObject(auth.CapScreenPair, "authorizes the destination location inside the creating transaction"),
	"GET /api/v1/screens/{id}/browser":                              screenObject(auth.CapScreenPair),
	"PUT /api/v1/screens/{id}/browser/recovery":                     screenObject(auth.CapScreenPair),
	"POST /api/v1/screens/pairing/resolve":                          handlerObject(auth.CapScreenRead, "a code resolves only new hardware or hardware paired to a reachable screen"),
	"POST /api/v1/screens/pairing/{id}/approve":                     handlerObject(auth.CapScreenPair, "authorizes the destination or existing screen inside the approval transaction"),
	"POST /api/v1/screens/pairing/{id}/reject":                      {kind: objectPairingReject, capability: auth.CapScreenPair},
	"PATCH /api/v1/screens/{id}":                                    screenObject(auth.CapScreenManage),
	"POST /api/v1/screens/{id}/disable":                             screenObject(auth.CapScreenManage),
	"POST /api/v1/screens/{id}/enable":                              screenObject(auth.CapScreenManage),
	"POST /api/v1/screens/{id}/revoke":                              screenObject(auth.CapScreenPair),
	"GET /api/v1/screens/{id}/commands":                             screenObject(auth.CapScreenRead),
	"POST /api/v1/screens/{id}/commands":                            screenObject(auth.CapScreenManage),
	"POST /api/v1/screens/{id}/commands/{commandId}/cancel":         screenObject(auth.CapScreenManage),
	"PUT /api/v1/screens/{id}/power-assist":                         screenObject(auth.CapScreenManage),
	"POST /api/v1/airplay/sessions":                                 handlerObject(auth.CapScreenAssign, "authorizes the target screen or group as a selection"),
	"GET /api/v1/airplay/sessions/{id}":                             {kind: objectAirPlaySession, capability: auth.CapScreenRead},
	"POST /api/v1/airplay/sessions/{id}/stop":                       {kind: objectAirPlaySession, capability: auth.CapScreenAssign},
	"GET /api/v1/presentation-networks":                             handlerObject(auth.CapScreenManage, "network definitions carry no secret; assignment counts stay organization facts"),
	"GET /api/v1/presentation-networks/{id}":                        handlerObject(auth.CapScreenManage, "assignments are narrowed to reachable screens"),
	"POST /api/v1/presentation-networks":                            {kind: objectWholeFleet, capability: auth.CapScreenNetworksManage},
	"PATCH /api/v1/presentation-networks/{id}":                      {kind: objectWholeFleet, capability: auth.CapScreenNetworksManage},
	"DELETE /api/v1/presentation-networks/{id}":                     {kind: objectWholeFleet, capability: auth.CapScreenNetworksManage},
	"PUT /api/v1/presentation-networks/{id}/screens":                {kind: objectWholeFleet, capability: auth.CapScreenNetworksManage},
	"POST /api/v1/presentation-networks/{id}/test":                  handlerObject(auth.CapScreenManage, "authorizes the screen the test runs on"),
	"GET /api/v1/presentation-overrides":                            handlerObject(auth.CapScreenRead, "lists only overrides whose target is reachable"),
	"POST /api/v1/presentation-overrides":                           handlerObject(auth.CapScreenAssign, "authorizes the target screen or group as a selection"),
	"POST /api/v1/presentation-overrides/{id}/stop":                 {kind: objectPresentationOverride, capability: auth.CapScreenAssign},
	"GET /api/v1/locations":                                         handlerObject(auth.CapScreenRead, "lists granted locations and the locations of reachable screens"),
	"POST /api/v1/locations":                                        {kind: objectWholeFleet, capability: auth.CapScreenLocationsManage},
	"PATCH /api/v1/locations/{id}":                                  {kind: objectWholeFleet, capability: auth.CapScreenLocationsManage},
	"DELETE /api/v1/locations/{id}":                                 {kind: objectWholeFleet, capability: auth.CapScreenLocationsManage},
	"GET /api/v1/screen-groups":                                     handlerObject(auth.CapScreenRead, "lists only reachable Display Groups"),
	"GET /api/v1/screen-groups/{id}":                                {kind: objectGroup, capability: auth.CapScreenRead},
	"GET /api/v1/screen-groups/{id}/span":                           {kind: objectGroup, capability: auth.CapScreenRead},
	"GET /api/v1/screen-groups/{id}/display-control/preview":        {kind: objectGroup, capability: auth.CapScreenManage},
	"GET /api/v1/screen-groups/{id}/policy":                         {kind: objectGroup, capability: auth.CapScreenRead},
	"PUT /api/v1/screen-groups/{id}/policy":                         {kind: objectGroup, capability: auth.CapScreenManage},
	"DELETE /api/v1/screen-groups/{id}/policy":                      {kind: objectGroup, capability: auth.CapScreenManage},
	"POST /api/v1/screen-groups":                                    handlerObject(auth.CapScreenManage, "a restricted caller creates a group with reachable initial members in one transaction"),
	"PATCH /api/v1/screen-groups/{id}":                              {kind: objectGroup, capability: auth.CapScreenManage, note: "the handler also authorizes a new gateway screen"},
	"PUT /api/v1/screen-groups/{id}/span":                           {kind: objectGroup, capability: auth.CapScreenManage},
	"POST /api/v1/screen-groups/{id}/display-control":               {kind: objectGroup, capability: auth.CapScreenManage},
	"DELETE /api/v1/screen-groups/{id}":                             {kind: objectGroup, capability: auth.CapScreenManage},
	"POST /api/v1/screen-groups/{id}/screens":                       {kind: objectGroup, capability: auth.CapScreenManage, note: "the handler also authorizes the added screen"},
	"DELETE /api/v1/screen-groups/{id}/screens/{screenId}":          {kind: objectGroupMember, capability: auth.CapScreenManage},
	"PUT /api/v1/screen-groups/{id}/playlist-assignment":            {kind: objectGroup, capability: auth.CapScreenAssign},
	"DELETE /api/v1/screen-groups/{id}/playlist-assignment":         {kind: objectGroup, capability: auth.CapScreenAssign},
	"GET /api/v1/schedules":                                         handlerObject(auth.CapScheduleRead, "lists only reachable schedules"),
	"GET /api/v1/schedules/{id}":                                    {kind: objectSchedule, capability: auth.CapScheduleRead},
	"POST /api/v1/schedules":                                        handlerObject(auth.CapScheduleEdit, "authorizes the targets as a selection; a restricted caller needs at least one"),
	"PATCH /api/v1/schedules/{id}":                                  {kind: objectSchedule, capability: auth.CapScheduleEdit, note: "the handler also authorizes the new targets"},
	"DELETE /api/v1/schedules/{id}":                                 {kind: objectSchedule, capability: auth.CapScheduleEdit},
	"POST /api/v1/schedules/{id}/enable":                            {kind: objectSchedule, capability: auth.CapScheduleEdit},
	"POST /api/v1/schedules/{id}/disable":                           {kind: objectSchedule, capability: auth.CapScheduleEdit},
	"POST /api/v1/schedules/preview":                                handlerObject(auth.CapScheduleEdit, "authorizes the screen and any proposed targets"),
	"POST /api/v1/schedules/preflight":                              handlerObject(auth.CapScheduleRead, "authorizes the proposed targets and hides unreachable competitors"),
	"GET /api/v1/takeovers":                                         handlerObject(auth.CapScreenRead, "lists only reachable takeovers"),
	"GET /api/v1/takeovers/{id}":                                    {kind: objectTakeover, capability: auth.CapScreenRead},
	"POST /api/v1/takeovers":                                        handlerObject(auth.CapScreenAssign, "authorizes the targets as a selection"),
	"POST /api/v1/takeovers/{id}/cancel":                            {kind: objectTakeover, capability: auth.CapScreenAssign},
	"GET /api/v1/update-deployments":                                handlerObject(auth.CapScreenRead, "lists deployments reaching a reachable screen and counts only those screens"),
	"GET /api/v1/update-deployments/{id}":                           {kind: objectDeploymentRead, capability: auth.CapScreenRead, note: "the handler narrows the rows"},
	"POST /api/v1/update-deployments":                               handlerObject(auth.CapScreenManage, "authorizes the targets as a selection"),
	"POST /api/v1/update-deployments/preview":                       handlerObject(auth.CapScreenManage, "authorizes the targets as a selection"),
	"POST /api/v1/update-deployments/{id}/cancel":                   {kind: objectDeployment, capability: auth.CapScreenManage},
	"POST /api/v1/update-deployments/{id}/screens/{screenId}/retry": {kind: objectScreen, capability: auth.CapScreenManage, param: "screenId"},
	"GET /api/v1/users/{id}/screen-scopes":                          handlerObject(auth.CapUsersManage, "reads another account's policy"),
	"PUT /api/v1/users/{id}/screen-scopes":                          handlerObject(auth.CapUsersManage, "applies the delegation rule before storing a policy"),
	"POST /api/v1/users":                                            handlerObject(auth.CapUsersManage, "writes the new account's screen access in the creating transaction"),
	"GET /api/v1/me/access":                                         handlerObject("", "reports the caller's own screen access"),
	"GET /api/v1/plugins/dependency-graph":                          handlerObject(auth.CapPluginsUse, "counts dependencies on reachable screens only"),
	"GET /api/v1/content-health":                                    handlerObject(auth.CapScreenRead, "lists only reachable unassigned screens"),
}

// guardedRouter registers dashboard routes with their declared object rule.
type guardedRouter struct {
	chi.Router
	s      *server
	prefix string
}

func (g guardedRouter) With(middlewares ...func(http.Handler) http.Handler) chi.Router {
	return guardedRouter{Router: g.Router.With(middlewares...), s: g.s, prefix: g.prefix}
}

func (g guardedRouter) Group(fn func(chi.Router)) chi.Router {
	return guardedRouter{Router: g.Router.Group(func(r chi.Router) {
		fn(guardedRouter{Router: r, s: g.s, prefix: g.prefix})
	}), s: g.s, prefix: g.prefix}
}

func (g guardedRouter) Route(string, func(chi.Router)) chi.Router {
	panic("guardedRouter: register dashboard routes with a method and full pattern")
}

func (g guardedRouter) Mount(string, http.Handler) {
	panic("guardedRouter: register dashboard routes with a method and full pattern")
}

func (g guardedRouter) Handle(string, http.Handler) {
	panic("guardedRouter: dashboard routes must name a method")
}

func (g guardedRouter) HandleFunc(string, http.HandlerFunc) {
	panic("guardedRouter: dashboard routes must name a method")
}

func (g guardedRouter) Method(method, pattern string, handler http.Handler) {
	g.Router.Method(method, pattern, g.s.guard(method, g.prefix+pattern, handler))
}

func (g guardedRouter) MethodFunc(method, pattern string, handler http.HandlerFunc) {
	g.Method(method, pattern, handler)
}

func (g guardedRouter) Get(pattern string, handler http.HandlerFunc) {
	g.Method(http.MethodGet, pattern, handler)
}

func (g guardedRouter) Head(pattern string, handler http.HandlerFunc) {
	g.Method(http.MethodHead, pattern, handler)
}

func (g guardedRouter) Post(pattern string, handler http.HandlerFunc) {
	g.Method(http.MethodPost, pattern, handler)
}

func (g guardedRouter) Put(pattern string, handler http.HandlerFunc) {
	g.Method(http.MethodPut, pattern, handler)
}

func (g guardedRouter) Patch(pattern string, handler http.HandlerFunc) {
	g.Method(http.MethodPatch, pattern, handler)
}

func (g guardedRouter) Delete(pattern string, handler http.HandlerFunc) {
	g.Method(http.MethodDelete, pattern, handler)
}

func (g guardedRouter) Options(pattern string, handler http.HandlerFunc) {
	g.Method(http.MethodOptions, pattern, handler)
}

func (g guardedRouter) Connect(pattern string, handler http.HandlerFunc) {
	g.Method(http.MethodConnect, pattern, handler)
}

func (g guardedRouter) Trace(pattern string, handler http.HandlerFunc) {
	g.Method(http.MethodTrace, pattern, handler)
}

// guard wraps one route's handler with its declared object rule. It runs
// innermost, after the capability, CSRF, and credential-scope checks.
func (s *server) guard(method, pattern string, handler http.Handler) http.Handler {
	key := method + " " + pattern
	rule, declared := objectRules[key]
	if !declared {
		if inScreenDomain(pattern) {
			panic(fmt.Sprintf("route %s acts on screens but declares no object authorization; add it to objectRules", key))
		}
		return handler
	}
	if s.registeredObjectRules != nil {
		s.registeredObjectRules[key] = true
	}
	if rule.kind == objectHandler {
		return handler
	}
	param := rule.param
	if param == "" {
		param = "id"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor, ok := s.actor(w, r)
		if !ok {
			return
		}
		if rule.kind == objectWholeFleet {
			if err := s.authorizer().WholeFleet(r.Context(), actor, rule.capability); err != nil {
				s.writeAuthzError(w, r, err, notFoundFor(rule.kind))
				return
			}
			handler.ServeHTTP(w, r)
			return
		}
		id, err := uuid.Parse(chi.URLParam(r, param))
		if err != nil {
			// Let the handler report a malformed id in its own words.
			handler.ServeHTTP(w, r)
			return
		}
		ctx := r.Context()
		switch rule.kind {
		case objectScreen:
			err = s.authorizer().Screen(ctx, actor, rule.capability, id)
		case objectScreenAssignment:
			err = s.authorizer().ScreenAssignment(ctx, actor, rule.capability, id)
		case objectGroup:
			err = s.authorizer().Group(ctx, actor, rule.capability, id)
		case objectGroupMember:
			screen, parseErr := uuid.Parse(chi.URLParam(r, "screenId"))
			if parseErr != nil {
				err = authz.ErrNotFound
				break
			}
			err = s.authorizer().GroupMember(ctx, actor, rule.capability, id, screen)
		case objectSchedule:
			err = s.authorizer().Schedule(ctx, actor, rule.capability, id)
		case objectTakeover:
			err = s.authorizer().Takeover(ctx, actor, rule.capability, id)
		case objectPresentationOverride:
			err = s.authorizer().PresentationOverride(ctx, actor, rule.capability, id)
		case objectAirPlaySession:
			err = s.authorizer().AirPlaySession(ctx, actor, rule.capability, id)
		case objectDeploymentRead:
			err = s.authorizer().DeploymentRead(ctx, actor, rule.capability, id)
		case objectDeployment:
			err = s.authorizer().Deployment(ctx, actor, rule.capability, id)
		case objectPairingReject:
			err = s.authorizer().PairingSession(ctx, actor, rule.capability, id, true)
		default:
			err = fmt.Errorf("object rule %d has no decision", rule.kind)
		}
		if err != nil {
			s.writeAuthzError(w, r, err, notFoundFor(rule.kind))
			return
		}
		handler.ServeHTTP(w, r)
	})
}

type notFoundAnswer struct{ code, message string }

func notFoundFor(kind objectKind) notFoundAnswer {
	switch kind {
	case objectGroup, objectSchedule:
		return notFoundAnswer{"schedule_not_found", "The requested scheduling resource was not found."}
	case objectGroupMember:
		return notFoundAnswer{"screen_not_found", "Screen was not found."}
	case objectTakeover:
		return notFoundAnswer{"takeover_not_found", "Takeover was not found."}
	case objectPresentationOverride:
		return notFoundAnswer{"presentation_not_found", "Quick Present is no longer active."}
	case objectAirPlaySession:
		return notFoundAnswer{"airplay_session_not_found", "AirPlay session was not found."}
	case objectDeploymentRead, objectDeployment:
		return notFoundAnswer{"update_deployment_not_found", "Deployment was not found."}
	case objectPairingReject:
		return notFoundAnswer{"not_found", "The requested pairing or screen was not found."}
	case objectWholeFleet:
		return notFoundAnswer{"not_found", "The requested resource was not found."}
	default:
		return notFoundAnswer{"screen_not_found", "Screen was not found."}
	}
}

// actor returns the request's authz actor. It returns false when it has
// already written the response.
func (s *server) actor(w http.ResponseWriter, r *http.Request) (authz.Actor, bool) {
	principal, ok := principalOf(r)
	if !ok {
		// Fail closed: a guarded route reached without a principal is a
		// wiring mistake, never an anonymous allowance.
		writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
		return authz.Actor{}, false
	}
	return authz.ActorFor(principal), true
}

// callerAccess resolves the request's screen access, for handlers that
// filter their SQL. It returns false when it has already written the
// response.
func (s *server) callerAccess(w http.ResponseWriter, r *http.Request) (authz.ScreenAccess, bool) {
	actor, ok := s.actor(w, r)
	if !ok {
		return authz.ScreenAccess{}, false
	}
	access, err := s.authorizer().Access(r.Context(), actor)
	if err != nil {
		s.internalError(w, r, err)
		return authz.ScreenAccess{}, false
	}
	return access, true
}

// decide runs one authz decision for a handler and writes the refusal. It
// returns false when it has already written the response.
func (s *server) decide(w http.ResponseWriter, r *http.Request, notFound notFoundAnswer, decision func(*authz.Authorizer, authz.Actor) error) bool {
	actor, ok := s.actor(w, r)
	if !ok {
		return false
	}
	if err := decision(s.authorizer(), actor); err != nil {
		s.writeAuthzError(w, r, err, notFound)
		return false
	}
	return true
}

// writeAuthzError maps a decision to the dashboard's error contract.
func (s *server) writeAuthzError(w http.ResponseWriter, r *http.Request, err error, notFound notFoundAnswer) {
	switch {
	case errors.Is(err, authz.ErrForbidden):
		writeError(w, http.StatusForbidden, "insufficient_role", "Your role does not allow this action.")
	case errors.Is(err, authz.ErrNotFound):
		// 404 rather than 403: a restricted operator has no business
		// learning what exists outside their screen access.
		writeError(w, http.StatusNotFound, notFound.code, notFound.message)
	case errors.Is(err, authz.ErrOutOfScope):
		writeError(w, http.StatusForbidden, "out_of_scope", "Some of the selected screens are outside your screen access.")
	case errors.Is(err, authz.ErrRestricted):
		writeError(w, http.StatusForbidden, "screen_access_restricted", "This action changes organization structure and needs access to every screen.")
	case errors.Is(err, authz.ErrLocationRequired):
		writeError(w, http.StatusUnprocessableEntity, "screen_location_required", "Choose a location within your screen access.")
	default:
		s.internalError(w, r, err)
	}
}

// isAuthzError reports whether err is a decision rather than a failure.
func isAuthzError(err error) bool {
	return errors.Is(err, authz.ErrForbidden) || errors.Is(err, authz.ErrNotFound) ||
		errors.Is(err, authz.ErrOutOfScope) || errors.Is(err, authz.ErrRestricted) ||
		errors.Is(err, authz.ErrLocationRequired)
}

// authorizer returns the server's authz decisions. A server built without
// one (a handler test) decides against its own database handle.
func (s *server) authorizer() *authz.Authorizer {
	if s.authz != nil {
		return s.authz
	}
	return authz.New(s.db)
}
