package wasm

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/services"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Guests below are hand-assembled: real bytecode exercising the host
// ABI end to end. i32Const emits a signed constant, call emits a call,
// drop discards one stack value.
func sleb(value int32) []byte {
	var out []byte
	signed := value
	for {
		part := byte(signed & 0x7f)
		signed >>= 7
		done := (signed == 0 && part&0x40 == 0) || (signed == -1 && part&0x40 != 0)
		if !done {
			part |= 0x80
		}
		out = append(out, part)
		if done {
			return out
		}
	}
}

func i32Const(t *testing.T, value uint32) []byte {
	t.Helper()
	if value >= 1<<31 {
		t.Fatalf("test constant %d overflows i32", value)
	}
	return append([]byte{0x41}, sleb(int32(value))...)
}

func call(index uint32) []byte { return []byte{0x10, byte(index)} }

var drop = []byte{0x1a}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func testHost(t *testing.T, store KVStore) *Host {
	t.Helper()
	host, err := NewHost(context.Background(), store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("NewHost returned error: %v", err)
	}
	t.Cleanup(func() { host.Close(context.Background()) }) //nolint:errcheck
	return host
}

// kvRoundtripGuest stores "v" at "k", reads it back, and answers the
// read length. Imports kv_get (0) and kv_set (1); run_job is index 2.
func kvRoundtripGuest(t *testing.T) []byte {
	t.Helper()
	body := concat(
		i32Const(t, 100), i32Const(t, 1), i32Const(t, 110), i32Const(t, 1), call(1), drop,
		i32Const(t, 100), i32Const(t, 1), i32Const(t, 200), i32Const(t, 64), call(0),
		[]byte{0x0b},
	)
	return assemble(testModule{
		types:   []testFuncType{typeCall, typeJob},
		imports: []testImport{{module: "tilecast", name: "kv_get", kind: 0}, {module: "tilecast", name: "kv_set", kind: 0}},
		funcs:   []testFunc{{typeIdx: 1, body: body}},
		memory:  &testMemory{min: 1, max: 1, hasMax: true},
		exports: []testExport{{name: "run_job", kind: 0, index: 2}},
		data:    []testData{{offset: 100, bytes: []byte("k")}, {offset: 110, bytes: []byte("v")}},
	})
}

func TestInvokeKVRoundtrip(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	result, err := host.Invoke(context.Background(), Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:kv",
		Module:    kvRoundtripGuest(t),
		Grants:    Grants{Storage: true},
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	if result.Status != 1 {
		t.Fatalf("status = %d, want the one stored byte", result.Status)
	}
}

// denialGuest answers whatever kv_set answers: the guest observes the
// host's denial code as its own status.
func denialGuest(t *testing.T) []byte {
	t.Helper()
	body := concat(
		i32Const(t, 100), i32Const(t, 1), i32Const(t, 110), i32Const(t, 1), call(0),
		[]byte{0x0b},
	)
	return assemble(testModule{
		types:   []testFuncType{typeCall, typeJob},
		imports: []testImport{{module: "tilecast", name: "kv_set", kind: 0}},
		funcs:   []testFunc{{typeIdx: 1, body: body}},
		memory:  &testMemory{min: 1, max: 1, hasMax: true},
		exports: []testExport{{name: "run_job", kind: 0, index: 1}},
		data:    []testData{{offset: 100, bytes: []byte("k")}, {offset: 110, bytes: []byte("v")}},
	})
}

func TestInvokeDeniesUngrantedStorage(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	result, err := host.Invoke(context.Background(), Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:deny",
		Module:    denialGuest(t),
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	if result.Status != ErrNoGrant {
		t.Fatalf("status = %d, want %d", result.Status, ErrNoGrant)
	}
}

// fetchGuest requests one URL and answers the fetched length.
func fetchGuest(t *testing.T, rawURL string) []byte {
	t.Helper()
	body := concat(
		i32Const(t, 100), i32Const(t, uint32(len(rawURL))), i32Const(t, 200), i32Const(t, 64), call(0),
		[]byte{0x0b},
	)
	return assemble(testModule{
		types:   []testFuncType{typeCall, typeJob},
		imports: []testImport{{module: "tilecast", name: "http_fetch", kind: 0}},
		funcs:   []testFunc{{typeIdx: 1, body: body}},
		memory:  &testMemory{min: 1, max: 1, hasMax: true},
		exports: []testExport{{name: "run_job", kind: 0, index: 1}},
		data:    []testData{{offset: 100, bytes: []byte(rawURL)}},
	})
}

func TestInvokeHTTPFetch(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	var gotURL string
	var gotAllow []string
	host.fetch = func(_ context.Context, rawURL string, allow []string) ([]byte, error) {
		gotURL, gotAllow = rawURL, allow
		return []byte("ok"), nil
	}
	const rawURL = "https://api.example.com/x"
	result, err := host.Invoke(context.Background(), Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:fetch",
		Module:    fetchGuest(t, rawURL),
		Grants:    Grants{NetworkHosts: []string{"api.example.com"}},
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	if result.Status != 2 {
		t.Fatalf("status = %d, want the two fetched bytes", result.Status)
	}
	if gotURL != rawURL {
		t.Fatalf("fetched URL = %q", gotURL)
	}
	if len(gotAllow) != 1 || gotAllow[0] != "api.example.com" {
		t.Fatalf("allowlist = %v", gotAllow)
	}
}

func TestInvokeHTTPFetchDeniesWithoutGrant(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	host.fetch = func(context.Context, string, []string) ([]byte, error) {
		t.Fatal("fetch ran without a network grant")
		return nil, nil
	}
	result, err := host.Invoke(context.Background(), Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:fetchdeny",
		Module:    fetchGuest(t, "https://api.example.com/x"),
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	if result.Status != ErrNoGrant {
		t.Fatalf("status = %d, want %d", result.Status, ErrNoGrant)
	}
}

// logClockGuest logs one line, reads the clock, and answers 7.
func logClockGuest(t *testing.T) []byte {
	t.Helper()
	body := concat(
		i32Const(t, 0), i32Const(t, 100), i32Const(t, 5), call(0),
		call(1), drop,
		i32Const(t, 7),
		[]byte{0x0b},
	)
	return assemble(testModule{
		types:   []testFuncType{typeLog, typeNow, typeJob},
		imports: []testImport{{module: "tilecast", name: "log", kind: 0}, {module: "tilecast", name: "now_ms", kind: 0, typeIdx: 1}},
		funcs:   []testFunc{{typeIdx: 2, body: body}},
		memory:  &testMemory{min: 1, max: 1, hasMax: true},
		exports: []testExport{{name: "run_job", kind: 0, index: 2}},
		data:    []testData{{offset: 100, bytes: []byte("hello")}},
	})
}

func TestInvokeLogAndClock(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	result, err := host.Invoke(context.Background(), Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:log",
		Module:    logClockGuest(t),
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	if result.Status != 7 {
		t.Fatalf("status = %d, want 7", result.Status)
	}
}

// loopGuest never returns: loop { br 0 } then the unreachable constant
// the signature requires.
func loopGuest(t *testing.T) []byte {
	t.Helper()
	return assemble(testModule{
		types:   []testFuncType{typeJob},
		funcs:   []testFunc{{body: []byte{0x03, 0x40, 0x0c, 0x00, 0x0b, 0x41, 0x00, 0x0b}}},
		memory:  &testMemory{min: 1, max: 1, hasMax: true},
		exports: []testExport{{name: "run_job", kind: 0, index: 0}},
	})
}

func TestInvokeTimeoutStopsInfiniteGuest(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	started := time.Now()
	_, err := host.Invoke(context.Background(), Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:loop",
		Module:    loopGuest(t),
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   200 * time.Millisecond,
	})
	if err == nil {
		t.Fatal("Invoke ran an infinite guest without error")
	}
	if elapsed := time.Since(started); elapsed > 30*time.Second {
		t.Fatalf("call took %v, the deadline did not stop it", elapsed)
	}
}

func TestInvokeRejects(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	base := Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:ok",
		Module:    kvRoundtripGuest(t),
		Grants:    Grants{Storage: true},
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   5 * time.Second,
	}
	if _, err := host.Invoke(context.Background(), base); err != nil {
		t.Fatalf("baseline Invoke returned error: %v", err)
	}
	badEntry := base
	badEntry.Entry = "main"
	if _, err := host.Invoke(context.Background(), badEntry); err == nil {
		t.Fatal("Invoke accepted an unknown entry")
	}
	badModule := base
	badModule.Module = []byte("not wasm")
	badModule.Digest = "sha256:bad"
	if _, err := host.Invoke(context.Background(), badModule); err == nil {
		t.Fatal("Invoke accepted a malformed module")
	}
	tooBig := base
	tooBig.Input = make([]byte, callInputCap+1)
	if _, err := host.Invoke(context.Background(), tooBig); err == nil {
		t.Fatal("Invoke accepted an oversized input")
	}
}

func TestIsPublicIP(t *testing.T) {
	public := []string{"8.8.8.8", "1.1.1.1", "93.184.216.34"}
	for _, raw := range public {
		if !isPublicIP(net.ParseIP(raw)) {
			t.Fatalf("%s is not public", raw)
		}
	}
	private := []string{"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "0.0.0.0", "224.0.0.1", "100.64.0.1"}
	for _, raw := range private {
		if isPublicIP(net.ParseIP(raw)) {
			t.Fatalf("%s is public", raw)
		}
	}
}

func TestRestrictedFetch(t *testing.T) {
	ctx := context.Background()
	for _, rawURL := range []string{
		"http://api.example.com/x",
		"https://evil.example.com/x",
		"https://api.example.com:8443/x",
		"https://127.0.0.1/x",
		"::not-a-url::",
	} {
		if _, err := restrictedFetch(ctx, rawURL, []string{"api.example.com"}); !errors.Is(err, errNotAllowlisted) {
			t.Fatalf("%s: error = %v, want not-allowlisted", rawURL, err)
		}
	}
	// The guard engages on the real dial path: a loopback literal never
	// exchanges a byte even when nominally approved.
	_, err := restrictedFetch(ctx, "https://127.0.0.1/x", []string{"127.0.0.1"})
	if err == nil || errors.Is(err, errNotAllowlisted) {
		t.Fatalf("loopback fetch: error = %v, want the address guard", err)
	}
}

// fakeServiceCaller records the call the host built and answers canned.
type fakeServiceCaller struct {
	last    services.Call
	seen    bool
	data    any
	denial  *services.Denial
	failure *services.CallError
}

func (f *fakeServiceCaller) Call(_ context.Context, call services.Call) (any, *services.Denial, *services.CallError) {
	f.last, f.seen = call, true
	return f.data, f.denial, f.failure
}

// serviceCallGuest answers whatever call_v1 answers for one operation.
// Imports call_v1 (0); run_job is index 1.
func serviceCallGuest(t *testing.T, operation string, outCap uint32) []byte {
	t.Helper()
	body := concat(
		i32Const(t, 100), i32Const(t, uint32(len(operation))),
		i32Const(t, 200), i32Const(t, 2),
		i32Const(t, 300), i32Const(t, outCap),
		call(0),
		[]byte{0x0b},
	)
	return assemble(testModule{
		types:   []testFuncType{typeServiceCall, typeJob},
		imports: []testImport{{module: "tilecast", name: "call_v1", kind: 0}},
		funcs:   []testFunc{{typeIdx: 1, body: body}},
		memory:  &testMemory{min: 1, max: 1, hasMax: true},
		exports: []testExport{{name: "run_job", kind: 0, index: 1}},
		data:    []testData{{offset: 100, bytes: []byte(operation)}, {offset: 200, bytes: []byte("{}")}},
	})
}

func TestInvokeServiceCallEnvelopes(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	caller := &fakeServiceCaller{data: map[string]any{"id": "x"}}
	grants := Grants{Services: []packagemanifest.ServiceGrant{{ID: "instance.read", Version: 1}}}
	result, err := host.Invoke(context.Background(), Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:call",
		Module:    serviceCallGuest(t, "instance.read@1/get", 4096),
		Grants:    grants,
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   5 * time.Second,
		Context:   services.ContextBackground,
		Caller:    caller,
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	want, err := services.MarshalSuccess(map[string]any{"id": "x"})
	if err != nil {
		t.Fatalf("MarshalSuccess: %v", err)
	}
	if result.Status != int32(len(want)) {
		t.Fatalf("status = %d, want %d envelope bytes", result.Status, len(want))
	}
	if !caller.seen || caller.last.Operation != "instance.read@1/get" || string(caller.last.Input) != "{}" {
		t.Fatalf("caller saw %+v", caller.last)
	}
	if caller.last.PackageID != "acme.athletics" || caller.last.Context != services.ContextBackground || caller.last.Actor != nil {
		t.Fatalf("caller context = %+v", caller.last)
	}
	if len(caller.last.Grants) != 1 || caller.last.Grants[0].ID != "instance.read" {
		t.Fatalf("caller grants = %+v", caller.last.Grants)
	}
}

func TestInvokeServiceCallCarriesStudioActor(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	caller := &fakeServiceCaller{data: map[string]any{"ok": true}}
	actor := &services.Actor{UserID: uuid.New(), Role: "owner"}
	result, err := host.Invoke(context.Background(), Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:call-actor",
		Module:    serviceCallGuest(t, "screens.read@1/list", 4096),
		Grants:    Grants{Services: []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 1}}},
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   5 * time.Second,
		Context:   services.ContextStudio,
		Actor:     actor,
		Caller:    caller,
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	if result.Status <= 0 {
		t.Fatalf("status = %d, want envelope bytes", result.Status)
	}
	if !caller.seen || caller.last.Actor == nil || caller.last.Actor.UserID != actor.UserID || caller.last.Actor.Role != "owner" {
		t.Fatalf("caller actor = %+v", caller.last.Actor)
	}
}

func TestInvokeServiceCallDenialCodes(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	invoke := func(caller ServiceCaller) int32 {
		t.Helper()
		result, err := host.Invoke(context.Background(), Call{
			PackageID: "acme.athletics",
			Digest:    "sha256:call-deny",
			Module:    serviceCallGuest(t, "screens.read@1/drop", 4096),
			Entry:     "run_job",
			Input:     []byte("refresh"),
			Timeout:   5 * time.Second,
			Context:   services.ContextBackground,
			Caller:    caller,
		})
		if err != nil {
			t.Fatalf("Invoke returned error: %v", err)
		}
		return result.Status
	}
	if status := invoke(&fakeServiceCaller{denial: &services.Denial{Kind: services.DenialUnknownOperation}}); status != ErrNoOperation {
		t.Fatalf("unknown operation status = %d, want %d", status, ErrNoOperation)
	}
	if status := invoke(&fakeServiceCaller{denial: &services.Denial{Kind: services.DenialMissingGrant}}); status != ErrNoGrant {
		t.Fatalf("missing grant status = %d, want %d", status, ErrNoGrant)
	}
	if status := invoke(nil); status != ErrNoGrant {
		t.Fatalf("missing caller status = %d, want %d", status, ErrNoGrant)
	}
}

func TestInvokeServiceCallFailsClosed(t *testing.T) {
	host := testHost(t, NewMemoryKV())
	caller := &fakeServiceCaller{failure: &services.CallError{Code: services.ErrCodeInvalidInput, Message: "bad"}}
	result, err := host.Invoke(context.Background(), Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:call-fail",
		Module:    serviceCallGuest(t, "screens.read@1/list", 4096),
		Grants:    Grants{Services: []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 1}}},
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   5 * time.Second,
		Context:   services.ContextBackground,
		Caller:    caller,
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	want, err := services.MarshalFailure(caller.failure)
	if err != nil {
		t.Fatalf("MarshalFailure: %v", err)
	}
	if result.Status != int32(len(want)) {
		t.Fatalf("status = %d, want %d envelope bytes", result.Status, len(want))
	}
	// A clipped buffer writes nothing and answers too-large.
	clipped, err := host.Invoke(context.Background(), Call{
		PackageID: "acme.athletics",
		Digest:    "sha256:call-clip",
		Module:    serviceCallGuest(t, "screens.read@1/list", 4),
		Grants:    Grants{Services: []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 1}}},
		Entry:     "run_job",
		Input:     []byte("refresh"),
		Timeout:   5 * time.Second,
		Context:   services.ContextBackground,
		Caller:    &fakeServiceCaller{data: map[string]any{"id": "x"}},
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	if clipped.Status != ErrTooLarge {
		t.Fatalf("clipped status = %d, want %d", clipped.Status, ErrTooLarge)
	}
}
