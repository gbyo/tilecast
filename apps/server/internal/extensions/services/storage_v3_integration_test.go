package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/kvstore"
	"github.com/tilecast/tilecast/apps/server/internal/plugins"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest/samplestate"
)

// storage.kv@1 end to end through the dispatcher: the plugin identity the
// host binds is the namespace, and the bounds are the package KV bounds.

type kvFixture struct {
	*serviceFixture
	plugins *plugins.Service
}

func newKVFixture(t *testing.T) *kvFixture {
	t.Helper()
	f := newServiceFixture(t)
	if _, err := f.pool.Exec(context.Background(), `TRUNCATE plugin_kv`); err != nil {
		t.Fatal(err)
	}
	service := plugins.NewService(f.pool, nil, plugins.WithPlugins(samplestate.New()))
	f.dispatcher.deps.Plugins = service
	service.SetServiceCaller(f.dispatcher)
	if _, _, err := service.Install(context.Background(), samplestate.ID, f.ownerID); err != nil {
		t.Fatal(err)
	}
	return &kvFixture{serviceFixture: f, plugins: service}
}

func (f *kvFixture) call(t *testing.T, operation string, input any) (map[string]any, *CallError) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	data, denial, failure := f.dispatcher.Call(context.Background(), Call{PluginID: samplestate.ID, Context: ContextSystem,
		Grants: bundledGrants("storage.kv"), Operation: operation, Input: raw})
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

func (f *kvFixture) set(t *testing.T, key string, value []byte) *CallError {
	t.Helper()
	_, failure := f.call(t, "storage.kv@1/set", map[string]any{"key": key, "value": value})
	return failure
}

func (f *kvFixture) get(t *testing.T, key string) ([]byte, *CallError) {
	t.Helper()
	out, failure := f.call(t, "storage.kv@1/get", map[string]any{"key": key})
	if failure != nil {
		return nil, failure
	}
	var value []byte
	raw, _ := json.Marshal(out["value"])
	_ = json.Unmarshal(raw, &value)
	return value, nil
}

func (f *kvFixture) cas(t *testing.T, key string, expected []byte, value []byte) (bool, *CallError) {
	t.Helper()
	input := map[string]any{"key": key, "expected": nil, "value": value}
	if expected != nil {
		input["expected"] = expected
	}
	out, failure := f.call(t, "storage.kv@1/compareAndSet", input)
	if failure != nil {
		return false, failure
	}
	return out["swapped"] == true, nil
}

func expectCode(t *testing.T, failure *CallError, code string) {
	t.Helper()
	if failure == nil || failure.Code != code {
		t.Fatalf("failure = %+v, want %s", failure, code)
	}
}

func TestKVBoundsAreThePackageBounds(t *testing.T) {
	f := newKVFixture(t)
	if failure := f.set(t, strings.Repeat("k", kvstore.MaxKeyBytes), []byte("x")); failure != nil {
		t.Fatalf("128-byte key = %+v", failure)
	}
	expectCode(t, f.set(t, strings.Repeat("k", kvstore.MaxKeyBytes+1), []byte("x")), ErrCodeInvalidInput)
	expectCode(t, f.set(t, "", []byte("x")), ErrCodeInvalidInput)
	// A multi-byte key counts bytes: 43 three-byte runes are 129 bytes.
	expectCode(t, f.set(t, strings.Repeat("€", 43), []byte("x")), ErrCodeInvalidInput)
	full := bytes.Repeat([]byte{0xa5}, kvstore.MaxValueBytes)
	if failure := f.set(t, "full", full); failure != nil {
		t.Fatalf("64 KiB value = %+v", failure)
	}
	if value, failure := f.get(t, "full"); failure != nil || !bytes.Equal(value, full) {
		t.Fatalf("64 KiB read = %d %+v", len(value), failure)
	}
	expectCode(t, f.set(t, "over", append(full, 0)), ErrCodeInvalidInput)
	if _, failure := f.get(t, "missing"); failure == nil || failure.Code != ErrCodeNotFound {
		t.Fatalf("missing = %+v", failure)
	}
	// An empty value is a value.
	if failure := f.set(t, "empty", []byte{}); failure != nil {
		t.Fatal(failure)
	}
	if value, failure := f.get(t, "empty"); failure != nil || len(value) != 0 {
		t.Fatalf("empty = %v %+v", value, failure)
	}
	out, failure := f.call(t, "storage.kv@1/delete", map[string]any{"key": "empty"})
	if failure != nil || out["deleted"] != true {
		t.Fatalf("delete = %v %+v", out, failure)
	}
	if _, failure := f.get(t, "empty"); failure == nil || failure.Code != ErrCodeNotFound {
		t.Fatalf("deleted key = %+v", failure)
	}
}

func TestKVQuotaIsTransactional(t *testing.T) {
	f := newKVFixture(t)
	value := bytes.Repeat([]byte{1}, kvstore.MaxValueBytes)
	// Sixteen 64 KiB values fill 1 MiB exactly.
	for i := 0; i < 16; i++ {
		if failure := f.set(t, fmt.Sprintf("k%02d", i), value); failure != nil {
			t.Fatalf("value %d = %+v", i, failure)
		}
	}
	expectCode(t, f.set(t, "k16", []byte{1}), ErrCodeQuotaExceeded)
	// Replacing a value counts the new value, not both.
	if failure := f.set(t, "k00", value); failure != nil {
		t.Fatalf("replace at the quota = %+v", failure)
	}
	if _, failure := f.call(t, "storage.kv@1/delete", map[string]any{"key": "k00"}); failure != nil {
		t.Fatal(failure)
	}
	// Twenty concurrent writers compete for the one free 64 KiB: one wins.
	var wg sync.WaitGroup
	failures := make([]*CallError, 20)
	for i := range failures {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			failures[i] = f.set(t, fmt.Sprintf("race%02d", i), value)
		}(i)
	}
	wg.Wait()
	stored := 0
	for _, failure := range failures {
		switch {
		case failure == nil:
			stored++
		case failure.Code != ErrCodeQuotaExceeded:
			t.Fatalf("racer = %+v", failure)
		}
	}
	var total int64
	if err := f.pool.QueryRow(context.Background(), `SELECT sum(octet_length(value)) FROM plugin_kv WHERE plugin_id=$1`, samplestate.ID).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if stored != 1 || total != kvstore.MaxNamespaceBytes {
		t.Fatalf("stored %d, total %d", stored, total)
	}
	// A compare-and-set that would pass the quota changes nothing.
	expectCode(t, func() *CallError { _, failure := f.cas(t, "k17", nil, []byte{1}); return failure }(), ErrCodeQuotaExceeded)
}

func TestKVCompareAndSet(t *testing.T) {
	f := newKVFixture(t)
	if swapped, failure := f.cas(t, "cursor", nil, []byte("v1")); failure != nil || !swapped {
		t.Fatalf("absent to value = %t %+v", swapped, failure)
	}
	if swapped, failure := f.cas(t, "cursor", nil, []byte("other")); failure != nil || swapped {
		t.Fatalf("absent expected on a set key = %t %+v", swapped, failure)
	}
	if swapped, failure := f.cas(t, "cursor", []byte("wrong"), []byte("other")); failure != nil || swapped {
		t.Fatalf("wrong expected = %t %+v", swapped, failure)
	}
	if value, _ := f.get(t, "cursor"); string(value) != "v1" {
		t.Fatalf("a failed comparison changed the value to %q", value)
	}
	// The empty value and a missing key are different.
	if swapped, failure := f.cas(t, "cursor", []byte{}, []byte("x")); failure != nil || swapped {
		t.Fatalf("empty expected = %t %+v", swapped, failure)
	}
	if swapped, failure := f.cas(t, "cursor", []byte("v1"), []byte("v2")); failure != nil || !swapped {
		t.Fatalf("right expected = %t %+v", swapped, failure)
	}
	// Ten concurrent writers swap from v2: exactly one wins.
	var wg sync.WaitGroup
	results := make([]bool, 10)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			swapped, failure := f.cas(t, "cursor", []byte("v2"), []byte(fmt.Sprintf("w%d", i)))
			if failure != nil {
				t.Errorf("racer %d = %+v", i, failure)
			}
			results[i] = swapped
		}(i)
	}
	wg.Wait()
	winners := 0
	winner := ""
	for i, swapped := range results {
		if swapped {
			winners++
			winner = fmt.Sprintf("w%d", i)
		}
	}
	if value, _ := f.get(t, "cursor"); winners != 1 || string(value) != winner {
		t.Fatalf("winners = %d, value %q, want %q", winners, value, winner)
	}
	expectCode(t, func() *CallError {
		_, failure := f.cas(t, "cursor", bytes.Repeat([]byte{1}, kvstore.MaxValueBytes+1), []byte("x"))
		return failure
	}(), ErrCodeInvalidInput)
	// The transport bound holds two 64 KiB values.
	full := bytes.Repeat([]byte{2}, kvstore.MaxValueBytes)
	if swapped, failure := f.cas(t, "big", nil, full); failure != nil || !swapped {
		t.Fatalf("big absent = %t %+v", swapped, failure)
	}
	if swapped, failure := f.cas(t, "big", full, full); failure != nil || !swapped {
		t.Fatalf("two 64 KiB values = %t %+v", swapped, failure)
	}
}

func TestKVNamespaceIsThePluginAndOutlivesRemoval(t *testing.T) {
	f := newKVFixture(t)
	ctx := context.Background()
	if failure := f.set(t, "theme", []byte("dark")); failure != nil {
		t.Fatal(failure)
	}
	// Another plugin's namespace is separate, and no input names one.
	if _, err := f.plugins.KVGet(ctx, "other_plugin", "theme"); err != kvstore.ErrNotFound {
		t.Fatalf("other namespace = %v", err)
	}
	if _, failure := f.call(t, "storage.kv@1/get", map[string]any{"key": "theme", "plugin": "other_plugin"}); failure == nil || failure.Code != ErrCodeInvalidInput {
		t.Fatalf("an input naming a namespace = %+v", failure)
	}
	// Removal keeps the values, like settings and instances; a reinstall
	// reads them again.
	if err := f.plugins.Remove(ctx, samplestate.ID, f.ownerID); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM plugin_kv WHERE plugin_id=$1`, samplestate.ID).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("rows after removal = %d %v", rows, err)
	}
	if _, _, err := f.plugins.Install(ctx, samplestate.ID, f.ownerID); err != nil {
		t.Fatal(err)
	}
	if value, failure := f.get(t, "theme"); failure != nil || string(value) != "dark" {
		t.Fatalf("after reinstall = %q %+v", value, failure)
	}
}
