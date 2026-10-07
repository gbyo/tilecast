package installer

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// InUseResource is one kind of package-contributed content that still
// exists. Resolution tells Studio what the operator does about it. The
// shape matches the plugin removal-blocker contract so Studio renders
// both the same way.
type InUseResource struct {
	Kind       string `json:"kind"`
	Count      int    `json:"count"`
	Label      string `json:"label"`
	Resolution string `json:"resolution"`
}

// InUseError answers a removal, update, or rollback while contributed
// content still exists. The operation deletes only installation state,
// never the content itself, so any remaining row blocks. Action names
// the blocked operation: "removed", "updated", or "rolled back".
type InUseError struct {
	PackageID string
	Name      string
	Action    string
	Resources []InUseResource
}

func (e *InUseError) Error() string {
	action := e.Action
	if action == "" {
		action = "removed"
	}
	if len(e.Resources) == 0 {
		return e.Name + " cannot be " + action + " while it is in use."
	}
	first := e.Resources[0]
	return fmt.Sprintf("%s cannot be %s while %d %s remain.", e.Name, action, first.Count, first.Label)
}

// removalBlockers counts persisted content using the package's Widget
// and Data Source contributions. The caller holds the installation row
// lock, so nothing can slip between the count and the delete. Widget
// blockers come first for a deterministic order.
func removalBlockers(ctx context.Context, tx pgx.Tx, packageID string) ([]InUseResource, error) {
	widgets, sources, err := currentContributionIDs(ctx, tx, packageID)
	if err != nil {
		return nil, err
	}
	return countUsage(ctx, tx, packageID, widgets, sources)
}

// droppedInUse counts persisted content using contributions the next
// activation drops. Updates and rollbacks never strand content: dropping
// an in-use contribution blocks like a removal.
func droppedInUse(ctx context.Context, tx pgx.Tx, packageID string, next []Contribution) ([]InUseResource, error) {
	widgets, sources, err := currentContributionIDs(ctx, tx, packageID)
	if err != nil {
		return nil, err
	}
	keep := make(map[string]bool, len(next))
	for _, contribution := range next {
		keep[contribution.Kind+"\x00"+contribution.ID] = true
	}
	var droppedWidgets, droppedSources []string
	for _, id := range widgets {
		if !keep[packagemanifest.ContributionWidget+"\x00"+id] {
			droppedWidgets = append(droppedWidgets, id)
		}
	}
	for _, id := range sources {
		if !keep[packagemanifest.ContributionDataSource+"\x00"+id] {
			droppedSources = append(droppedSources, id)
		}
	}
	return countUsage(ctx, tx, packageID, droppedWidgets, droppedSources)
}

func currentContributionIDs(ctx context.Context, tx pgx.Tx, packageID string) (widgets, sources []string, err error) {
	rows, err := tx.Query(ctx, `SELECT kind,contribution_id FROM installed_package_contributions
		WHERE package_id=$1 ORDER BY kind,contribution_id`, packageID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, id string
		if err := rows.Scan(&kind, &id); err != nil {
			return nil, nil, err
		}
		switch kind {
		case packagemanifest.ContributionWidget:
			widgets = append(widgets, id)
		case packagemanifest.ContributionDataSource:
			sources = append(sources, id)
		}
	}
	return widgets, sources, rows.Err()
}

func countUsage(ctx context.Context, tx pgx.Tx, packageID string, widgets, sources []string) ([]InUseResource, error) {
	resources := []InUseResource{}
	if len(widgets) > 0 {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM widgets widget
			JOIN assets asset ON asset.id=widget.asset_id AND asset.deleted_at IS NULL
			WHERE widget.provider=ANY($1)`, widgets).Scan(&count); err != nil {
			return nil, fmt.Errorf("package %s: contributed Widget usage: %w", packageID, err)
		}
		if count > 0 {
			resources = append(resources, InUseResource{Kind: "widget", Count: count, Label: pluralize(count, "Widget", "Widgets"), Resolution: "delete"})
		}
	}
	if len(sources) > 0 {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM data_sources WHERE provider=ANY($1) AND deleted_at IS NULL`, sources).Scan(&count); err != nil {
			return nil, fmt.Errorf("package %s: contributed Data Source usage: %w", packageID, err)
		}
		if count > 0 {
			resources = append(resources, InUseResource{Kind: "data_source", Count: count, Label: pluralize(count, "Data Source", "Data Sources"), Resolution: "delete"})
		}
	}
	return resources, nil
}

func pluralize(count int, singular, plural string) string {
	if count == 1 {
		return singular
	}
	return plural
}
