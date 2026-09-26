package server_test

import (
	"encoding/json"
	"errors"
	formserver "github.com/tilecast/tilecast/plugins/forms/server"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// pngBytes returns a minimal byte slice that DetectType recognizes as a PNG image.
func pngBytes() []byte {
	return append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
}

func imageSchema() formserver.FormSchema {
	return formserver.FormSchema{Fields: []formserver.FormField{
		{Key: "title", Label: "Title", Control: formserver.ControlShortText, Required: true, MaxLength: 120},
		{Key: "photo", Label: "Photo", Control: formserver.ControlImage},
	}}
}

func (e formTestEnv) insertLibraryAsset(t *testing.T) uuid.UUID {
	t.Helper()
	var org uuid.UUID
	if err := e.pool.QueryRow(e.ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	id := uuid.New()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,sha256,original_size,processing_status,origin,created_by)
		VALUES($1,$2,'Library','image','library.png','image/png',$3,64,'ready','library',$4)`, id, org, []byte("0123456789012345678901234567890a"), e.owner); err != nil {
		t.Fatal(err)
	}
	return id
}

// --- 1. Record-level ownership ---

func TestSubmitterCannotModifyOthersRecord(t *testing.T) {
	e := setupForms(t)
	formA, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Form A", DraftSchema: announcementSchema()})
	formB, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Form B", DraftSchema: announcementSchema()})
	alice := e.insertUser(t, "Alice", "alice", "viewer")
	bob := e.insertUser(t, "Bob", "bob", "viewer")
	for _, form := range []uuid.UUID{formA.ID, formB.ID} {
		if _, err := e.service.SetGrant(e.ctx, form, e.owner, formserver.GrantInput{UserID: alice, Capability: formserver.CapSubmit}); err != nil {
			t.Fatal(err)
		}
		if _, err := e.service.SetGrant(e.ctx, form, e.owner, formserver.GrantInput{UserID: bob, Capability: formserver.CapSubmit}); err != nil {
			t.Fatal(err)
		}
	}
	rec, err := e.service.CreateRecord(e.ctx, formA.ID, alice, formserver.RecordInput{Values: map[string]any{"title": "Alice's"}})
	if err != nil {
		t.Fatalf("alice create: %v", err)
	}

	// Bob cannot edit, transition, or attach to Alice's record; existence is hidden (NotFound).
	if _, err := e.service.UpdateRecord(e.ctx, formA.ID, rec.ID, bob, formserver.RecordInput{Values: map[string]any{"title": "Hijack"}}, rec.Version); err != formserver.ErrNotFound {
		t.Fatalf("expected NotFound for bob edit, got %v", err)
	}
	if _, err := e.service.Transition(e.ctx, formA.ID, rec.ID, bob, "submitted", "", rec.Version); err != formserver.ErrNotFound {
		t.Fatalf("expected NotFound for bob submit, got %v", err)
	}
	if _, err := e.attach(formA.ID, rec.ID, bob, formserver.AttachmentUpload{FieldKey: "photo", Data: pngBytes()}); err != formserver.ErrNotFound {
		t.Fatalf("expected NotFound for bob attach, got %v", err)
	}

	// The record cannot be reached through a different form.
	if _, err := e.service.UpdateRecord(e.ctx, formB.ID, rec.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "x"}}, rec.Version); err != formserver.ErrNotFound {
		t.Fatalf("expected NotFound for wrong-form edit, got %v", err)
	}

	// Alice may edit her own draft, but not after she submits it (non-editable state).
	if _, err := e.service.UpdateRecord(e.ctx, formA.ID, rec.ID, alice, formserver.RecordInput{Values: map[string]any{"title": "Revised"}}, rec.Version); err != nil {
		t.Fatalf("alice edit own draft: %v", err)
	}
	submitted, err := e.service.Transition(e.ctx, formA.ID, rec.ID, alice, "submitted", "", rec.Version+1)
	if err != nil {
		t.Fatalf("alice submit own: %v", err)
	}
	if _, err := e.service.UpdateRecord(e.ctx, formA.ID, rec.ID, alice, formserver.RecordInput{Values: map[string]any{"title": "Late"}}, submitted.Version); !isValidation(err) {
		t.Fatalf("expected validation error editing submitted record, got %v", err)
	}

	// A manager (the owner) may edit any record.
	if _, err := e.service.UpdateRecord(e.ctx, formA.ID, rec.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "Manager edit"}}, submitted.Version); err != nil {
		t.Fatalf("manager edit: %v", err)
	}
}

func isValidation(err error) bool { return errors.Is(err, formserver.ErrValidation) }

// --- 2. Attachment upload guards ---

func TestFormAttachmentUploadAndGuards(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Photos", DraftSchema: imageSchema()})
	rec, err := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "Has photo"}})
	if err != nil {
		t.Fatal(err)
	}

	// A valid upload creates a dedicated form-attachment asset and records the field value.
	created, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "photo", FileName: "p.png", ContentType: "image/png", Data: pngBytes()})
	if err != nil {
		t.Fatalf("create attachment: %v", err)
	}
	if len(created.Attachments) != 1 {
		t.Fatalf("expected one attachment on returned record, got %d", len(created.Attachments))
	}
	attachment := created.Attachments[0]
	var origin string
	if err := e.pool.QueryRow(e.ctx, `SELECT origin FROM assets WHERE id=$1`, attachment.AssetID).Scan(&origin); err != nil {
		t.Fatal(err)
	}
	if origin != "form_attachment" {
		t.Fatalf("attachment asset origin=%q, want form_attachment", origin)
	}
	// Library visibility of private attachments is the media package's
	// boundary and is covered there; the field value now references the
	// asset id.

	detail, err := e.service.GetRecord(e.ctx, form.ID, rec.ID, e.owner)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Values["photo"] != attachment.AssetID.String() {
		t.Fatalf("record value not set to attachment id: %#v", detail.Values["photo"])
	}

	// Invalid field keys are rejected.
	if _, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "title", Data: pngBytes()}); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("expected validation error for non-image field, got %v", err)
	}
	if _, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "missing", Data: pngBytes()}); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("expected validation error for unknown field, got %v", err)
	}
	// Non-image bytes are rejected.
	if _, err := e.attach(form.ID, rec.ID, e.owner, formserver.AttachmentUpload{FieldKey: "photo", Data: []byte("not an image at all")}); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("expected validation error for non-image bytes, got %v", err)
	}

	// A normal library Media asset cannot be claimed as a form attachment.
	// The public attachment API only binds freshly ingested private assets,
	// so the cross-record backstop below it is defense-in-depth behind a
	// path the API never takes.
	libraryAsset := e.insertLibraryAsset(t)
	tx, err := e.pool.Begin(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.harness.Host.PluginAssets.ClaimPrivateInTx(e.ctx, tx, libraryAsset); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("expected invalid error claiming a library asset, got %v", err)
	}
	_ = tx.Rollback(e.ctx)

	// Bob cannot attach to the owner's record.
	bob := e.insertUser(t, "Bob", "bob", "viewer")
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: bob, Capability: formserver.CapSubmit}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.attach(form.ID, rec.ID, bob, formserver.AttachmentUpload{FieldKey: "photo", Data: pngBytes()}); err != formserver.ErrNotFound {
		t.Fatalf("expected NotFound for bob attach, got %v", err)
	}

	// Approved attachment is projected; before approval it is excluded.
	payload := e.readPayload(t, form.ID)
	if ds, ok := datasetByID(payload, "approved"); ok && len(ds.Records) != 0 {
		t.Fatalf("unapproved attachment record must not project, got %d", len(ds.Records))
	}
	if _, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "submitted", "", detail.Version); err != nil {
		t.Fatalf("submit: %v", err)
	}
	current, _ := e.service.GetRecord(e.ctx, form.ID, rec.ID, e.owner)
	if _, err := e.service.Transition(e.ctx, form.ID, rec.ID, e.owner, "approved", "", current.Version); err != nil {
		t.Fatalf("approve: %v", err)
	}
	payload = e.readPayload(t, form.ID)
	approved, _ := datasetByID(payload, "approved")
	if len(approved.Records) != 1 || approved.Records[0].Values["photo"] != attachment.AssetID.String() {
		t.Fatalf("approved attachment not projected: %#v", approved.Records)
	}
}

// --- 3. Workflow reconciliation ---

func mutateWorkflow(f func(*formserver.Workflow)) formserver.Workflow {
	wf := testWorkflow()
	f(&wf)
	return wf
}

func TestWorkflowReconciliation(t *testing.T) {
	e := setupForms(t)

	// A: relabel and toggle output eligibility; existing record eligibility re-derives.
	formA, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "A", DraftSchema: announcementSchema()})
	e.submitAndApprove(t, formA.ID, map[string]any{"title": "Live"})
	relabel := mutateWorkflow(func(wf *formserver.Workflow) {
		for i := range wf.States {
			switch wf.States[i].Key {
			case "approved":
				wf.States[i].Label = "Published"
				wf.States[i].EligibleForOutput = false
			case "submitted":
				// Keep at least one eligible state so the workflow stays valid.
				wf.States[i].EligibleForOutput = true
			}
		}
	})
	if err := e.service.ConfigureWorkflow(e.ctx, formA.ID, e.owner, formserver.WorkflowInput{Workflow: relabel}); err != nil {
		t.Fatalf("relabel workflow: %v", err)
	}
	if ds, _ := datasetByID(e.readPayload(t, formA.ID), "approved"); len(ds.Records) != 0 {
		t.Fatalf("record should be ineligible after eligibility removed, got %d", len(ds.Records))
	}
	// Turning eligibility back on re-derives eligibility again.
	if err := e.service.ConfigureWorkflow(e.ctx, formA.ID, e.owner, formserver.WorkflowInput{Workflow: testWorkflow()}); err != nil {
		t.Fatalf("restore workflow: %v", err)
	}
	if ds, _ := datasetByID(e.readPayload(t, formA.ID), "approved"); len(ds.Records) != 1 {
		t.Fatalf("record should be eligible again, got %d", len(ds.Records))
	}

	// B: deleting a state referenced by a record is rejected.
	formB, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "B", DraftSchema: announcementSchema()})
	rec, _ := e.service.CreateRecord(e.ctx, formB.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "held"}})
	if _, err := e.service.Transition(e.ctx, formB.ID, rec.ID, e.owner, "submitted", "", rec.Version); err != nil {
		t.Fatal(err)
	}
	withoutSubmitted := formserver.Workflow{
		States: []formserver.WorkflowState{
			{Key: "draft", Label: "Draft", Initial: true},
			{Key: "changes_requested", Label: "Changes"},
			{Key: "approved", Label: "Approved", EligibleForOutput: true},
			{Key: "rejected", Label: "Rejected", Terminal: true},
			{Key: "expired", Label: "Expired", Terminal: true},
		},
		Transitions: []formserver.WorkflowTransition{
			{From: "draft", To: "approved", RequiredCapability: formserver.CapApprove},
			{From: "approved", To: "expired", RequiredCapability: formserver.CapManage},
		},
	}
	if err := e.service.ConfigureWorkflow(e.ctx, formB.ID, e.owner, formserver.WorkflowInput{Workflow: withoutSubmitted}); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("expected validation error deleting a used state, got %v", err)
	}

	// C: renaming a used state key (removing 'approved' in favor of 'published') is rejected.
	formC, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "C", DraftSchema: announcementSchema()})
	e.submitAndApprove(t, formC.ID, map[string]any{"title": "approved-record"})
	renamed := mutateWorkflow(func(wf *formserver.Workflow) {
		for i := range wf.States {
			if wf.States[i].Key == "approved" {
				wf.States[i].Key = "published"
			}
		}
		for i := range wf.Transitions {
			if wf.Transitions[i].To == "approved" {
				wf.Transitions[i].To = "published"
			}
			if wf.Transitions[i].From == "approved" {
				wf.Transitions[i].From = "published"
			}
		}
	})
	if err := e.service.ConfigureWorkflow(e.ctx, formC.ID, e.owner, formserver.WorkflowInput{Workflow: renamed}); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("expected validation error renaming a used state, got %v", err)
	}

	// D: changing the initial state while drafts exist is rejected.
	formD, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "D", DraftSchema: announcementSchema()})
	if _, err := e.service.CreateRecord(e.ctx, formD.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "draft"}}); err != nil {
		t.Fatal(err)
	}
	moveInitial := mutateWorkflow(func(wf *formserver.Workflow) {
		for i := range wf.States {
			switch wf.States[i].Key {
			case "draft":
				wf.States[i].Initial = false
			case "submitted":
				wf.States[i].Initial = true
			}
		}
	})
	if err := e.service.ConfigureWorkflow(e.ctx, formD.ID, e.owner, formserver.WorkflowInput{Workflow: moveInitial}); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("expected validation error moving the initial state with drafts present, got %v", err)
	}
}

// --- 4. Transactional, concurrency-safe expiry + comments ---

func (e formTestEnv) forceDue(t *testing.T, formID uuid.UUID) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx, `UPDATE data_source_refresh_states SET next_refresh_at=now()-interval '1 minute' WHERE data_source_id=$1`, formID); err != nil {
		t.Fatal(err)
	}
}

func (e formTestEnv) approveWithExpiry(t *testing.T, formID uuid.UUID, title string, expiresAt time.Time) formserver.Record {
	t.Helper()
	rec, err := e.service.CreateRecord(e.ctx, formID, e.owner, formserver.RecordInput{
		Values:    map[string]any{"title": title},
		ExpiresAt: formserver.Optional[time.Time]{Set: true, Value: &expiresAt},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	rec, err = e.service.Transition(e.ctx, formID, rec.ID, e.owner, "submitted", "", rec.Version)
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	rec, err = e.service.Transition(e.ctx, formID, rec.ID, e.owner, "approved", "", rec.Version)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	return rec
}

func (e formTestEnv) expiredEventCount(t *testing.T, recordID uuid.UUID) int {
	t.Helper()
	var count int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM form_record_events WHERE record_id=$1 AND to_state='expired'`, recordID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestAutoExpiryTransactional(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Expiring", DraftSchema: announcementSchema()})
	rec := e.approveWithExpiry(t, form.ID, "Old", time.Now().UTC().Add(-time.Hour))
	e.forceDue(t, form.ID)

	if err := e.service.RunDue(e.ctx); err != nil {
		t.Fatalf("run due: %v", err)
	}
	reloaded, err := e.service.GetRecord(e.ctx, form.ID, rec.ID, e.owner)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.State != "expired" || reloaded.Eligible {
		t.Fatalf("record should be expired and ineligible, got state=%q eligible=%v", reloaded.State, reloaded.Eligible)
	}
	// The history event records the actual previous state (not a hardcoded 'approved').
	var from string
	if err := e.pool.QueryRow(e.ctx, `SELECT from_state FROM form_record_events WHERE record_id=$1 AND to_state='expired'`, rec.ID).Scan(&from); err != nil {
		t.Fatal(err)
	}
	if from != "approved" {
		t.Fatalf("expected from_state approved, got %q", from)
	}
	// The audit event committed in the same transaction as the state change.
	var audits int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM audit_logs WHERE action='form.record_expired' AND resource_id=$1`, form.ID.String()).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 1 {
		t.Fatalf("expected one expiry audit event, got %d", audits)
	}
	// Running again is idempotent: no second expiry event.
	e.forceDue(t, form.ID)
	if err := e.service.RunDue(e.ctx); err != nil {
		t.Fatal(err)
	}
	if got := e.expiredEventCount(t, rec.ID); got != 1 {
		t.Fatalf("expected exactly one expiry event after a second pass, got %d", got)
	}
}

func TestConcurrentExpiryDoesNotDoubleProcess(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Concurrent expiry", DraftSchema: announcementSchema()})
	past := time.Now().UTC().Add(-time.Hour)
	rec1 := e.approveWithExpiry(t, form.ID, "One", past)
	rec2 := e.approveWithExpiry(t, form.ID, "Two", past)
	e.forceDue(t, form.ID)

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = e.service.RunDue(e.ctx)
		}()
	}
	wg.Wait()

	for _, id := range []uuid.UUID{rec1.ID, rec2.ID} {
		if got := e.expiredEventCount(t, id); got != 1 {
			t.Fatalf("record %s expired %d times, want exactly 1 (SKIP LOCKED must prevent double processing)", id, got)
		}
	}
}

func TestAddCommentIsTransactional(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Comments", DraftSchema: announcementSchema()})
	rec, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "t"}})
	if _, err := e.service.AddComment(e.ctx, form.ID, rec.ID, e.owner, "Please revise"); err != nil {
		t.Fatalf("add comment: %v", err)
	}
	var comments, events int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM form_record_comments WHERE record_id=$1`, rec.ID).Scan(&comments); err != nil {
		t.Fatal(err)
	}
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM form_record_events WHERE record_id=$1 AND event_type='comment'`, rec.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if comments != 1 || events != 1 {
		t.Fatalf("comment and its history event must both persist, got comments=%d events=%d", comments, events)
	}
}

// --- 5. PATCH tri-state timestamp semantics ---

func TestOptionalJSONThreeStates(t *testing.T) {
	type payload struct {
		DisplayAt formserver.Optional[time.Time] `json:"displayAt"`
	}
	var omitted payload
	if err := json.Unmarshal([]byte(`{}`), &omitted); err != nil {
		t.Fatal(err)
	}
	if omitted.DisplayAt.Set {
		t.Fatal("omitted field must not be Set")
	}
	var cleared payload
	if err := json.Unmarshal([]byte(`{"displayAt":null}`), &cleared); err != nil {
		t.Fatal(err)
	}
	if !cleared.DisplayAt.Set || cleared.DisplayAt.Value != nil {
		t.Fatal("explicit null must be Set with a nil Value")
	}
	var supplied payload
	if err := json.Unmarshal([]byte(`{"displayAt":"2026-01-02T03:04:05Z"}`), &supplied); err != nil {
		t.Fatal(err)
	}
	if !supplied.DisplayAt.Set || supplied.DisplayAt.Value == nil {
		t.Fatal("a supplied value must be Set with a non-nil Value")
	}
}

func TestRecordPatchTimestampSemantics(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Timestamps", DraftSchema: announcementSchema()})
	start := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	end := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Second)
	rec, err := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{
		Values:    map[string]any{"title": "t"},
		DisplayAt: formserver.Optional[time.Time]{Set: true, Value: &start},
		ExpiresAt: formserver.Optional[time.Time]{Set: true, Value: &end},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rec.DisplayAt == nil || rec.ExpiresAt == nil {
		t.Fatal("timestamps should be set on create")
	}

	// Omitting both preserves the stored values.
	rec, err = e.service.UpdateRecord(e.ctx, form.ID, rec.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "t2"}}, rec.Version)
	if err != nil {
		t.Fatalf("preserve update: %v", err)
	}
	if rec.DisplayAt == nil || !rec.DisplayAt.Equal(start) {
		t.Fatalf("omitted displayAt must be preserved, got %v", rec.DisplayAt)
	}
	if rec.ExpiresAt == nil || !rec.ExpiresAt.Equal(end) {
		t.Fatalf("omitted expiresAt must be preserved, got %v", rec.ExpiresAt)
	}

	// Explicit null clears displayAt; omitted expiresAt is still preserved.
	rec, err = e.service.UpdateRecord(e.ctx, form.ID, rec.ID, e.owner, formserver.RecordInput{
		Values:    map[string]any{"title": "t3"},
		DisplayAt: formserver.Optional[time.Time]{Set: true, Value: nil},
	}, rec.Version)
	if err != nil {
		t.Fatalf("clear update: %v", err)
	}
	if rec.DisplayAt != nil {
		t.Fatalf("explicit null must clear displayAt, got %v", rec.DisplayAt)
	}
	if rec.ExpiresAt == nil || !rec.ExpiresAt.Equal(end) {
		t.Fatalf("omitted expiresAt must remain, got %v", rec.ExpiresAt)
	}

	// A supplied value replaces expiresAt.
	newEnd := end.Add(24 * time.Hour)
	rec, err = e.service.UpdateRecord(e.ctx, form.ID, rec.ID, e.owner, formserver.RecordInput{
		Values:    map[string]any{"title": "t4"},
		ExpiresAt: formserver.Optional[time.Time]{Set: true, Value: &newEnd},
	}, rec.Version)
	if err != nil {
		t.Fatalf("replace update: %v", err)
	}
	if rec.ExpiresAt == nil || !rec.ExpiresAt.Equal(newEnd) {
		t.Fatalf("supplied expiresAt must replace, got %v", rec.ExpiresAt)
	}
}
