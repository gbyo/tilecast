package services

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/keyset"
)

// The list contract of the read services added after content.read@1:
// every *.list operation takes {limit, cursor, ...filters} and answers
// {items, nextCursor}. The contract is bounded from its first release.
//
//   - limit defaults to DefaultListLimit and may not exceed MaxListLimit. A
//     page holds at most limit items, and fewer when the items would not fit
//     the operation's transport bound; nextCursor then continues it.
//   - Order is stable and deterministic, with a unique tie-breaker.
//   - A cursor is opaque. It names the operation and the filters it was
//     issued for; continuing it under another operation or other filters is
//     invalid_input, never an undefined page.
//   - A cursor is a position, not a permission. Every page re-runs the
//     caller's authorization.
//
// content.read@1 keeps its page/pageSize contract; it is frozen.

const (
	DefaultListLimit = 50
	MaxListLimit     = 250
)

// listLimit resolves a requested limit: zero is the default, and anything
// outside 1..MaxListLimit is invalid.
func listLimit(limit int) (int, *CallError) {
	if limit == 0 {
		return DefaultListLimit, nil
	}
	if limit < 1 || limit > MaxListLimit {
		return 0, invalidInput("limit must be between 1 and %d", MaxListLimit)
	}
	return limit, nil
}

// maxCursorBytes bounds a cursor off the wire.
const maxCursorBytes = 1024

type cursorToken struct {
	Version   int      `json:"v"`
	Operation string   `json:"o"`
	Filters   string   `json:"f"`
	Key       []string `json:"k"`
}

// filterFingerprint identifies the filters a cursor was issued for. It is a
// consistency check, not a secret.
func filterFingerprint(filters any) string {
	encoded, _ := json.Marshal(filters)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:12])
}

func encodeCursor(operation string, filters any, key ...string) string {
	encoded, _ := json.Marshal(cursorToken{Version: 1, Operation: operation, Filters: filterFingerprint(filters), Key: key})
	return base64.RawURLEncoding.EncodeToString(encoded)
}

// decodeCursor returns the position of a cursor issued by operation for
// these filters, or nil for an empty cursor.
func decodeCursor(token, operation string, filters any, keyLength int) ([]string, *CallError) {
	if token == "" {
		return nil, nil
	}
	if len(token) > maxCursorBytes {
		return nil, invalidInput("cursor is invalid")
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return nil, invalidInput("cursor is invalid")
	}
	var decoded cursorToken
	if err := json.Unmarshal(raw, &decoded); err != nil || decoded.Version != 1 || decoded.Operation != operation || len(decoded.Key) != keyLength {
		return nil, invalidInput("cursor is invalid")
	}
	if decoded.Filters != filterFingerprint(filters) {
		return nil, invalidInput("cursor does not match these filters; start again without a cursor")
	}
	return decoded.Key, nil
}

// keysetCursor encodes a (time, id) position.
func keysetCursor(operation string, filters any, at time.Time, id uuid.UUID) string {
	return encodeCursor(operation, filters, at.UTC().Format(time.RFC3339Nano), id.String())
}

// decodeKeysetCursor decodes a (time, id) position.
func decodeKeysetCursor(token, operation string, filters any) (*keyset.After, *CallError) {
	key, failure := decodeCursor(token, operation, filters, 2)
	if failure != nil || key == nil {
		return nil, failure
	}
	at, err := time.Parse(time.RFC3339Nano, key[0])
	if err != nil {
		return nil, invalidInput("cursor is invalid")
	}
	id, err := uuid.Parse(key[1])
	if err != nil {
		return nil, invalidInput("cursor is invalid")
	}
	return &keyset.After{At: at.UTC(), ID: id}, nil
}

// offsetCursor and decodeOffsetCursor carry a position in an aggregate
// report, whose groups have no stable row identity.
func offsetCursor(operation string, filters any, offset int, extra ...string) string {
	return encodeCursor(operation, filters, append([]string{strconv.Itoa(offset)}, extra...)...)
}

func decodeOffsetCursor(token, operation string, filters any, extra int) (int, []string, *CallError) {
	key, failure := decodeCursor(token, operation, filters, 1+extra)
	if failure != nil || key == nil {
		return 0, nil, failure
	}
	offset, err := strconv.Atoi(key[0])
	if err != nil || offset < 0 {
		return 0, nil, invalidInput("cursor is invalid")
	}
	return offset, key[1:], nil
}

// pageEnvelopeRoom is the part of an operation's output bound that a page
// keeps for the envelope, the next cursor, and any report-wide members.
const pageEnvelopeRoom = 4 << 10

// fitPage keeps the leading items whose encoding fits the operation's
// output bound, at most limit of them. more says whether rows exist past
// items. It returns the kept items and the index of the last kept item
// when another page follows, or -1.
func fitPage[T any](operation string, items []T, limit int, more bool) ([]T, int) {
	budget := OperationLimits(operation).MaxOutputBytes - pageEnvelopeRoom
	if len(items) > limit {
		items, more = items[:limit], true
	}
	used := 0
	for index, item := range items {
		encoded, _ := json.Marshal(item)
		used += len(encoded) + 1
		if used > budget && index > 0 {
			return items[:index], index - 1
		}
	}
	if more && len(items) > 0 {
		return items, len(items) - 1
	}
	return items, -1
}

// keysetPosition is the decoded position of a keyset cursor.
type keysetPosition = keyset.After
