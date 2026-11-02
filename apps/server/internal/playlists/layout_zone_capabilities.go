package playlists

import (
	"context"
	"github.com/google/uuid"
)

const layoutPlaylistWidgetsCapability = "layout.playlist_widgets"

// layoutPlaylistWidgets follows the same published graph as manifest assembly.
// Keeping this separate from Widget type negotiation prevents a legacy Player
// that renders a fullscreen Widget from accepting a timed Layout occurrence.
func layoutPlaylistWidgets(ctx context.Context, q presentationQuery, playlistIDs, layoutIDs []uuid.UUID) (map[uuid.UUID]bool, error) {
	rows, err := q.Query(ctx, `WITH RECURSIVE refs(kind,id) AS (
  SELECT 'playlist',unnest($1::uuid[])
  UNION SELECT 'layout',unnest($2::uuid[])
  UNION SELECT next.kind,next.id FROM refs ref CROSS JOIN LATERAL (
   SELECT 'layout'::text AS kind,i.layout_id AS id FROM playlist_items i
   WHERE ref.kind='playlist' AND i.playlist_id=ref.id AND i.layout_id IS NOT NULL
   UNION SELECT 'playlist'::text,d.dependency_id FROM layouts l
   JOIN layout_revision_dependencies d ON d.revision_id=l.published_revision_id AND d.dependency_type='playlist'
   WHERE ref.kind='layout' AND l.id=ref.id AND l.deleted_at IS NULL
  ) next
 ) SELECT DISTINCT w.asset_id FROM refs r JOIN layouts l ON r.kind='layout' AND l.id=r.id
 JOIN layout_revision_dependencies d ON d.revision_id=l.published_revision_id AND d.dependency_type='playlist'
 JOIN playlist_items i ON i.playlist_id=d.dependency_id JOIN widgets w ON w.asset_id=i.asset_id`, playlistIDs, layoutIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[uuid.UUID]bool{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result[id] = true
	}
	return result, rows.Err()
}

func requireLayoutPlaylistWidgets(presentation *WidgetPresentation) {
	if presentation == nil {
		return
	}
	if presentation.RequiredCapabilities == nil {
		presentation.RequiredCapabilities = map[string]int{}
	}
	presentation.RequiredCapabilities[layoutPlaylistWidgetsCapability] = 1
}

func rootIDs(id *uuid.UUID) []uuid.UUID {
	if id == nil {
		return []uuid.UUID{}
	}
	return []uuid.UUID{*id}
}
