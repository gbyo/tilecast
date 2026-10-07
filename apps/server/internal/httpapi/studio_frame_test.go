package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func studioRequest(t *testing.T, method, target, packageID, body string) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	route := chi.NewRouteContext()
	route.URLParams.Add("packageId", packageID)
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, route))
	return httptest.NewRecorder(), request
}

func studioErrorCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return body.Error.Code
}

func TestStudioFrameRejectsInvalidIDs(t *testing.T) {
	handler := &server{}
	for _, packageID := range []string{"not-a-package", "tilecast.clock", ""} {
		response, request := studioRequest(t, http.MethodGet, "/frame", packageID, "")
		handler.studioFrame(response, request)
		if response.Code != http.StatusNotFound || studioErrorCode(t, response) != "package_studio_unavailable" {
			t.Fatalf("%q: status = %d, body = %q", packageID, response.Code, response.Body.String())
		}
	}
}

func TestStudioBridgeRejectsBadPayloads(t *testing.T) {
	handler := &server{}
	response, request := studioRequest(t, http.MethodPost, "/bridge", "not-a-package", `{"input":""}`)
	handler.studioBridge(response, request)
	if response.Code != http.StatusNotFound || studioErrorCode(t, response) != "package_studio_unavailable" {
		t.Fatalf("invalid id: status = %d, body = %q", response.Code, response.Body.String())
	}

	response, request = studioRequest(t, http.MethodPost, "/bridge", "acme.athletics", `{"input":"!!!not-base64"}`)
	handler.studioBridge(response, request)
	if response.Code != http.StatusBadRequest || studioErrorCode(t, response) != "invalid_bridge_input" {
		t.Fatalf("bad base64: status = %d, body = %q", response.Code, response.Body.String())
	}

	big := base64.StdEncoding.EncodeToString(make([]byte, 17<<10))
	response, request = studioRequest(t, http.MethodPost, "/bridge", "acme.athletics", `{"input":"`+big+`"}`)
	handler.studioBridge(response, request)
	if response.Code != http.StatusBadRequest || studioErrorCode(t, response) != "invalid_bridge_input" {
		t.Fatalf("oversize: status = %d", response.Code)
	}
}

func TestPackageJobsRejectsInvalidIDs(t *testing.T) {
	handler := &server{}
	for _, packageID := range []string{"not-a-package", "tilecast.clock", ""} {
		response, request := studioRequest(t, http.MethodGet, "/jobs", packageID, "")
		handler.packageJobs(response, request)
		if response.Code != http.StatusNotFound || studioErrorCode(t, response) != "package_not_installed" {
			t.Fatalf("%q: status = %d, body = %q", packageID, response.Code, response.Body.String())
		}
	}
}

func TestStudioFramePolicySandboxes(t *testing.T) {
	if !strings.Contains(studioFramePolicy, "sandbox allow-scripts") {
		t.Fatalf("policy %q must sandbox", studioFramePolicy)
	}
	for _, forbidden := range []string{"allow-same-origin", "connect-src 'self'", "worker-src 'self'"} {
		if strings.Contains(studioFramePolicy, forbidden) {
			t.Fatalf("policy %q must not contain %q", studioFramePolicy, forbidden)
		}
	}
}
