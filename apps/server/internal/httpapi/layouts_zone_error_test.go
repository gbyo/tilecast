package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/layouts"
)

// A playlist zone that points at a playlist with Widgets or Websites used to
// miss writeLayoutError's substring match and surface as a bare 500. It is an
// operator-fixable validation failure and must say which items to fix.
func TestPlaylistZoneRejectionIsAnActionableValidationError(t *testing.T) {
	detail := `Playlist "Morning Announcements" contains items a zone cannot play: Weather (Widget), School Website (Website). Remove them from the Playlist, or place them in the Layout directly.`
	for name, write := range map[string]func(*server, http.ResponseWriter, *http.Request, error){
		"layout":    (*server).writeLayoutError,
		"editorial": (*server).writeEditorialError,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			// Wrapped, as publication and assignment readiness wrap it.
			err := fmt.Errorf("publish: %w", &layouts.PlaylistZoneUnsupportedError{Detail: detail})
			write(&server{}, recorder, httptest.NewRequest(http.MethodPost, "/", nil), err)
			if recorder.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want 422", recorder.Code)
			}
			var body struct {
				Error struct{ Code, Message string }
			}
			if json.Unmarshal(recorder.Body.Bytes(), &body) != nil {
				t.Fatal("response is not the error envelope")
			}
			if body.Error.Code != "layout_playlist_zone_unsupported" {
				t.Fatalf("code = %q", body.Error.Code)
			}
			for _, want := range []string{"support only image and video items", "Weather (Widget)", "School Website (Website)"} {
				if !strings.Contains(body.Error.Message, want) {
					t.Fatalf("message %q should mention %q", body.Error.Message, want)
				}
			}
		})
	}
}
