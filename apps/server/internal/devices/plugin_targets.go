package devices

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/authz"
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

// PluginTargetOptions exposes only the bounded directory fields needed by a
// target picker; it does not grant the screen/content directory services.
// A nil access is a system caller and lists the whole directory. A
// restricted account lists the screens it reaches and the groups and
// locations granted to it directly, the ones authz.Directory accepts.
func (s *Service) PluginTargetOptions(ctx context.Context, access *authz.ScreenAccess, input TargetOptionQuery) (TargetOptionPage, error) {
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
	scoped := access != nil && !access.All
	actor := uuid.Nil
	if access != nil {
		actor = access.UserID
	}
	var table, condition string
	switch input.Kind {
	case "screen":
		table = "screens sc"
		condition = `sc.deleted_at IS NULL AND sc.archived_at IS NULL`
		if scoped {
			condition += ` AND ` + access.ScreenSQL("sc", "$2")
		}
	case "group":
		table = "screen_groups sc"
		condition = `sc.deleted_at IS NULL`
		if scoped {
			condition += ` AND ` + access.DirectGrantSQL("group", "sc.id", "$2")
		}
	case "location":
		table = "locations sc"
		condition = `true`
		if scoped {
			condition += ` AND ` + access.DirectGrantSQL("location", "sc.id", "$2")
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
