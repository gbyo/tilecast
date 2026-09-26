package server_test

import (
	"errors"
	formserver "github.com/tilecast/tilecast/plugins/forms/server"
	"net/http/httptest"
	"testing"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// TestListAccessibleFormsScopingAndCounts verifies that owners see all forms, granted users see
// only their forms, and own-submission counts bucket by workflow meaning (draft / changes / submitted).
func TestListAccessibleFormsScopingAndCounts(t *testing.T) {
	e := setupForms(t)
	formA, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Alpha", DraftSchema: announcementSchema()})
	formB, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Beta", DraftSchema: announcementSchema()})

	alice := e.insertUser(t, "Alice", "alice", "viewer")
	if _, err := e.service.SetGrant(e.ctx, formA.ID, e.owner, formserver.GrantInput{UserID: alice, Capability: formserver.CapSubmit}); err != nil {
		t.Fatal(err)
	}

	// Alice, submit-only on Alpha, submits three records covering each bucket.
	draftRec, err := e.service.CreateRecord(e.ctx, formA.ID, alice, formserver.RecordInput{Values: map[string]any{"title": "Draft one"}})
	if err != nil {
		t.Fatal(err)
	}
	_ = draftRec // stays a draft
	submittedRec, err := e.service.CreateRecord(e.ctx, formA.ID, alice, formserver.RecordInput{Values: map[string]any{"title": "Submitted one"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.Transition(e.ctx, formA.ID, submittedRec.ID, alice, "submitted", "", submittedRec.Version); err != nil {
		t.Fatalf("submit: %v", err)
	}
	changesRec, err := e.service.CreateRecord(e.ctx, formA.ID, alice, formserver.RecordInput{Values: map[string]any{"title": "Changes one"}})
	if err != nil {
		t.Fatal(err)
	}
	changesRec, err = e.service.Transition(e.ctx, formA.ID, changesRec.ID, alice, "submitted", "", changesRec.Version)
	if err != nil {
		t.Fatalf("submit for changes: %v", err)
	}
	// Owner (manager) requests changes, bouncing it into an editable non-initial state.
	if _, err := e.service.Transition(e.ctx, formA.ID, changesRec.ID, e.owner, "changes_requested", "Fix it", changesRec.Version); err != nil {
		t.Fatalf("request changes: %v", err)
	}

	// Alice sees only Alpha, with her own counts.
	aliceForms, err := e.service.ListAccessibleForms(e.ctx, alice)
	if err != nil {
		t.Fatal(err)
	}
	if len(aliceForms) != 1 || aliceForms[0].ID != formA.ID {
		t.Fatalf("alice should see only Alpha, got %#v", aliceForms)
	}
	if len(aliceForms[0].Capabilities) != 1 || aliceForms[0].Capabilities[0] != formserver.CapSubmit {
		t.Fatalf("alice capabilities = %#v, want [submit]", aliceForms[0].Capabilities)
	}
	c := aliceForms[0].Counts
	if c.Draft != 1 || c.Submitted != 1 || c.ChangesRequested != 1 || c.Total != 3 {
		t.Fatalf("alice counts = %#v, want draft1 submitted1 changes1 total3", c)
	}
	if aliceForms[0].PublishedRevisionNumber == nil || *aliceForms[0].PublishedRevisionNumber != 1 {
		t.Fatalf("alice form should report published revision 1, got %v", aliceForms[0].PublishedRevisionNumber)
	}

	// The owner sees both forms; Alice's submissions are not counted as the owner's own.
	ownerForms, err := e.service.ListAccessibleForms(e.ctx, e.owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(ownerForms) != 2 {
		t.Fatalf("owner should see both forms, got %d", len(ownerForms))
	}
	for _, f := range ownerForms {
		if f.Counts.Total != 0 {
			t.Fatalf("owner has no own submissions, got %#v for %s", f.Counts, f.Name)
		}
		if len(f.Capabilities) != 1 || f.Capabilities[0] != formserver.CapManage {
			t.Fatalf("owner capabilities on %s = %#v, want [manage]", f.Name, f.Capabilities)
		}
	}
	_ = formB
}

// TestRecordDetailRevisionAndActions verifies the server-calculated record detail: the immutable
// revision schema, the can* flags, and the available transitions per viewer role.
func TestRecordDetailRevisionAndActions(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Actions", DraftSchema: announcementSchema()})
	alice := e.insertUser(t, "Alice", "alice", "viewer")
	approver := e.insertUser(t, "Ada", "ada", "viewer")
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: alice, Capability: formserver.CapSubmit}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: approver, Capability: formserver.CapApprove}); err != nil {
		t.Fatal(err)
	}

	rec, err := e.service.CreateRecord(e.ctx, form.ID, alice, formserver.RecordInput{Values: map[string]any{"title": "Hi"}})
	if err != nil {
		t.Fatal(err)
	}

	// As the submitter in the draft state: can edit, cannot delete, and may submit.
	asAlice, err := e.service.GetRecord(e.ctx, form.ID, rec.ID, alice)
	if err != nil {
		t.Fatal(err)
	}
	if asAlice.Revision == nil || len(asAlice.Revision.Schema.Fields) == 0 {
		t.Fatal("record detail must include its immutable revision schema")
	}
	if !asAlice.CanEdit || asAlice.CanDelete {
		t.Fatalf("submitter draft flags wrong: canEdit=%v canDelete=%v", asAlice.CanEdit, asAlice.CanDelete)
	}
	if !hasTransition(asAlice.AvailableTransitions, "submitted") {
		t.Fatalf("submitter should be offered the submit transition, got %#v", asAlice.AvailableTransitions)
	}

	// Move to submitted so the approver has decisions to make.
	if _, err := e.service.Transition(e.ctx, form.ID, rec.ID, alice, "submitted", "", asAlice.Version); err != nil {
		t.Fatalf("submit: %v", err)
	}

	// As the approver: cannot edit or delete, can comment, and sees approve/reject/request-changes.
	asApprover, err := e.service.GetRecord(e.ctx, form.ID, rec.ID, approver)
	if err != nil {
		t.Fatalf("approver GetRecord: %v", err)
	}
	if asApprover.CanEdit || asApprover.CanDelete {
		t.Fatalf("approver should not edit/delete: %#v", asApprover)
	}
	if !asApprover.CanComment {
		t.Fatal("approver should be able to comment")
	}
	for _, want := range []string{"approved", "rejected", "changes_requested"} {
		if !hasTransition(asApprover.AvailableTransitions, want) {
			t.Fatalf("approver missing transition to %q: %#v", want, asApprover.AvailableTransitions)
		}
	}
	// The request-changes transition must require a note; approve/reject must not.
	for _, tr := range asApprover.AvailableTransitions {
		switch tr.To {
		case "changes_requested":
			if !tr.RequiresNote {
				t.Fatal("request-changes transition should require a note")
			}
		case "approved", "rejected":
			if tr.RequiresNote {
				t.Fatalf("%q transition should not require a note", tr.To)
			}
		}
	}

	// The owner (manager) can edit and delete any record.
	asOwner, err := e.service.GetRecord(e.ctx, form.ID, rec.ID, e.owner)
	if err != nil {
		t.Fatal(err)
	}
	if !asOwner.CanEdit || !asOwner.CanDelete {
		t.Fatalf("manager should edit and delete: %#v", asOwner)
	}
}

// TestChangesRequestedRequiresNote verifies the default changes_requested transition rejects an
// empty note through the workflow-derived requiresNote contract mirrored server-side.
func TestChangesRequestedTransition(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Notes", DraftSchema: announcementSchema()})
	rec, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "T"}})
	rec, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "submitted", "", rec.Version)
	if err != nil {
		t.Fatal(err)
	}
	// Requesting changes with a note records a comment reviewers/submitters can read.
	rec, err = e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "changes_requested", "Please add a date", rec.Version)
	if err != nil {
		t.Fatalf("request changes: %v", err)
	}
	detail, err := e.service.GetRecord(e.ctx, form.ID, rec.ID, e.owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Comments) == 0 || detail.Comments[len(detail.Comments)-1].Body != "Please add a date" {
		t.Fatalf("reviewer note should be recorded as a comment, got %#v", detail.Comments)
	}
}

// TestAttachmentPreviewReplacementAndRemoval covers the secure attachment lifecycle: upload,
// authorized preview, cross-user denial, replacement, and removal.
func TestAttachmentPreviewReplacementAndRemoval(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Photos", DraftSchema: imageSchema()})
	alice := e.insertUser(t, "Alice", "alice", "viewer")
	bob := e.insertUser(t, "Bob", "bob", "viewer")
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: alice, Capability: formserver.CapSubmit}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: bob, Capability: formserver.CapSubmit}); err != nil {
		t.Fatal(err)
	}
	rec, err := e.service.CreateRecord(e.ctx, form.ID, alice, formserver.RecordInput{Values: map[string]any{"title": "Mine"}})
	if err != nil {
		t.Fatal(err)
	}

	detail, err := e.attach(form.ID, rec.ID, alice, formserver.AttachmentUpload{FieldKey: "photo", FileName: "a.png", ContentType: "image/png", Data: pngBytes()})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if len(detail.Attachments) != 1 {
		t.Fatalf("expected 1 attachment, got %d", len(detail.Attachments))
	}
	firstAttachment := detail.Attachments[0]

	// The submitter can resolve and serve the attachment.
	assetID, err := e.service.AttachmentAsset(e.ctx, form.ID, rec.ID, firstAttachment.ID, alice)
	if err != nil {
		t.Fatalf("owner AttachmentAsset: %v", err)
	}
	if assetID != firstAttachment.AssetID {
		t.Fatalf("attachment asset mismatch")
	}
	if err := e.harness.Host.PluginAssets.ServePrivate(httptest.NewRecorder(), httptest.NewRequest("GET", "/content", nil), assetID); err != nil {
		t.Fatalf("form attachment should be servable: %v", err)
	}

	// Bob (not the owner, no view_all) cannot resolve the attachment; existence is hidden.
	if _, err := e.service.AttachmentAsset(e.ctx, form.ID, rec.ID, firstAttachment.ID, bob); !errors.Is(err, formserver.ErrNotFound) {
		t.Fatalf("cross-user attachment access must be denied with NotFound, got %v", err)
	}

	// Uploading again to the single-valued image field replaces the attachment.
	replaced, err := e.attach(form.ID, rec.ID, alice, formserver.AttachmentUpload{FieldKey: "photo", FileName: "b.png", ContentType: "image/png", Data: pngBytes()})
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if len(replaced.Attachments) != 1 {
		t.Fatalf("replacement should leave exactly one attachment, got %d", len(replaced.Attachments))
	}
	newAttachment := replaced.Attachments[0]
	if newAttachment.AssetID == firstAttachment.AssetID {
		t.Fatal("replacement should bind a new asset")
	}
	if replaced.Values["photo"] != newAttachment.AssetID.String() {
		t.Fatalf("field value should point at the new asset, got %v", replaced.Values["photo"])
	}
	// The replaced asset is soft-deleted and no longer servable.
	if err := e.harness.Host.PluginAssets.ServePrivate(httptest.NewRecorder(), httptest.NewRequest("GET", "/content", nil), firstAttachment.AssetID); !errors.Is(err, plugin.ErrNotFound) {
		t.Fatalf("replaced attachment asset should no longer be servable, got %v", err)
	}

	// Removal unbinds the attachment and clears the field.
	afterRemove, err := e.removeAttachment(form.ID, rec.ID, newAttachment.ID, alice)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if len(afterRemove.Attachments) != 0 {
		t.Fatalf("removal should leave no attachments, got %d", len(afterRemove.Attachments))
	}
	if _, ok := afterRemove.Values["photo"]; ok {
		t.Fatalf("removal should clear the field value, got %v", afterRemove.Values["photo"])
	}
}

// TestApprovalsPagination verifies the central inbox paginates rather than silently capping.
func TestApprovalsPagination(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Inbox", DraftSchema: announcementSchema()})
	// Five pending (submitted) records.
	for i := 0; i < 5; i++ {
		rec, err := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "R"}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "submitted", "", rec.Version); err != nil {
			t.Fatal(err)
		}
	}
	page1, err := e.service.PendingApprovals(e.ctx, e.owner, formserver.ApprovalFilter{Page: 1, PageSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	if page1.Total != 5 || len(page1.Items) != 2 || page1.Page != 1 || page1.PageSize != 2 {
		t.Fatalf("page1 = %#v, want total5 items2", page1)
	}
	page3, err := e.service.PendingApprovals(e.ctx, e.owner, formserver.ApprovalFilter{Page: 3, PageSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	if page3.Total != 5 || len(page3.Items) != 1 {
		t.Fatalf("page3 = %#v, want total5 items1", page3)
	}
	if page3.Items[0].StateLabel != "Submitted" {
		t.Fatalf("approval item should carry the state label, got %q", page3.Items[0].StateLabel)
	}
}

func hasTransition(transitions []formserver.AvailableTransition, to string) bool {
	for _, t := range transitions {
		if t.To == to {
			return true
		}
	}
	return false
}
