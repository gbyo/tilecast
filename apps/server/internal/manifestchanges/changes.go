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
