package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"strings"
	"testing"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Operation transport limits: the defaults stay the package call window,
// and only bundled-only operations ask for more.

func TestPackageOperationsKeepTheDefaultWindow(t *testing.T) {
	for _, capability := range All() {
		for _, operation := range capability.Operations {
			limits := LimitsOf(operation)
			if limits.MaxInputBytes > MaxTransportBytes || limits.MaxOutputBytes > MaxTransportBytes {
				t.Errorf("%s asks for more than %d bytes", operation.Name, MaxTransportBytes)
			}
			if capability.AllowsCaller(CallerPackage) && (limits.MaxInputBytes != MaxInputBytes || limits.MaxOutputBytes != MaxOutputBytes) {
				t.Errorf("%s is callable by packages but changes the package call window", operation.Name)
			}
		}
	}
	if got := OperationLimits("unknown@1/op"); got.MaxInputBytes != MaxInputBytes || got.MaxOutputBytes != MaxOutputBytes {
		t.Fatalf("unknown operation limits %+v", got)
	}
}

func TestHTTPFetchLimitsHoldTheEncodedDomainLimits(t *testing.T) {
	limits := OperationLimits("http.fetch@1/request")
	body := base64.StdEncoding.EncodedLen(1 << 20)
	if body != base64Size(1<<20) {
		t.Fatalf("base64Size disagrees with the encoder: %d", base64Size(1<<20))
	}
	// A 1 MiB body in base64, 16 KiB of headers, an 8 KiB URL, and JSON.
	if limits.MaxInputBytes < body+16<<10+8<<10+1<<10 {
		t.Fatalf("input bound %d cannot hold a 1 MiB body", limits.MaxInputBytes)
	}
	if limits.MaxInputBytes > 2*body {
		t.Fatalf("input bound %d is far above what the domain needs", limits.MaxInputBytes)
	}
	answer := base64.StdEncoding.EncodedLen(16 << 20)
	if limits.MaxOutputBytes < answer+16<<10 || limits.MaxOutputBytes > answer+128<<10 {
		t.Fatalf("output bound %d does not fit a 16 MiB body in base64", limits.MaxOutputBytes)
	}
}

func TestInputBoundIsPerOperation(t *testing.T) {
	dispatcher := testDispatcher()
	big := []byte(`{"connection":"` + strings.Repeat("a", 40<<10) + `"}`)
	// A default operation refuses 40 KiB.
	_, denial, failure := dispatcher.Call(context.Background(), Call{
		PluginID: "sample_plugin", Context: ContextBackground,
		Grants:    []packagemanifest.ServiceGrant{{ID: "settings.read", Version: 1}},
		Operation: "settings.read@1/get", Input: big,
	})
	if denial != nil || failure == nil || failure.Code != ErrCodeTooLarge {
		t.Fatalf("default operation: denial %+v failure %+v", denial, failure)
	}
	// http.fetch@1 reads it and fails on its own input rules instead.
	_, denial, failure = dispatcher.Call(context.Background(), Call{
		PluginID: "sample_plugin", Context: ContextBackground,
		Grants:    []packagemanifest.ServiceGrant{{ID: "http.fetch", Version: 1}},
		Operation: "http.fetch@1/request", Input: big,
	})
	if denial != nil || failure == nil || failure.Code == ErrCodeTooLarge {
		t.Fatalf("http.fetch: denial %+v failure %+v", denial, failure)
	}
	// Past its own bound it refuses too.
	huge := append([]byte(`{"body":"`), bytes.Repeat([]byte("A"), HTTPFetchMaxInputBytes)...)
	_, _, failure = dispatcher.Call(context.Background(), Call{
		PluginID: "sample_plugin", Context: ContextBackground,
		Grants:    []packagemanifest.ServiceGrant{{ID: "http.fetch", Version: 1}},
		Operation: "http.fetch@1/request", Input: huge,
	})
	if failure == nil || failure.Code != ErrCodeTooLarge {
		t.Fatalf("over the http.fetch bound: %+v", failure)
	}
}

func TestPackagesCannotCallHTTPFetch(t *testing.T) {
	_, denial, _ := testDispatcher().Call(context.Background(), Call{
		PackageID: "acme.test", Context: ContextBackground,
		Grants:    []packagemanifest.ServiceGrant{{ID: "http.fetch", Version: 1}},
		Operation: "http.fetch@1/request", Input: []byte(`{}`),
	})
	if denial == nil || denial.Kind != DenialMissingGrant {
		t.Fatalf("denial = %+v, want missing grant", denial)
	}
	if err := ValidateGrants([]packagemanifest.ServiceGrant{{ID: "http.fetch", Version: 1}}); err == nil {
		t.Fatal("a package grant for http.fetch@1 validated")
	}
}

func TestOversizeInputIsCheckedAfterAuthorization(t *testing.T) {
	// A call that is not granted is denied before its size is considered,
	// so the input bound cannot be used to probe grants.
	_, denial, failure := testDispatcher().Call(context.Background(), Call{
		PackageID: "acme.test", Context: ContextBackground,
		Operation: "screens.read@1/list", Input: bytes.Repeat([]byte("a"), MaxInputBytes+1),
	})
	if denial == nil || failure != nil {
		t.Fatalf("denial %+v failure %+v", denial, failure)
	}
}
