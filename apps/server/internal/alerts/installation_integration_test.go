package alerts

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
)

// TestUninstalledEmergencyAlertsNeverPolls proves installation is the top-level
// gate: a monitor left switched on for an uninstalled plugin makes no upstream
// request, and the plugin cannot be configured until it is installed.
func TestUninstalledEmergencyAlertsNeverPolls(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}
	organizationID, userID := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Alert Gate',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role,active) VALUES($1,'Owner','alert-gate','unused','owner',TRUE)`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO alert_monitor(singleton,enabled,areas) VALUES(TRUE,TRUE,'{OH}')
		ON CONFLICT(singleton) DO UPDATE SET enabled=TRUE,areas='{OH}'`); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/geo+json")
		_, _ = w.Write([]byte(`{"features":[]}`))
	}))
	defer upstream.Close()
	service := NewService(pool, nil, nil, nil, "", time.Hour)
	service.baseURL = upstream.URL

	if err = service.Poll(ctx); !errors.Is(err, plugins.ErrPluginNotInstalled) {
		t.Fatalf("poll while uninstalled err = %v", err)
	}
	if _, err = service.UpdateMonitor(ctx, false, []string{"OH"}, nil, 120, userID); !errors.Is(err, plugins.ErrPluginNotInstalled) {
		t.Fatalf("monitor update while uninstalled err = %v", err)
	}
	if _, err = service.SaveRule(ctx, uuid.Nil, RuleInput{Name: "Tornado"}, userID); !errors.Is(err, plugins.ErrPluginNotInstalled) {
		t.Fatalf("rule save while uninstalled err = %v", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("uninstalled plugin made %d upstream requests", requests.Load())
	}

	if _, err = pool.Exec(ctx, `INSERT INTO plugin_installations(organization_id,plugin_id) VALUES($1,'emergency_alerts')`, organizationID); err != nil {
		t.Fatal(err)
	}
	if err = service.Poll(ctx); err != nil {
		t.Fatalf("poll after install: %v", err)
	}
	if requests.Load() == 0 {
		t.Fatal("installed plugin did not poll")
	}
}
