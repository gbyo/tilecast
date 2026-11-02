package devices

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/targeting"
)

type TargetOption struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
	Kind string    `json:"kind"`
}
type TargetOptionQuery struct {
	Kind     string `json:"kind"`
	Search   string `json:"search"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
}
type TargetOptionPage struct {
	Items        []TargetOption `json:"items"`
	Page         int            `json:"page"`
	PageSize     int            `json:"pageSize"`
	Total        int            `json:"total"`
	CanSelectAll bool           `json:"canSelectAll"`
}

// AuthorizeTargetDefinitionInTx prevents scoped accounts from selecting a
// directory target that would acquire out-of-scope members in the future.
func (s *Service) AuthorizeTargetDefinitionInTx(ctx context.Context, tx pgx.Tx, user uuid.UUID, role string, definition targeting.Definition) error {
	if role == "owner" {
		return nil
	}
	var scoped bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM user_screen_scopes WHERE user_id=$1)`, user).Scan(&scoped); err != nil {
		return err
	}
	if !scoped {
		return nil
	}
	if definition.Mode == "all" {
		return ErrOutOfScope
	}
	for _, item := range []struct {
		kind string
		ids  []uuid.UUID
	}{{"group", definition.GroupIDs}, {"location", definition.LocationIDs}} {
		if len(item.ids) == 0 {
			continue
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_screen_scopes WHERE user_id=$1 AND scope_type=$2 AND scope_id=ANY($3)`, user, item.kind, item.ids).Scan(&count); err != nil {
			return err
		}
		if count != len(item.ids) {
			return ErrOutOfScope
		}
	}
	var outside int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM screens sc WHERE sc.id=ANY($2) AND NOT `+InScopeSQL("sc", "$1"), user, definition.ScreenIDs).Scan(&outside); err != nil {
		return err
	}
	if outside > 0 {
		return ErrOutOfScope
	}
	return nil
}

// PluginTargetOptions exposes only the bounded directory fields needed by a
// target picker; it does not grant the screen/content directory services.
func (s *Service) PluginTargetOptions(ctx context.Context, user *uuid.UUID, role string, input TargetOptionQuery) (TargetOptionPage, error) {
	input.Search = strings.TrimSpace(input.Search)
	if len(input.Search) > 100 || input.Page < 0 || input.PageSize < 0 {
		return TargetOptionPage{}, fmt.Errorf("invalid target option query")
	}
	if input.Page < 1 {
		input.Page = 1
	}
	if input.PageSize < 1 {
		input.PageSize = 50
	}
	if input.PageSize > 100 {
		input.PageSize = 100
	}
	if input.Page > 100000 {
		return TargetOptionPage{}, fmt.Errorf("target option page exceeds limit")
	}
	var scoped bool
	var actor uuid.UUID
	if user != nil {
		actor = *user
		var err error
		scoped, err = s.Scoped(ctx, actor, role)
		if err != nil {
			return TargetOptionPage{}, err
		}
	}
	var table, condition string
	switch input.Kind {
	case "screen":
		table = "screens sc"
		condition = `sc.deleted_at IS NULL AND sc.archived_at IS NULL`
		if scoped {
			condition += ` AND ` + InScopeSQL("sc", "$2")
		}
	case "group":
		table = "screen_groups sc"
		condition = `sc.deleted_at IS NULL`
		if scoped {
			condition += ` AND EXISTS(SELECT 1 FROM user_screen_scopes us WHERE us.user_id=$2 AND us.scope_type='group' AND us.scope_id=sc.id)`
		}
	case "location":
		table = "locations sc"
		condition = `true`
		if scoped {
			condition += ` AND EXISTS(SELECT 1 FROM user_screen_scopes us WHERE us.user_id=$2 AND us.scope_type='location' AND us.scope_id=sc.id)`
		}
	default:
		return TargetOptionPage{}, fmt.Errorf("target option kind must be screen, group, or location")
	}
	condition += ` AND ($2::uuid IS NOT NULL) AND sc.organization_id=(SELECT id FROM organization_settings WHERE singleton) AND strpos(lower(sc.name),lower($1))>0`
	result := TargetOptionPage{Items: []TargetOption{}, Page: input.Page, PageSize: input.PageSize, CanSelectAll: !scoped}
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE `+condition, input.Search, actor).Scan(&result.Total); err != nil {
		return TargetOptionPage{}, err
	}
	rows, err := s.db.Query(ctx, `SELECT sc.id,sc.name FROM `+table+` WHERE `+condition+` ORDER BY lower(sc.name),sc.id LIMIT $3 OFFSET $4`, input.Search, actor, input.PageSize, (input.Page-1)*input.PageSize)
	if err != nil {
		return TargetOptionPage{}, err
	}
	defer rows.Close()
	for rows.Next() {
		item := TargetOption{Kind: input.Kind}
		if err := rows.Scan(&item.ID, &item.Name); err != nil {
			return TargetOptionPage{}, err
		}
		result.Items = append(result.Items, item)
	}
	return result, rows.Err()
}
