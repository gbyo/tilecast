package devices

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/tilecast/tilecast/apps/server/internal/audit"
)

var (
	// ErrCommandScreenNotFound answers a command for an unknown screen.
	ErrCommandScreenNotFound = errors.New("screen not found")
	// ErrCommandLimit answers a screen whose pending queue is full.
	ErrCommandLimit = errors.New("pending command limit reached")
	// ErrCommandUnsupported answers a command type the screen's player
	// cannot run. It is refused before anything is queued.
	ErrCommandUnsupported = errors.New("the player does not support this command")
	// ErrCommandConflict answers an idempotency key that already names a
	// different command. Retries must repeat the type and payload exactly.
	ErrCommandConflict = errors.New("idempotency key conflicts with an existing command")
)

// EnqueuePlayerCommand is the single persistent Player command path.
// Dashboard operations, group display control, bulk fleet commands, and
// granted package services all queue here, so the pending-command
// limit, the idempotency key, the audit entries, and the socket wake
// cannot drift apart. createdBy is nil for system actors (background
// package calls); the audit row then carries a NULL user like every
// other system-attributed write.
func (s *Service) EnqueuePlayerCommand(ctx context.Context, screenID uuid.UUID, createdBy *uuid.UUID, commandType string, payload []byte, idempotencyKey uuid.UUID, maxPending, expiryMinutes int) (uuid.UUID, time.Time, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// The quota is a per-screen invariant. Serialize the idempotency lookup,
	// pending count and insert so concurrent requests cannot both observe the
	// same slot and overfill the queue.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('tilecast.command.'||$1))`, screenID.String()); err != nil {
		return uuid.Nil, time.Time{}, err
	}

	// Archived and deleted screens cannot poll for commands, so they are refused
	// here. The row lock also orders this check against archiving: an archive
	// that commits first is seen, and an archive that waits cancels this command.
	var org uuid.UUID
	var platform string
	if err = tx.QueryRow(ctx, `SELECT organization_id,platform FROM screens WHERE id=$1 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`, screenID).Scan(&org, &platform); errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, time.Time{}, ErrCommandScreenNotFound
	} else if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	// One check for every way a command is queued. A Browser Player performs
	// only the command types its capability matrix lists.
	if !PlatformSupportsCommand(platform, commandType) {
		return uuid.Nil, time.Time{}, ErrCommandUnsupported
	}

	// Idempotent retries return the original command even when the queue is now
	// full; they do not consume another slot or create a second audit entry.
	var existing uuid.UUID
	var existingExpires time.Time
	var sameType, samePayload bool
	err = tx.QueryRow(ctx, `SELECT id,expires_at,type=$3,payload=$4::jsonb FROM player_commands WHERE screen_id=$1 AND idempotency_key=$2`, screenID, idempotencyKey, commandType, string(payload)).Scan(&existing, &existingExpires, &sameType, &samePayload)
	if err == nil {
		if !sameType || !samePayload {
			return uuid.Nil, time.Time{}, ErrCommandConflict
		}
		if err = tx.Commit(ctx); err != nil {
			return uuid.Nil, time.Time{}, err
		}
		return existing, existingExpires, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, time.Time{}, err
	}

	var pending int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM player_commands WHERE screen_id=$1 AND state IN ('pending','delivered','acknowledged','running') AND expires_at>now()`, screenID).Scan(&pending); err != nil {
		return uuid.Nil, time.Time{}, err
	}
	if pending >= maxPending {
		return uuid.Nil, time.Time{}, ErrCommandLimit
	}

	id := uuid.New()
	expires := time.Now().Add(time.Duration(expiryMinutes) * time.Minute)
	if err = tx.QueryRow(ctx, `INSERT INTO player_commands(id,organization_id,screen_id,type,payload,idempotency_key,created_by,expires_at)VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id,expires_at`, id, org, screenID, commandType, string(payload), idempotencyKey, createdBy, expires).Scan(&id, &expires); err != nil {
		return uuid.Nil, time.Time{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return uuid.Nil, time.Time{}, err
	}

	record := func(action, resourceType, resourceID string) {
		event := audit.Event{Action: action, ResourceType: resourceType, ResourceID: resourceID, Actor: createdBy}
		if audit.SurfaceFrom(ctx) == "" {
			// Background package calls carry no HTTP principal. Name the
			// server as the initiating client instead of inventing a caller.
			event.Surface = audit.SurfaceSystem
			event.ClientID = "tilecast-server"
		}
		_ = audit.Record(ctx, s.db, event)
	}
	record("command.created", "player_command", id.String())
	if action := map[string]string{"clear_media_cache": "media.cache_clear_requested", "clear_website_data": "website.data_clear_requested", "disable_playback": "playback.disable_requested", "enable_playback": "playback.enable_requested"}[commandType]; action != "" {
		record(action, "screen", screenID.String())
	}
	s.Notify(screenID, map[string]any{"type": "commands.available"})
	return id, expires, nil
}
