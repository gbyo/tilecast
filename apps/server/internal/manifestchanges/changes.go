package manifestchanges

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Change is the committed manifest version a player may be told to fetch.
// Domain mutations collect these while holding their own transaction and
// publish them only after that transaction commits.
type Change struct {
	ScreenID uuid.UUID
	Version  int64
}

// BumpScreens changes only the named current screens. Stable lock order keeps
// intersecting target sets from acquiring manifest rows in opposite orders.
func BumpScreens(ctx context.Context, tx pgx.Tx, ids []uuid.UUID, reason string) ([]Change, error) {
	if len(ids) == 0 {
		return []Change{}, nil
	}
	rows, err := tx.Query(ctx, `INSERT INTO screen_manifest_state(screen_id,manifest_version,change_reason)
 SELECT id,1,$2 FROM screens WHERE id=ANY($1) AND organization_id=(SELECT id FROM organization_settings WHERE singleton)
 AND deleted_at IS NULL AND archived_at IS NULL ORDER BY id
 ON CONFLICT(screen_id) DO UPDATE SET previous_manifest_version=screen_manifest_state.manifest_version,
 manifest_version=screen_manifest_state.manifest_version+1,changed_at=now(),change_reason=$2
 RETURNING screen_id,manifest_version`, ids, reason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	changes := []Change{}
	for rows.Next() {
		var change Change
		if err := rows.Scan(&change.ScreenID, &change.Version); err != nil {
			return nil, err
		}
		changes = append(changes, change)
	}
	return changes, rows.Err()
}

// LocationSchedulePeers returns the Display Group peers of a screen whose
// schedules can change when that screen's location or group membership
// changes. A schedule that targets a location reaches every member of a group
// that holds a screen at that location, so a screen that joins or leaves such
// a location also adds or removes the schedule for its peers. Call it before
// the change and pass the locations the screen had and will have. The screen
// itself is not returned.
func LocationSchedulePeers(ctx context.Context, tx pgx.Tx, screen uuid.UUID, locations ...*uuid.UUID) ([]uuid.UUID, error) {
	ids := make([]uuid.UUID, 0, len(locations))
	for _, location := range locations {
		if location != nil {
			ids = append(ids, *location)
		}
	}
	if len(ids) == 0 {
		return []uuid.UUID{}, nil
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT peer.screen_id
 FROM screen_group_memberships own
 JOIN screen_group_memberships peer ON peer.screen_group_id=own.screen_group_id AND peer.screen_id<>own.screen_id
 WHERE own.screen_id=$1
 AND EXISTS(SELECT 1 FROM schedule_targets t WHERE t.target_type='location' AND t.location_id=ANY($2))
 ORDER BY peer.screen_id`, screen, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	peers := []uuid.UUID{}
	for rows.Next() {
		var peer uuid.UUID
		if err := rows.Scan(&peer); err != nil {
			return nil, err
		}
		peers = append(peers, peer)
	}
	return peers, rows.Err()
}
