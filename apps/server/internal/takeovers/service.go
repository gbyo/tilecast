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

const takeoverLifecycleLockSQL = `SELECT pg_advisory_xact_lock(hashtextextended('tilecast.takeover.activate',0))`

func normalizePriorityClass(value plugin.TakeoverPriorityClass) (plugin.TakeoverPriorityClass, error) {
	if value == "" {
		value = plugin.TakeoverClassRoutine
	}
	if !value.Valid() {
		return "", fmt.Errorf("invalid takeover priority class %q", value)
	}
	return value, nil
}

func takeoverPriorityOrderSQL(alias string) string {
	return `CASE ` + alias + `.priority_class
		WHEN 'emergency' THEN 4
		WHEN 'urgent' THEN 3
		WHEN 'priority' THEN 2
		ELSE 1
	END DESC,` + alias + `.activated_at DESC,` + alias + `.id DESC`
}

func (s *Service) winnerInTx(ctx context.Context, tx pgx.Tx, screenID uuid.UUID, at time.Time) (uuid.UUID, string, error) {
	var id uuid.UUID
	var state string
	err := tx.QueryRow(ctx, `SELECT t.id,st.state
		FROM takeovers t JOIN takeover_screen_states st ON st.takeover_id=t.id
		WHERE st.screen_id=$1 AND t.status='active' AND t.activated_at<=$2 AND t.expires_at>$2
		AND st.state NOT IN ('restored','cancelled','expired')
		ORDER BY `+takeoverPriorityOrderSQL("t")+` LIMIT 1`, screenID, at.UTC()).Scan(&id, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, "", nil
	}
	return id, state, err
}

func (s *Service) winnersInTx(ctx context.Context, tx pgx.Tx, screens []uuid.UUID, at time.Time) (map[uuid.UUID]uuid.UUID, error) {
	out := make(map[uuid.UUID]uuid.UUID, len(screens))
	for _, screen := range unique(screens) {
		winner, _, err := s.winnerInTx(ctx, tx, screen, at)
		if err != nil {
			return nil, err
		}
		out[screen] = winner
	}
	return out, nil
}

// reconcileScreenInTx keeps one eligible takeover runnable on a screen. Every
// other eligible contender is suspended, not cancelled, so it can resume when
// the winner ends. A resumed contender returns to pending because the Player
// must prepare it against the new manifest generation.
func (s *Service) reconcileScreenInTx(ctx context.Context, tx pgx.Tx, screenID uuid.UUID, at time.Time) (uuid.UUID, error) {
	winner, _, err := s.winnerInTx(ctx, tx, screenID, at)
	if err != nil || winner == uuid.Nil {
		return winner, err
	}
	if _, err = tx.Exec(ctx, `UPDATE takeover_screen_states st
		SET state='suspended',last_updated_at=$2
		FROM takeovers t
		WHERE st.takeover_id=t.id AND st.screen_id=$1 AND st.takeover_id<>$3
		AND t.status='active' AND t.activated_at<=$2 AND t.expires_at>$2
		AND st.state NOT IN ('restored','cancelled','expired','suspended')`,
		screenID, at.UTC(), winner); err != nil {
		return uuid.Nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE takeover_screen_states
		SET state='pending',last_updated_at=$3,failure_code=NULL,safe_failure_message=NULL,
			prepared_at=NULL,activated_at=NULL,restored_at=NULL
		WHERE takeover_id=$1 AND screen_id=$2 AND state='suspended'`,
		winner, screenID, at.UTC()); err != nil {
		return uuid.Nil, err
	}
	return winner, nil
}

func (s *Service) bumpScreenInTx(ctx context.Context, tx pgx.Tx, screenID uuid.UUID, reason string, at time.Time) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,change_reason,changed_at)
		VALUES($1,1,$2,$3)
		ON CONFLICT(screen_id) DO UPDATE SET
			previous_manifest_version=screen_manifest_state.manifest_version,
			manifest_version=screen_manifest_state.manifest_version+1,
			changed_at=$3,change_reason=$2
		RETURNING manifest_version`, screenID, reason, at.UTC()).Scan(&version)
	return version, err
}

func (s *Service) reconcileWinnerChangeInTx(ctx context.Context, tx pgx.Tx, screenID, before uuid.UUID, at time.Time, reason string) (int64, bool, error) {
	after, err := s.reconcileScreenInTx(ctx, tx, screenID, at)
	if err != nil {
		return 0, false, err
	}
	if before == after {
		return 0, false, nil
	}
	version, err := s.bumpScreenInTx(ctx, tx, screenID, reason, at)
	if err != nil {
		return 0, false, err
	}
	if after != uuid.Nil {
		if _, err = tx.Exec(ctx, `UPDATE takeover_screen_states SET manifest_version=$3,last_updated_at=$4 WHERE takeover_id=$1 AND screen_id=$2`,
			after, screenID, version, at.UTC()); err != nil {
			return 0, false, err
		}
	}
	return version, true, nil
}

func (s *Service) ActivateInTx(ctx context.Context, tx pgx.Tx, request plugin.TakeoverRequest) (plugin.TakeoverResult, plugin.AfterCommit, error) {
	priorityClass, err := normalizePriorityClass(request.PriorityClass)
	if err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	if request.PlaylistID == uuid.Nil || !request.ExpiresAt.After(request.ActivatedAt) || request.ExpiresAt.Sub(request.ActivatedAt) > s.maximumDuration {
		return plugin.TakeoverResult{}, nil, fmt.Errorf("invalid takeover presentation or duration")
	}
	var org uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT organization_id FROM playlists WHERE id=$1 AND organization_id=(SELECT id FROM organization_settings WHERE singleton) AND deleted_at IS NULL`, request.PlaylistID).Scan(&org); err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	if err = s.playlists.ValidatePresentationNowInTx(ctx, tx, "playlist", request.PlaylistID, request.ActivatedAt); err != nil {
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
	// All lifecycle decisions take the same transaction-scoped lock. This makes
	// the before/after winner comparison stable across activation, cancellation,
	// and the expiry sweep.
	if _, err = tx.Exec(ctx, takeoverLifecycleLockSQL); err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	before, err := s.winnersInTx(ctx, tx, screens, request.ActivatedAt)
	if err != nil {
		return plugin.TakeoverResult{}, nil, err
	}

	id := uuid.New()
	actor := nullableUser(request.ActivatedBy)
	_, err = tx.Exec(ctx, `INSERT INTO takeovers(id,organization_id,name,description,playlist_id,status,priority_class,activated_by,activated_at,expires_at) VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$9)`,
		id, org, request.Name, request.Description, request.PlaylistID, priorityClass, actor, request.ActivatedAt, request.ExpiresAt)
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

	// Every target keeps a durable state row even when another takeover wins
	// there. That is what lets one takeover be active on screen B while it is
	// suspended behind a higher class on screen A.
	for _, screen := range screens {
		var version int64
		if err = tx.QueryRow(ctx, `SELECT manifest_version FROM screen_manifest_state WHERE screen_id=$1`, screen).Scan(&version); err != nil {
			return plugin.TakeoverResult{}, nil, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO takeover_screen_states(takeover_id,screen_id,manifest_version,state) VALUES($1,$2,$3,'pending')`, id, screen, version); err != nil {
			return plugin.TakeoverResult{}, nil, err
		}
	}

	versions := map[uuid.UUID]int64{}
	for _, screen := range screens {
		version, changed, reconcileErr := s.reconcileWinnerChangeInTx(ctx, tx, screen, before[screen], request.ActivatedAt, "takeover.activated")
		if reconcileErr != nil {
			return plugin.TakeoverResult{}, nil, reconcileErr
		}
		if changed {
			versions[screen] = version
		}
	}

	action := request.AuditAction
	if action == "" {
		action = "takeover.activated"
	}
	if !strings.HasPrefix(action, "takeover.") {
		return plugin.TakeoverResult{}, nil, fmt.Errorf("invalid takeover audit action")
	}
	metadata := request.AuditMetadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'takeover',$4,$5)`, uuid.New(), actor, action, id.String(), metadata); err != nil {
		return plugin.TakeoverResult{}, nil, err
	}
	return plugin.TakeoverResult{ID: id, AffectedCount: len(screens), ScreenIDs: screens}, s.afterCommit(id, versions), nil
}

func (s *Service) CancelInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, actorID uuid.UUID, reason string) (plugin.AfterCommit, error) {
	if _, err := tx.Exec(ctx, takeoverLifecycleLockSQL); err != nil {
		return nil, err
	}
	var active bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM takeovers WHERE id=$1 AND status='active')`, id).Scan(&active); err != nil {
		return nil, err
	}
	if !active {
		return nil, ErrInactive
	}
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
	now := time.Now().UTC()
	before, err := s.winnersInTx(ctx, tx, screens, now)
	if err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `UPDATE takeovers SET status='cancelled',cancelled_by=$2,cancelled_at=now(),cancellation_reason=$3,updated_at=now() WHERE id=$1 AND status='active'`, id, nullableUser(actorID), reason)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrInactive
	}
	if _, err = tx.Exec(ctx, `UPDATE takeover_screen_states SET state='cancelled',restored_at=now(),last_updated_at=now() WHERE takeover_id=$1 AND state NOT IN ('restored','cancelled','expired')`, id); err != nil {
		return nil, err
	}
	versions := map[uuid.UUID]int64{}
	for _, screen := range screens {
		version, changed, reconcileErr := s.reconcileWinnerChangeInTx(ctx, tx, screen, before[screen], now, "takeover.cancelled")
		if reconcileErr != nil {
			return nil, reconcileErr
		}
		if changed {
			versions[screen] = version
		}
	}
	if actorID != uuid.Nil {
		if _, err = tx.Exec(ctx, `INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id) VALUES($1,$2,'takeover.cancelled','takeover',$3)`, uuid.New(), actorID, id.String()); err != nil {
			return nil, err
		}
	}
	return s.afterCommit(id, versions), nil
}

func (s *Service) expiredIDsInTx(ctx context.Context, tx pgx.Tx, now time.Time, screenID *uuid.UUID) ([]uuid.UUID, error) {
	query := `SELECT DISTINCT t.id FROM takeovers t
		WHERE t.status='active' AND t.expires_at<=$1`
	args := []any{now.UTC()}
	if screenID != nil {
		query = `SELECT DISTINCT t.id FROM takeovers t
			JOIN takeover_screen_states st ON st.takeover_id=t.id
			WHERE t.status='active' AND t.expires_at<=$1 AND st.screen_id=$2
			AND st.state NOT IN ('restored','cancelled','expired')`
		args = append(args, *screenID)
	}
	query += ` ORDER BY t.id`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Service) expireIDsInTx(ctx context.Context, tx pgx.Tx, ids []uuid.UUID, now time.Time) (map[uuid.UUID]int64, error) {
	versions := map[uuid.UUID]int64{}
	if len(ids) == 0 {
		return versions, nil
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT screen_id FROM takeover_screen_states
		WHERE takeover_id=ANY($1) AND state NOT IN ('restored','cancelled','expired')
		ORDER BY screen_id`, ids)
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
	if _, err = tx.Exec(ctx, `UPDATE takeovers SET status='expired',updated_at=$2 WHERE id=ANY($1) AND status='active'`, ids, now.UTC()); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE takeover_screen_states SET state='expired',restored_at=$2,last_updated_at=$2
		WHERE takeover_id=ANY($1) AND state NOT IN ('restored','cancelled','expired')`, ids, now.UTC()); err != nil {
		return nil, err
	}
	for _, screen := range screens {
		winner, reconcileErr := s.reconcileScreenInTx(ctx, tx, screen, now)
		if reconcileErr != nil {
			return nil, reconcileErr
		}
		version, bumpErr := s.bumpScreenInTx(ctx, tx, screen, "takeover.expired", now)
		if bumpErr != nil {
			return nil, bumpErr
		}
		versions[screen] = version
		if winner != uuid.Nil {
			if _, err = tx.Exec(ctx, `UPDATE takeover_screen_states SET manifest_version=$3,last_updated_at=$4 WHERE takeover_id=$1 AND screen_id=$2`,
				winner, screen, version, now.UTC()); err != nil {
				return nil, err
			}
		}
	}
	return versions, nil
}

func (s *Service) expireDue(ctx context.Context, screenID *uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err = tx.Exec(ctx, takeoverLifecycleLockSQL); err != nil {
		return err
	}
	now := time.Now().UTC()
	ids, err := s.expiredIDsInTx(ctx, tx, now, screenID)
	if err != nil {
		return err
	}
	versions, err := s.expireIDsInTx(ctx, tx, ids, now)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.afterCommit(uuid.Nil, versions)()
	return nil
}

// ExpireDue retires every overdue takeover. The maintenance loop calls it as a
// backstop for screens that have not requested a manifest recently.
func (s *Service) ExpireDue(ctx context.Context) error {
	return s.expireDue(ctx, nil)
}

// ReconcileExpiredForScreen is the manifest-read boundary. If this screen
// observes an overdue takeover, the whole takeover is expired across all of
// its screens in one transaction and every affected screen is re-arbitrated.
func (s *Service) ReconcileExpiredForScreen(ctx context.Context, screenID uuid.UUID) error {
	return s.expireDue(ctx, &screenID)
}

func (s *Service) RefreshInTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) (plugin.AfterCommit, error) {
	rows, err := tx.Query(ctx, `SELECT screen_id FROM takeover_screen_states WHERE takeover_id=$1 AND state NOT IN ('suspended','restored','cancelled','expired') ORDER BY screen_id`, id)
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
			message := map[string]any{"type": "takeover.changed", "manifestVersion": version}
			if id != uuid.Nil {
				message["takeoverId"] = id
			}
			s.notifier.Notify(screen, message)
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
