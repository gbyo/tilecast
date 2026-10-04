package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestScreenMapPositionOverridePresence(t *testing.T) {
	t.Run("omitted preserves existing position", func(t *testing.T) {
		var request updateScreenRequest
		if err := json.Unmarshal([]byte(`{"name":"Lobby","roomName":"","roomNumber":"","description":""}`), &request); err != nil {
			t.Fatal(err)
		}
		if request.MapPositionOverride.Set {
			t.Fatal("omitted mapPositionOverride must not be marked as set")
		}
	})

	t.Run("null clears existing position", func(t *testing.T) {
		var request updateScreenRequest
		if err := json.Unmarshal([]byte(`{"mapPositionOverride":null}`), &request); err != nil {
			t.Fatal(err)
		}
		if !request.MapPositionOverride.Set {
			t.Fatal("null mapPositionOverride must be marked as set")
		}
		if request.MapPositionOverride.Value != nil {
			t.Fatal("null mapPositionOverride must decode to nil")
		}
	})

	t.Run("coordinates replace existing position", func(t *testing.T) {
		var request updateScreenRequest
		if err := json.Unmarshal([]byte(`{"mapPositionOverride":{"latitude":34.157,"longitude":-82.027}}`), &request); err != nil {
			t.Fatal(err)
		}
		if !request.MapPositionOverride.Set || request.MapPositionOverride.Value == nil {
			t.Fatal("coordinate override must decode as a present value")
		}
		if request.MapPositionOverride.Value.Latitude != 34.157 || request.MapPositionOverride.Value.Longitude != -82.027 {
			t.Fatalf("unexpected coordinates: %#v", request.MapPositionOverride.Value)
		}
	})
}

func TestApprovePairingRejectsMapPositionOverride(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/", strings.NewReader(`{"name":"Lobby","mapPositionOverride":{"latitude":1,"longitude":2}}`))
	var body approvePairingRequest
	if err := decodeJSON(recorder, request, &body); err == nil {
		t.Fatal("approving a pairing must not accept a map position the approval would ignore")
	}
}
