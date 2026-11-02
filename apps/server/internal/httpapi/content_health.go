package httpapi

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/contenthealth"
)

// contentHealth reports content that is degrading quietly: a Data Source
// serving stale cache, a playlist with nothing available, media about to
// expire, and screens with nothing assigned.
//
// The first two are also incidents, so they reach notifications. The last two
// are not faults and never open one.
func (s *server) contentHealth(w http.ResponseWriter, r *http.Request) {
	report, err := s.contentHealthService.Report(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// The report spans the installation. Each section is shown only to a
	// role that may read that kind of resource, and expiring media only when
	// it is within the caller's content access.
	principal, _ := principalOf(r)
	if !principal.Can(auth.CapDataSourceRead) {
		report.StaleSources = []contenthealth.StaleSource{}
	}
	if !principal.Can(auth.CapPlaylistRead) {
		report.EmptyPlaylists = []contenthealth.EmptyPlaylist{}
	}
	if !principal.Can(auth.CapScreenRead) {
		report.UnassignedScreens = []contenthealth.UnassignedScreen{}
	}
	if !principal.Can(auth.CapMediaRead) {
		report.ExpiringAssets = []contenthealth.ExpiringAsset{}
	} else if access, err := s.contentAccess(r); err != nil {
		s.internalError(w, r, err)
		return
	} else if !access.LibraryAll {
		visible := []contenthealth.ExpiringAsset{}
		for _, asset := range report.ExpiringAssets {
			if _, err := s.media.AuthorizeAssets(r.Context(), access, []uuid.UUID{asset.ID}, true); err == nil {
				visible = append(visible, asset)
			}
		}
		report.ExpiringAssets = visible
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": report})
}
