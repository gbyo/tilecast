package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/samplefeeds"
)

// feeds.publish@1 through the dispatcher: the plugin the host bound owns
// the feed, the transport bound holds a 512 KiB publication, and a stale
// revision answers revision_conflict.
func TestFeedPublishThroughTheDispatcher(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `TRUNCATE plugin_feed_datasets CASCADE`); err != nil {
		t.Fatal(err)
	}
	service := plugins.NewService(f.pool, nil, plugins.WithPlugins(samplefeeds.New()))
	f.dispatcher.deps.Plugins = service
	service.SetServiceCaller(f.dispatcher)
	if _, _, err := service.Install(ctx, samplefeeds.ID, f.ownerID); err != nil {
		t.Fatal(err)
	}
	call := func(operation string, input any) (map[string]any, *CallError) {
		raw, _ := json.Marshal(input)
		data, denial, failure := f.dispatcher.Call(ctx, Call{PluginID: samplefeeds.ID, Context: ContextSystem,
			Grants: bundledGrants("feeds.publish"), Operation: operation, Input: raw})
		if denial != nil {
			t.Fatalf("%s denied: %+v", operation, denial)
		}
		if failure != nil {
			return nil, failure
		}
		encoded, _ := json.Marshal(data)
		out := map[string]any{}
		_ = json.Unmarshal(encoded, &out)
		return out, nil
	}
	records := []map[string]any{{"id": "n1", "values": map[string]any{"text": "Welcome"}}}
	out, failure := call("feeds.publish@1/publish", map[string]any{"feed": "notices", "replaces": 0, "records": records})
	if failure != nil || out["revision"] != float64(1) {
		t.Fatalf("publish = %v %+v", out, failure)
	}
	if _, failure := call("feeds.publish@1/publish", map[string]any{"feed": "notices", "replaces": 0, "records": records}); failure == nil || failure.Code != ErrCodeFeedConflict {
		t.Fatalf("stale publish = %+v", failure)
	}
	if out, failure := call("feeds.publish@1/revision", map[string]any{"feed": "notices"}); failure != nil || out["revision"] != float64(1) {
		t.Fatalf("revision = %v %+v", out, failure)
	}
	if _, failure := call("feeds.publish@1/publish", map[string]any{"feed": "notices", "replaces": 1}); failure == nil || failure.Code != ErrCodeInvalidInput {
		t.Fatalf("a publication without records = %+v", failure)
	}
	if _, failure := call("feeds.publish@1/publish", map[string]any{"feed": "notices", "replaces": 1, "records": records, "plugin": "other"}); failure == nil || failure.Code != ErrCodeInvalidInput {
		t.Fatalf("an input naming a plugin = %+v", failure)
	}
	if limits := OperationLimits("feeds.publish@1/publish"); limits.MaxInputBytes < 512<<10 {
		t.Fatalf("publish input bound %d", limits.MaxInputBytes)
	}
}
