package server

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// maxOutputPreviewRecords bounds the number of preview records returned per view.
const maxOutputPreviewRecords = 20

// OutputUsage summarizes where a view's dataset is consumed downstream.
type OutputUsage struct {
	Widgets int      `json:"widgets"`
	Layouts int      `json:"layouts"`
	Names   []string `json:"names"`
}

// OutputView is one saved view's generated dataset and status for the Outputs tab. Preview records
// come from the cached projection, which only ever contains output-eligible records.
type OutputView struct {
	Key            string                   `json:"key"`
	Name           string                   `json:"name"`
	Fields         []plugin.DataSourceField `json:"fields"`
	RecordCount    int                      `json:"recordCount"`
	PreviewRecords []plugin.TypedRecord     `json:"previewRecords"`
	Usage          OutputUsage              `json:"usage"`
}

// FormOutputs is the Outputs tab payload: per-view datasets plus form-level projection status.
type FormOutputs struct {
	Views         []OutputView `json:"views"`
	LastSuccessAt *time.Time   `json:"lastSuccessAt,omitempty"`
	NextRefreshAt *time.Time   `json:"nextRefreshAt,omitempty"`
	UsingCached   bool         `json:"usingCachedData"`
	ErrorCode     *string      `json:"errorCode,omitempty"`
	Stale         bool         `json:"stale"`
}

// GetOutputs returns the generated datasets for each saved view together with the form's projection
// status (last success, next scheduled refresh/boundary, stale/error). It reads the cached payload
// the Player consumes, so previews never contain unapproved records.
func (s *Service) GetOutputs(ctx context.Context, id uuid.UUID) (FormOutputs, error) {
	if _, err := s.ensureForm(ctx, id); err != nil {
		return FormOutputs{}, err
	}
	views, err := s.listViews(ctx, s.db, id)
	if err != nil {
		return FormOutputs{}, err
	}
	state, err := s.host.DataSources.RefreshState(ctx, id)
	if err != nil {
		return FormOutputs{}, err
	}
	byKey := map[string]plugin.TypedDataset{}
	for _, dataset := range state.Payload.Datasets {
		byKey[dataset.ID] = dataset
	}
	out := FormOutputs{
		Views:         []OutputView{},
		LastSuccessAt: state.LastSuccess,
		NextRefreshAt: state.NextRefresh,
		UsingCached:   state.UsingCached,
		ErrorCode:     state.ErrorCode,
		Stale:         state.UsingCached || state.ErrorCode != nil,
	}
	for _, view := range views {
		dataset := byKey[view.Key]
		records := dataset.Records
		if records == nil {
			records = []plugin.TypedRecord{}
		}
		preview := records
		if len(preview) > maxOutputPreviewRecords {
			preview = preview[:maxOutputPreviewRecords]
		}
		fields := dataset.Fields
		if fields == nil {
			fields = []plugin.DataSourceField{}
		}
		usage, err := s.viewUsage(ctx, id, view.Key)
		if err != nil {
			return FormOutputs{}, err
		}
		out.Views = append(out.Views, OutputView{
			Key:            view.Key,
			Name:           view.Name,
			Fields:         fields,
			RecordCount:    len(records),
			PreviewRecords: preview,
			Usage:          usage,
		})
	}
	return out, nil
}

// viewUsage reports how many Widgets reference a form view's dataset.
func (s *Service) viewUsage(ctx context.Context, id uuid.UUID, viewKey string) (OutputUsage, error) {
	return s.datasetUsage(ctx, id, viewKey)
}

// datasetUsage finds the Widgets that reference a specific view's dataset. A Widget names a Form
// dataset by carrying both the Data Source id and the view key in its configuration (only chart
// Widgets select a dataset), so a per-view reference is `dataSourceId==form AND dataset==viewKey`.
// Layout bindings reference a Data Source at the source level (they carry no dataset key), so they
// are not attributable to an individual view and are guarded by the Data Source delete path instead.
func (s *Service) datasetUsage(ctx context.Context, id uuid.UUID, viewKey string) (OutputUsage, error) {
	usage, err := s.host.DataSources.Usage(ctx, id, viewKey)
	if err != nil {
		return OutputUsage{}, err
	}
	names := usage.Names
	if names == nil {
		names = []string{}
	}
	return OutputUsage{Widgets: usage.Widgets, Layouts: usage.Layouts, Names: names}, nil
}

// RebuildOutputs re-runs the projection for a form and returns the refreshed Outputs status. The
// projection rebuild invalidates affected manifests via the AssetInvalidator.
func (s *Service) RebuildOutputs(ctx context.Context, id, actor uuid.UUID) (FormOutputs, error) {
	if _, err := s.ensureForm(ctx, id); err != nil {
		return FormOutputs{}, err
	}
	if err := s.RebuildProjection(ctx, id); err != nil {
		return FormOutputs{}, err
	}
	if err := s.auditChecked(ctx, actor, "form.output_rebuilt", id.String(), nil); err != nil {
		return FormOutputs{}, err
	}
	return s.GetOutputs(ctx, id)
}
