package server

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

var (
	_ plugin.Initializer    = (*Service)(nil)
	_ plugin.StatusReporter = (*Service)(nil)
	_ plugin.RemovalGuard   = (*Service)(nil)
	_ plugin.WorkerProvider = (*Service)(nil)
)

// Status answers the catalog's plugin-specific questions: a Form counts as
// both configured and active, so the counts are the live Forms.
func (s *Service) Status(ctx context.Context) (plugin.Status, error) {
	count, err := s.host.DataSources.CountLive(ctx, providerName)
	if err != nil {
		return plugin.Status{}, err
	}
	return plugin.Status{
		Configured:    count > 0,
		Active:        count > 0,
		InstanceCount: count,
	}, nil
}

// RemovalBlockers refuses removal while undeleted Forms exist. Removal never
// deletes form data; the operator deletes the Forms through the plugin's own
// page first.
func (s *Service) RemovalBlockers(ctx context.Context, tx pgx.Tx) ([]plugin.Blocker, error) {
	count, err := s.host.DataSources.CountLiveInTx(ctx, tx, providerName)
	if err != nil {
		return nil, err
	}
	return []plugin.Blocker{{
		Kind: "form", Count: count,
		Singular: "form", Plural: "forms",
		Resolution: plugin.ResolveDelete,
	}}, nil
}
