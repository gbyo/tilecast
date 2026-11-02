package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

func TestUpdateCompatibilityEvaluation(t *testing.T) {
	sdk := 30
	oldSDK := 23
	current := int64(42)
	release := deploymentRelease{family: "edge", architecture: "x86_64", versionCode: 42}
	for _, test := range []struct {
		name          string
		release       deploymentRelease
		target        resolvedUpdateTarget
		state, reason string
	}{
		{"eligible", release, resolvedUpdateTarget{Family: "edge", Architecture: "x86_64", RecentlyContacted: true}, "pending", ""},
		{"offline queued", release, resolvedUpdateTarget{Family: "edge", Architecture: "x86_64"}, "offline", ""},
		{"wrong architecture", release, resolvedUpdateTarget{Family: "edge", Architecture: "aarch64"}, "incompatible", "requires x86_64 architecture, but this screen reports aarch64"},
		{"missing architecture", release, resolvedUpdateTarget{Family: "edge"}, "incompatible", "unknown architecture"},
		{"wrong family", release, resolvedUpdateTarget{Family: "electron-linux", Architecture: "x86_64", Current: &current}, "incompatible", "runs Linux"},
		{"already current precedence", release, resolvedUpdateTarget{Family: "edge", Architecture: "aarch64", Current: &current}, "already_current", ""},
		{"SDK", deploymentRelease{family: "android", versionCode: 42, minimumSDK: &sdk}, resolvedUpdateTarget{Family: "android", sdk: &oldSDK}, "incompatible", "requires Android SDK 30"},
		{"unknown SDK preserves player verification", deploymentRelease{family: "android", versionCode: 42, minimumSDK: &sdk}, resolvedUpdateTarget{Family: "android", RecentlyContacted: true}, "pending", ""},
		{"Windows", deploymentRelease{family: "windows", architecture: "aarch64", versionCode: 42}, resolvedUpdateTarget{Family: "windows", Architecture: "x86_64"}, "incompatible", "requires aarch64 architecture"},
	} {
		t.Run(test.name, func(t *testing.T) {
			target := test.target
			evaluateUpdateTarget(test.release, &target)
			if target.state != test.state {
				t.Fatalf("state=%s want %s", target.state, test.state)
			}
			if test.reason == "" {
				if target.Reason != nil {
					t.Fatalf("unexpected reason %q", *target.Reason)
				}
			} else if target.Reason == nil || !strings.Contains(*target.Reason, test.reason) {
				t.Fatalf("reason=%v want %q", target.Reason, test.reason)
			}
		})
	}
}

func TestUpdatePreviewRoles(t *testing.T) {
	s := &server{}
	for _, role := range []string{"owner", "administrator", "editor", "viewer"} {
		t.Run(role, func(t *testing.T) {
			request := requestWithTestPrincipal(httptest.NewRequest(http.MethodPost, "/api/v1/update-deployments/preview", nil), auth.Session{User: auth.User{Role: role}})
			response := httptest.NewRecorder()
			s.requireCapability(auth.CapScreenManage)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })).ServeHTTP(response, request)
			want := http.StatusForbidden
			if role == "owner" || role == "administrator" {
				want = http.StatusNoContent
			}
			if response.Code != want {
				t.Fatalf("status=%d want %d", response.Code, want)
			}
		})
	}
}
