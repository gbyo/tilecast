// Package targeting owns display target validation and membership semantics.
package targeting

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrInvalid = errors.New("invalid display targets")

// Definition requires explicit all or a nonempty selected union. Missing or
// empty selections never silently become all screens.
type Definition struct {
	Mode        string      `json:"mode"`
	ScreenIDs   []uuid.UUID `json:"screenIds"`
	GroupIDs    []uuid.UUID `json:"groupIds"`
	LocationIDs []uuid.UUID `json:"locationIds"`
}

func (d Definition) Canonical() Definition {
	copyIDs := func(ids []uuid.UUID) []uuid.UUID {
		copy := append([]uuid.UUID{}, ids...)
		sort.Slice(copy, func(i, j int) bool { return copy[i].String() < copy[j].String() })
		return copy
	}
	d.ScreenIDs = copyIDs(d.ScreenIDs)
	d.GroupIDs = copyIDs(d.GroupIDs)
	d.LocationIDs = copyIDs(d.LocationIDs)
	return d
}

type Query interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (d Definition) Validate() error {
	count := len(d.ScreenIDs) + len(d.GroupIDs) + len(d.LocationIDs)
	if d.Mode != "all" && d.Mode != "selected" {
		return fmt.Errorf("%w: mode must be all or selected", ErrInvalid)
	}
	if count > 1000 || (d.Mode == "all" && count != 0) || (d.Mode == "selected" && count == 0) {
		return fmt.Errorf("%w: select 1 to 1000 targets or explicit all", ErrInvalid)
	}
	return validateIDs(d)
}

func validateIDs(d Definition) error {
	if len(d.ScreenIDs)+len(d.GroupIDs)+len(d.LocationIDs) > 1000 {
		return fmt.Errorf("%w: too many targets", ErrInvalid)
	}
	for _, ids := range [][]uuid.UUID{d.ScreenIDs, d.GroupIDs, d.LocationIDs} {
		seen := make(map[uuid.UUID]bool)
		for _, id := range ids {
			if id == uuid.Nil || seen[id] {
				return fmt.Errorf("%w: empty or duplicate target", ErrInvalid)
			}
			seen[id] = true
		}
	}
	return nil
}

func Validate(ctx context.Context, q Query, d Definition) error {
	if err := d.Validate(); err != nil {
		return err
	}
	return validateExisting(ctx, q, d)
}

// ValidateScreenGroups retains the older API's empty-selection-means-none
// contract while sharing the same existence and membership rules.
func ValidateScreenGroups(ctx context.Context, q Query, screens, groups []uuid.UUID) error {
	d := Definition{Mode: "selected", ScreenIDs: screens, GroupIDs: groups}
	if err := validateIDs(d); err != nil {
		return err
	}
	return validateExisting(ctx, q, d)
}

func validateExisting(ctx context.Context, q Query, d Definition) error {
	for _, selection := range []struct {
		ids              []uuid.UUID
		table, condition string
	}{
		{d.ScreenIDs, "screens", "deleted_at IS NULL AND archived_at IS NULL"},
		{d.GroupIDs, "screen_groups", "deleted_at IS NULL"},
		{d.LocationIDs, "locations", "true"},
	} {
		if len(selection.ids) == 0 {
			continue
		}
		var count int
		if err := q.QueryRow(ctx, `SELECT count(*) FROM `+selection.table+` WHERE organization_id=(SELECT id FROM organization_settings WHERE singleton) AND id=ANY($1) AND `+selection.condition, selection.ids).Scan(&count); err != nil {
			return err
		}
		if count != len(selection.ids) {
			return fmt.Errorf("%w: one or more targets do not exist", ErrInvalid)
		}
	}
	return nil
}

const membership = `( $1::boolean OR s.id=ANY($2::uuid[]) OR s.location_id=ANY($4::uuid[])
 OR EXISTS(SELECT 1 FROM screen_group_memberships m JOIN screen_groups g ON g.id=m.screen_group_id
 WHERE m.screen_id=s.id AND m.screen_group_id=ANY($3::uuid[]) AND g.deleted_at IS NULL))`

// Resolve evaluates current membership; callers validate authored definitions
// before saving. Removed targets naturally contribute no screens.
func Resolve(ctx context.Context, q Query, d Definition) ([]uuid.UUID, error) {
	rows, err := q.Query(ctx, `SELECT s.id FROM screens s WHERE s.organization_id=(SELECT id FROM organization_settings WHERE singleton)
 AND s.deleted_at IS NULL AND s.archived_at IS NULL AND `+membership+` ORDER BY s.id`, d.Mode == "all", d.ScreenIDs, d.GroupIDs, d.LocationIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func Applies(ctx context.Context, q Query, d Definition, screen uuid.UUID) (bool, error) {
	var applies bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM screens s WHERE s.organization_id=(SELECT id FROM organization_settings WHERE singleton)
 AND s.deleted_at IS NULL AND s.archived_at IS NULL AND s.id=$5 AND `+membership+`)`, d.Mode == "all", d.ScreenIDs, d.GroupIDs, d.LocationIDs, screen).Scan(&applies)
	return applies, err
}
