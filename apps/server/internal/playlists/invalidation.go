package playlists

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// bumpResourcesInTx is the one manifest dependency traversal. It walks both
// directions because a mutation may be made at either end of a presentation
// graph: a playlist edit needs to reach nested layouts, while an asset/data
// source edit needs to walk back through widgets, layouts, playlists, and
// assignments. UNION (rather than UNION ALL) makes cycles in nested content
// finite and deterministic.
func bumpResourcesInTx(ctx context.Context, tx pgx.Tx, kind string, id uuid.UUID, reason string) ([]notification, error) {
	rows, err := tx.Query(ctx, `
WITH RECURSIVE refs(kind,id) AS (
	SELECT $1::text,$2::uuid
	UNION
	-- PostgreSQL permits one recursive reference in the recursive term. Keep
	-- every graph edge in this lateral branch so the traversal remains one
	-- authoritative, cycle-safe CTE rather than a set of partially recursive
	-- CTEs that only works on some PostgreSQL versions.
	SELECT next.kind,next.id
	FROM refs r
	CROSS JOIN LATERAL (
		-- Playlist contents and tag-driven playlist membership.
		SELECT 'layout'::text,i.layout_id AS id
		FROM playlist_items i
		WHERE r.kind='playlist' AND i.playlist_id=r.id AND i.layout_id IS NOT NULL
		UNION
		SELECT 'asset'::text,i.asset_id
		FROM playlist_items i
		WHERE r.kind='playlist' AND i.playlist_id=r.id AND i.asset_id IS NOT NULL
		UNION
		SELECT 'playlist'::text,pt.playlist_id
		FROM playlist_tags pt
		WHERE r.kind='tag' AND pt.tag_id=r.id
		UNION
		SELECT 'playlist'::text,pt.playlist_id
		FROM playlist_tags pt JOIN content_asset_tags at ON at.tag_id=pt.tag_id
		WHERE r.kind='asset' AND at.asset_id=r.id
		UNION
		-- Published and draft layout dependencies.
		SELECT d.dependency_type,d.dependency_id
		FROM layout_revision_dependencies d
		JOIN layout_revisions rev ON rev.id=d.revision_id
		JOIN layouts l ON l.published_revision_id=rev.id AND l.deleted_at IS NULL
		WHERE r.kind='layout' AND l.id=r.id
		  AND d.dependency_type IN ('asset','widget','playlist','data_source')
		UNION
		SELECT 'playlist'::text,i.playlist_id
		FROM playlist_items i
		WHERE r.kind='asset' AND i.asset_id=r.id
		UNION
		SELECT 'playlist'::text,i.playlist_id
		FROM playlist_items i
		WHERE r.kind='layout' AND i.layout_id=r.id
		UNION
		SELECT 'playlist'::text,i.playlist_id
		FROM playlist_items i
		WHERE r.kind='widget' AND i.asset_id=r.id
		UNION
		SELECT 'layout'::text,l.id
		FROM layout_revision_dependencies d
		JOIN layout_revisions rev ON rev.id=d.revision_id
		JOIN layouts l ON l.published_revision_id=rev.id AND l.deleted_at IS NULL
		WHERE r.kind=d.dependency_type AND r.id=d.dependency_id
		  AND d.dependency_type IN ('asset','widget','data_source','playlist')
		UNION
		SELECT 'layout'::text,l.id
		FROM layout_draft_dependencies d JOIN layouts l ON l.id=d.layout_id AND l.deleted_at IS NULL
		WHERE r.kind=d.dependency_type AND r.id=d.dependency_id
		  AND d.dependency_type IN ('asset','widget','data_source','playlist')
		UNION
		-- Widgets may contain one or more source selectors and website fallback
		-- assets. UUID values are matched as JSON strings, never as names.
		SELECT 'data_source'::text,d.id
		FROM data_sources d JOIN widgets w ON w.asset_id=r.id
		WHERE r.kind='widget'
		  AND jsonb_path_exists(w.configuration,'$.** ? (@ == $id)',jsonb_build_object('id',d.id::text))
		UNION
		SELECT 'widget'::text,w.asset_id
		FROM widgets w
		WHERE r.kind='data_source'
		  AND jsonb_path_exists(w.configuration,'$.** ? (@ == $id)',jsonb_build_object('id',r.id::text))
		UNION
		SELECT 'widget'::text,w.asset_id
		FROM widgets w
		WHERE r.kind='asset' AND w.configuration::text LIKE '%"' || r.id::text || '"%'
		UNION
		SELECT 'widget'::text,wa.asset_id
		FROM website_assets wa
		WHERE r.kind='asset' AND wa.fallback_image_asset_id=r.id
	) AS next(kind,id)
), affected(screen_id) AS (
	SELECT a.screen_id
	FROM screen_playlist_assignments a JOIN refs r ON (r.kind='playlist' AND r.id=a.playlist_id) OR (r.kind='layout' AND r.id=a.layout_id)
	UNION
	SELECT m.screen_id
	FROM screen_group_playlist_assignments a
	JOIN screen_group_memberships m ON m.screen_group_id=a.screen_group_id
	JOIN refs r ON (r.kind='playlist' AND r.id=a.playlist_id) OR (r.kind='layout' AND r.id=a.layout_id)
	UNION
	SELECT t.screen_id
	FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id AND t.screen_id IS NOT NULL
	JOIN refs r ON (r.kind='playlist' AND r.id=s.playlist_id) OR (r.kind='layout' AND r.id=s.layout_id)
	WHERE s.deleted_at IS NULL
	UNION
	SELECT m.screen_id
	FROM schedules s JOIN schedule_targets t ON t.schedule_id=s.id AND t.screen_group_id IS NOT NULL
	JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id
	JOIN refs r ON (r.kind='playlist' AND r.id=s.playlist_id) OR (r.kind='layout' AND r.id=s.layout_id)
	WHERE s.deleted_at IS NULL
	UNION
	SELECT t.screen_id
	FROM takeovers e JOIN takeover_targets t ON t.takeover_id=e.id AND t.screen_id IS NOT NULL
	JOIN refs r ON r.kind='playlist' AND r.id=e.playlist_id
	WHERE e.status IN ('draft','active','cancelling')
	UNION
	SELECT m.screen_id
	FROM takeovers e JOIN takeover_targets t ON t.takeover_id=e.id AND t.screen_group_id IS NOT NULL
	JOIN screen_group_memberships m ON m.screen_group_id=t.screen_group_id
	JOIN refs r ON r.kind='playlist' AND r.id=e.playlist_id
	WHERE e.status IN ('draft','active','cancelling')
	UNION
	SELECT CASE WHEN o.target_type='screen' THEN o.target_id ELSE m.screen_id END
	FROM presentation_overrides o
	LEFT JOIN screen_group_memberships m ON o.target_type='group' AND m.screen_group_id=o.target_id
	JOIN refs r ON r.kind=o.content_type AND r.id=o.content_id
	WHERE o.stopped_at IS NULL AND (o.expires_at IS NULL OR o.expires_at>now())
	UNION
	-- Plugin configuration is a manifest dependency even when it does not
	-- reference playlist content. The central path deliberately fans out to
	-- every active screen: plugin implementations own targeting rules, while
	-- this transaction owns the invalidation/version guarantee.
	SELECT s.id
	FROM screens s
	JOIN refs r ON r.kind='plugin'
	WHERE s.archived_at IS NULL
	UNION
	-- Organization branding and website default fallbacks are projected into
	-- every screen's player configuration. An asset mutation therefore has to
	-- invalidate the configuration/manifest view even when no playlist names it.
	SELECT s.id
	FROM screens s
	JOIN organization_runtime_settings o ON o.organization_id=s.organization_id
	JOIN refs r ON r.kind='asset'
	WHERE s.archived_at IS NULL
	  AND (o.settings->>'branding.logo_asset_id'=r.id::text
	       OR o.settings->>'branding.icon_asset_id'=r.id::text
	       OR o.settings->>'website.default_fallback_image_id'=r.id::text)
)
INSERT INTO screen_manifest_state(screen_id,manifest_version,previous_manifest_version,changed_at,change_reason)
SELECT DISTINCT screen_id,1,NULL::bigint,now(),$3 FROM affected
ON CONFLICT(screen_id) DO UPDATE SET
 previous_manifest_version=screen_manifest_state.manifest_version,
 manifest_version=screen_manifest_state.manifest_version+1,
 changed_at=now(),change_reason=$3
RETURNING screen_id,manifest_version`, kind, id, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notices := []notification{}
	for rows.Next() {
		var item notification
		if err := rows.Scan(&item.screen, &item.version); err != nil {
			return nil, err
		}
		notices = append(notices, item)
	}
	return notices, rows.Err()
}

func bumpScreensInTx(ctx context.Context, tx pgx.Tx, screenIDs []uuid.UUID, reason string) ([]notification, error) {
	if len(screenIDs) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
		INSERT INTO screen_manifest_state(screen_id,manifest_version,previous_manifest_version,changed_at,change_reason)
		SELECT DISTINCT unnest($1::uuid[]),1,NULL::bigint,now(),$2
		ON CONFLICT(screen_id) DO UPDATE SET
			previous_manifest_version=screen_manifest_state.manifest_version,
			manifest_version=screen_manifest_state.manifest_version+1,
			changed_at=now(),change_reason=$2
		RETURNING screen_id,manifest_version`, screenIDs, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	changes := []notification{}
	for rows.Next() {
		var change notification
		if err := rows.Scan(&change.screen, &change.version); err != nil {
			return nil, err
		}
		changes = append(changes, change)
	}
	return changes, rows.Err()
}
