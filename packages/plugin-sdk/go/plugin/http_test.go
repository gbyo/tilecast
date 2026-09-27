package plugin

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeJSONContract(t *testing.T) {
	type input struct {
		Name string `json:"name"`
	}
	cases := map[string]string{
		`{"name":"a"}`:            "",
		``:                        "Request body is missing.",
		`{"name":"a","extra":1}`:  "Unsupported request field: extra.",
		`{"name":1}`:              "Request field has an invalid value type: name.",
		`{"name":"a"} {"name":2}`: "Request body must contain one JSON object.",
		`{`:                       "Request body contains malformed JSON.",
	}
	for body, want := range cases {
		request := httptest.NewRequest("POST", "/", strings.NewReader(body))
		var target input
		err := DecodeJSON(httptest.NewRecorder(), request, &target)
		if want == "" {
			if err != nil {
				t.Fatalf("%q: %v", body, err)
			}
			continue
		}
		var apiError *APIError
		if !errors.As(err, &apiError) || apiError.Code != "invalid_request" || apiError.Message != want {
			t.Fatalf("%q: got %v, want %q", body, err, want)
		}
	}
}

func TestPathUUIDMalformedIsNotFound(t *testing.T) {
	request := httptest.NewRequest("GET", "/x/not-a-uuid", nil)
	request.SetPathValue("id", "not-a-uuid")
	var apiError *APIError
	if _, err := PathUUID(request, "id"); !errors.As(err, &apiError) || apiError.Status != 404 {
		t.Fatalf("got %v", err)
	}
}
