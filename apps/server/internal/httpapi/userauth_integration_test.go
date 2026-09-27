package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/oauth"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

type userAuthCall struct {
	t       *testing.T
	base    string
	session *auth.Session
}

func (c userAuthCall) do(method, path, bearer, body string, csrf bool) (int, map[string]any) {
	c.t.Helper()
	request, _ := http.NewRequest(method, c.base+path, strings.NewReader(body))
	if bearer == "-" {
		// Anonymous call: neither cookie nor bearer.
	} else if bearer != "" {
		// Pure bearer call: no session cookie, so the grant path is
		// exercised instead of the cookie-first session path.
		request.Header.Set("Authorization", "Bearer "+bearer)
	} else if c.session != nil {
		request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: c.session.Token})
		if csrf {
			request.Header.Set("X-CSRF-Token", c.session.CSRFToken)
		}
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		c.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	decoded := map[string]any{}
	_ = json.Unmarshal(raw, &decoded)
	return response.StatusCode, decoded
}

func withUserAuthServer(t *testing.T, run func(call userAuthCall, service *oauth.Service, userID uuid.UUID, pool *pgxpool.Pool)) {
	t.Helper()
	withActivityDatabase(t, func(env activityTestEnvironment) {
		ctx := t.Context()
		authService := auth.NewService(env.pool, time.Hour)
		oauthService := oauth.NewService(env.pool)
		env.server.auth = authService
		env.server.oauth = oauthService
		env.server.settings = settings.NewService(env.pool, nil, settings.HardLimits{})
		env.server.operationsLimiter = newRateLimiter(60, time.Minute)
		env.server.authLimiter = newRateLimiter(10, 10*time.Minute)
		env.server.cookieName = "tilecast_session"
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		hash, err := auth.HashPassword("correct horse battery staple")
		if err != nil {
			t.Fatal(err)
		}
		userID := uuid.New()
		if _, err = env.pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,'owner',TRUE)`,
			userID, "Owner", "userauth-owner", hash); err != nil {
			t.Fatal(err)
		}
		result, err := authService.Login(ctx, auth.LoginInput{Username: "userauth-owner", Password: "correct horse battery staple"}, auth.MFAPolicyNone)
		if err != nil || result.Session == nil {
			t.Fatalf("login: %v", err)
		}
		session := *result.Session
		run(userAuthCall{t: t, base: router.URL, session: &session}, oauthService, userID, env.pool)
	})
}

func mustPAT(t *testing.T, service *oauth.Service, userID uuid.UUID, name string, scopes []string) string {
	t.Helper()
	secret, _, err := service.CreatePAT(t.Context(), userID, name, scopes, 30)
	if err != nil {
		t.Fatal(err)
	}
	return secret
}

func mustOAuthToken(t *testing.T, service *oauth.Service, userID uuid.UUID, scopes string) string {
	t.Helper()
	ctx := t.Context()
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	req, err := service.ValidateAuthorize(ctx, oauth.ClientCLI, "http://127.0.0.1:8471/callback", scopes, "userauth", challenge, "S256")
	if err != nil {
		t.Fatal(err)
	}
	code, err := service.Approve(ctx, userID, req)
	if err != nil {
		t.Fatal(err)
	}
	tokens, _, err := service.Exchange(ctx, oauth.ClientCLI, code, "http://127.0.0.1:8471/callback", verifier)
	if err != nil {
		t.Fatal(err)
	}
	return tokens.AccessToken
}

func errorCode(body map[string]any) string {
	envelope, _ := body["error"].(map[string]any)
	code, _ := envelope["code"].(string)
	return code
}

// A bearer user grant reaches the same management reads as the session
// that created it, without manufacturing a CSRF token.
func TestRequireUserBearerReads(t *testing.T) {
	withUserAuthServer(t, func(call userAuthCall, service *oauth.Service, userID uuid.UUID, pool *pgxpool.Pool) {
		readPAT := mustPAT(t, service, userID, "userauth-read", []string{"read"})
		access := mustOAuthToken(t, service, userID, "read")

		if status, _ := call.do(http.MethodGet, "/api/v1/me/security/grants", "", "", false); status != http.StatusOK {
			t.Fatalf("session grants = %d", status)
		}
		for name, secret := range map[string]string{"pat": readPAT, "oauth": access} {
			if status, _ := call.do(http.MethodGet, "/api/v1/me/preferences", secret, "", false); status != http.StatusOK {
				t.Fatalf("%s bearer read = %d", name, status)
			}
		}
		// Grants management is an admin operation: a read grant names its
		// ceiling honestly instead of being waved through.
		if status, body := call.do(http.MethodGet, "/api/v1/me/security/grants", readPAT, "", false); status != http.StatusForbidden || errorCode(body) != "insufficient_scope" {
			t.Fatalf("read grant on admin route = %d %v", status, body)
		}
	})
}

// Unsafe bearer requests skip CSRF; unsafe session requests still need it,
// and a read grant cannot write.
func TestRequireUserUnsafeMatrix(t *testing.T) {
	withUserAuthServer(t, func(call userAuthCall, service *oauth.Service, userID uuid.UUID, pool *pgxpool.Pool) {
		readPAT := mustPAT(t, service, userID, "userauth-r", []string{"read"})
		writePAT := mustPAT(t, service, userID, "userauth-w", []string{"read", "write"})

		_, prefs := call.do(http.MethodGet, "/api/v1/me/preferences", writePAT, "", false)
		revision := prefs["data"].(map[string]any)["revision"]
		update, _ := json.Marshal(map[string]any{"revision": revision, "values": map[string]any{}})

		if status, body := call.do(http.MethodPatch, "/api/v1/me/preferences", "", string(update), false); status != http.StatusForbidden || errorCode(body) != "csrf_failed" {
			t.Fatalf("session write without CSRF = %d %v", status, body)
		}
		if status, body := call.do(http.MethodPatch, "/api/v1/me/preferences", readPAT, string(update), false); status != http.StatusForbidden || errorCode(body) != "insufficient_scope" {
			t.Fatalf("read grant write = %d %v", status, body)
		}
		if status, _ := call.do(http.MethodPatch, "/api/v1/me/preferences", writePAT, string(update), false); status != http.StatusOK {
			t.Fatalf("write grant without CSRF = %d", status)
		}
	})
}

// Admin routes need the admin scope on top of the role: an owner holding
// only a write grant cannot manage users, and an admin grant can.
func TestRequireUserAdminCeiling(t *testing.T) {
	withUserAuthServer(t, func(call userAuthCall, service *oauth.Service, userID uuid.UUID, pool *pgxpool.Pool) {
		writePAT := mustPAT(t, service, userID, "userauth-w2", []string{"read", "write"})
		adminPAT := mustPAT(t, service, userID, "userauth-a", []string{"read", "write", "admin"})

		if status, body := call.do(http.MethodGet, "/api/v1/users", writePAT, "", false); status != http.StatusForbidden || errorCode(body) != "insufficient_scope" {
			t.Fatalf("write grant user list = %d %v", status, body)
		}
		if status, _ := call.do(http.MethodGet, "/api/v1/users", adminPAT, "", false); status != http.StatusOK {
			t.Fatalf("admin grant user list = %d", status)
		}
	})
}

// Anything that is not a user token fails closed: device credentials,
// integration tokens, refresh secrets, and garbage never authenticate as
// the user, and inert grants behave like unknown ones.
func TestRequireUserRejectsForeignCredentials(t *testing.T) {
	withUserAuthServer(t, func(call userAuthCall, service *oauth.Service, userID uuid.UUID, pool *pgxpool.Pool) {
		for name, secret := range map[string]string{
			"device":      "tc_device_01J0000000000000000000000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"integration": "tci_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"refresh":     "tcr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"garbage":     "not-a-credential",
		} {
			if status, body := call.do(http.MethodGet, "/api/v1/me/preferences", secret, "", false); status != http.StatusUnauthorized || errorCode(body) != "authentication_required" {
				t.Fatalf("%s credential = %d %v", name, status, body)
			}
		}
		if status, _ := call.do(http.MethodGet, "/api/v1/me/preferences", "-", "", false); status != http.StatusUnauthorized {
			t.Fatalf("anonymous = %d", status)
		}

		revoked := mustPAT(t, service, userID, "userauth-rev", []string{"read"})
		pats, err := service.ListPATs(t.Context(), userID, "userauth-rev")
		if err != nil || len(pats) != 1 {
			t.Fatalf("revocation target missing: %+v %v", pats, err)
		}
		if err := service.RevokeGrant(t.Context(), userID, pats[0].ID); err != nil {
			t.Fatal(err)
		}
		if status, _ := call.do(http.MethodGet, "/api/v1/me/preferences", revoked, "", false); status != http.StatusUnauthorized {
			t.Fatalf("revoked grant = %d", status)
		}
	})
}

// Browser security ceremonies stay session-only: a bearer grant, however
// privileged, cannot enroll factors, approve OAuth grants, or end the
// session.
func TestRequireUserCeremoniesStaySessionOnly(t *testing.T) {
	withUserAuthServer(t, func(call userAuthCall, service *oauth.Service, userID uuid.UUID, pool *pgxpool.Pool) {
		adminPAT := mustPAT(t, service, userID, "userauth-c", []string{"read", "write", "admin"})

		if status, _ := call.do(http.MethodPost, "/api/v1/me/security/totp", adminPAT, "{}", false); status != http.StatusUnauthorized {
			t.Fatalf("bearer TOTP enroll = %d", status)
		}
		if status, _ := call.do(http.MethodPost, "/api/v1/auth/logout", adminPAT, "", false); status != http.StatusUnauthorized {
			t.Fatalf("bearer logout = %d", status)
		}
		if status, _ := call.do(http.MethodPost, "/api/v1/oauth/approve", adminPAT, "{}", false); status != http.StatusUnauthorized {
			t.Fatalf("bearer OAuth approve = %d", status)
		}
	})
}

// A bearer grant cannot walk around MFA enrollment: a user the policy
// covers but who has no factor is gated exactly like an enrolled session.
func TestRequireUserBearerEnrollmentGate(t *testing.T) {
	withUserAuthServer(t, func(call userAuthCall, service *oauth.Service, userID uuid.UUID, pool *pgxpool.Pool) {
		ctx := t.Context()
		settingsService := settings.NewService(pool, nil, settings.HardLimits{})
		if _, err := settingsService.Organization(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE organization_runtime_settings SET settings='{"security.mfa_required_scope":"all"}'`); err != nil {
			t.Fatal(err)
		}
		adminPAT := mustPAT(t, service, userID, "userauth-enroll", []string{"read", "write", "admin"})
		if status, body := call.do(http.MethodGet, "/api/v1/me/preferences", adminPAT, "", false); status != http.StatusForbidden || errorCode(body) != "mfa_enrollment_required" {
			t.Fatalf("unenrolled bearer = %d %v", status, body)
		}
	})
}

// Bearer grants answer the public auth status with their user identity,
// which is what `tilecast whoami` reads. No session and no CSRF token is
// ever reported for a grant.
func TestAuthStatusAnswersBearerWhoami(t *testing.T) {
	withUserAuthServer(t, func(call userAuthCall, service *oauth.Service, userID uuid.UUID, pool *pgxpool.Pool) {
		readPAT := mustPAT(t, service, userID, "userauth-whoami", []string{"read"})
		status, body := call.do(http.MethodGet, "/api/v1/auth/status", readPAT, "", false)
		if status != http.StatusOK {
			t.Fatalf("bearer auth status = %d", status)
		}
		data := body["data"].(map[string]any)
		if data["authenticated"] != true {
			t.Fatalf("bearer auth status = %v", data)
		}
		user := data["user"].(map[string]any)
		if user["username"] != "userauth-owner" || user["role"] != "owner" {
			t.Fatalf("bearer user = %v", user)
		}
		if data["authMethod"] != "pat" {
			t.Fatalf("bearer auth method = %v", data["authMethod"])
		}
		if _, ok := data["csrfToken"]; ok {
			t.Fatalf("bearer status leaks a CSRF token: %v", data)
		}
		if status, body := call.do(http.MethodGet, "/api/v1/auth/status", "-", "", false); status != http.StatusOK || body["data"].(map[string]any)["authenticated"] != false {
			t.Fatalf("anonymous auth status = %d %v", status, body)
		}
	})
}
