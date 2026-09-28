package plugins

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// installPluginsForTest records plugins as installed for the singleton
// organization, as an administrator's Install action would.
func installPluginsForTest(t *testing.T, pool *pgxpool.Pool, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if _, err := pool.Exec(context.Background(), `INSERT INTO plugin_installations(organization_id,plugin_id)
			SELECT id,$1 FROM organization_settings WHERE singleton ON CONFLICT DO NOTHING`, id); err != nil {
			t.Fatal(err)
		}
	}
}
