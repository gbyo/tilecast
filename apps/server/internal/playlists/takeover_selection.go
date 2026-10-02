package playlists

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ActiveTakeoverAt is shared by manifest projection and read-only inspection.
// It evaluates currently configured Takeovers; it is not historical evidence.
func (s *Service) ActiveTakeoverAt(ctx context.Context, screenID uuid.UUID, at time.Time) (*ManifestTakeover, error) {
	return s.activeTakeoverAt(ctx, s.db, screenID, at)
}

func (s *Service) ActiveTakeoverAtInTx(ctx context.Context, tx pgx.Tx, screenID uuid.UUID, at time.Time) (*ManifestTakeover, error) {
	return s.activeTakeoverAt(ctx, tx, screenID, at)
}

func (s *Service) activeTakeoverAt(ctx context.Context, q presentationQuery, screenID uuid.UUID, at time.Time) (*ManifestTakeover, error) {
	var takeover ManifestTakeover
	err := q.QueryRow(ctx, `SELECT e.id,e.playlist_id,e.activated_at,e.expires_at
		FROM takeovers e JOIN takeover_screen_states es ON es.takeover_id=e.id
		WHERE es.screen_id=$1 AND e.status='active' AND e.activated_at<=$2 AND e.expires_at>$2
		AND es.state NOT IN ('restored','cancelled','expired')
		ORDER BY e.activated_at DESC,e.id DESC LIMIT 1`, screenID, at.UTC()).Scan(
		&takeover.ID, &takeover.PlaylistID, &takeover.ActivatedAt, &takeover.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &takeover, nil
}
