package media

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestRefreshResultIsDiscardedAfterConfigurationChange holds an upstream response open,
// saves a new configuration while it is in flight, and releases the old response. The old
// result must not become the cache of the new configuration or move its refresh schedule.
func TestRefreshResultIsDiscardedAfterConfigurationChange(t *testing.T) {
	ctx, pool, userID := setupContributionDB(t)
	service := NewService(pool, nil, Config{SourceFetch: SourceFetchPolicy{AllowPrivateNetworks: true, Timeout: 10 * time.Second, MaximumBytes: 1 << 20, MaximumRedirects: 3, MinimumRefresh: 5 * time.Minute, MaximumRefresh: 24 * time.Hour}})

	started := make(chan struct{})
	release := make(chan struct{})
	oldServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"items":[{"name":"Old endpoint"}]}`)
	}))
	defer oldServer.Close()
	newServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"items":[{"name":"New endpoint"}]}`)
	}))
	defer newServer.Close()

	configuration := func(url string, refreshSeconds int) json.RawMessage {
		raw, err := json.Marshal(StructuredSourceConfig{URL: url, Presentation: "list", MaxItems: 10, Fields: StructuredFields{Title: true}, Sort: "source", Mapping: &StructuredMapping{RootList: "/items", Title: "/name"}, RefreshIntervalSeconds: refreshSeconds, StalenessLimitHours: 168, EmptyState: "No items"})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	source, err := service.CreateDataSource(ctx, userID, DataSourceInput{Provider: "json", Name: "Feed", Configuration: configuration(oldServer.URL, 3600)})
	if err != nil {
		t.Fatal(err)
	}

	worker := NewDataSourceRefreshWorker(service, nil)
	type outcome struct {
		worked bool
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		worked, err := worker.runOne(ctx)
		done <- outcome{worked, err}
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the refresh worker never fetched the old endpoint")
	}

	if _, err := service.UpdateDataSource(ctx, source.ID, userID, DataSourceInput{Provider: "json", Name: "Feed", Configuration: configuration(newServer.URL, 300)}); err != nil {
		t.Fatal(err)
	}
	close(release)
	select {
	case result := <-done:
		if result.err != nil || !result.worked {
			t.Fatalf("old refresh worked=%t err=%v", result.worked, result.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the old refresh never finished")
	}

	var payload string
	var dueNow bool
	var lockedBy *string
	var errorCode *string
	if err := pool.QueryRow(ctx, `SELECT cached_payload::text,next_refresh_at<=now(),locked_by,error_code FROM data_source_refresh_states WHERE data_source_id=$1`, source.ID).Scan(&payload, &dueNow, &lockedBy, &errorCode); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "Old endpoint") {
		t.Fatalf("the superseded refresh result became the new configuration's cache: %s", payload)
	}
	if !dueNow || lockedBy != nil || errorCode != nil {
		t.Fatalf("the superseded refresh changed the saved schedule: due=%t lockedBy=%v errorCode=%v", dueNow, lockedBy, errorCode)
	}

	worked, err := worker.runOne(ctx)
	if err != nil || !worked {
		t.Fatalf("new refresh worked=%t err=%v", worked, err)
	}
	if err := pool.QueryRow(ctx, `SELECT cached_payload::text,next_refresh_at>now()+interval '200 seconds' AND next_refresh_at<now()+interval '400 seconds' FROM data_source_refresh_states WHERE data_source_id=$1`, source.ID).Scan(&payload, &dueNow); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload, "New endpoint") || !dueNow {
		t.Fatalf("the new configuration did not refresh on its own interval: due=%t payload=%s", dueNow, payload)
	}
}
