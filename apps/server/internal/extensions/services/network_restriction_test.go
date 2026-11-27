package services

import (
	"context"
	"testing"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// A restricted invocation, such as a webhook verify hook, is refused every
// operation that reaches the network, before the operation runs.
func TestDenyNetworkRefusesNetworkOperations(t *testing.T) {
	networked := map[string]bool{}
	for _, capability := range capabilities {
		for _, operation := range capability.Operations {
			if operation.Network {
				networked[operation.Name] = true
			}
		}
	}
	if !networked["http.fetch@1/request"] || len(networked) != 1 {
		t.Fatalf("network operations %v: http.fetch@1/request is the one network operation of this release", networked)
	}
	dispatcher := NewDispatcher(Dependencies{})
	_, denial, failure := dispatcher.Call(context.Background(), Call{
		PluginID: "harness_hooks", Context: ContextSystem, Operation: "http.fetch@1/request",
		Grants: []packagemanifest.ServiceGrant{{ID: "http.fetch", Version: 1}}, Input: []byte(`{}`), DenyNetwork: true,
	})
	if failure != nil || denial == nil || denial.Kind != DenialForbiddenContext {
		t.Fatalf("denial %+v failure %+v", denial, failure)
	}
}
