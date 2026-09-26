package server_test

import (
	"errors"
	formserver "github.com/tilecast/tilecast/plugins/forms/server"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

func requiredImageSchema() formserver.FormSchema {
	return formserver.FormSchema{Fields: []formserver.FormField{
		{Key: "title", Label: "Title", Control: formserver.ControlShortText, Required: true, MaxLength: 120},
		{Key: "photo", Label: "Photo", Control: formserver.ControlImage, Required: true},
	}}
}

// TestPrivateAttachmentsStayPrivate verifies the private-asset boundary in
// both directions: library assets are refused by the plugin's asset service,
// and the record-scoped delivery still serves a bound attachment.
func TestPrivateAttachmentsStayPrivate(t *testing.T) {
	e := setupForms(t)
	assets := e.harness.Host.PluginAssets
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Photos", DraftSchema: imageSchema()})
	rec, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "Has photo"}})
	detail, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "photo", FileName: "p.png", ContentType: "image/png", Data: pngBytes()})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	assetID := detail.Attachments[0].AssetID

	libraryID := uuid.New()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status)
		VALUES($1,(SELECT id FROM organization_settings WHERE singleton),'Library','image','l.png','image/png','\x00','10','ready')`, libraryID); err != nil {
		t.Fatal(err)
	}
	tx, err := e.pool.Begin(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(e.ctx) //nolint:errcheck
	if err := assets.ClaimPrivateInTx(e.ctx, tx, libraryID); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("ClaimPrivate should refuse library assets, got %v", err)
	}
	if err := tx.Commit(e.ctx); err != nil {
		t.Fatal(err)
	}
	serve := func(id uuid.UUID) error {
		return assets.ServePrivate(httptest.NewRecorder(), httptest.NewRequest("GET", "/content", nil), id)
	}
	if err := serve(libraryID); !errors.Is(err, plugin.ErrNotFound) {
		t.Fatalf("ServePrivate should refuse library assets, got %v", err)
	}
	if err := assets.DiscardPrivate(e.ctx, libraryID); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("DiscardPrivate should refuse library assets, got %v", err)
	}
	if err := serve(uuid.New()); !errors.Is(err, plugin.ErrNotFound) {
		t.Fatalf("ServePrivate should 404 missing assets, got %v", err)
	}
	// The record-scoped delivery remains available.
	if err := serve(assetID); err != nil {
		t.Fatalf("record-scoped delivery should work: %v", err)
	}
}

// TestImageValueForgeryRejected verifies a client cannot set an image field's value directly and
// that a normal value edit preserves the server-managed image value.
func TestImageValueForgeryRejected(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Photos", DraftSchema: imageSchema()})

	// Forging an image value on create is rejected.
	if _, err := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "T", "photo": uuid.New().String()}}); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("create with forged image value should be rejected, got %v", err)
	}

	rec, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "T"}})
	detail, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "photo", FileName: "p.png", ContentType: "image/png", Data: pngBytes()})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	assetID := detail.Attachments[0].AssetID.String()

	// Forging an image value on update is rejected.
	if _, err := e.service.UpdateRecord(e.ctx, form.ID, rec.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "T", "photo": uuid.New().String()}}, detail.Version); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("update with forged image value should be rejected, got %v", err)
	}

	// A normal edit that omits the image preserves the bound image value.
	updated, err := e.service.UpdateRecord(e.ctx, form.ID, rec.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "New title"}}, detail.Version)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Values["photo"] != assetID {
		t.Fatalf("image value should be preserved, got %v", updated.Values["photo"])
	}
}

// TestRequiredImageRequiresBoundAttachment verifies a required image field is satisfied only by a
// live bound attachment, not by the client payload.
func TestRequiredImageRequiresBoundAttachment(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Photos", DraftSchema: requiredImageSchema()})
	rec, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "T"}})

	// Submitting without an attachment fails the required-image check.
	if _, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "submitted", "", rec.Version); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("submit without image should fail, got %v", err)
	}
	// After a real upload, the submit succeeds.
	detail, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "photo", FileName: "p.png", ContentType: "image/png", Data: pngBytes()})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if _, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "submitted", "", detail.Version); err != nil {
		t.Fatalf("submit with image should succeed: %v", err)
	}
}

// TestApprovedAttachmentReplacementRebuildsProjection verifies replacing an attachment on an
// output-eligible record updates the projection and drops the old asset, and that removing a
// required image from an approved record is rejected.
func TestApprovedAttachmentReplacementRebuildsProjection(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Photos", DraftSchema: requiredImageSchema()})
	rec, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "T"}})
	first, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "photo", FileName: "a.png", ContentType: "image/png", Data: pngBytes()})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	firstAsset := first.Attachments[0].AssetID
	rec2, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "submitted", "", first.Version)
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if _, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "approved", "", rec2.Version); err != nil {
		t.Fatalf("approve: %v", err)
	}

	// The approved record projects with the first asset.
	payload := e.readPayload(t, form.ID)
	ds, _ := datasetByID(payload, "approved")
	if len(ds.Records) != 1 || ds.Records[0].Values["photo"] != firstAsset.String() {
		t.Fatalf("approved projection should reference the first asset, got %#v", ds.Records)
	}

	// Replacing the image rebuilds the projection to the new asset and drops the old one.
	replaced, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "photo", FileName: "b.png", ContentType: "image/png", Data: pngBytes()})
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	newAsset := replaced.Attachments[0].AssetID
	if newAsset == firstAsset {
		t.Fatal("replacement should bind a new asset")
	}
	payload = e.readPayload(t, form.ID)
	ds, _ = datasetByID(payload, "approved")
	if len(ds.Records) != 1 || ds.Records[0].Values["photo"] != newAsset.String() {
		t.Fatalf("projection should reference the new asset, got %#v", ds.Records)
	}
	// The cached output no longer references the deleted asset, and the old asset is gone.
	if err := e.harness.Host.PluginAssets.ServePrivate(httptest.NewRecorder(), httptest.NewRequest("GET", "/content", nil), firstAsset); !errors.Is(err, plugin.ErrNotFound) {
		t.Fatalf("the replaced asset should be soft-deleted, got %v", err)
	}

	// Removing the required image from the approved (eligible) record is rejected.
	if _, err := e.removeAttachment(form.ID, rec.ID, replaced.Attachments[0].ID, e.owner); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("removing a required image from an approved record should be rejected, got %v", err)
	}
}

// TestReplacementLeavesOneAttachmentPerField verifies the single-attachment-per-field invariant.
func TestReplacementLeavesOneAttachmentPerField(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Photos", DraftSchema: imageSchema()})
	rec, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "T"}})
	if _, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "photo", FileName: "a.png", ContentType: "image/png", Data: pngBytes()}); err != nil {
		t.Fatal(err)
	}
	detail, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "photo", FileName: "b.png", ContentType: "image/png", Data: pngBytes()})
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Attachments) != 1 {
		t.Fatalf("a field should hold exactly one attachment, got %d", len(detail.Attachments))
	}
	// The UNIQUE(record_id, field_key) constraint is the hard backstop.
	var count int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM form_record_attachments WHERE record_id=$1 AND field_key='photo'`, rec.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected one attachment row for the field, got %d", count)
	}
}

// TestAttachmentOptimisticConcurrency verifies attachment upload and removal reject a stale record
// version with a conflict and succeed at the current version.
func TestAttachmentOptimisticConcurrency(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Photos", DraftSchema: imageSchema()})
	rec, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "T"}})
	upload := formserver.AttachmentUpload{FieldKey: "photo", FileName: "p.png", ContentType: "image/png", Data: pngBytes()}

	// A stale upload version is rejected.
	if _, err := e.service.CreateAttachment(e.ctx, form.ID, rec.ID, e.owner, upload, rec.Version+5); !errors.Is(err, formserver.ErrConflict) {
		t.Fatalf("stale upload should conflict, got %v", err)
	}
	// The current version succeeds and increments the record version.
	detail, err := e.service.CreateAttachment(e.ctx, form.ID, rec.ID, e.owner, upload, rec.Version)
	if err != nil {
		t.Fatalf("upload at current version: %v", err)
	}
	if detail.Version <= rec.Version {
		t.Fatalf("upload should increment the version: before=%d after=%d", rec.Version, detail.Version)
	}
	// A stale removal version (the pre-upload version) is rejected.
	if _, err := e.service.RemoveAttachment(e.ctx, form.ID, rec.ID, detail.Attachments[0].ID, e.owner, rec.Version); !errors.Is(err, formserver.ErrConflict) {
		t.Fatalf("stale removal should conflict, got %v", err)
	}
	// The current version succeeds.
	after, err := e.service.RemoveAttachment(e.ctx, form.ID, rec.ID, detail.Attachments[0].ID, e.owner, detail.Version)
	if err != nil {
		t.Fatalf("removal at current version: %v", err)
	}
	if len(after.Attachments) != 0 {
		t.Fatalf("removal should leave no attachments, got %d", len(after.Attachments))
	}
}

// TestFailedBindingCleansUpIngestedAsset verifies a bind/validation failure after ingest does not
// leak the freshly ingested asset.
func TestFailedBindingCleansUpIngestedAsset(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Photos", DraftSchema: requiredImageSchema()})
	rec, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "T"}})
	// Force an output-eligible record that is missing its required title, so the post-attachment
	// validation fails and the ingested asset must be cleaned up.
	if _, err := e.pool.Exec(e.ctx, `UPDATE form_records SET eligible=TRUE,values='{}'::jsonb WHERE id=$1`, rec.ID); err != nil {
		t.Fatal(err)
	}
	var liveBefore int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM assets WHERE origin='form_attachment' AND deleted_at IS NULL`).Scan(&liveBefore); err != nil {
		t.Fatal(err)
	}
	if _, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "photo", FileName: "p.png", ContentType: "image/png", Data: pngBytes()}); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("attachment on an incomplete eligible record should fail validation, got %v", err)
	}
	var liveAfter int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM assets WHERE origin='form_attachment' AND deleted_at IS NULL`).Scan(&liveAfter); err != nil {
		t.Fatal(err)
	}
	if liveAfter != liveBefore {
		t.Fatalf("ingested asset should be cleaned up on failure: live before=%d after=%d", liveBefore, liveAfter)
	}
}

// TestEmptyRequiredNoteRejected verifies the server enforces required transition notes.
func TestEmptyRequiredNoteRejected(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Notes", DraftSchema: announcementSchema()})
	rec, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "T"}})
	rec, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "submitted", "", rec.Version)
	if err != nil {
		t.Fatal(err)
	}
	// The default changes_requested transition requires a note.
	if _, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "changes_requested", "   ", rec.Version); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("empty required note should be rejected, got %v", err)
	}
	if _, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "changes_requested", "Please revise", rec.Version); err != nil {
		t.Fatalf("transition with a note should succeed: %v", err)
	}
}

// TestApprovalSubmittedAtReflectsTransition verifies the approvals inbox orders by the transition
// into the pending state, not record creation order.
func TestApprovalSubmittedAtReflectsTransition(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Inbox", DraftSchema: announcementSchema()})
	// A is created first, B second.
	recA, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "A"}})
	recB, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "B"}})
	// B is submitted before A, so B entered the pending state first.
	if _, err := e.service.Transition(e.ctx, form.ID, recB.ID, e.owner, "submitted", "", recB.Version); err != nil {
		t.Fatal(err)
	}
	// Nudge A's submit transition to a later timestamp so ordering is unambiguous.
	if _, err := e.service.Transition(e.ctx, form.ID, recA.ID, e.owner, "submitted", "", recA.Version); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE form_record_events SET created_at=created_at+interval '1 minute'
		WHERE record_id=$1 AND event_type='transition' AND to_state='submitted'`, recA.ID); err != nil {
		t.Fatal(err)
	}
	page, err := e.service.PendingApprovals(e.ctx, e.owner, formserver.ApprovalFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("expected 2 pending items, got %d", len(page.Items))
	}
	// Ordered by submission (transition) time ascending: B first, then A.
	if page.Items[0].RecordID != recB.ID || page.Items[1].RecordID != recA.ID {
		t.Fatalf("approvals should order by transition-into-pending time (B before A), got %s then %s", page.Items[0].Title, page.Items[1].Title)
	}
}
