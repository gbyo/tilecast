package edge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The signed Edge change feed (RFC §15, Amendment A1.5).
//
// Writers call AppendChange inside the same PostgreSQL transaction as the
// authoritative change, which inserts an outbox row. That makes the change
// impossible to lose once the domain transaction commits.
//
// Publish is the single serialized signer. Under a transaction-scoped
// advisory lock it reads committed outbox rows in id order, assigns each a
// feed sequence from edge_changes' BIGSERIAL, links it to the previously
// published sequence, signs it with the Edge authority key and stores the
// exact signed bytes. Because only one signer runs at a time and each commit
// happens under the lock, feed sequences define signed publication order and
// every published row is visible before the next one is signed.
//
// Sequences are monotonic and may skip integers (a rolled-back signer
// transaction consumes values). Nodes never treat a missing integer as a lost
// change: they follow the signed previousSequence links.

const (
	changeSchemaV1    = 1
	maxPublishBatch   = 200
	signerAdvisoryKey = 7421918
	MaxChangesPerPage = 500
)

type Change struct {
	Type       string
	TargetKind string
	TargetID   *uuid.UUID
	Object     *ObjectRef
	Payload    map[string]any
	ExpiresAt  *time.Time
}

type ObjectRef struct {
	SHA256    string
	SizeBytes int64
	Kind      string
}

var validTargetKinds = map[string]bool{"installation": true, "screen": true, "display_group": true, "node": true}

// AppendChange queues a change in the caller's transaction.
func AppendChange(ctx context.Context, tx pgx.Tx, change Change) error {
	if !validTargetKinds[change.TargetKind] || change.Type == "" || len(change.Type) > 64 {
		return fmt.Errorf("invalid edge change %q/%q", change.Type, change.TargetKind)
	}
	payload := change.Payload
	if payload == nil {
		payload = map[string]any{}
	}
	encoded, err := Canonicalize(payload)
	if err != nil {
		return fmt.Errorf("edge change payload: %w", err)
	}
	if len(encoded) > 8*1024 {
		return errors.New("edge change payload is too large")
	}
	var sha, kind *string
	var size *int64
	if change.Object != nil {
		sha, kind, size = &change.Object.SHA256, &change.Object.Kind, &change.Object.SizeBytes
	}
	_, err = tx.Exec(ctx, `INSERT INTO edge_change_outbox(change_type,target_kind,target_id,object_sha256,object_size_bytes,object_kind,payload,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, change.Type, change.TargetKind, change.TargetID, sha, size, kind, encoded, change.ExpiresAt)
	if err != nil {
		return fmt.Errorf("queue edge change: %w", err)
	}
	return nil
}

// Publish signs pending outbox rows. It returns how many were published.
func (s *Service) Publish(ctx context.Context) (int, error) {
	authority, err := s.Authority()
	if err != nil {
		return 0, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, signerAdvisoryKey); err != nil {
		return 0, err
	}
	rows, err := tx.Query(ctx, `SELECT id,change_type,target_kind,target_id,object_sha256,object_size_bytes,object_kind,payload,expires_at
		FROM edge_change_outbox WHERE published_sequence IS NULL ORDER BY id LIMIT $1 FOR UPDATE`, maxPublishBatch)
	if err != nil {
		return 0, err
	}
	type pending struct {
		id         int64
		change     Change
		payloadRaw []byte
	}
	var batch []pending
	for rows.Next() {
		var item pending
		var sha, kind *string
		var size *int64
		if err := rows.Scan(&item.id, &item.change.Type, &item.change.TargetKind, &item.change.TargetID, &sha, &size, &kind, &item.payloadRaw, &item.change.ExpiresAt); err != nil {
			rows.Close()
			return 0, err
		}
		if sha != nil && size != nil && kind != nil {
			item.change.Object = &ObjectRef{SHA256: *sha, SizeBytes: *size, Kind: *kind}
		}
		batch = append(batch, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(batch) == 0 {
		return 0, nil
	}
	var previous int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(sequence),0) FROM edge_changes`).Scan(&previous); err != nil {
		return 0, err
	}
	var generation int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT generation FROM edge_revocation_state WHERE singleton=TRUE),0)`).Scan(&generation); err != nil {
		return 0, err
	}
	issuedAt := s.now().UTC().Truncate(time.Second)
	for _, item := range batch {
		var sequence int64
		if err := tx.QueryRow(ctx, `SELECT nextval(pg_get_serial_sequence('edge_changes','sequence'))`).Scan(&sequence); err != nil {
			return 0, err
		}
		// The outbox stores canonical payload bytes (BYTEA, not JSONB, so
		// nothing reorders or reformats them).
		payload, err := ParseCanonical(item.payloadRaw)
		if err != nil {
			return 0, fmt.Errorf("outbox payload %d: %w", item.id, err)
		}
		body := map[string]any{
			"schema":               int64(changeSchemaV1),
			"installationId":       authority.InstallationID,
			"authorityEpoch":       int64(authority.Epoch),
			"sequence":             sequence,
			"previousSequence":     previous,
			"type":                 item.change.Type,
			"target":               target(item.change),
			"object":               object(item.change.Object),
			"revocationGeneration": generation,
			"issuedAt":             issuedAt.Format(time.RFC3339),
			"expiresAt":            timestamp(item.change.ExpiresAt),
			"payload":              payload,
		}
		document, canonical, err := Sign(authority.signingKey, PurposeServerChange, body)
		if err != nil {
			return 0, fmt.Errorf("sign edge change %d: %w", item.id, err)
		}
		encoded, err := document.Encode()
		if err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO edge_changes(sequence,previous_sequence,change_type,target_kind,target_id,body_digest,signed_document,outbox_id,issued_at,expires_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, sequence, previous, item.change.Type, item.change.TargetKind, item.change.TargetID,
			BodyDigest(canonical), encoded, item.id, issuedAt, item.change.ExpiresAt); err != nil {
			return 0, fmt.Errorf("store edge change: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE edge_change_outbox SET published_sequence=$2 WHERE id=$1`, item.id, sequence); err != nil {
			return 0, err
		}
		previous = sequence
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(batch), nil
}

func target(change Change) map[string]any {
	var id any
	if change.TargetID != nil {
		id = change.TargetID.String()
	}
	return map[string]any{"kind": change.TargetKind, "id": id}
}

func object(ref *ObjectRef) any {
	if ref == nil {
		return nil
	}
	return map[string]any{"sha256": ref.SHA256, "sizeBytes": ref.SizeBytes, "kind": ref.Kind}
}

func timestamp(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Truncate(time.Second).Format(time.RFC3339)
}

type ChangePage struct {
	Items          []json.RawMessage `json:"items"`
	LatestSequence int64             `json:"latestSequence"`
	// OldestSequence is the earliest retained sequence. A node whose
	// position is older must rebuild from a signed snapshot.
	OldestSequence int64 `json:"oldestSequence"`
}

// ChangesAfter returns signed changes with sequence > after, in order.
func (s *Service) ChangesAfter(ctx context.Context, after int64, limit int) (ChangePage, error) {
	if limit <= 0 || limit > MaxChangesPerPage {
		limit = MaxChangesPerPage
	}
	page := ChangePage{Items: []json.RawMessage{}}
	if err := s.db.QueryRow(ctx, `SELECT COALESCE(max(sequence),0), COALESCE(min(sequence),0) FROM edge_changes`).
		Scan(&page.LatestSequence, &page.OldestSequence); err != nil {
		return page, err
	}
	rows, err := s.db.Query(ctx, `SELECT signed_document FROM edge_changes WHERE sequence > $1 ORDER BY sequence LIMIT $2`, after, limit)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var document []byte
		if err := rows.Scan(&document); err != nil {
			return page, err
		}
		page.Items = append(page.Items, json.RawMessage(document))
	}
	return page, rows.Err()
}

func (s *Service) LatestSequence(ctx context.Context) (int64, error) {
	var latest int64
	err := s.db.QueryRow(ctx, `SELECT COALESCE(max(sequence),0) FROM edge_changes`).Scan(&latest)
	return latest, err
}
