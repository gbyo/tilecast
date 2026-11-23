// Package contenthealth turns quiet content degradation into a named
// condition.
//
// The failure this exists for is not a black screen. It is a board that still
// looks fine while showing last week's lunch menu, because the calendar feed
// stopped refreshing and the Player is serving cache exactly as designed. The
// evidence was already in the database; nothing read it.
package contenthealth

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/coreevents"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// SettingsReader is the part of the settings service this package needs.
type SettingsReader interface {
	Organization(ctx context.Context) (settings.Document, error)
}

// Service evaluates content health and maintains the matching incidents.
type Service struct {
	db          *pgxpool.Pool
	settings    SettingsReader
	definitions contentdefs.Catalogs
	// events receives incident.opened@1, incident.recovered@1, and
	// feed.stale@1 in the sweep's transaction. Nil drops them.
	events coreevents.Sink
	// now dates those events. Tests replace it.
	now func() time.Time
	// checks and models are the contenthealth.checks provider slot. Nil
	// runs no plugin check.
	checks PluginChecks
	models ContentModels
	logger *slog.Logger
}

// SetClock replaces the clock that dates the sweep's core events.
func (s *Service) SetClock(now func() time.Time) { s.now = now }

func (s *Service) clock() time.Time {
	if s.now == nil {
		return time.Now().UTC()
	}
	return s.now().UTC()
}

// SetEvents wires the core event sink.
func (s *Service) SetEvents(events coreevents.Sink) { s.events = events }

// emitIDs collects the incident IDs a statement returned and emits their
// core event in the same transaction.
func (s *Service) emitIDs(ctx context.Context, tx pgx.Tx, rows pgx.Rows, err error, name, reason string) error {
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	return coreevents.EmitIncidents(ctx, tx, s.events, name, reason, s.clock(), ids...)
}

// NewService builds the content health service.
func NewService(db *pgxpool.Pool, reader SettingsReader) *Service {
	return &Service{db: db, settings: reader, definitions: contentdefs.MustLoad(), now: time.Now, logger: slog.Default()}
}

// SetContentDefinitions shares the release catalog used for playback projection.
func (s *Service) SetContentDefinitions(catalog contentdefs.Catalogs) { s.definitions = catalog }

// Thresholds are the organization's content health settings.
type Thresholds struct {
	StaleSourceHours  int
	ExpiringMediaDays int
}

func (s *Service) thresholds(ctx context.Context) (Thresholds, error) {
	document, err := s.settings.Organization(ctx)
	if err != nil {
		return Thresholds{}, err
	}
	t := Thresholds{StaleSourceHours: 12, ExpiringMediaDays: 14}
	if v, ok := document.Values["content_health.stale_source_hours"].(float64); ok && v > 0 {
		t.StaleSourceHours = int(v)
	}
	if v, ok := document.Values["content_health.expiring_media_days"].(float64); ok && v > 0 {
		t.ExpiringMediaDays = int(v)
	}
	return t, nil
}

// Sweep opens and recovers content incidents from current state.
//
// It is written the same way as the offline-screen sweep, and for the same
// reason: nothing sends an event when a feed quietly stops working, so a
// condition that is only ever derived from events would never be seen. It is
// idempotent, so a source that has been stale for a week still has exactly one
// open incident.
func (s *Service) Sweep(ctx context.Context) error {
	thresholds, err := s.thresholds(ctx)
	if err != nil {
		return err
	}
	staleAfter := time.Duration(thresholds.StaleSourceHours) * time.Hour
	if err := s.sweepDataSources(ctx, staleAfter); err != nil {
		return err
	}
	if err := s.sweepFeeds(ctx); err != nil {
		return err
	}
	if err := s.sweepEmptyPlaylists(ctx); err != nil {
		return err
	}
	// Plugin checks are additional. They never change the built-in sweeps.
	return s.sweepPluginChecks(ctx)
}

func (s *Service) sweepDataSources(ctx context.Context, staleAfter time.Duration) error {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT w.provider,w.configuration,w.managed_data_source_id
		FROM widgets w JOIN assets a ON a.id=w.asset_id AND a.deleted_at IS NULL`)
	if err != nil {
		return err
	}
	used := []uuid.UUID{}
	seen := map[uuid.UUID]bool{}
	for rows.Next() {
		var provider string
		var configuration json.RawMessage
		var managedID *uuid.UUID
		if err = rows.Scan(&provider, &configuration, &managedID); err != nil {
			rows.Close()
			return err
		}
		ids := s.definitions.WidgetDataSourceIDs(provider, configuration)
		if managedID != nil {
			ids = append(ids, *managedID)
		}
		for _, id := range ids {
			if id != uuid.Nil && !seen[id] {
				used = append(used, id)
				seen[id] = true
			}
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	// A source is stale when its last success is older than the threshold, or
	// when it has never succeeded and has had long enough to try. Serving
	// cached data is not itself a fault -- that is the cache working -- so the
	// age of the data, not the flag, is the condition.
	rows, err = tx.Query(ctx, `
		INSERT INTO incidents(
			id,incident_type,severity,status,title,description,opened_at,last_seen_at,
			failure_code,probable_cause,related_type,related_id,dedupe_key,metadata)
		SELECT gen_random_uuid(),'data_source','warning','open',
		       'Data Source is not refreshing',
		       d.name||' last updated '||
		           COALESCE(to_char(r.last_success_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')||' UTC',
		                    'never')||'. Screens are showing cached data.',
		       COALESCE(r.last_success_at,d.created_at)+$1::interval, now(),
		       COALESCE(r.error_code,''),
		       CASE WHEN r.error_code IS NULL OR r.error_code=''
		            THEN '' ELSE 'The last refresh failed with '||r.error_code||'.' END,
		       'data_source',d.id::text,
		       'data_source:source:'||d.id::text,
		       jsonb_build_object('source','content_health','dataSourceId',d.id::text,
		                          'dataSourceName',d.name,'provider',d.provider)
		FROM data_sources d
		JOIN data_source_refresh_states r ON r.data_source_id=d.id
		WHERE d.deleted_at IS NULL
		  AND COALESCE(r.last_success_at,d.created_at) < now()-$1::interval
		  AND d.id=ANY($2::uuid[])
		  AND NOT EXISTS (SELECT 1 FROM plugin_feed_datasets f WHERE f.id=d.id)
		ON CONFLICT DO NOTHING
		RETURNING id`, staleAfter, used)
	if err := s.emitIDs(ctx, tx, rows, err, plugin.CoreIncidentOpened, coreevents.IncidentDetected); err != nil {
		return err
	}

	rows, err = tx.Query(ctx, `
		UPDATE incidents i SET status='recovered',recovered_at=COALESCE(r.last_success_at,now()),
			recovery_mode='automatic',
			resolution_reason=COALESCE(NULLIF(i.resolution_reason,''),'The Data Source refreshed successfully.'),
			updated_at=now()
		FROM data_sources d
		JOIN data_source_refresh_states r ON r.data_source_id=d.id
		WHERE i.incident_type='data_source' AND i.status IN('open','acknowledged')
		  AND i.dedupe_key='data_source:source:'||d.id::text
		  AND NOT EXISTS (SELECT 1 FROM plugin_feed_datasets f WHERE f.id=d.id)
		  AND (d.deleted_at IS NOT NULL
		       OR (r.last_success_at IS NOT NULL AND r.last_success_at >= now()-$1::interval))
		RETURNING i.id`,
		staleAfter)
	if err := s.emitIDs(ctx, tx, rows, err, plugin.CoreIncidentRecovered, coreevents.IncidentAutomatic); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// sweepFeeds is the Content Health condition of plugin feeds
// (docs/plugin-feeds.md#staleness). A feed dataset that a Widget uses is
// stale when its last publication is older than twice the feed's expected
// refresh interval; a fresh publication recovers it. It is the same
// data_source incident as any other Data Source.
func (s *Service) sweepFeeds(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		WITH opened AS (
		INSERT INTO incidents(
			id,incident_type,severity,status,title,description,opened_at,last_seen_at,
			failure_code,probable_cause,related_type,related_id,dedupe_key,metadata)
		SELECT gen_random_uuid(),'data_source','warning','open',
		       'Data Source is not refreshing',
		       d.name||' last published '||
		           COALESCE(to_char(f.published_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')||' UTC','never')||
		           '. The plugin publishes it every '||(f.expected_refresh_seconds/60)||' minutes.',
		       COALESCE(f.published_at,f.created_at)+make_interval(secs=>2*f.expected_refresh_seconds), now(),
		       'feed_stale','The plugin has not published this feed on time.',
		       'data_source',d.id::text,'data_source:source:'||d.id::text,
		       jsonb_build_object('source','content_health','dataSourceId',d.id::text,'dataSourceName',d.name,
		                          'provider',d.provider,'pluginId',f.plugin_id,'feed',f.feed_id)
		FROM plugin_feed_datasets f JOIN data_sources d ON d.id=f.id AND d.deleted_at IS NULL
		WHERE COALESCE(f.published_at,f.created_at) < now()-make_interval(secs=>2*f.expected_refresh_seconds)
		  AND EXISTS (SELECT 1 FROM widgets w JOIN assets a ON a.id=w.asset_id AND a.deleted_at IS NULL
		              WHERE w.configuration->>'dataSourceId'=d.id::text OR w.managed_data_source_id=d.id)
		ON CONFLICT DO NOTHING
		RETURNING id, related_id, opened_at)
		SELECT o.id, f.id, f.plugin_id, f.feed_id, f.instance_id, f.published_at, f.expected_refresh_seconds, o.opened_at
		FROM opened o JOIN plugin_feed_datasets f ON f.id::text=o.related_id`)
	if err != nil {
		return err
	}
	type staleFeed struct {
		incident uuid.UUID
		event    coreevents.FeedStale
		owner    string
	}
	stale, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (staleFeed, error) {
		var item staleFeed
		err := row.Scan(&item.incident, &item.event.DatasetID, &item.owner, &item.event.Feed, &item.event.InstanceID,
			&item.event.PublishedAt, &item.event.ExpectedRefreshSeconds, &item.event.StaleSince)
		return item, err
	})
	if err != nil {
		return err
	}
	now := s.clock()
	for _, item := range stale {
		// The dataset crossed into the stale state: its incident opened now.
		if err := coreevents.EmitIncidents(ctx, tx, s.events, plugin.CoreIncidentOpened, coreevents.IncidentDetected, now, item.incident); err != nil {
			return err
		}
		if err := coreevents.Emit(ctx, tx, s.events, coreevents.Event{Name: plugin.CoreFeedStale, Subject: coreevents.FeedSubject(item.event.DatasetID),
			OccurredAt: now, Payload: item.event, Owner: item.owner}); err != nil {
			return err
		}
	}
	rows, err = tx.Query(ctx, `
		UPDATE incidents i SET status='recovered',recovered_at=COALESCE(f.published_at,now()),recovery_mode='automatic',
			resolution_reason=COALESCE(NULLIF(i.resolution_reason,''),'The plugin published the feed again.'),updated_at=now()
		FROM plugin_feed_datasets f JOIN data_sources d ON d.id=f.id
		WHERE i.incident_type='data_source' AND i.status IN('open','acknowledged')
		  AND i.dedupe_key='data_source:source:'||d.id::text
		  AND (d.deleted_at IS NOT NULL
		       OR (f.published_at IS NOT NULL AND f.published_at >= now()-make_interval(secs=>2*f.expected_refresh_seconds)))
		RETURNING i.id`)
	if err := s.emitIDs(ctx, tx, rows, err, plugin.CoreIncidentRecovered, coreevents.IncidentAutomatic); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) sweepEmptyPlaylists(ctx context.Context) error {
	// A playlist with nothing available is only a problem when a screen is
	// pointed at it. An empty draft in the library is ordinary.
	//
	// A tag playlist is evaluated through its tags, because it legitimately
	// has no playlist_items rows at all; treating it like a static playlist
	// would report every tag playlist in the installation as broken.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		WITH assigned AS (
			SELECT DISTINCT p.id, p.name, p.source_type, p.tag_match
			FROM playlists p
			WHERE p.deleted_at IS NULL AND (
				EXISTS(SELECT 1 FROM screen_playlist_assignments a WHERE a.playlist_id=p.id)
				OR EXISTS(SELECT 1 FROM screen_group_playlist_assignments g WHERE g.playlist_id=p.id))
		), available AS (
			SELECT a.id, a.name,
				CASE WHEN a.source_type='tag' THEN (
					SELECT count(*) FROM assets s
					WHERE s.deleted_at IS NULL AND s.origin='library'
					  AND s.processing_status='ready'
					  AND (s.available_from IS NULL OR s.available_from<=now())
					  AND (s.expires_at IS NULL OR s.expires_at>now())
					  AND (
						CASE WHEN a.tag_match='all' THEN
							NOT EXISTS(
								SELECT 1 FROM playlist_tags t
								WHERE t.playlist_id=a.id
								  AND NOT EXISTS(SELECT 1 FROM content_asset_tags ct
								                 WHERE ct.asset_id=s.id AND ct.tag_id=t.tag_id))
							AND EXISTS(SELECT 1 FROM playlist_tags t WHERE t.playlist_id=a.id)
						ELSE
							EXISTS(SELECT 1 FROM playlist_tags t
							       JOIN content_asset_tags ct ON ct.tag_id=t.tag_id
							       WHERE t.playlist_id=a.id AND ct.asset_id=s.id)
						END)
				) ELSE (
					SELECT count(*) FROM playlist_items i
					LEFT JOIN assets s ON s.id=i.asset_id
					LEFT JOIN layouts l ON l.id=i.layout_id AND l.deleted_at IS NULL
					WHERE i.playlist_id=a.id AND (
						(i.layout_id IS NOT NULL AND l.published_revision_id IS NOT NULL)
						OR (i.asset_id IS NOT NULL AND s.deleted_at IS NULL
						    AND (s.available_from IS NULL OR s.available_from<=now())
						    AND (s.expires_at IS NULL OR s.expires_at>now()))
					)
				) END AS playable
			FROM assigned a
		)
		INSERT INTO incidents(
			id,incident_type,severity,status,title,description,opened_at,last_seen_at,
			related_type,related_id,dedupe_key,metadata)
		SELECT gen_random_uuid(),'content','error','open',
		       'Playlist has nothing to play',
		       v.name||' is assigned to a screen but has no content available right now. '||
		       'Everything in it has expired, is not available yet, or was removed.',
		       now(),now(),'playlist',v.id::text,
		       'content:playlist:'||v.id::text,
		       jsonb_build_object('source','content_health','playlistId',v.id::text,'playlistName',v.name)
		FROM available v WHERE v.playable=0
		ON CONFLICT DO NOTHING
		RETURNING id`)
	if err := s.emitIDs(ctx, tx, rows, err, plugin.CoreIncidentOpened, coreevents.IncidentDetected); err != nil {
		return err
	}

	// Recover when the playlist has content again or is no longer assigned.
	// Both are genuine ends of the condition: nothing is on a screen with
	// nothing to play any more. A plugin check's condition is also a
	// content incident; only its own check recovers it.
	rows, err = tx.Query(ctx, `
		UPDATE incidents i SET status='recovered',recovered_at=now(),
			recovery_mode='automatic',
			resolution_reason=COALESCE(NULLIF(i.resolution_reason,''),'The playlist has content available again.'),
			updated_at=now()
		WHERE i.incident_type='content' AND i.status IN('open','acknowledged')
		  AND i.failure_code IS DISTINCT FROM 'plugin_check'
		  AND NOT EXISTS(
		      WITH assigned AS (
		          SELECT p.id, p.source_type, p.tag_match
		          FROM playlists p
		          WHERE p.deleted_at IS NULL
		            AND 'content:playlist:'||p.id::text = i.dedupe_key
		            AND (EXISTS(SELECT 1 FROM screen_playlist_assignments a WHERE a.playlist_id=p.id)
		                 OR EXISTS(SELECT 1 FROM screen_group_playlist_assignments g WHERE g.playlist_id=p.id))
		      )
		      SELECT 1 FROM assigned a WHERE (
		          CASE WHEN a.source_type='tag' THEN (
		              SELECT count(*) FROM assets s
		              WHERE s.deleted_at IS NULL AND s.origin='library'
		                AND s.processing_status='ready'
		                AND (s.available_from IS NULL OR s.available_from<=now())
		                AND (s.expires_at IS NULL OR s.expires_at>now())
		                -- Must mirror the opening query's branching. Testing an
		                -- all-match playlist with any-match semantics would close
		                -- the incident while the playlist still has nothing to play.
		                AND (
		                  CASE WHEN a.tag_match='all' THEN
		                      NOT EXISTS(
		                          SELECT 1 FROM playlist_tags t
		                          WHERE t.playlist_id=a.id
		                            AND NOT EXISTS(SELECT 1 FROM content_asset_tags ct
		                                           WHERE ct.asset_id=s.id AND ct.tag_id=t.tag_id))
		                      AND EXISTS(SELECT 1 FROM playlist_tags t WHERE t.playlist_id=a.id)
		                  ELSE
		                      EXISTS(SELECT 1 FROM playlist_tags t
		                             JOIN content_asset_tags ct ON ct.tag_id=t.tag_id
		                             WHERE t.playlist_id=a.id AND ct.asset_id=s.id)
		                  END))
		          ELSE (
		              SELECT count(*) FROM playlist_items pi
		              LEFT JOIN assets s ON s.id=pi.asset_id
		              LEFT JOIN layouts l ON l.id=pi.layout_id AND l.deleted_at IS NULL
		              WHERE pi.playlist_id=a.id AND (
		                  (pi.layout_id IS NOT NULL AND l.published_revision_id IS NOT NULL)
		                  OR (pi.asset_id IS NOT NULL AND s.deleted_at IS NULL
		                      AND (s.available_from IS NULL OR s.available_from<=now())
		                      AND (s.expires_at IS NULL OR s.expires_at>now())))
		          )
		          END) = 0)
		RETURNING i.id`)
	if err := s.emitIDs(ctx, tx, rows, err, plugin.CoreIncidentRecovered, coreevents.IncidentAutomatic); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// StaleSource is one Data Source that is not refreshing.
type StaleSource struct {
	ID            uuid.UUID  `json:"id"`
	Name          string     `json:"name"`
	Provider      string     `json:"provider"`
	LastSuccessAt *time.Time `json:"lastSuccessAt,omitempty"`
	ErrorCode     string     `json:"errorCode,omitempty"`
	UsingCache    bool       `json:"usingCachedData"`
}

// ExpiringAsset is media that is about to stop playing.
type ExpiringAsset struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	ExpiresAt time.Time `json:"expiresAt"`
	InUse     bool      `json:"inUse"`
}

// EmptyPlaylist is a playlist that is assigned but has nothing to play.
type EmptyPlaylist struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	ScreenCount int       `json:"screenCount"`
}

// UnassignedScreen is a screen with no playlist. It is a setup state, not a
// fault, which is why it is reported here and never opens an incident.
type UnassignedScreen struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

// Report is the content health rollup shown in Studio.
type Report struct {
	StaleSources      []StaleSource      `json:"staleSources"`
	ExpiringAssets    []ExpiringAsset    `json:"expiringAssets"`
	EmptyPlaylists    []EmptyPlaylist    `json:"emptyPlaylists"`
	UnassignedScreens []UnassignedScreen `json:"unassignedScreens"`
	Thresholds        Thresholds         `json:"thresholds"`
	GeneratedAt       time.Time          `json:"generatedAt"`
}

// Healthy reports whether anything needs attention, so Studio can say so
// plainly instead of showing four empty lists.
func (r Report) Healthy() bool {
	return len(r.StaleSources) == 0 && len(r.ExpiringAssets) == 0 &&
		len(r.EmptyPlaylists) == 0 && len(r.UnassignedScreens) == 0
}

// Report builds the rollup.
func (s *Service) Report(ctx context.Context) (Report, error) {
	thresholds, err := s.thresholds(ctx)
	if err != nil {
		return Report{}, err
	}
	report := Report{
		StaleSources:      []StaleSource{},
		ExpiringAssets:    []ExpiringAsset{},
		EmptyPlaylists:    []EmptyPlaylist{},
		UnassignedScreens: []UnassignedScreen{},
		Thresholds:        thresholds,
		GeneratedAt:       time.Now().UTC(),
	}
	staleAfter := time.Duration(thresholds.StaleSourceHours) * time.Hour

	rows, err := s.db.Query(ctx, `
		SELECT d.id,d.name,d.provider,r.last_success_at,COALESCE(r.error_code,''),r.using_cached_data
		FROM data_sources d
		JOIN data_source_refresh_states r ON r.data_source_id=d.id
		WHERE d.deleted_at IS NULL
		  AND COALESCE(r.last_success_at,d.created_at) < now()-$1::interval
		ORDER BY r.last_success_at NULLS FIRST, d.name
		LIMIT 100`, staleAfter)
	if err != nil {
		return Report{}, err
	}
	for rows.Next() {
		var item StaleSource
		if err := rows.Scan(&item.ID, &item.Name, &item.Provider, &item.LastSuccessAt,
			&item.ErrorCode, &item.UsingCache); err != nil {
			rows.Close()
			return Report{}, err
		}
		report.StaleSources = append(report.StaleSources, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Report{}, err
	}

	rows, err = s.db.Query(ctx, `
		SELECT a.id,a.name,a.expires_at,
		       EXISTS(SELECT 1 FROM playlist_items i WHERE i.asset_id=a.id)
		       OR EXISTS(SELECT 1 FROM content_asset_tags ct
		                 JOIN playlist_tags t ON t.tag_id=ct.tag_id
		                 WHERE ct.asset_id=a.id)
		FROM assets a
		WHERE a.deleted_at IS NULL AND a.origin='library' AND a.expires_at IS NOT NULL
		  AND a.expires_at > now() AND a.expires_at < now()+make_interval(days=>$1)
		ORDER BY a.expires_at
		LIMIT 100`, thresholds.ExpiringMediaDays)
	if err != nil {
		return Report{}, err
	}
	for rows.Next() {
		var item ExpiringAsset
		if err := rows.Scan(&item.ID, &item.Name, &item.ExpiresAt, &item.InUse); err != nil {
			rows.Close()
			return Report{}, err
		}
		report.ExpiringAssets = append(report.ExpiringAssets, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Report{}, err
	}

	// Read the empty-playlist list from the incidents the sweep maintains, so
	// the page and the notification can never disagree about what is wrong.
	rows, err = s.db.Query(ctx, `
		SELECT (i.metadata->>'playlistId')::uuid, COALESCE(i.metadata->>'playlistName',''),
		       -- Both assignment paths, like the unassigned-screens query below.
		       -- Counting only direct rows reported zero for a playlist assigned
		       -- through a sync group, which is the common case.
		       (SELECT count(DISTINCT s.id) FROM screens s
		        WHERE EXISTS(SELECT 1 FROM screen_playlist_assignments a
		                     WHERE a.playlist_id=(i.metadata->>'playlistId')::uuid
		                       AND a.screen_id=s.id)
		           OR EXISTS(SELECT 1 FROM screen_group_memberships m
		                     JOIN screen_group_playlist_assignments g
		                       ON g.screen_group_id=m.screen_group_id
		                     WHERE g.playlist_id=(i.metadata->>'playlistId')::uuid
		                       AND m.screen_id=s.id))
		FROM incidents i
		WHERE i.incident_type='content' AND i.status IN('open','acknowledged')
		  AND i.metadata->>'playlistId' IS NOT NULL
		ORDER BY i.opened_at DESC LIMIT 100`)
	if err != nil {
		return Report{}, err
	}
	for rows.Next() {
		var item EmptyPlaylist
		if err := rows.Scan(&item.ID, &item.Name, &item.ScreenCount); err != nil {
			rows.Close()
			return Report{}, err
		}
		report.EmptyPlaylists = append(report.EmptyPlaylists, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Report{}, err
	}

	rows, err = s.db.Query(ctx, `
		SELECT s.id,s.name FROM screens s
		WHERE s.deleted_at IS NULL AND s.archived_at IS NULL AND s.enabled=TRUE
		  AND NOT EXISTS(SELECT 1 FROM screen_playlist_assignments a WHERE a.screen_id=s.id)
		  AND NOT EXISTS(
		      SELECT 1 FROM screen_group_memberships m
		      JOIN screen_group_playlist_assignments g ON g.screen_group_id=m.screen_group_id
		      WHERE m.screen_id=s.id)
		ORDER BY s.name LIMIT 100`)
	if err != nil {
		return Report{}, err
	}
	for rows.Next() {
		var item UnassignedScreen
		if err := rows.Scan(&item.ID, &item.Name); err != nil {
			rows.Close()
			return Report{}, err
		}
		report.UnassignedScreens = append(report.UnassignedScreens, item)
	}
	rows.Close()
	return report, rows.Err()
}
