package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/media"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
)

// A plugin that is not installed is a conflict the author can resolve,
// never a server fault, whichever path refuses the content.
func TestPluginUnavailableIsAConflict(t *testing.T) {
	s := &server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	decode := func(t *testing.T, rec *httptest.ResponseRecorder) string {
		t.Helper()
		var body struct {
			Error struct{ Code string } `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("body %q: %v", rec.Body.String(), err)
		}
		return body.Error.Code
	}
	for _, kind := range []string{"widget provider", "data source provider"} {
		rec := httptest.NewRecorder()
		err := fmt.Errorf("create: %w", &media.PluginUnavailableError{Kind: kind, Provider: "acme_board", PluginID: "acme"})
		s.writeMediaError(rec, httptest.NewRequest(http.MethodPost, "/api/v1/widgets", nil), err)
		if rec.Code != http.StatusConflict || decode(t, rec) != "plugin_not_installed" {
			t.Fatalf("%s: status %d body %s", kind, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	err := fmt.Errorf("%w: Widget %q uses provider %q from plugin %q, which is not installed", playlists.ErrConflict, "Board", "acme_board", "Acme")
	s.writePlaylistError(rec, httptest.NewRequest(http.MethodPut, "/api/v1/screens/x/assignment", nil), err)
	if rec.Code != http.StatusConflict || decode(t, rec) != "playlist_conflict" {
		t.Fatalf("assignment: status %d body %s", rec.Code, rec.Body.String())
	}
}
