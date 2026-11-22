package takeovers

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/takeovers/precedence"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

var ErrNoEligibleScreens = errors.New("no eligible screens matched the targets")

// ErrInactive is the host's spelling of plugin.ErrTakeoverInactive, kept so
// existing core callers do not change. Plugin code uses the SDK sentinel.
var ErrInactive = plugin.ErrTakeoverInactive

type Notifier interface {
	Notify(uuid.UUID, map[string]any) bool
}

// Service is the sole writer of Takeover lifecycle and screen state. Callers
// own their transaction and invoke the returned callback only after commit.
type Service struct {
	db              *pgxpool.Pool
	playlists       *playlists.Service
	notifier        Notifier
	maximumDuration time.Duration
}

func NewService(db *pgxpool.Pool, playlists *playlists.Service, notifier Notifier, maximumDuration time.Duration) *Service {
	return &Service{db: db, playlists: playlists, notifier: notifier, maximumDuration: maximumDuration}
}

func (s *Service) MaximumDuration() time.Duration { return s.maximumDuration }

// TargetScreens returns the screens a takeover currently addresses,
// through its screen states. Scoped callers authorize these before
// acting on the takeover.
func (s *Service) TargetScreens(ctx context.Context, id uuid.UUID) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `SELECT screen_id FROM takeover_screen_states WHERE takeover_id=$1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	screens := []uuid.UUID{}
	for rows.Next() {
		var screen uuid.UUID
		if err := rows.Scan(&screen); err != nil {
			return nil, err
		}
		screens = append(screens, screen)
	}
	return screens, rows.Err()
}

func (s *Service) ValidatePlaylist(ctx context.Context, playlistID uuid.UUID, targets plugin.ScreenTargets, userSelectable bool) error {
	if playlistID == uuid.Nil {
		return fmt.Errorf("playlist is missing")
	}
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM playlists WHERE id=$1 AND organization_id=(SELECT id FROM organization_settings WHERE singleton) AND deleted_at IS NULL AND ($2=FALSE OR system_managed=FALSE))`, playlistID, userSelectable).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("playlist is unavailable")
	}
	if err := s.playlists.ValidatePresentationNow(ctx, "playlist", playlistID, time.Now().UTC()); err != nil {
		return err
	}
	return s.playlists.ValidatePresentationTargets(ctx, &playlistID, nil, targets.ScreenIDs, targets.GroupIDs)
}

func (s *Service) ActivateInTx(ctx context.Context, tx pgx.Tx, request plugin.TakeoverRequest) (plugin.TakeoverResult, plugin.AfterCommit, error) {
	if request.PlaylistID == uuid.Nil || !request.ExpiresAt.After(request.ActivatedAt) || request.ExpiresAt.Sub(request.ActivatedAt) > s.maximumDuration {
		return plugin.TakeoverResult{}, nil, fmt.Errorf("invalid takeover presentation or duration")
	}
	// Callers name the class explicitly. The plugin host fills in the plugin
	// default before it reaches here, so an empty class is a defect.
	if !request.Class.Valid() {
		return plugin.TakeoverResult{}, nil, fmt.Errorf("%w: unknown takeover class %q", plugin.ErrInvalid, request.Class)
	}
	var org uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT organization_id FROM playlists WHERE id=$1 AND organization_id=(SELECT id FROM organization_settings WHERE singleton) AND deleted_at IS NULL`, request.PlaylistID).Scan(&org); err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	if err := s.playlists.ValidatePresentationNowInTx(ctx, tx, "playlist", request.PlaylistID, request.ActivatedAt); err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT sc.id FROM screens sc WHERE sc.organization_id=$1 AND sc.deleted_at IS NULL AND sc.archived_at IS NULL AND (sc.id=ANY($2) OR EXISTS(SELECT 1 FROM screen_group_memberships m JOIN screen_groups g ON g.id=m.screen_group_id WHERE m.screen_id=sc.id AND m.screen_group_id=ANY($3) AND g.deleted_at IS NULL)) ORDER BY sc.id`, org, request.Targets.ScreenIDs, request.Targets.GroupIDs)
	if err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	screens := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return plugin.TakeoverResult{}, nil, err
		}
		screens = append(screens, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	if len(screens) == 0 {
		return plugin.TakeoverResult{}, nil, ErrNoEligibleScreens
	}
	// Serialize activations, so the screens this activation reports as
	// suspended are computed against every committed Takeover. The lock is
	// held to commit.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('tilecast.takeover.activate',0))`); err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	id := uuid.New()
	actor := nullableUser(request.ActivatedBy)
	_, err = tx.Exec(ctx, `INSERT INTO takeovers(id,organization_id,name,description,playlist_id,status,activated_by,activated_at,expires_at,class) VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$9)`, id, org, request.Name, request.Description, request.PlaylistID, actor, request.ActivatedAt, request.ExpiresAt, string(request.Class))
	if err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	for _, screen := range unique(request.Targets.ScreenIDs) {
		if _, err = tx.Exec(ctx, `INSERT INTO takeover_targets(takeover_id,target_type,screen_id) SELECT $1,'screen',$2 WHERE EXISTS(SELECT 1 FROM screens WHERE id=$2 AND organization_id=$3 AND deleted_at IS NULL)`, id, screen, org); err != nil {
			return plugin.TakeoverResult{}, nil, err
		}
	}
	for _, group := range unique(request.Targets.GroupIDs) {
		if _, err = tx.Exec(ctx, `INSERT INTO takeover_targets(takeover_id,target_type,screen_group_id) SELECT $1,'group',$2 WHERE EXISTS(SELECT 1 FROM screen_groups WHERE id=$2 AND organization_id=$3 AND deleted_at IS NULL)`, id, group, org); err != nil {
			return plugin.TakeoverResult{}, nil, err
		}
	}
	// An activation never cancels another Takeover. Each target screen shows
	// whichever active Takeover the precedence rule selects; a weaker one
	// waits there until the stronger one ends.
	versions := map[uuid.UUID]int64{}
	for _, screen := range screens {
		var version int64
		if err = tx.QueryRow(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,change_reason,changed_at) VALUES($1,1,'takeover.activated',$2) ON CONFLICT(screen_id) DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,manifest_version=screen_manifest_state.manifest_version+1,changed_at=$2,change_reason='takeover.activated' RETURNING manifest_version`, screen, request.ActivatedAt).Scan(&version); err != nil {
			return plugin.TakeoverResult{}, nil, err
		}
		versions[screen] = version
		if _, err = tx.Exec(ctx, `INSERT INTO takeover_screen_states(takeover_id,screen_id,manifest_version,state) VALUES($1,$2,$3,'pending')`, id, screen, version); err != nil {
			return plugin.TakeoverResult{}, nil, err
		}
	}
	suspended, err := suspendedScreens(ctx, tx, id, screens, request.ActivatedAt)
	if err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	action := request.AuditAction
	if action == "" {
		action = "takeover.activated"
	}
	if !strings.HasPrefix(action, "takeover.") {
		return plugin.TakeoverResult{}, nil, fmt.Errorf("invalid takeover audit action")
	}
	metadata := make(map[string]any, len(request.AuditMetadata)+2)
	for key, value := range request.AuditMetadata {
		metadata[key] = value
	}
	metadata["class"] = string(request.Class)
	metadata["suspendedScreenCount"] = len(suspended)
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'takeover',$4,$5)`, uuid.New(), actor, action, id.String(), metadata); err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	return plugin.TakeoverResult{ID: id, AffectedCount: len(screens), ScreenIDs: screens, SuspendedScreenIDs: suspended}, s.afterCommit(id, versions), nil
}

// suspendedScreens answers the screens where Takeover id is not the one the
// precedence rule shows at the given time: a stronger, or a newer equal,
// Takeover is active there.
func suspendedScreens(ctx context.Context, tx pgx.Tx, id uuid.UUID, screens []uuid.UUID, at time.Time) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT s.id FROM unnest($1::uuid[]) AS s(id)
		WHERE `+precedence.EffectiveIDSQL("s.id", "$3")+` IS DISTINCT FROM $2 ORDER BY s.id`, screens, id, at)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

func (s *Service) CancelInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, actorID uuid.UUID, reason string) (plugin.AfterCommit, error) {
	tag, err := tx.Exec(ctx, `UPDATE takeovers SET status='cancelled',cancelled_by=$2,cancelled_at=now(),cancellation_reason=$3,updated_at=now() WHERE id=$1 AND status='active'`, id, nullableUser(actorID), reason)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrInactive
	}
	rows, err := tx.Query(ctx, `UPDATE takeover_screen_states SET state='cancelled',restored_at=now(),last_updated_at=now() WHERE takeover_id=$1 AND state NOT IN ('restored','cancelled','expired') RETURNING screen_id`, id)
	if err != nil {
		return nil, err
	}
	screens := []uuid.UUID{}
	for rows.Next() {
		var screen uuid.UUID
		if err = rows.Scan(&screen); err != nil {
			rows.Close()
			return nil, err
		}
		screens = append(screens, screen)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	versions, err := s.bumpTakeoverScreens(ctx, tx, screens, "takeover.cancelled", uuid.Nil)
	if err != nil {
		return nil, err
	}
	if actorID != uuid.Nil {
		if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'takeover.cancelled','takeover',$3)`, uuid.New(), actorID, id.String()); err != nil {
			return nil, err
		}
	}
	return s.afterCommit(id, versions), nil
}

func (s *Service) RefreshInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) (plugin.AfterCommit, error) {
	rows, err := tx.Query(ctx, `SELECT screen_id FROM takeover_screen_states WHERE takeover_id=$1 AND state NOT IN ('restored','cancelled','expired') ORDER BY screen_id`, id)
	if err != nil {
		return nil, err
	}
	screens := []uuid.UUID{}
	for rows.Next() {
		var screen uuid.UUID
		if err = rows.Scan(&screen); err != nil {
			rows.Close()
			return nil, err
		}
		screens = append(screens, screen)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	versions, err := s.bumpTakeoverScreens(ctx, tx, screens, reason, id)
	if err != nil {
		return nil, err
	}
	return s.afterCommit(id, versions), nil
}

func (s *Service) bumpTakeoverScreens(ctx context.Context, tx pgx.Tx, screens []uuid.UUID, reason string, stateID uuid.UUID) (map[uuid.UUID]int64, error) {
	versions := map[uuid.UUID]int64{}
	for _, screen := range unique(screens) {
		var version int64
		if err := tx.QueryRow(ctx, `UPDATE screen_manifest_state SET previous_manifest_version=manifest_version,manifest_version=manifest_version+1,changed_at=now(),change_reason=$2 WHERE screen_id=$1 RETURNING manifest_version`, screen, reason).Scan(&version); err != nil {
			return nil, err
		}
		versions[screen] = version
		if stateID != uuid.Nil {
			if _, err := tx.Exec(ctx, `UPDATE takeover_screen_states SET manifest_version=$3,last_updated_at=now() WHERE takeover_id=$1 AND screen_id=$2`, stateID, screen, version); err != nil {
				return nil, err
			}
		}
	}
	return versions, nil
}

func (s *Service) afterCommit(id uuid.UUID, versions map[uuid.UUID]int64) plugin.AfterCommit {
	return func() {
		if s.notifier == nil {
			return
		}
		ids := make([]uuid.UUID, 0, len(versions))
		for screen := range versions {
			ids = append(ids, screen)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
		for _, screen := range ids {
			version := versions[screen]
			s.notifier.Notify(screen, map[string]any{"type": "takeover.changed", "takeoverId": id, "manifestVersion": version})
			s.notifier.Notify(screen, map[string]any{"type": "manifest.changed", "manifestVersion": version})
		}
	}
}

func unique(ids []uuid.UUID) []uuid.UUID {
	seen := map[uuid.UUID]bool{}
	out := []uuid.UUID{}
	for _, id := range ids {
		if id != uuid.Nil && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func nullableUser(id uuid.UUID) *uuid.UUID {
	if id == uuid.Nil {
		return nil
	}
	return &id
}
