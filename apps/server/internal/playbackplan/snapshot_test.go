package playbackplan

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
)

type afterAssignmentRead struct {
	TransactionalAssignments
	after func(context.Context, pgx.Tx)
}

func (r afterAssignmentRead) ReadAssignmentStateInTx(ctx context.Context, tx pgx.Tx, screen uuid.UUID) (playlists.Assignment, error) {
	a, err := r.TransactionalAssignments.ReadAssignmentStateInTx(ctx, tx, screen)
	if err == nil {
		r.after(ctx, tx)
	}
	return a, err
}

func TestSnapshotRejectsInvalidInputBeforeDatabaseAccess(t *testing.T) {
	service := NewSnapshotCurrent(nil, nil, nil, nil)
	for _, input := range []struct {
		screen uuid.UUID
		at     time.Time
	}{{uuid.Nil, time.Now()}, {uuid.New(), time.Time{}}} {
		if _, err := service.At(context.Background(), input.screen, input.at); !errors.Is(err, ErrInvalidCurrentInspection) {
			t.Fatalf("invalid error=%v", err)
		}
	}
}
