package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"

	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// These tests cover the dispatcher paths that never touch the database:
// transport authorization (operation, grant, context, actor), envelope
// shapes, strict input decoding, and Studio role policy. Adapter
// behavior against domain services lives in the integration tests.

func testDispatcher() *Dispatcher {
	return NewDispatcher(Dependencies{})
}

func TestCallDeniesUnknownOperation(t *testing.T) {
	_, denial, _ := testDispatcher().Call(context.Background(), Call{
		PackageID: "acme.test", Context: ContextBackground,
		Operation: "screens.read@1/drop",
	})
	if denial == nil || denial.Kind != DenialUnknownOperation {
		t.Fatalf("denial = %+v, want unknown operation", denial)
	}
}

func TestCallDeniesMissingGrant(t *testing.T) {
	_, denial, _ := testDispatcher().Call(context.Background(), Call{
		PackageID: "acme.test", Context: ContextBackground,
		Grants:    []packagemanifest.ServiceGrant{{ID: "content.read", Version: 1}},
		Operation: "screens.read@1/list",
	})
	if denial == nil || denial.Kind != DenialMissingGrant {
		t.Fatalf("denial = %+v, want missing grant", denial)
	}
}

func TestCallDeniesWrongVersion(t *testing.T) {
	_, denial, _ := testDispatcher().Call(context.Background(), Call{
		PackageID: "acme.test", Context: ContextBackground,
		Grants:    []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 2}},
		Operation: "screens.read@1/list",
	})
	if denial == nil || denial.Kind != DenialMissingGrant {
		t.Fatalf("denial = %+v, want missing grant", denial)
	}
}

func TestCallDeniesBadContextAndActor(t *testing.T) {
	dispatcher := testDispatcher()
	grants := []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 1}}
	// A future system context invokes nothing today.
	if _, denial, _ := dispatcher.Call(context.Background(), Call{Context: ContextSystem, Grants: grants, Operation: "screens.read@1/list"}); denial == nil || denial.Kind != DenialForbiddenContext {
		t.Fatalf("system context denial = %+v", denial)
	}
	// Studio calls require an authenticated actor.
	if _, denial, _ := dispatcher.Call(context.Background(), Call{Context: ContextStudio, Grants: grants, Operation: "screens.read@1/list"}); denial == nil || denial.Kind != DenialInvalidActor {
		t.Fatalf("missing actor denial = %+v", denial)
	}
	// Background calls never carry an actor.
	actor := &Actor{UserID: uuid.New(), Role: "owner"}
	if _, denial, _ := dispatcher.Call(context.Background(), Call{Context: ContextBackground, Actor: actor, Grants: grants, Operation: "screens.read@1/list"}); denial == nil || denial.Kind != DenialInvalidActor {
		t.Fatalf("background actor denial = %+v", denial)
	}
}

func TestCallRejectsOversizeInput(t *testing.T) {
	_, _, failure := testDispatcher().Call(context.Background(), Call{
		Context:   ContextBackground,
		Grants:    []packagemanifest.ServiceGrant{{ID: "screens.read", Version: 1}},
		Operation: "screens.read@1/list", Input: make([]byte, MaxInputBytes+1),
	})
	if failure == nil || failure.Code != ErrCodeTooLarge {
		t.Fatalf("failure = %+v, want too_large", failure)
	}
}

func TestStudioRolePolicy(t *testing.T) {
	dispatcher := testDispatcher()
	viewer := &Actor{UserID: uuid.New(), Role: "viewer"}
	// Viewers may not browse the user directory from Studio.
	if _, _, failure := dispatcher.Call(context.Background(), Call{
		Context: ContextStudio, Actor: viewer,
		Grants:    []packagemanifest.ServiceGrant{{ID: "users.read-basic", Version: 1}},
		Operation: "users.read-basic@1/search", Input: []byte(`{"query":"a"}`),
	}); failure == nil || failure.Code != ErrCodeForbidden {
		t.Fatalf("viewer directory search = %+v, want forbidden", failure)
	}
	// Viewers may not start takeovers from Studio.
	if _, _, failure := dispatcher.Call(context.Background(), Call{
		Context: ContextStudio, Actor: viewer,
		Grants:    []packagemanifest.ServiceGrant{{ID: "takeovers.manage", Version: 1}},
		Operation: "takeovers.manage@1/cancel", Input: []byte(`{"id":"` + uuid.NewString() + `"}`),
	}); failure == nil || failure.Code != ErrCodeForbidden {
		t.Fatalf("viewer takeover cancel = %+v, want forbidden", failure)
	}
	// Contributors sit inside the content-author set for managed data.
	contributor := &Actor{UserID: uuid.New(), Role: "contributor"}
	if failure := studioRole(Call{Context: ContextStudio, Actor: contributor}, "owner", "administrator", "editor", "contributor"); failure != nil {
		t.Fatalf("contributor managed role = %+v, want allowed", failure)
	}
	if failure := studioRole(Call{Context: ContextStudio, Actor: viewer}, "owner", "administrator", "editor", "contributor"); failure == nil || failure.Code != ErrCodeForbidden {
		t.Fatalf("viewer managed role = %+v, want forbidden", failure)
	}
}

func TestEnvelopeShapes(t *testing.T) {
	raw, err := MarshalSuccess(map[string]any{"id": "x"})
	if err != nil {
		t.Fatalf("MarshalSuccess: %v", err)
	}
	var success struct {
		OK   bool           `json:"ok"`
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(raw, &success); err != nil || !success.OK || success.Data["id"] != "x" {
		t.Fatalf("success envelope = %s", raw)
	}
	raw, err = MarshalFailure(invalidInput("bad"))
	if err != nil {
		t.Fatalf("MarshalFailure: %v", err)
	}
	var failure Envelope
	if err := json.Unmarshal(raw, &failure); err != nil || failure.OK || failure.Error == nil || failure.Error.Code != ErrCodeInvalidInput {
		t.Fatalf("failure envelope = %s", raw)
	}
}

func TestDecodeIsStrict(t *testing.T) {
	var out struct {
		Name string `json:"name"`
	}
	if failure := decode([]byte(`{"name":"x","extra":1}`), &out); failure == nil || failure.Code != ErrCodeInvalidInput {
		t.Fatalf("unknown field = %+v, want invalid_input", failure)
	}
	if failure := decode([]byte(`{}`), &out); failure != nil {
		t.Fatalf("empty object = %+v, want nil", failure)
	}
	if failure := decode(nil, &out); failure != nil {
		t.Fatalf("empty input = %+v, want nil", failure)
	}
	if failure := decode([]byte(`{"name":`), &out); failure == nil {
		t.Fatal("truncated JSON decoded")
	}
}

func TestEveryRegistryOperationDispatches(t *testing.T) {
	// Every registry operation must reach a handler, not the default
	// denial: with empty grants the dispatcher denies for the missing
	// grant, which proves the token resolved and routed.
	dispatcher := testDispatcher()
	for _, capability := range All() {
		for _, operation := range capability.Operations {
			_, denial, _ := dispatcher.Call(context.Background(), Call{
				Context: ContextBackground, Operation: operation.Name,
			})
			if denial == nil || denial.Kind != DenialMissingGrant {
				t.Fatalf("operation %s denial = %+v, want missing grant", operation.Name, denial)
			}
			if !strings.Contains(denial.Message, capability.ID) {
				t.Fatalf("operation %s denial names %q", operation.Name, denial.Message)
			}
		}
	}
}
