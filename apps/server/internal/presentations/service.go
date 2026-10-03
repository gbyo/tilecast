package presentations

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
)

type Notifier interface {
	ManifestChanged(screenID uuid.UUID, version int64)
}

type Service struct {
	db        *pgxpool.Pool
	notifier  Notifier
	now       func() time.Time
	readiness playlists.PresentationReadiness
}

func NewService(db *pgxpool.Pool, notifier Notifier) *Service {
	return &Service{db: db, notifier: notifier, now: time.Now}
}

func (s *Service) SetPresentationReadiness(readiness playlists.PresentationReadiness) {
	s.readiness = readiness
}

// ActiveForScreen is the only lookup used by manifest generation. The player
// therefore observes the same override after a reconnect or a server restart
// without keeping a process-local presentation snapshot.
func (s *Service) ActiveForScreen(ctx context.Context, screenID uuid.UUID) (*playlists.PresentationOverride, error) {
	return s.ActiveForScreenAt(ctx, screenID, s.now().UTC())
}

// ActiveForScreenAt evaluates stored Quick Present state without reconciling
// or persisting expiration. Current/future inspection supplies its instant.
func (s *Service) ActiveForScreenAt(ctx context.Context, screenID uuid.UUID, at time.Time) (*playlists.PresentationOverride, error) {
	var item playlists.PresentationOverride
	var contentName string
	err := s.db.QueryRow(ctx, `
		SELECT po.id,po.target_type,po.target_id,po.content_type,po.content_id,
		       po.started_at,po.expires_at,po.wake_display,
		       CASE WHEN po.content_type='playlist' THEN p.name
		            WHEN po.content_type='layout' THEN l.name
		            ELSE a.name END
		FROM presentation_overrides po
		LEFT JOIN playlists p ON p.id=po.content_id AND po.content_type='playlist'
		LEFT JOIN layouts l ON l.id=po.content_id AND po.content_type='layout'
		LEFT JOIN assets a ON a.id=po.content_id AND po.content_type='asset'
		WHERE po.stopped_at IS NULL
		  AND po.started_at<=$2
		  AND (po.expires_at IS NULL OR po.expires_at>$2)
		  AND ((po.target_type='screen' AND po.target_id=$1)
		       OR (po.target_type='group' AND EXISTS(
				SELECT 1 FROM screen_group_memberships m
				JOIN screen_groups g ON g.id=m.screen_group_id AND g.deleted_at IS NULL
				WHERE m.screen_id=$1 AND m.screen_group_id=po.target_id)))
		ORDER BY po.started_at DESC,po.id DESC
		LIMIT 1`, screenID, at.UTC()).Scan(
		&item.ID, &item.TargetType, &item.TargetID, &item.ContentType,
		&item.ContentID, &item.StartedAt, &item.ExpiresAt, &item.WakeDisplay,
		&contentName,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("load active presentation override: %w", err)
	}
	item.ContentName = contentName
	return &item, nil
}

func (s *Service) Create(ctx context.Context, input CreateInput) (Override, error) {
	input.TargetType = strings.TrimSpace(input.TargetType)
	input.ContentType = strings.TrimSpace(input.ContentType)
	input.AfterAction = strings.TrimSpace(input.AfterAction)
	if input.TargetType != "screen" && input.TargetType != "group" {
		return Override{}, fmt.Errorf("%w: targetType must be screen or group", ErrInvalid)
	}
	if input.ContentType != "playlist" && input.ContentType != "layout" && input.ContentType != "asset" {
		return Override{}, fmt.Errorf("%w: unsupported content type", ErrInvalid)
	}
	if input.ContentID == uuid.Nil || input.TargetID == uuid.Nil {
		return Override{}, fmt.Errorf("%w: target and content are required", ErrInvalid)
	}
	if input.AfterAction == "" {
		input.AfterAction = "resume"
	}
	if input.AfterAction != "resume" {
		return Override{}, fmt.Errorf("%w: afterAction must be resume", ErrInvalid)
	}
	if input.Duration != 0 && (input.Duration < 5*time.Minute || input.Duration > 24*time.Hour) {
		return Override{}, fmt.Errorf("%w: duration must be until stopped or between five minutes and one day", ErrInvalid)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Override{}, fmt.Errorf("begin presentation override: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var org uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&org); err != nil {
		return Override{}, fmt.Errorf("load organization: %w", err)
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('tilecast.presentation.'||$1))`, org.String()); err != nil {
		return Override{}, fmt.Errorf("lock presentation installation: %w", err)
	}
	screens, targetName, err := targetScreens(ctx, tx, org, input.TargetType, input.TargetID)
	if err != nil {
		return Override{}, err
	}
	if len(screens) == 0 {
		return Override{}, fmt.Errorf("%w: target has no active screens", ErrConflict)
	}
	// When the shared readiness service is wired, it owns the complete graph
	// decision below. The local query still verifies organization ownership and
	// obtains the display name, but must not reject a dependency with a partial
	// readiness rule before the authoritative validator can explain it.
	contentName, err := validateContent(ctx, tx, org, input.ContentType, input.ContentID, s.readiness == nil)
	if err != nil {
		return Override{}, err
	}
	if s.readiness != nil {
		if err = s.readiness.ValidatePresentationNowInTx(ctx, tx, input.ContentType, input.ContentID, s.now().UTC()); err != nil {
			return Override{}, err
		}
	}
	var conflict bool
	err = tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM presentation_overrides po
			WHERE po.organization_id=$1
			  AND po.stopped_at IS NULL
			  AND (po.expires_at IS NULL OR po.expires_at>$2)
			  AND EXISTS (
				SELECT 1
				FROM screens affected
				WHERE affected.id=ANY($3::uuid[])
				  AND (
					(po.target_type='screen' AND po.target_id=affected.id)
					OR (
						po.target_type='group'
						AND EXISTS (
							SELECT 1
							FROM screen_group_memberships m
							WHERE m.screen_id=affected.id AND m.screen_group_id=po.target_id
						)
					)
				  )
			)
		)`, org, s.now().UTC(), screens).Scan(&conflict)
	if err != nil {
		return Override{}, fmt.Errorf("check presentation conflicts: %w", err)
	}
	if conflict {
		return Override{}, ErrConflict
	}
	var airplay bool
	err = tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM external_presentation_screen_states st
			JOIN external_presentation_sessions ep ON ep.id=st.session_id
			WHERE st.screen_id=ANY($1::uuid[])
			  AND ep.status IN ('preparing','waiting','active','stopping'))
		OR EXISTS(
			SELECT 1 FROM screen_player_status ps
			WHERE ps.screen_id=ANY($1::uuid[])
			  AND ps.external_presentation_state IS NOT NULL
			  AND ps.external_presentation_state NOT IN ('','none','ended','failed'))`, screens).Scan(&airplay)
	if err != nil {
		return Override{}, fmt.Errorf("check external presentation conflict: %w", err)
	}
	if airplay {
		return Override{}, fmt.Errorf("%w: an AirPlay presentation is active on one or more selected displays", ErrConflict)
	}

	now := s.now().UTC()
	var expires *time.Time
	if input.Duration > 0 {
		value := now.Add(input.Duration)
		expires = &value
	}
	id := uuid.New()
	if _, err = tx.Exec(ctx, `INSERT INTO presentation_overrides(id,organization_id,target_type,target_id,content_type,content_id,duration_seconds,started_at,expires_at,after_action,wake_display,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, id, org, input.TargetType, input.TargetID, input.ContentType, input.ContentID, int(input.Duration/time.Second), now, expires, input.AfterAction, input.WakeDisplay, nullableUUID(input.CreatedBy)); err != nil {
		return Override{}, fmt.Errorf("create presentation override: %w", err)
	}
	notes, err := bumpScreens(ctx, tx, screens, "presentation_override.started")
	if err != nil {
		return Override{}, err
	}
	if input.CreatedBy != uuid.Nil {
		if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'presentation_override.started','presentation_override',$3)`, uuid.New(), input.CreatedBy, id.String()); err != nil {
			return Override{}, fmt.Errorf("audit presentation override: %w", err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Override{}, fmt.Errorf("commit presentation override: %w", err)
	}
	notify(s.notifier, notes)
	return Override{ID: id, TargetType: input.TargetType, TargetID: input.TargetID, TargetName: targetName, ContentType: input.ContentType, ContentID: input.ContentID, ContentName: contentName, DurationSecs: int(input.Duration / time.Second), StartedAt: now, ExpiresAt: expires, AfterAction: input.AfterAction, WakeDisplay: input.WakeDisplay}, nil
}

func (s *Service) Stop(ctx context.Context, id uuid.UUID, userID uuid.UUID, reason string) (Override, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Override{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var lockOrg uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&lockOrg); err != nil {
		return Override{}, fmt.Errorf("load organization: %w", err)
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('tilecast.presentation.'||$1))`, lockOrg.String()); err != nil {
		return Override{}, fmt.Errorf("lock presentation installation: %w", err)
	}
	var item Override
	var org uuid.UUID
	err = tx.QueryRow(ctx, `SELECT po.organization_id,po.target_type,po.target_id,po.content_type,po.content_id,po.duration_seconds,po.started_at,po.expires_at,po.after_action,po.wake_display,COALESCE(sc.name,g.name,''),CASE WHEN po.content_type='playlist' THEN p.name WHEN po.content_type='layout' THEN l.name ELSE a.name END FROM presentation_overrides po LEFT JOIN screens sc ON sc.id=po.target_id AND po.target_type='screen' LEFT JOIN screen_groups g ON g.id=po.target_id AND po.target_type='group' LEFT JOIN playlists p ON p.id=po.content_id AND po.content_type='playlist' LEFT JOIN layouts l ON l.id=po.content_id AND po.content_type='layout' LEFT JOIN assets a ON a.id=po.content_id AND po.content_type='asset' WHERE po.id=$1 AND po.stopped_at IS NULL FOR UPDATE OF po`, id).Scan(&org, &item.TargetType, &item.TargetID, &item.ContentType, &item.ContentID, &item.DurationSecs, &item.StartedAt, &item.ExpiresAt, &item.AfterAction, &item.WakeDisplay, &item.TargetName, &item.ContentName)
	if errors.Is(err, pgx.ErrNoRows) {
		return Override{}, ErrNotFound
	}
	if err != nil {
		return Override{}, fmt.Errorf("load presentation override: %w", err)
	}
	screens, _, err := targetScreens(ctx, tx, org, item.TargetType, item.TargetID)
	if err != nil {
		return Override{}, err
	}
	stopReason := strings.TrimSpace(reason)
	if stopReason == "" {
		stopReason = "Stopped from Studio"
	}
	if len(stopReason) > 500 {
		return Override{}, fmt.Errorf("%w: stop reason is too long", ErrInvalid)
	}
	now := s.now().UTC()
	if _, err = tx.Exec(ctx, `UPDATE presentation_overrides SET stopped_at=$2,stop_reason=$3 WHERE id=$1 AND stopped_at IS NULL`, id, now, stopReason); err != nil {
		return Override{}, fmt.Errorf("stop presentation override: %w", err)
	}
	notes, err := bumpScreens(ctx, tx, screens, "presentation_override.stopped")
	if err != nil {
		return Override{}, err
	}
	if userID != uuid.Nil {
		if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)VALUES($1,$2,'presentation_override.stopped','presentation_override',$3)`, uuid.New(), userID, id.String()); err != nil {
			return Override{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Override{}, fmt.Errorf("commit presentation stop: %w", err)
	}
	notify(s.notifier, notes)
	item.ID, item.StoppedAt, item.StopReason = id, &now, stopReason
	return item, nil
}

func (s *Service) List(ctx context.Context) ([]Override, error) {
	if err := s.ReconcileExpired(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT po.id,po.target_type,po.target_id,po.content_type,po.content_id,po.duration_seconds,po.started_at,po.expires_at,po.after_action,po.wake_display,COALESCE(sc.name,g.name,''),CASE WHEN po.content_type='playlist' THEN p.name WHEN po.content_type='layout' THEN l.name ELSE a.name END FROM presentation_overrides po LEFT JOIN screens sc ON sc.id=po.target_id AND po.target_type='screen' LEFT JOIN screen_groups g ON g.id=po.target_id AND po.target_type='group' LEFT JOIN playlists p ON p.id=po.content_id AND po.content_type='playlist' LEFT JOIN layouts l ON l.id=po.content_id AND po.content_type='layout' LEFT JOIN assets a ON a.id=po.content_id AND po.content_type='asset' WHERE po.stopped_at IS NULL ORDER BY po.started_at DESC,po.id DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Override{}
	for rows.Next() {
		var item Override
		if err = rows.Scan(&item.ID, &item.TargetType, &item.TargetID, &item.ContentType, &item.ContentID, &item.DurationSecs, &item.StartedAt, &item.ExpiresAt, &item.AfterAction, &item.WakeDisplay, &item.TargetName, &item.ContentName); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// ReconcileExpired advances manifest versions before a player evaluates an
// expired override. This preserves conditional-GET correctness for players
// that do not happen to fire their local expiry timer first.
func (s *Service) ReconcileExpired(ctx context.Context) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var org uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton=TRUE`).Scan(&org); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('tilecast.presentation.'||$1))`, org.String()); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
		WITH expired AS (
			UPDATE presentation_overrides
			SET stopped_at=expires_at,stop_reason='Expired'
			WHERE stopped_at IS NULL AND expires_at IS NOT NULL AND expires_at<=now()
			RETURNING target_type,target_id
		), affected AS (
			SELECT s.id AS screen_id
			FROM screens s JOIN expired e ON e.target_type='screen' AND e.target_id=s.id
			WHERE s.deleted_at IS NULL
			UNION
			SELECT m.screen_id
			FROM screen_group_memberships m JOIN expired e ON e.target_type='group' AND e.target_id=m.screen_group_id
		), changed AS (
			INSERT INTO screen_manifest_state(screen_id,manifest_version,previous_manifest_version,changed_at,change_reason)
			SELECT screen_id,1,NULL::bigint,now(),'presentation_override.expired' FROM affected
			ON CONFLICT(screen_id) DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason='presentation_override.expired'
			RETURNING screen_id,manifest_version
		)
		SELECT screen_id,manifest_version FROM changed`)
	if err != nil {
		return err
	}
	notes := []notification{}
	for rows.Next() {
		var note notification
		if err = rows.Scan(&note.screen, &note.version); err != nil {
			rows.Close()
			return err
		}
		notes = append(notes, note)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	notify(s.notifier, notes)
	return nil
}

type notification struct {
	screen  uuid.UUID
	version int64
}

func notify(notifier Notifier, notes []notification) {
	if notifier == nil {
		return
	}
	for _, note := range notes {
		notifier.ManifestChanged(note.screen, note.version)
	}
}

func bumpScreens(ctx context.Context, tx pgx.Tx, screens []uuid.UUID, reason string) ([]notification, error) {
	rows, err := tx.Query(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,previous_manifest_version,changed_at,change_reason) SELECT screen_id,1,NULL::bigint,now(),$2 FROM unnest($1::uuid[]) AS affected(screen_id) ON CONFLICT(screen_id) DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$2 RETURNING screen_id,manifest_version`, screens, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notes := []notification{}
	for rows.Next() {
		var note notification
		if err = rows.Scan(&note.screen, &note.version); err != nil {
			return nil, err
		}
		notes = append(notes, note)
	}
	return notes, rows.Err()
}

func targetScreens(ctx context.Context, tx pgx.Tx, org uuid.UUID, targetType string, targetID uuid.UUID) ([]uuid.UUID, string, error) {
	if targetType == "screen" {
		var name string
		if err := tx.QueryRow(ctx, `SELECT name FROM screens WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, targetID, org).Scan(&name); err == pgx.ErrNoRows {
			return nil, "", fmt.Errorf("%w: screen was not found", ErrNotFound)
		} else if err != nil {
			return nil, "", err
		}
		return []uuid.UUID{targetID}, name, nil
	}
	var name string
	if err := tx.QueryRow(ctx, `SELECT name FROM screen_groups WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, targetID, org).Scan(&name); err == pgx.ErrNoRows {
		return nil, "", fmt.Errorf("%w: Display Group was not found", ErrNotFound)
	} else if err != nil {
		return nil, "", err
	}
	rows, err := tx.Query(ctx, `SELECT m.screen_id FROM screen_group_memberships m JOIN screens s ON s.id=m.screen_id WHERE m.screen_group_id=$1 AND s.organization_id=$2 AND s.deleted_at IS NULL ORDER BY m.screen_id`, targetID, org)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			return nil, "", err
		}
		ids = append(ids, id)
	}
	return ids, name, rows.Err()
}

func validateContent(ctx context.Context, tx pgx.Tx, org uuid.UUID, contentType string, id uuid.UUID, requireReady bool) (string, error) {
	var name string
	switch contentType {
	case "playlist":
		if requireReady {
			var ready bool
			if err := tx.QueryRow(ctx, `SELECT p.name,(p.deleted_at IS NULL AND EXISTS(SELECT 1 FROM playlist_items i WHERE i.playlist_id=p.id)) FROM playlists p WHERE p.id=$1 AND p.organization_id=$2`, id, org).Scan(&name, &ready); err == pgx.ErrNoRows || !ready {
				return "", fmt.Errorf("%w: playlist is missing or empty", ErrInvalid)
			} else if err != nil {
				return "", err
			}
		} else if err := tx.QueryRow(ctx, `SELECT name FROM playlists WHERE id=$1 AND organization_id=$2`, id, org).Scan(&name); err == pgx.ErrNoRows {
			return "", fmt.Errorf("%w: playlist is missing or empty", ErrInvalid)
		} else if err != nil {
			return "", err
		}
	case "layout":
		if requireReady {
			var published bool
			if err := tx.QueryRow(ctx, `SELECT name,(deleted_at IS NULL AND published_revision_id IS NOT NULL) FROM layouts WHERE id=$1 AND organization_id=$2`, id, org).Scan(&name, &published); err == pgx.ErrNoRows || !published {
				return "", fmt.Errorf("%w: Layout is not published", ErrInvalid)
			} else if err != nil {
				return "", err
			}
		} else if err := tx.QueryRow(ctx, `SELECT name FROM layouts WHERE id=$1 AND organization_id=$2`, id, org).Scan(&name); err == pgx.ErrNoRows {
			return "", fmt.Errorf("%w: Layout is missing", ErrInvalid)
		} else if err != nil {
			return "", err
		}
	case "asset":
		if requireReady {
			var ready bool
			if err := tx.QueryRow(ctx, `SELECT name,(deleted_at IS NULL AND archived_at IS NULL AND origin='library' AND system_managed=FALSE AND processing_status='ready') FROM assets WHERE id=$1 AND organization_id=$2`, id, org).Scan(&name, &ready); err == pgx.ErrNoRows || !ready {
				return "", fmt.Errorf("%w: content is not ready", ErrInvalid)
			} else if err != nil {
				return "", err
			}
		} else if err := tx.QueryRow(ctx, `SELECT name FROM assets WHERE id=$1 AND organization_id=$2`, id, org).Scan(&name); err == pgx.ErrNoRows {
			return "", fmt.Errorf("%w: content is missing", ErrInvalid)
		} else if err != nil {
			return "", err
		}
	}
	return name, nil
}

func nullableUUID(id uuid.UUID) any {
	if id == uuid.Nil {
		return nil
	}
	return id
}
