package samplev3

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest"
)

func TestDeclarationsAndGeneratedRoutes(t *testing.T) {
	p := New()
	if err := plugin.CheckDeclarations(p); err != nil {
		t.Fatal(err)
	}
	routes := plugin.GeneratedRoutes(p.Manifest())
	// Two settings scopes and two instance kinds, five routes each kind.
	if len(routes) != 4+10 {
		t.Fatalf("generated routes = %d: %v", len(routes), routes)
	}
	personal := p.Manifest().PersonalFields()
	if len(personal) != 1 || personal["instances.sign.contact"].RetentionDays != 1 {
		t.Fatalf("personal fields = %v", personal)
	}
}

func TestServiceClientRefusesWhatTheManifestDoesNotDeclare(t *testing.T) {
	var called []string
	services := plugintest.Services(New().Manifest(), func(operation string, _ []byte) (any, error) {
		called = append(called, operation)
		return map[string]string{"value": "token"}, nil
	})
	if value, err := services.ReadSecret(context.Background(), plugin.ScopeOrganization, uuid.Nil, "apiToken"); err != nil || value != "token" {
		t.Fatalf("declared service: %q %v", value, err)
	}
	// takeovers.manage@1 is not declared, and is not offered to bundled plugins.
	err := services.Call(context.Background(), "takeovers.manage@1/activate", nil, nil)
	var denial *plugin.ServiceDenial
	if !errors.As(err, &denial) || denial.Kind != "missing_grant" {
		t.Fatalf("undeclared service = %v", err)
	}
	if err := services.Call(context.Background(), "not-an-operation", nil, nil); err == nil {
		t.Fatal("a malformed operation token was sent")
	}
	if len(called) != 1 {
		t.Fatalf("the transport was reached for refused calls: %v", called)
	}
}

func TestSecretUnavailableIsATypedFailure(t *testing.T) {
	services := plugintest.Services(New().Manifest(), func(string, []byte) (any, error) {
		return nil, &plugin.ServiceError{Code: plugin.ServiceSecretUnavailable, Message: "enter it again"}
	})
	_, err := services.ReadSecret(context.Background(), plugin.ScopeOrganization, uuid.Nil, "apiToken")
	if !plugin.IsServiceError(err, plugin.ServiceSecretUnavailable) {
		t.Fatalf("err = %v", err)
	}
}

func TestInstanceCountBoundMatchesTheDeclaredLimit(t *testing.T) {
	if plugin.MaxInstanceKinds != 16 {
		t.Fatalf("MaxInstanceKinds = %d; the TypeScript schema and docs say 16", plugin.MaxInstanceKinds)
	}
}
