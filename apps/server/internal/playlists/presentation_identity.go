package playlists

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type PresentationIdentity struct {
	Name     string
	Revision *int64
}

// PresentationIdentityInTx reads current public metadata for an inspection.
// A Layout revision is its published revision. Asset metadata has no common
// presentation revision, so the reader must not invent one from updated_at.
func (s *Service) PresentationIdentityInTx(ctx context.Context, tx pgx.Tx, kind string, id uuid.UUID) (PresentationIdentity, error) {
	var query string
	switch kind {
	case "playlist":
		query = `SELECT name,revision FROM playlists WHERE id=$1 AND deleted_at IS NULL`
	case "layout":
		query = `SELECT l.name,r.revision FROM layouts l LEFT JOIN layout_revisions r ON r.id=l.published_revision_id WHERE l.id=$1 AND l.deleted_at IS NULL`
	case "asset":
		query = `SELECT name,NULL::bigint FROM assets WHERE id=$1 AND deleted_at IS NULL`
	default:
		return PresentationIdentity{}, errors.New("unsupported presentation type")
	}
	var identity PresentationIdentity
	err := tx.QueryRow(ctx, query, id).Scan(&identity.Name, &identity.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return PresentationIdentity{}, ErrNotFound
	}
	return identity, err
}
