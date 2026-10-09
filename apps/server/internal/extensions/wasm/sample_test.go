package wasm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/services"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// sampleModulePath resolves the committed Hello Services guest from the
// package directory, wherever the test binary runs.
func sampleModulePath(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the test file")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "..",
		"packages", "package-samples", "hello-services", "runtime", "hello_services.wasm")
}

// scriptedCaller answers the three operations the sample's report job
// calls, and records every operation with its decoded input.
type scriptedCaller struct {
	operations []string
	inputs     []map[string]any
}

func (s *scriptedCaller) Call(_ context.Context, call services.Call) (any, *services.Denial, *services.CallError) {
	var input map[string]any
	if len(call.Input) > 0 {
		_ = json.Unmarshal(call.Input, &input)
	}
	s.operations, s.inputs = append(s.operations, call.Operation), append(s.inputs, input)
	switch call.Operation {
	case "organization.read@1/get":
		return map[string]any{"id": "org-1", "name": "Civic Library"}, nil, nil
	case "screens.read@1/list":
		return map[string]any{"items": []any{}, "total": 3, "page": 1, "pageSize": 50}, nil, nil
	case "audit.write@1/write":
		return map[string]any{"written": true}, nil, nil
	default:
		return nil, &services.Denial{Kind: services.DenialUnknownOperation}, nil
	}
}

// TestSampleHelloServicesReport runs the committed sample guest through
// the real host: validation, instantiation, the run_job entry, and
// three call_v1 round trips. It proves the reference guest SDK speaks
// the host ABI byte for byte.
func TestSampleHelloServicesReport(t *testing.T) {
	raw, err := os.ReadFile(sampleModulePath(t))
	if err != nil {
		t.Fatalf("read the sample module: %v", err)
	}
	module, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse refused the sample module: %v", err)
	}
	found := false
	for _, name := range module.Imports {
		found = found || name == "call_v1"
	}
	if !found {
		t.Fatalf("sample imports = %v, want call_v1", module.Imports)
	}
	if module.Exports["run_job"] != 0 || module.Exports["handle_ui_request"] != 0 {
		t.Fatalf("sample exports = %v, want run_job and handle_ui_request", module.Exports)
	}

	host := testHost(t, NewMemoryKV())
	caller := &scriptedCaller{}
	result, err := host.Invoke(context.Background(), Call{
		PackageID: "example.hello-services",
		Digest:    "sha256:sample",
		Module:    raw,
		Grants: Grants{Services: []packagemanifest.ServiceGrant{
			{ID: "organization.read", Version: 1},
			{ID: "screens.read", Version: 1},
			{ID: "audit.write", Version: 1},
		}},
		Entry:   "run_job",
		Input:   []byte("report"),
		Timeout: 30 * time.Second,
		Context: services.ContextBackground,
		Caller:  caller,
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	if result.Status != 0 {
		t.Fatalf("report status = %d, want 0", result.Status)
	}
	want := []string{"organization.read@1/get", "screens.read@1/list", "audit.write@1/write"}
	if len(caller.operations) != len(want) {
		t.Fatalf("operations = %v, want %v", caller.operations, want)
	}
	for i, operation := range want {
		if caller.operations[i] != operation {
			t.Fatalf("operations = %v, want %v", caller.operations, want)
		}
	}
	audit := caller.inputs[2]
	if audit["action"] != "package.screens.reported" {
		t.Fatalf("audit input = %v", audit)
	}
	metadata, _ := audit["metadata"].(map[string]any)
	if metadata["organization"] != "Civic Library" || metadata["screenCount"] != float64(3) {
		t.Fatalf("audit metadata = %v", metadata)
	}
}

// TestSampleHelloServicesRejectsUnknownJob proves the sample fails
// closed on a job identity it does not declare, without calling any
// service.
func TestSampleHelloServicesRejectsUnknownJob(t *testing.T) {
	raw, err := os.ReadFile(sampleModulePath(t))
	if err != nil {
		t.Fatalf("read the sample module: %v", err)
	}
	host := testHost(t, NewMemoryKV())
	caller := &scriptedCaller{}
	result, err := host.Invoke(context.Background(), Call{
		PackageID: "example.hello-services",
		Digest:    "sha256:sample-unknown",
		Module:    raw,
		Entry:     "run_job",
		Input:     []byte("midnight-heist"),
		Timeout:   30 * time.Second,
		Context:   services.ContextBackground,
		Caller:    caller,
	})
	if err != nil {
		t.Fatalf("Invoke returned error: %v", err)
	}
	if result.Status != -1 {
		t.Fatalf("unknown job status = %d, want -1", result.Status)
	}
	if len(caller.operations) != 0 {
		t.Fatalf("unknown job called %v", caller.operations)
	}
}
