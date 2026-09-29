package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/oauth"
)

// iosHarness drives the Tilecast for iOS bootstrap against a real router
// and database, the way the app does: approve in a browser session, then
// exchange and refresh with no cookies.
type iosHarness struct {
	t       *testing.T
	env     activityTestEnvironment
	router  *httptest.Server
	userID  uuid.UUID
	browser auth.Session
}

type iosResponse struct {
	status  int
	body    map[string]any
	cookies []*http.Cookie
}

func (r iosResponse) data() map[string]any {
	data, _ := r.body["data"].(map[string]any)
	return data
}

func (r iosResponse) credential() map[string]any {
	credential, _ := r.data()["credential"].(map[string]any)
	return credential
}

func (r iosResponse) errorCode() string {
	failure, _ := r.body["error"].(map[string]any)
	code, _ := failure["code"].(string)
	return code
}

func withIOSHarness(t *testing.T, run func(h *iosHarness)) {
	withActivityDatabase(t, func(env activityTestEnvironment) {
		env.server.auth = auth.NewService(env.pool, time.Hour)
		env.server.oauth = oauth.NewService(env.pool)
		env.server.operationsLimiter = newRateLimiter(1000, time.Minute)
		env.server.authLimiter = newRateLimiter(1000, time.Minute)
		env.server.cookieName = "tilecast_session"
		router := httptest.NewServer(env.server.routes())
		defer router.Close()

		hash, err := auth.HashPassword("correct horse battery staple")
		if err != nil {
			t.Fatal(err)
		}
		userID := uuid.New()
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,$2,$3,$4,'owner',TRUE)`,
			userID, "Owner", "ios-owner", hash); err != nil {
			t.Fatal(err)
		}
		login, err := env.server.auth.Login(t.Context(), auth.LoginInput{Username: "ios-owner", Password: "correct horse battery staple"}, auth.MFAPolicyNone)
		if err != nil || login.Session == nil {
			t.Fatalf("login: %v", err)
		}
		run(&iosHarness{t: t, env: env, router: router, userID: userID, browser: *login.Session})
	})
}

func (h *iosHarness) do(method, path string, body any, configure func(*http.Request)) iosResponse {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = strings.NewReader(string(raw))
	}
	request, err := http.NewRequest(method, h.router.URL+path, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	if configure != nil {
		configure(request)
	}
	response, err := h.router.Client().Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	decoded := map[string]any{}
	_ = json.Unmarshal(raw, &decoded)
	return iosResponse{status: response.StatusCode, body: decoded, cookies: response.Cookies()}
}

// withBrowser sends the Studio browser session, its CSRF token, and the
// Origin a browser reports for the approval page.
func (h *iosHarness) withBrowser(origin string) func(*http.Request) {
	return func(request *http.Request) {
		request.AddCookie(&http.Cookie{Name: "tilecast_session", Value: h.browser.Token})
		request.Header.Set("X-CSRF-Token", h.browser.CSRFToken)
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
	}
}

func withBearer(token string) func(*http.Request) {
	return func(request *http.Request) { request.Header.Set("Authorization", "Bearer "+token) }
}

func withCookie(cookie *http.Cookie) func(*http.Request) {
	return func(request *http.Request) { request.AddCookie(cookie) }
}

func pkcePair(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

const iosVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"

// approve records one approval and returns the parsed callback.
func (h *iosHarness) approve(client, redirect, origin string) url.Values {
	h.t.Helper()
	response := h.do(http.MethodPost, "/api/v1/oauth/approve", map[string]string{
		"client": client, "redirectUri": redirect, "scope": "read write admin",
		"state": "ios-state", "challenge": pkcePair(iosVerifier), "method": "S256",
	}, h.withBrowser(origin))
	if response.status != http.StatusOK {
		h.t.Fatalf("approve: %d %v", response.status, response.body)
	}
	redirectURI, _ := response.data()["redirectUri"].(string)
	callback, err := url.Parse(redirectURI)
	if err != nil {
		h.t.Fatal(err)
	}
	return callback.Query()
}

func (h *iosHarness) exchange(code, verifier string) iosResponse {
	h.t.Helper()
	return h.do(http.MethodPost, "/api/v1/oauth/ios-session", map[string]string{
		"grant_type": "authorization_code", "client_id": oauth.ClientIOS,
		"code": code, "redirect_uri": oauth.IOSRedirectURI, "code_verifier": verifier,
	}, nil)
}

func (h *iosHarness) refresh(refreshToken string, studioSession bool) iosResponse {
	h.t.Helper()
	return h.do(http.MethodPost, "/api/v1/oauth/ios-session", map[string]any{
		"grant_type": "refresh_token", "client_id": oauth.ClientIOS,
		"refresh_token": refreshToken, "studio_session": studioSession,
	}, nil)
}

// bootstrap runs one complete successful authorization.
func (h *iosHarness) bootstrap() iosResponse {
	h.t.Helper()
	callback := h.approve(oauth.ClientIOS, oauth.IOSRedirectURI, h.router.URL)
	response := h.exchange(callback.Get("code"), iosVerifier)
	if response.status != http.StatusOK {
		h.t.Fatalf("bootstrap: %d %v", response.status, response.body)
	}
	return response
}

func (h *iosHarness) liveIOSGrants() int {
	h.t.Helper()
	var count int
	if err := h.env.pool.QueryRow(h.t.Context(), `SELECT count(*) FROM api_grants WHERE client_id=$1 AND revoked_at IS NULL`, oauth.ClientIOS).Scan(&count); err != nil {
		h.t.Fatal(err)
	}
	return count
}

func (h *iosHarness) studioAuthenticated(cookie *http.Cookie) bool {
	h.t.Helper()
	response := h.do(http.MethodGet, "/api/v1/auth/status", nil, withCookie(cookie))
	authenticated, _ := response.data()["authenticated"].(bool)
	return authenticated
}

func (h *iosHarness) bearerWorks(accessToken string) bool {
	h.t.Helper()
	return h.do(http.MethodGet, "/api/v1/me/security/grants", nil, withBearer(accessToken)).status == http.StatusOK
}

func sessionCookie(t *testing.T, response iosResponse) *http.Cookie {
	t.Helper()
	if len(response.cookies) != 1 || response.cookies[0].Name != "tilecast_session" || !response.cookies[0].HttpOnly {
		t.Fatalf("session cookie: %+v", response.cookies)
	}
	return response.cookies[0]
}

func tokenString(credential map[string]any, field string) string {
	value, _ := credential[field].(string)
	return value
}

func TestIOSBootstrapCreatesStudioSessionAndNativeCredential(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		callback := h.approve(oauth.ClientIOS, oauth.IOSRedirectURI, h.router.URL)
		if callback.Get("state") != "ios-state" || callback.Get("iss") != h.router.URL {
			t.Fatalf("callback state %q iss %q, want iss %q", callback.Get("state"), callback.Get("iss"), h.router.URL)
		}
		code := callback.Get("code")

		// The general token endpoint stays closed to tilecast-ios codes.
		generic := h.do(http.MethodPost, "/api/v1/oauth/token", map[string]string{
			"grant_type": "authorization_code", "client_id": oauth.ClientIOS,
			"code": code, "redirect_uri": oauth.IOSRedirectURI, "code_verifier": iosVerifier,
		}, nil)
		if generic.status != http.StatusBadRequest {
			t.Fatalf("iOS code at the token endpoint = %d", generic.status)
		}

		response := h.exchange(code, iosVerifier)
		if response.status != http.StatusOK {
			t.Fatalf("bootstrap: %d %v", response.status, response.body)
		}
		cookie := sessionCookie(t, response)
		if response.data()["authenticated"] != true {
			t.Fatalf("authenticated = %v", response.data()["authenticated"])
		}
		credential := response.credential()
		access, refresh := tokenString(credential, "access_token"), tokenString(credential, "refresh_token")
		if !strings.HasPrefix(access, oauth.AccessPrefix) || !strings.HasPrefix(refresh, oauth.RefreshPrefix) ||
			credential["token_type"] != "Bearer" || credential["expires_at"] == nil {
			t.Fatalf("credential: %v", credential)
		}
		if strings.Contains(cookie.Value, access) || strings.Contains(cookie.Value, refresh) {
			t.Fatal("the Studio cookie carries a native credential")
		}
		if h.liveIOSGrants() != 1 {
			t.Fatalf("live iOS grants = %d, want 1", h.liveIOSGrants())
		}
		var linkedSessions int
		if err := h.env.pool.QueryRow(t.Context(), `SELECT count(*) FROM sessions s JOIN api_grants g ON g.id=s.api_grant_id WHERE g.client_id=$1`, oauth.ClientIOS).Scan(&linkedSessions); err != nil || linkedSessions != 1 {
			t.Fatalf("iOS sessions = %d: %v", linkedSessions, err)
		}
		if !h.studioAuthenticated(cookie) {
			t.Fatal("the Studio cookie is not authenticated")
		}
		grants := h.do(http.MethodGet, "/api/v1/me/security/grants", nil, withBearer(access))
		if grants.status != http.StatusOK || !strings.Contains(stringify(grants.body), oauth.ClientIOSDisplayName) {
			t.Fatalf("bearer API call: %d %v", grants.status, grants.body)
		}
		// A native request authenticates with the bearer alone; the Studio
		// cookie is not a substitute for it.
		if h.do(http.MethodGet, "/api/v1/me/security/grants", nil, func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+refresh)
			r.AddCookie(cookie)
		}).status != http.StatusUnauthorized {
			t.Fatal("a refresh token was accepted as a bearer credential")
		}

		if replay := h.exchange(code, iosVerifier); replay.status == http.StatusOK || len(replay.cookies) != 0 {
			t.Fatalf("replayed code: %d %v", replay.status, replay.cookies)
		}
		if h.liveIOSGrants() != 1 {
			t.Fatal("a replayed code changed the grants")
		}
	})
}

func stringify(value any) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

func TestIOSApprovalIssuerFollowsTheApprovalOrigin(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		if iss := h.approve(oauth.ClientIOS, oauth.IOSRedirectURI, "https://studio.example.org").Get("iss"); iss != "https://studio.example.org" {
			t.Fatalf("iss = %q", iss)
		}
		// Without a usable browser Origin there is no issuer to report, and
		// the app accepts a missing iss for servers released before it
		// existed. Refuse the ceremony instead of looking like one.
		for name, origin := range map[string]string{
			"missing Origin": "",
			"opaque origin":  "null",
			"not an origin":  "https://studio.example.org/oauth/approve",
		} {
			approval := h.do(http.MethodPost, "/api/v1/oauth/approve", map[string]string{
				"client": oauth.ClientIOS, "redirectUri": oauth.IOSRedirectURI, "scope": "read write admin",
				"state": "ios-state", "challenge": pkcePair(iosVerifier), "method": "S256",
			}, h.withBrowser(origin))
			if approval.status != http.StatusBadRequest || approval.errorCode() != "invalid_request" {
				t.Fatalf("%s: approve = %d %v", name, approval.status, approval.body)
			}
			denied := h.do(http.MethodPost, "/api/v1/oauth/deny", map[string]string{
				"client": oauth.ClientIOS, "redirectUri": oauth.IOSRedirectURI, "scope": "read",
				"state": "ios-state", "challenge": pkcePair(iosVerifier), "method": "S256",
			}, h.withBrowser(origin))
			if denied.status != http.StatusBadRequest || denied.errorCode() != "invalid_request" {
				t.Fatalf("%s: deny = %d %v", name, denied.status, denied.body)
			}
		}
		if h.liveIOSGrants() != 1 {
			t.Fatalf("live iOS grants = %d, want only the approval with a valid Origin", h.liveIOSGrants())
		}
		denied := h.do(http.MethodPost, "/api/v1/oauth/deny", map[string]string{
			"client": oauth.ClientIOS, "redirectUri": oauth.IOSRedirectURI, "scope": "read",
			"state": "ios-state", "challenge": pkcePair(iosVerifier), "method": "S256",
		}, h.withBrowser(h.router.URL))
		redirect, _ := denied.data()["redirectUri"].(string)
		callback, _ := url.Parse(redirect)
		if callback == nil || callback.Query().Get("error") != "access_denied" || callback.Query().Get("iss") != h.router.URL {
			t.Fatalf("deny redirect = %q", redirect)
		}
	})
}

func TestIOSBootstrapRefusesMismatchedExchanges(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		callback := h.approve(oauth.ClientIOS, oauth.IOSRedirectURI, h.router.URL)
		code := callback.Get("code")
		if response := h.exchange(code, "wrong-verifier-wrong-verifier-wrong-verifier"); response.status != http.StatusBadRequest ||
			response.errorCode() != "invalid_grant" || len(response.cookies) != 0 {
			t.Fatalf("PKCE mismatch: %d %v", response.status, response.body)
		}
		for name, body := range map[string]map[string]string{
			"another redirect": {"grant_type": "authorization_code", "client_id": oauth.ClientIOS, "code": code,
				"redirect_uri": "tilecast-ios://oauth/other", "code_verifier": iosVerifier},
			"another client": {"grant_type": "authorization_code", "client_id": oauth.ClientCLI, "code": code,
				"redirect_uri": oauth.IOSRedirectURI, "code_verifier": iosVerifier},
			"no grant type": {"client_id": oauth.ClientIOS, "code": code,
				"redirect_uri": oauth.IOSRedirectURI, "code_verifier": iosVerifier},
		} {
			if response := h.do(http.MethodPost, "/api/v1/oauth/ios-session", body, nil); response.status != http.StatusBadRequest || len(response.cookies) != 0 {
				t.Fatalf("%s: %d %v", name, response.status, response.body)
			}
		}
		// A code issued to the CLI cannot open an iOS session.
		cli := h.approve(oauth.ClientCLI, "http://127.0.0.1:8471/callback", h.router.URL)
		if response := h.exchange(cli.Get("code"), iosVerifier); response.status != http.StatusBadRequest || len(response.cookies) != 0 {
			t.Fatalf("CLI code: %d %v", response.status, response.body)
		}
		// None of the refusals consumed the iOS code.
		if response := h.exchange(code, iosVerifier); response.status != http.StatusOK {
			t.Fatalf("exchange after refusals: %d %v", response.status, response.body)
		}
	})
}

func TestIOSRefreshRotatesTheNativeCredential(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		first := h.bootstrap()
		cookie := sessionCookie(t, first)
		oldAccess, oldRefresh := tokenString(first.credential(), "access_token"), tokenString(first.credential(), "refresh_token")

		rotated := h.refresh(oldRefresh, false)
		if rotated.status != http.StatusOK || len(rotated.cookies) != 0 || rotated.data()["authenticated"] != false {
			t.Fatalf("refresh: %d %v %v", rotated.status, rotated.body, rotated.cookies)
		}
		access, refresh := tokenString(rotated.credential(), "access_token"), tokenString(rotated.credential(), "refresh_token")
		if access == oldAccess || refresh == oldRefresh || !h.bearerWorks(access) {
			t.Fatal("the refresh did not rotate to a working credential")
		}
		// A plain refresh leaves the running Studio session alone.
		if !h.studioAuthenticated(cookie) {
			t.Fatal("a plain refresh ended the Studio session")
		}

		renewed := h.refresh(refresh, true)
		if renewed.status != http.StatusOK || renewed.data()["authenticated"] != true {
			t.Fatalf("refresh with a Studio session: %d %v", renewed.status, renewed.body)
		}
		newCookie := sessionCookie(t, renewed)
		if !h.studioAuthenticated(newCookie) || h.studioAuthenticated(cookie) {
			t.Fatal("the new Studio session did not replace the grant's old session")
		}

		// Presenting a rotated token again is reuse: the grant is revoked
		// with every credential and session under it.
		reused := h.refresh(oldRefresh, false)
		if reused.status != http.StatusBadRequest || reused.errorCode() != "invalid_grant" {
			t.Fatalf("reuse: %d %v", reused.status, reused.body)
		}
		if h.liveIOSGrants() != 0 || h.bearerWorks(tokenString(renewed.credential(), "access_token")) || h.studioAuthenticated(newCookie) {
			t.Fatal("reuse left part of the grant usable")
		}
		if response := h.refresh(tokenString(renewed.credential(), "refresh_token"), false); response.status != http.StatusBadRequest {
			t.Fatalf("refresh after reuse: %d", response.status)
		}
	})
}

func TestIOSConcurrentRefreshRotatesOnce(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		refresh := tokenString(h.bootstrap().credential(), "refresh_token")
		const callers = 6
		statuses := make([]int, callers)
		var wait sync.WaitGroup
		for index := range callers {
			wait.Add(1)
			go func() {
				defer wait.Done()
				statuses[index] = h.refresh(refresh, false).status
			}()
		}
		wait.Wait()
		succeeded := 0
		for _, status := range statuses {
			if status == http.StatusOK {
				succeeded++
			}
		}
		// The row lock admits one rotation; every other presentation is reuse.
		if succeeded != 1 || h.liveIOSGrants() != 0 {
			t.Fatalf("statuses %v, live grants %d: want one success and a revoked grant", statuses, h.liveIOSGrants())
		}
	})
}

func TestIOSSessionRefusesOtherClientsRefreshTokens(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		redirect := "http://127.0.0.1:8471/callback"
		callback := h.approve(oauth.ClientCLI, redirect, h.router.URL)
		issued := h.do(http.MethodPost, "/api/v1/oauth/token", map[string]string{
			"grant_type": "authorization_code", "client_id": oauth.ClientCLI,
			"code": callback.Get("code"), "redirect_uri": redirect, "code_verifier": iosVerifier,
		}, nil)
		cliRefresh, _ := issued.data()["refresh_token"].(string)
		if issued.status != http.StatusOK || cliRefresh == "" {
			t.Fatalf("CLI exchange: %d %v", issued.status, issued.body)
		}
		for _, studioSession := range []bool{false, true} {
			if response := h.refresh(cliRefresh, studioSession); response.status != http.StatusBadRequest || len(response.cookies) != 0 || response.credential() != nil {
				t.Fatalf("CLI refresh token at the iOS endpoint: %d %v %v", response.status, response.body, response.cookies)
			}
		}
		// Refused before it was consumed: the CLI can still rotate it.
		rotated := h.do(http.MethodPost, "/api/v1/oauth/token", map[string]string{"grant_type": "refresh_token", "refresh_token": cliRefresh}, nil)
		if rotated.status != http.StatusOK {
			t.Fatalf("CLI refresh after refusal: %d %v", rotated.status, rotated.body)
		}

		// The reverse also holds: the general endpoint does not rotate an
		// iOS refresh token, and refusing it consumes nothing.
		iosRefresh := tokenString(h.bootstrap().credential(), "refresh_token")
		if response := h.do(http.MethodPost, "/api/v1/oauth/token", map[string]string{"grant_type": "refresh_token", "refresh_token": iosRefresh}, nil); response.status != http.StatusBadRequest {
			t.Fatalf("iOS refresh token at the token endpoint: %d %v", response.status, response.body)
		}
		if response := h.refresh(iosRefresh, false); response.status != http.StatusOK {
			t.Fatalf("iOS refresh after refusal: %d %v", response.status, response.body)
		}
	})
}

func TestIOSGrantRevocationEndsEveryCredential(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		response := h.bootstrap()
		cookie := sessionCookie(t, response)
		access, refresh := tokenString(response.credential(), "access_token"), tokenString(response.credential(), "refresh_token")
		var grantID uuid.UUID
		if err := h.env.pool.QueryRow(t.Context(), `SELECT id FROM api_grants WHERE client_id=$1`, oauth.ClientIOS).Scan(&grantID); err != nil {
			t.Fatal(err)
		}
		// Account security in another browser revokes Tilecast for iOS.
		if revoked := h.do(http.MethodDelete, "/api/v1/me/security/grants/"+grantID.String(), nil, h.withBrowser("")); revoked.status != http.StatusNoContent {
			t.Fatalf("revoke: %d %v", revoked.status, revoked.body)
		}
		if h.bearerWorks(access) {
			t.Fatal("the access token outlived its grant")
		}
		if again := h.refresh(refresh, true); again.status != http.StatusBadRequest || again.errorCode() != "invalid_grant" || len(again.cookies) != 0 {
			t.Fatalf("refresh after revocation: %d %v", again.status, again.body)
		}
		if h.studioAuthenticated(cookie) {
			t.Fatal("the Studio session outlived its grant")
		}
	})
}

func TestIOSStudioSignOutRevokesTheGrant(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		response := h.bootstrap()
		cookie := sessionCookie(t, response)
		access, refresh := tokenString(response.credential(), "access_token"), tokenString(response.credential(), "refresh_token")
		status := h.do(http.MethodGet, "/api/v1/auth/status", nil, withCookie(cookie))
		csrf, _ := status.data()["csrfToken"].(string)
		loggedOut := h.do(http.MethodPost, "/api/v1/auth/logout", nil, func(r *http.Request) {
			r.AddCookie(cookie)
			r.Header.Set("X-CSRF-Token", csrf)
		})
		if loggedOut.status != http.StatusNoContent && loggedOut.status != http.StatusOK {
			t.Fatalf("logout: %d %v", loggedOut.status, loggedOut.body)
		}
		if h.liveIOSGrants() != 0 || h.bearerWorks(access) {
			t.Fatal("signing out of Studio left the native credential usable")
		}
		if again := h.refresh(refresh, true); again.status != http.StatusBadRequest {
			t.Fatalf("refresh after sign-out: %d", again.status)
		}
		// Other sessions of the same user are unaffected.
		if !h.studioAuthenticated(&http.Cookie{Name: "tilecast_session", Value: h.browser.Token}) {
			t.Fatal("signing out of the app ended an unrelated browser session")
		}
	})
}

func TestIOSBootstrapForAnInactiveAccountLeavesNoGrant(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		callback := h.approve(oauth.ClientIOS, oauth.IOSRedirectURI, h.router.URL)
		if _, err := h.env.pool.Exec(t.Context(), `UPDATE users SET active=FALSE WHERE id=$1`, h.userID); err != nil {
			t.Fatal(err)
		}
		response := h.exchange(callback.Get("code"), iosVerifier)
		if response.status != http.StatusUnauthorized || len(response.cookies) != 0 || response.credential() != nil {
			t.Fatalf("inactive bootstrap: %d %v %v", response.status, response.body, response.cookies)
		}
		var sessions int
		if err := h.env.pool.QueryRow(t.Context(), `SELECT count(*) FROM sessions WHERE api_grant_id IS NOT NULL`).Scan(&sessions); err != nil || sessions != 0 {
			t.Fatalf("iOS sessions = %d: %v", sessions, err)
		}
		if h.liveIOSGrants() != 0 {
			t.Fatal("an inactive account kept a live iOS grant")
		}
	})
}

func TestIOSRefreshForAnInactiveAccountRevokesTheGrant(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		response := h.bootstrap()
		refresh := tokenString(response.credential(), "refresh_token")
		if _, err := h.env.pool.Exec(t.Context(), `UPDATE users SET active=FALSE WHERE id=$1`, h.userID); err != nil {
			t.Fatal(err)
		}
		// A refresh meets the same answer as a bootstrap: the grant is
		// revoked, not rotated into a credential for a dead account.
		renewed := h.refresh(refresh, true)
		if renewed.status != http.StatusUnauthorized || renewed.errorCode() != "authentication_required" ||
			len(renewed.cookies) != 0 || renewed.credential() != nil {
			t.Fatalf("inactive refresh: %d %v %v", renewed.status, renewed.body, renewed.cookies)
		}
		if h.liveIOSGrants() != 0 {
			t.Fatal("an inactive account kept a live iOS grant")
		}
		if again := h.refresh(refresh, false); again.status != http.StatusBadRequest {
			t.Fatalf("refresh after revocation: %d", again.status)
		}
	})
}

func TestIOSGrantEndsWhenTheUserIsSignedOutEverywhere(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		response := h.bootstrap()
		refresh := tokenString(response.credential(), "refresh_token")
		// Password changes, factor resets, and deactivation sign a user out
		// everywhere. An iOS grant could mint a replacement session, so it
		// ends too.
		if err := auth.RevokeUserSessions(t.Context(), h.env.pool, h.userID); err != nil {
			t.Fatal(err)
		}
		if h.liveIOSGrants() != 0 {
			t.Fatal("the iOS grant survived signing the user out everywhere")
		}
		if again := h.refresh(refresh, true); again.status != http.StatusBadRequest || len(again.cookies) != 0 {
			t.Fatalf("refresh after revocation: %d %v", again.status, again.body)
		}
	})
}

func TestIOSGrantWithoutSessionEndsWhenTheUserIsSignedOutEverywhere(t *testing.T) {
	withIOSHarness(t, func(h *iosHarness) {
		response := h.bootstrap()
		refresh := tokenString(response.credential(), "refresh_token")
		// The Studio session is gone, as after expiry cleanup, but the
		// native credential still rotates.
		if _, err := h.env.pool.Exec(t.Context(), `DELETE FROM sessions WHERE api_grant_id IS NOT NULL`); err != nil {
			t.Fatal(err)
		}
		rotated := h.refresh(refresh, false)
		if rotated.status != http.StatusOK {
			t.Fatalf("refresh without a session: %d %v", rotated.status, rotated.body)
		}
		refresh = tokenString(rotated.credential(), "refresh_token")
		// A CLI grant cannot mint a session, so signing out everywhere
		// leaves it alone.
		redirect := "http://127.0.0.1:8471/callback"
		callback := h.approve(oauth.ClientCLI, redirect, h.router.URL)
		issued := h.do(http.MethodPost, "/api/v1/oauth/token", map[string]string{
			"grant_type": "authorization_code", "client_id": oauth.ClientCLI,
			"code": callback.Get("code"), "redirect_uri": redirect, "code_verifier": iosVerifier,
		}, nil)
		cliRefresh, _ := issued.data()["refresh_token"].(string)
		if issued.status != http.StatusOK || cliRefresh == "" {
			t.Fatalf("CLI exchange: %d %v", issued.status, issued.body)
		}

		if err := auth.RevokeUserSessions(t.Context(), h.env.pool, h.userID); err != nil {
			t.Fatal(err)
		}
		if h.liveIOSGrants() != 0 {
			t.Fatal("the session-less iOS grant survived signing the user out everywhere")
		}
		if again := h.refresh(refresh, false); again.status != http.StatusBadRequest || len(again.cookies) != 0 {
			t.Fatalf("iOS refresh after revocation: %d %v", again.status, again.body)
		}
		cliRotated := h.do(http.MethodPost, "/api/v1/oauth/token", map[string]string{"grant_type": "refresh_token", "refresh_token": cliRefresh}, nil)
		if cliRotated.status != http.StatusOK {
			t.Fatalf("CLI refresh after signing out everywhere: %d %v", cliRotated.status, cliRotated.body)
		}
	})
}
