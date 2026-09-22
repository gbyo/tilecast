package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/alerts"
	"github.com/tilecast/tilecast/apps/server/internal/approvals"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/backup"
	"github.com/tilecast/tilecast/apps/server/internal/campaigns"
	"github.com/tilecast/tilecast/apps/server/internal/contenthealth"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/edge"
	"github.com/tilecast/tilecast/apps/server/internal/fleetops"
	"github.com/tilecast/tilecast/apps/server/internal/forms"
	"github.com/tilecast/tilecast/apps/server/internal/integrations"
	"github.com/tilecast/tilecast/apps/server/internal/layouts"
	"github.com/tilecast/tilecast/apps/server/internal/livestream"
	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/notify"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/apps/server/internal/presentations"
	"github.com/tilecast/tilecast/apps/server/internal/presentnet"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
	"github.com/tilecast/tilecast/apps/server/internal/snapshots"
	"github.com/tilecast/tilecast/apps/server/internal/span"
	"github.com/tilecast/tilecast/apps/server/internal/updates"
)

type Dependencies struct {
	Auth                 *auth.Service
	Devices              *devices.Service
	Media                *media.Service
	Forms                *forms.Service
	Playlists            *playlists.Service
	Campaigns            *campaigns.Service
	Presentations        *presentations.Service
	Plugins              *plugins.Service
	Layouts              *layouts.Service
	Scheduling           *scheduling.Service
	Settings             *settings.Service
	Updates              *updates.Service
	Alerts               *alerts.Service
	Notifications        *notify.Service
	ContentHealth        *contenthealth.Service
	Fleet                *fleetops.Service
	Integrations         *integrations.Service
	Approvals            *approvals.Service
	Snapshots            *snapshots.Service
	Span                 *span.Service
	PresentationNetworks *presentnet.Service
	Edge                 *edge.Service
	DB                   *pgxpool.Pool
	Logger               *slog.Logger
	CookieName           string
	SecureCookies        bool
	ReleasePublishToken  string
	PublicURL            string
	Operations           OperationsConfig
	Backups              *backup.Service
	BackupWorker         *backup.Worker
	BackupLimits         backup.Limits
}

type OperationsConfig struct {
	MaxTakeoverDurationHours    int
	MaxTakeoverTargets          int
	MaxPendingCommands          int
	DefaultCommandExpiryMinutes int
	MaxIdentifySeconds          int
	CommandRetentionDays        int
}

type server struct {
	auth                          *auth.Service
	devices                       *devices.Service
	media                         *media.Service
	forms                         *forms.Service
	playlists                     *playlists.Service
	campaigns                     *campaigns.Service
	presentations                 *presentations.Service
	plugins                       *plugins.Service
	layouts                       *layouts.Service
	scheduling                    *scheduling.Service
	db                            *pgxpool.Pool
	logger                        *slog.Logger
	cookieName                    string
	secureCookies                 bool
	authLimiter                   *rateLimiter
	pairingLimiter                *rateLimiter
	codeLimiter                   *rateLimiter
	operationsLimiter             *rateLimiter
	operations                    OperationsConfig
	settings                      *settings.Service
	updates                       *updates.Service
	alerts                        *alerts.Service
	notifications                 *notify.Service
	contentHealthService          *contenthealth.Service
	fleet                         *fleetops.Service
	integrations                  *integrations.Service
	approvals                     *approvals.Service
	snapshots                     *snapshots.Service
	span                          *span.Service
	presentationNetworks          *presentnet.Service
	edge                          *edge.Service
	liveStreams                   *livestream.Service
	releasePublishTokenHash       [32]byte
	releasePublishTokenConfigured bool
	startedAt                     time.Time
	backups                       *backup.Service
	backupWorker                  *backup.Worker
	backupLimits                  backup.Limits
	publicURL                     string
	installLimiter                *rateLimiter
}

type contextKey string

const sessionContextKey contextKey = "session"

// API is the HTTP handler together with the background work the request layer
// owns. AirPlay group preparation is durable state that has to be reconciled at
// startup and on a timer, not only while a request is in flight, so the process
// needs a handle on it.
type API struct {
	http.Handler
	server *server
}

// ReconcileAirplaySessions advances or fails every group AirPlay session that
// is still preparing. Safe to call repeatedly and concurrently.
func (a *API) ReconcileAirplaySessions(ctx context.Context) {
	a.server.ReconcileAirplaySessions(ctx)
}

func New(deps Dependencies) *API {
	s := &server{
		auth:              deps.Auth,
		devices:           deps.Devices,
		media:             deps.Media,
		forms:             deps.Forms,
		playlists:         deps.Playlists,
		campaigns:         deps.Campaigns,
		presentations:     deps.Presentations,
		plugins:           deps.Plugins,
		layouts:           deps.Layouts,
		scheduling:        deps.Scheduling,
		db:                deps.DB,
		logger:            deps.Logger,
		cookieName:        deps.CookieName,
		secureCookies:     deps.SecureCookies,
		authLimiter:       newRateLimiter(10, 10*time.Minute),
		pairingLimiter:    newRateLimiter(10, time.Minute),
		codeLimiter:       newRateLimiter(30, 10*time.Minute),
		operationsLimiter: newRateLimiter(60, time.Minute),
		// Provisioning is unauthenticated by necessity — the box has no
		// credential until it pairs — so it gets its own budget, generous
		// enough for a cart of machines behind one NAT.
		installLimiter:       newRateLimiter(60, time.Minute),
		publicURL:            deps.PublicURL,
		operations:           deps.Operations,
		settings:             deps.Settings,
		updates:              deps.Updates,
		alerts:               deps.Alerts,
		notifications:        deps.Notifications,
		contentHealthService: deps.ContentHealth,
		fleet:                deps.Fleet,
		integrations:         deps.Integrations,
		approvals:            deps.Approvals,
		snapshots:            deps.Snapshots,
		span:                 deps.Span,
		presentationNetworks: deps.PresentationNetworks,
		edge:                 deps.Edge,
		liveStreams:          livestream.NewService(deps.Devices),
		startedAt:            time.Now(),
		backups:              deps.Backups,
		backupWorker:         deps.BackupWorker,
		backupLimits:         deps.BackupLimits,
	}
	if s.fleet != nil {
		// The command path lives on the server, so bulk sending and single
		// sending share one implementation.
		s.fleet.SetCommandEnqueuer(s)
	}
	if s.devices != nil {
		// A heartbeat that reports the last preparing participant as ready should
		// release the gateway immediately rather than wait for the periodic sweep.
		s.devices.SetAirplayReconciler(s.reconcileAirplaySession)
		if s.edge != nil {
			s.wireEdgeRevocation()
		}
	}
	if deps.ReleasePublishToken != "" {
		s.releasePublishTokenHash = sha256.Sum256([]byte(deps.ReleasePublishToken))
		s.releasePublishTokenConfigured = true
	}
	if s.operations.MaxTakeoverDurationHours == 0 {
		s.operations = OperationsConfig{24, 250, 50, 10, 120, 30}
	}
	return &API{Handler: s.routes(), server: s}
}

func (s *server) requireRoles(roles ...string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(roles))
	for _, role := range roles {
		allowed[role] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			session, ok := r.Context().Value(sessionContextKey).(auth.Session)
			if !ok || !allowed[session.User.Role] {
				writeError(w, http.StatusForbidden, "insufficient_role", "Owner or Administrator access is required.")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"status": "ok", "service": "tilecast-server"}})
}

func (s *server) ready(w http.ResponseWriter, r *http.Request) {
	if s.backups != nil && s.backups.Guard().RestoreActive() {
		writeError(w, http.StatusServiceUnavailable, "restore_in_progress", "A restore is in progress. Tilecast will be back shortly.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "The database is not ready.")
		return
	}
	if s.media != nil {
		diagnostics, err := s.media.Diagnostics()
		if err != nil || diagnostics["ffmpegAvailable"] != true || diagnostics["ffprobeAvailable"] != true {
			writeError(w, http.StatusServiceUnavailable, "media_infrastructure_unavailable", "Media storage or processing tools are not ready.")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"status": "ready"}})
}

func (s *server) authStatus(w http.ResponseWriter, r *http.Request) {
	required, err := s.auth.SetupRequired(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	passkeysAvailable, passkeyReason := s.auth.PasskeysAvailable()
	result := map[string]any{
		"setupRequired":             required,
		"authenticated":             false,
		"passkeysAvailable":         passkeysAvailable,
		"passkeysUnavailableReason": passkeyReason,
	}
	if !required {
		if cookie, err := r.Cookie(s.cookieName); err == nil {
			if session, err := s.auth.Authenticate(r.Context(), cookie.Value); err == nil {
				result["authenticated"] = true
				result["user"] = session.User
				result["csrfToken"] = session.CSRFToken
				result["authMethod"] = session.AuthMethod
				result["mfaEnrollmentRequired"] = session.EnrollmentPending
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": result})
}

type setupRequest struct {
	OrganizationName string `json:"organizationName"`
	OwnerName        string `json:"ownerName"`
	Username         string `json:"username"`
	Password         string `json:"password"`
}

func (s *server) setup(w http.ResponseWriter, r *http.Request) {
	var body setupRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	session, err := s.auth.Setup(r.Context(), auth.SetupInput{
		OrganizationName: body.OrganizationName,
		OwnerName:        body.OwnerName,
		Username:         body.Username,
		Password:         body.Password,
	})
	if errors.Is(err, auth.ErrSetupComplete) {
		writeError(w, http.StatusConflict, "setup_complete", err.Error())
		return
	}
	if err != nil {
		if isInputError(err) {
			writeError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
			return
		}
		s.internalError(w, r, err)
		return
	}
	s.setSessionCookie(w, session)
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{"user": session.User, "csrfToken": session.CSRFToken}})
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	var body loginRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := s.auth.Login(r.Context(), auth.LoginInput{Username: body.Username, Password: body.Password}, s.mfaPolicy(r))
	if errors.Is(err, auth.ErrInvalidCredentials) || errors.Is(err, auth.ErrInactive) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "The username or password is incorrect.")
		return
	}
	if errors.Is(err, auth.ErrNoUsableFactor) {
		s.writeMFAError(w, r, err)
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// A correct password on an enrolled account produces a challenge, not a
	// session. No cookie is set until the second factor is presented.
	if result.Challenge != nil {
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
			"mfaRequired":    true,
			"challengeToken": result.Challenge.Token,
			"methods":        result.Challenge.Methods,
		}})
		return
	}
	s.sessionResponse(w, http.StatusOK, *result.Session)
}

func (s *server) logout(w http.ResponseWriter, r *http.Request) {
	session := r.Context().Value(sessionContextKey).(auth.Session)
	if err := s.auth.Logout(r.Context(), session.Token, session.User.ID); err != nil {
		s.internalError(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: s.cookieName, Value: "", Path: "/", HttpOnly: true, Secure: s.secureCookies, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(s.cookieName)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
			return
		}
		session, err := s.auth.Authenticate(r.Context(), cookie.Value)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "authentication_required", "Authentication is required.")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionContextKey, session)))
	})
}

// requireEnrollment closes the dashboard to a session that still owes the
// organization a second factor. The security endpoints are registered outside
// this group so the user can actually enroll, and the gate is a hard server
// check rather than a dashboard redirect.
func (s *server) requireEnrollment(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if session, ok := r.Context().Value(sessionContextKey).(auth.Session); ok && session.EnrollmentPending {
			writeError(w, http.StatusForbidden, "mfa_enrollment_required", "This organization requires multi-factor authentication. Finish enrollment to continue.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) requireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session := r.Context().Value(sessionContextKey).(auth.Session)
		provided := r.Header.Get("X-CSRF-Token")
		if len(provided) != len(session.CSRFToken) || subtle.ConstantTimeCompare([]byte(provided), []byte(session.CSRFToken)) != 1 {
			writeError(w, http.StatusForbidden, "csrf_failed", "The request could not be verified.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) requireReleasePublisher(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if credential, ok := parseAuthorization(r.Header.Get("Authorization"), "Bearer"); ok {
			provided := sha256.Sum256([]byte(credential))
			if !s.releasePublishTokenConfigured || subtle.ConstantTimeCompare(provided[:], s.releasePublishTokenHash[:]) != 1 {
				writeError(w, http.StatusUnauthorized, "release_publish_token_invalid", "The release publishing token is invalid.")
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		s.requireSession(s.requireRoles("owner")(s.requireCSRF(next))).ServeHTTP(w, r)
	})
}

func (s *server) setSessionCookie(w http.ResponseWriter, session auth.Session) {
	http.SetCookie(w, &http.Cookie{
		Name: s.cookieName, Value: session.Token, Path: "/", HttpOnly: true, Secure: s.secureCookies,
		SameSite: http.SameSiteStrictMode, Expires: session.ExpiresAt, MaxAge: int(time.Until(session.ExpiresAt).Seconds()),
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	return decodeJSONLimit(w, r, target, 1<<20)
}

func decodeJSONLimit(w http.ResponseWriter, r *http.Request, target any, maximumBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maximumBytes)
	return decodeJSONReader(r, r.Body, target)
}

// decodeJSONReader applies the strict request contract (one JSON object, no
// unknown fields) to an already-bounded body. Handlers that need the raw bytes
// as well read them first and pass a reader over them.
func decodeJSONReader(r *http.Request, body io.Reader, target any) error {
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		category := "malformed"
		message := "Request body contains malformed JSON."
		if errors.Is(err, io.EOF) {
			category, message = "missing", "Request body is missing."
		} else if strings.HasPrefix(err.Error(), "json: unknown field ") {
			category = "unsupported_field"
			field := strings.Trim(err.Error()[len("json: unknown field "):], `"`)
			message = "Unsupported request field: " + field + "."
		} else if typeError := new(json.UnmarshalTypeError); errors.As(err, &typeError) {
			category = "invalid_field_type"
			message = "Request field has an invalid value type: " + typeError.Field + "."
		}
		slog.Default().Warn("request JSON rejected", "error", err, "category", category, "request_id", middleware.GetReqID(r.Context()), "path", r.URL.Path)
		return errors.New(message)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("Request body must contain one JSON object.")
	}
	return nil
}

func (s *server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	s.logger.Error("request failed", "error", err, "request_id", middleware.GetReqID(r.Context()), "path", r.URL.Path)
	writeError(w, http.StatusInternalServerError, "internal_error", "Tilecast could not complete the request.")
}

func isInputError(err error) bool {
	message := err.Error()
	return strings.Contains(message, "must be") || strings.Contains(message, "characters")
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
