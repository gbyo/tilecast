package httpapi

import (
	"encoding/json"
	"testing"
)

func TestScreenMapPositionOverridePresence(t *testing.T) {
	t.Run("omitted preserves existing position", func(t *testing.T) {
		var request approvePairingRequest
		if err := json.Unmarshal([]byte(`{"name":"Lobby","roomName":"","roomNumber":"","description":""}`), &request); err != nil {
			t.Fatal(err)
		}
		if request.MapPositionOverride.Set {
			t.Fatal("omitted mapPositionOverride must not be marked as set")
		}
	})

	t.Run("null clears existing position", func(t *testing.T) {
		var request approvePairingRequest
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
		var request approvePairingRequest
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
