// Package execution serializes package lifecycle and guest mutations across
// Server replicas. The fence belongs to the host, never to guest JSON.
package execution

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrChanged = errors.New("package activation changed")

type heldKey struct{}

// Lock holds the package fence until tx completes. A service dispatcher can
// pass the returned context to a nested domain transaction without reacquiring
// its own outer lock on a different connection.
func Lock(ctx context.Context, tx pgx.Tx, packageID string) (context.Context, error) {
	if held, _ := ctx.Value(heldKey{}).(string); held == packageID {
		return ctx, nil
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "package_execution:"+packageID); err != nil {
		return ctx, err
	}
	return context.WithValue(ctx, heldKey{}, packageID), nil
}

func Check(ctx context.Context, tx pgx.Tx, packageID, digest string, epoch uuid.UUID) (uuid.UUID, error) {
	var storage uuid.UUID
	err := tx.QueryRow(ctx, `SELECT storage_epoch FROM installed_packages
		WHERE package_id=$1 AND digest=$2 AND execution_epoch=$3`, packageID, digest, epoch).Scan(&storage)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrChanged
	}
	return storage, err
}
