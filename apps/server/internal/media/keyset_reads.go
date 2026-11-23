package media

import (
	"context"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/keyset"
)

// Keyset reads for callers that need stable continuation rather than page
// numbers: oldest first by creation, the id as the final tie-breaker. They
// read the same live library rows and apply the same visibility predicate
// as ListAssets and ListDataSources.

// AssetPageQuery is one keyset page of the live Media library.
type AssetPageQuery struct {
	// View is the reader's library view. Types must name at least one
	// asset type; an empty view reads nothing.
	View   View
	Search string
	// Provider narrows Widgets to one provider.
	Provider string
	After    *keyset.After
	Limit    int
}

// ListAssetsAfter returns at most q.Limit live library assets after the
// position. Archived, expired, plugin-managed, and private plugin assets
// are never listed, the same rows ListAssets leaves out.
func (s *Service) ListAssetsAfter(ctx context.Context, q AssetPageQuery) ([]Asset, error) {
	if q.View.Types != nil && len(q.View.Types) == 0 {
		return []Asset{}, nil
	}
	where := []string{
		"a.deleted_at IS NULL", "a.origin='library'", "a.system_managed=FALSE",
		"a.archived_at IS NULL", "(a.expires_at IS NULL OR a.expires_at>now())",
	}
	args := []any{}
	if search := strings.TrimSpace(q.Search); search != "" {
		args = append(args, search)
		where = append(where, "a.name ILIKE '%' || $"+strconv.Itoa(len(args))+" || '%'")
	}
	if q.Provider != "" {
		args = append(args, q.Provider)
		where = append(where, "EXISTS(SELECT 1 FROM widgets wf WHERE wf.asset_id=a.id AND wf.provider=$"+strconv.Itoa(len(args))+")")
	}
	where = append(where, q.View.assetClause("a", &args), keyset.Ascending(q.After, "a.created_at", "a.id", &args))
	args = append(args, q.Limit)
	rows, err := s.db.Query(ctx, assetSelect+" WHERE "+strings.Join(where, " AND ")+" ORDER BY a.created_at,a.id LIMIT $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	items := []Asset{}
	for rows.Next() {
		asset, err := scanAsset(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, asset)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range items {
		if items[index].Type != "widget" {
			continue
		}
		if items[index].Widget, err = s.loadWidget(ctx, items[index].ID); err != nil {
			return nil, err
		}
	}
	return items, nil
}

// GetAssetInView returns one asset the view reaches, with the decision the
// Studio detail route makes: an asset that is missing, outside the
// reader's content access, or of a type the view does not read is
// ErrNotFound.
func (s *Service) GetAssetInView(ctx context.Context, view View, id uuid.UUID) (Asset, error) {
	refs, err := s.AuthorizeAssets(ctx, view.Access, []uuid.UUID{id}, false)
	if err != nil {
		return Asset{}, err
	}
	if len(refs) != 1 || (view.Types != nil && !slices.Contains(view.Types, refs[0].Type)) {
		return Asset{}, ErrNotFound
	}
	return s.GetAsset(ctx, id)
}

// ListDataSourcesAfter returns at most limit Data Sources after the
// position, with the refresh summary ListDataSources reports.
func (s *Service) ListDataSourcesAfter(ctx context.Context, search, provider string, after *keyset.After, limit int) ([]DataSourceListItem, error) {
	where := []string{"d.deleted_at IS NULL", "d.system_managed=FALSE"}
	args := []any{}
	if search = strings.TrimSpace(search); search != "" {
		args = append(args, search)
		where = append(where, "d.name ILIKE '%' || $"+strconv.Itoa(len(args))+" || '%'")
	}
	if provider != "" {
		args = append(args, provider)
		where = append(where, "d.provider=$"+strconv.Itoa(len(args)))
	}
	where = append(where, keyset.Ascending(after, "d.created_at", "d.id", &args))
	args = append(args, limit)
	rows, err := s.db.Query(ctx, dataSourceSelect+" WHERE "+strings.Join(where, " AND ")+" ORDER BY d.created_at,d.id LIMIT $"+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	items := []DataSourceListItem{}
	itemIndexes := map[uuid.UUID]int{}
	for rows.Next() {
		source, err := scanDataSource(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		source.Configuration = stripUploadedContent(source.Provider, source.Configuration)
		itemIndexes[source.ID] = len(items)
		items = append(items, DataSourceListItem{DataSource: source, Status: "pending"})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.attachRefreshSummaries(ctx, items, itemIndexes); err != nil {
		return nil, err
	}
	return items, nil
}
