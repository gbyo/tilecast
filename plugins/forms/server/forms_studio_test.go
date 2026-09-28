package server_test

import (
	"errors"
	formserver "github.com/tilecast/tilecast/plugins/forms/server"
	"testing"

	"github.com/google/uuid"
)

func strptr(value string) *string { return &value }

// --- 5. Metadata update endpoint (service level) ---

func TestUpdateMetadata(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Original", Description: "d", DraftSchema: announcementSchema()})

	// Success: name and description are updated on the parent Data Source row.
	updated, err := e.service.UpdateMetadata(e.ctx, form.ID, e.owner, formserver.MetadataInput{Name: "Staff Announcements", Description: strptr("By staff.")})
	if err != nil {
		t.Fatalf("update metadata: %v", err)
	}
	if updated.Name != "Staff Announcements" || updated.Description != "By staff." {
		t.Fatalf("metadata not updated: %+v", updated)
	}

	// An omitted description (nil) preserves the stored value; the name still updates.
	preserved, err := e.service.UpdateMetadata(e.ctx, form.ID, e.owner, formserver.MetadataInput{Name: "Renamed"})
	if err != nil {
		t.Fatalf("update name only: %v", err)
	}
	if preserved.Name != "Renamed" || preserved.Description != "By staff." {
		t.Fatalf("omitted description must be preserved: %+v", preserved)
	}

	// An explicit empty description clears it.
	cleared, err := e.service.UpdateMetadata(e.ctx, form.ID, e.owner, formserver.MetadataInput{Name: "Renamed", Description: strptr("")})
	if err != nil {
		t.Fatalf("clear description: %v", err)
	}
	if cleared.Description != "" {
		t.Fatalf("explicit empty description must clear: %+v", cleared)
	}

	// Validation: empty name is rejected.
	if _, err := e.service.UpdateMetadata(e.ctx, form.ID, e.owner, formserver.MetadataInput{Name: "   "}); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("expected validation error for empty name, got %v", err)
	}

	// Authorization: a submitter-only user cannot update metadata (enforced by the HTTP layer via
	// Authorize; verify the capability check directly here).
	viewer := e.insertUser(t, "Val", "val", "viewer")
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: viewer, Capability: formserver.CapSubmit}); err != nil {
		t.Fatal(err)
	}
	allowed, err := e.service.Authorize(e.ctx, form.ID, viewer, formserver.CapManage)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("submitter must not have manage capability")
	}
	// A viewer granted manage on this form may manage it even without a global editor role.
	manager := e.insertUser(t, "Man", "man", "viewer")
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: manager, Capability: formserver.CapManage}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.UpdateMetadata(e.ctx, form.ID, manager, formserver.MetadataInput{Name: "Managed", Description: strptr("")}); err != nil {
		t.Fatalf("granted manager should update metadata: %v", err)
	}
}

// --- 6. Publish compatibility checks ---

func TestPublishCompatibility(t *testing.T) {
	e := setupForms(t)

	base := func() formserver.FormSchema {
		return formserver.FormSchema{Fields: []formserver.FormField{
			{Key: "title", Label: "Title", Control: formserver.ControlShortText, Required: true},
			{Key: "count", Label: "Count", Control: formserver.ControlInteger},
			{Key: "intro", Label: "Intro", Control: formserver.ControlSection},
		}}
	}
	newForm := func(name string) uuid.UUID {
		f, err := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: name, DraftSchema: base()})
		if err != nil {
			t.Fatal(err)
		}
		return f.ID
	}
	publishDraft := func(id uuid.UUID, schema formserver.FormSchema) error {
		if _, err := e.service.UpdateDraft(e.ctx, id, e.owner, formserver.DraftInput{Schema: schema}); err != nil {
			t.Fatal(err)
		}
		_, err := e.service.PublishRevision(e.ctx, id, e.owner)
		return err
	}

	// Removing a published output field is rejected.
	id := newForm("remove")
	removed := formserver.FormSchema{Fields: []formserver.FormField{{Key: "title", Label: "Title", Control: formserver.ControlShortText}}}
	if err := publishDraft(id, removed); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("removing a published field must fail, got %v", err)
	}

	// Changing a published field from text to number is rejected.
	id = newForm("retype")
	retyped := base()
	retyped.Fields[0].Control = formserver.ControlNumber // title text -> number
	if err := publishDraft(id, retyped); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("changing output type must fail, got %v", err)
	}

	// Reordering fields is allowed.
	id = newForm("reorder")
	reordered := formserver.FormSchema{Fields: []formserver.FormField{
		{Key: "count", Label: "Count", Control: formserver.ControlInteger},
		{Key: "title", Label: "Title", Control: formserver.ControlShortText, Required: true},
		{Key: "intro", Label: "Intro", Control: formserver.ControlSection},
	}}
	if err := publishDraft(id, reordered); err != nil {
		t.Fatalf("reordering must be allowed, got %v", err)
	}

	// Renaming a label while preserving the key is allowed.
	id = newForm("relabel")
	relabeled := base()
	relabeled.Fields[0].Label = "Headline"
	if err := publishDraft(id, relabeled); err != nil {
		t.Fatalf("relabeling must be allowed, got %v", err)
	}

	// Adding a new field is allowed.
	id = newForm("add")
	added := base()
	added.Fields = append(added.Fields, formserver.FormField{Key: "note", Label: "Note", Control: formserver.ControlLongText})
	if err := publishDraft(id, added); err != nil {
		t.Fatalf("adding a field must be allowed, got %v", err)
	}

	// Removing a presentation-only field is allowed.
	id = newForm("drop_section")
	withoutSection := formserver.FormSchema{Fields: []formserver.FormField{
		{Key: "title", Label: "Title", Control: formserver.ControlShortText, Required: true},
		{Key: "count", Label: "Count", Control: formserver.ControlInteger},
	}}
	if err := publishDraft(id, withoutSection); err != nil {
		t.Fatalf("removing a presentation-only field must be allowed, got %v", err)
	}

	// Publishing a draft identical to the current published revision is a no-op and rejected.
	id = newForm("noop")
	if err := publishDraft(id, base()); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("publishing an identical revision must be rejected, got %v", err)
	}
}

// --- 16. Non-manager response shaping ---

func TestNonManagerSeesPublishedSchemaOnly(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Shaped", DraftSchema: announcementSchema()})
	// Add an unpublished draft-only field.
	draft := announcementSchema()
	draft.Fields = append(draft.Fields, formserver.FormField{Key: "secret", Label: "Draft only", Control: formserver.ControlShortText})
	if _, err := e.service.UpdateDraft(e.ctx, form.ID, e.owner, formserver.DraftInput{Schema: draft}); err != nil {
		t.Fatal(err)
	}

	// A submitter (non-manager) must not receive the draft-only field.
	viewer := e.insertUser(t, "Vic", "vic", "viewer")
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: viewer, Capability: formserver.CapSubmit}); err != nil {
		t.Fatal(err)
	}
	// Grant view access so GetForm succeeds for the viewer.
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: viewer, Capability: formserver.CapViewOwn}); err != nil {
		t.Fatal(err)
	}
	asViewer, err := e.service.GetForm(e.ctx, form.ID, viewer)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range asViewer.DraftSchema.Fields {
		if field.Key == "secret" {
			t.Fatal("non-manager must not see draft-only fields in the visible schema")
		}
	}
	if hasFormCap(asViewer.Capabilities, formserver.CapManage) {
		t.Fatal("viewer must not report manage capability")
	}

	// The manager still sees the full draft.
	asOwner, err := e.service.GetForm(e.ctx, form.ID, e.owner)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, field := range asOwner.DraftSchema.Fields {
		if field.Key == "secret" {
			found = true
		}
	}
	if !found {
		t.Fatal("manager should see the full draft schema")
	}
}

func hasFormCap(caps []formserver.Capability, want formserver.Capability) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}
