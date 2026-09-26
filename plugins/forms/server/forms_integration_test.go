package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/pluginharness"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
	formserver "github.com/tilecast/tilecast/plugins/forms/server"
)

// testPlugin hosts the real Forms server contribution without importing the
// parent package (which would cycle back into this one). Conformance against
// the real bundle runs in the parent package's TestConformance.
type testPlugin struct {
	plugin.Bundle
	*formserver.Service
}

func newTestPlugin(t *testing.T, service *formserver.Service) plugin.Plugin {
	t.Helper()
	manifest, err := os.ReadFile("../tilecast.plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	return &testPlugin{Bundle: plugin.NewBundle(manifest, os.DirFS("..")), Service: service}
}

type formTestEnv struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	harness *pluginharness.Harness
	service *formserver.Service
	owner   uuid.UUID
}

func setupForms(t *testing.T) formTestEnv {
	t.Helper()
	service := formserver.NewService()
	harness := pluginharness.New(t, newTestPlugin(t, service))
	// The harness truncates the core organization, user, and installation
	// tables; the plugin's own tables plus everything attachments and audit
	// rows touch still need a reset between tests.
	if _, err := harness.Pool.Exec(harness.Ctx, `TRUNCATE form_record_attachments,form_record_comments,form_record_events,form_records,form_views,form_grants,form_workflow_transitions,form_workflow_states,form_revisions,data_source_refresh_states,data_sources,widgets,asset_variants,assets,audit_logs CASCADE`); err != nil {
		t.Fatal(err)
	}
	// Forms is an installable plugin; these tests exercise an installation that has added it.
	harness.Install()
	return formTestEnv{ctx: harness.Ctx, pool: harness.Pool, harness: harness, service: service, owner: harness.OwnerID}
}

// versionOf returns a record's current stored version (0 if it does not exist), for tests that
// drive the version-checked attachment endpoints without threading the version by hand.
func (e formTestEnv) versionOf(recordID uuid.UUID) int {
	var version int
	_ = e.pool.QueryRow(e.ctx, `SELECT version FROM form_records WHERE id=$1`, recordID).Scan(&version)
	return version
}

// attach uploads an attachment using the record's current version (optimistic concurrency).
func (e formTestEnv) attach(formID, recordID, actor uuid.UUID, upload formserver.AttachmentUpload) (formserver.RecordDetail, error) {
	return e.service.CreateAttachment(e.ctx, formID, recordID, actor, upload, e.versionOf(recordID))
}

// removeAttachment removes an attachment using the record's current version.
func (e formTestEnv) removeAttachment(formID, recordID, attachmentID, actor uuid.UUID) (formserver.RecordDetail, error) {
	return e.service.RemoveAttachment(e.ctx, formID, recordID, attachmentID, actor, e.versionOf(recordID))
}

// insertUser creates an additional user with a role for grant/authorization tests.
func (e formTestEnv) insertUser(t *testing.T, name, username, role string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO users(id,name,username,password_hash,role) VALUES($1,$2,$3,'x',$4)`, id, name, username, role); err != nil {
		t.Fatal(err)
	}
	return id
}

// announcementSchema is a representative form definition used across tests.
func announcementSchema() formserver.FormSchema {
	return formserver.FormSchema{Fields: []formserver.FormField{
		{Key: "title", Label: "Title", Control: formserver.ControlShortText, Required: true, MaxLength: 120},
		{Key: "body", Label: "Body", Control: formserver.ControlLongText, MaxLength: 1000},
		{Key: "rank", Label: "Rank", Control: formserver.ControlInteger},
		{Key: "startAt", Label: "Start", Control: formserver.ControlDateTime},
		{Key: "endAt", Label: "End", Control: formserver.ControlDateTime},
	}}
}

func (e formTestEnv) readPayload(t *testing.T, formID uuid.UUID) plugin.TypedDatasetPayload {
	t.Helper()
	var raw []byte
	if err := e.pool.QueryRow(e.ctx, `SELECT cached_payload FROM data_source_refresh_states WHERE data_source_id=$1`, formID).Scan(&raw); err != nil {
		t.Fatalf("read cached payload: %v", err)
	}
	var payload plugin.TypedDatasetPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return payload
}

func datasetByID(payload plugin.TypedDatasetPayload, id string) (plugin.TypedDataset, bool) {
	for _, ds := range payload.Datasets {
		if ds.ID == id {
			return ds, true
		}
	}
	return plugin.TypedDataset{}, false
}

// submitAndApprove drives a fresh record through draft -> submitted -> approved.
func (e formTestEnv) submitAndApprove(t *testing.T, formID uuid.UUID, values map[string]any) formserver.Record {
	t.Helper()
	record, err := e.service.CreateRecord(e.ctx, formID, e.owner, formserver.RecordInput{Values: values})
	if err != nil {
		t.Fatalf("create record: %v", err)
	}
	record, err = e.service.Transition(e.ctx, formID, record.ID, e.owner, "submitted", "", record.Version)
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	record, err = e.service.Transition(e.ctx, formID, record.ID, e.owner, "approved", "", record.Version)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	return record
}

func TestCreateFormAndProjectApprovedOnly(t *testing.T) {
	e := setupForms(t)
	form, err := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Staff Announcements", DraftSchema: announcementSchema()})
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	// Parent data_sources row is a form provider.
	var provider string
	if err := e.pool.QueryRow(e.ctx, `SELECT provider FROM data_sources WHERE id=$1`, form.ID).Scan(&provider); err != nil {
		t.Fatal(err)
	}
	if provider != "form" {
		t.Fatalf("expected provider form, got %q", provider)
	}
	if form.Published == nil || form.Published.RevisionNumber != 1 {
		t.Fatalf("expected an initial published revision, got %+v", form.Published)
	}
	if len(form.Views) != 1 || form.Views[0].Key != "approved" {
		t.Fatalf("expected a default approved view, got %+v", form.Views)
	}

	// A draft record must not appear in the projected payload.
	draft, err := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "Draft only"}})
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	payload := e.readPayload(t, form.ID)
	approved, ok := datasetByID(payload, "approved")
	if !ok {
		t.Fatal("expected an approved dataset")
	}
	if len(approved.Records) != 0 {
		t.Fatalf("draft record must not be projected, got %d records", len(approved.Records))
	}

	// Approve a second record; it must appear, the draft must still be absent.
	e.submitAndApprove(t, form.ID, map[string]any{"title": "Welcome back", "body": "School reopens Monday.", "rank": float64(3)})
	payload = e.readPayload(t, form.ID)
	approved, _ = datasetByID(payload, "approved")
	if len(approved.Records) != 1 {
		t.Fatalf("expected exactly the approved record, got %d", len(approved.Records))
	}
	if approved.Records[0].Values["title"] != "Welcome back" {
		t.Fatalf("unexpected projected values: %#v", approved.Records[0].Values)
	}
	if approved.Records[0].Values["rank"] != "3" {
		t.Fatalf("expected integer rank coerced to string, got %q", approved.Records[0].Values["rank"])
	}
	_ = draft

	// The Outputs status serves the same cached payload Players consume.
	outputs, err := e.service.GetOutputs(e.ctx, form.ID)
	if err != nil {
		t.Fatalf("outputs: %v", err)
	}
	if len(outputs.Views) != 1 || outputs.Views[0].RecordCount != 1 {
		t.Fatalf("outputs payload mismatch: %+v", outputs.Views)
	}
}

func TestPublishRevisionKeepsOldSubmissions(t *testing.T) {
	e := setupForms(t)
	form, err := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Events", DraftSchema: announcementSchema()})
	if err != nil {
		t.Fatal(err)
	}
	first := form.Published.ID
	old := e.submitAndApprove(t, form.ID, map[string]any{"title": "Original"})

	// Revise the form: add a field and republish.
	schema := announcementSchema()
	schema.Fields = append(schema.Fields, formserver.FormField{Key: "location", Label: "Location", Control: formserver.ControlShortText})
	if _, err := e.service.UpdateDraft(e.ctx, form.ID, e.owner, formserver.DraftInput{Schema: schema}); err != nil {
		t.Fatalf("update draft: %v", err)
	}
	revision, err := e.service.PublishRevision(e.ctx, form.ID, e.owner)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if revision.RevisionNumber != 2 || revision.ID == first {
		t.Fatalf("expected a new revision 2, got %+v", revision)
	}

	// The old record still references the first revision and its values are intact.
	reloaded, err := e.service.GetRecord(e.ctx, form.ID, old.ID, e.owner)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.RevisionID != first {
		t.Fatalf("old record revision changed: %v != %v", reloaded.RevisionID, first)
	}
	if reloaded.Values["title"] != "Original" {
		t.Fatalf("old record values corrupted: %#v", reloaded.Values)
	}

	// New records bind to the latest revision.
	fresh := e.submitAndApprove(t, form.ID, map[string]any{"title": "New", "location": "Gym"})
	if fresh.RevisionID != revision.ID {
		t.Fatalf("new record should bind to revision 2")
	}
	var count int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM form_revisions WHERE data_source_id=$1`, form.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("expected 2 revisions, got %d", count)
	}
}

func TestWorkflowTransitionsAndValidation(t *testing.T) {
	e := setupForms(t)
	form, err := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Requests", DraftSchema: announcementSchema()})
	if err != nil {
		t.Fatal(err)
	}
	// Request changes then resubmit then approve.
	record, err := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "Needs work"}})
	if err != nil {
		t.Fatal(err)
	}
	record, err = e.service.Transition(e.ctx, form.ID, record.ID, e.owner, "submitted", "", record.Version)
	if err != nil {
		t.Fatal(err)
	}
	record, err = e.service.Transition(e.ctx, form.ID, record.ID, e.owner, "changes_requested", "Add detail", record.Version)
	if err != nil {
		t.Fatalf("request changes: %v", err)
	}
	record, err = e.service.Transition(e.ctx, form.ID, record.ID, e.owner, "submitted", "", record.Version)
	if err != nil {
		t.Fatalf("resubmit: %v", err)
	}
	if _, err := e.service.Transition(e.ctx, form.ID, record.ID, e.owner, "approved", "", record.Version); err != nil {
		t.Fatalf("approve after resubmit: %v", err)
	}

	// An invalid transition is rejected.
	rejectMe, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "x"}})
	if _, err := e.service.Transition(e.ctx, form.ID, rejectMe.ID, e.owner, "approved", "", rejectMe.Version); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("expected validation error for illegal transition, got %v", err)
	}

	// A record missing a required field cannot be submitted at all: required fields are enforced
	// before any transition requiring the submit capability, not only when entering the eligible
	// state. The incomplete draft is preserved (still editable) rather than advanced.
	incomplete, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{}})
	if _, err := e.service.Transition(e.ctx, form.ID, incomplete.ID, e.owner, "submitted", "", incomplete.Version); !errors.Is(err, formserver.ErrValidation) {
		t.Fatalf("expected required-field validation on submit, got %v", err)
	}
	stillDraft, err := e.service.GetRecord(e.ctx, form.ID, incomplete.ID, e.owner)
	if err != nil {
		t.Fatal(err)
	}
	if stillDraft.State != "draft" {
		t.Fatalf("incomplete record should remain a draft, got %q", stillDraft.State)
	}
}

func TestConcurrentEditConflict(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Concurrent", DraftSchema: announcementSchema()})
	record, err := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "First"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.service.UpdateRecord(e.ctx, form.ID, record.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "Edit A"}}, record.Version); err != nil {
		t.Fatalf("first edit: %v", err)
	}
	// A second edit with the stale version must conflict.
	if _, err := e.service.UpdateRecord(e.ctx, form.ID, record.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "Edit B"}}, record.Version); !errors.Is(err, formserver.ErrConflict) {
		t.Fatalf("expected conflict on stale version, got %v", err)
	}
	// A stale transition likewise conflicts.
	if _, err := e.service.Transition(e.ctx, form.ID, record.ID, e.owner, "submitted", "", record.Version); !errors.Is(err, formserver.ErrConflict) {
		t.Fatalf("expected conflict on stale transition, got %v", err)
	}
}

func TestPerFormGrantsScopeAccess(t *testing.T) {
	e := setupForms(t)
	formA, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Form A", DraftSchema: announcementSchema()})
	formB, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Form B", DraftSchema: announcementSchema()})
	viewer := e.insertUser(t, "Vera", "vera", "viewer")

	// Grant submit on Form A only.
	if _, err := e.service.SetGrant(e.ctx, formA.ID, e.owner, formserver.GrantInput{UserID: viewer, Capability: formserver.CapSubmit}); err != nil {
		t.Fatalf("set grant: %v", err)
	}
	assertAuth := func(formID uuid.UUID, need formserver.Capability, want bool) {
		got, err := e.service.Authorize(e.ctx, formID, viewer, need)
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("Authorize(%v,%s)=%v, want %v", formID, need, got, want)
		}
	}
	assertAuth(formA.ID, formserver.CapSubmit, true)
	assertAuth(formA.ID, formserver.CapReview, false) // submit does not imply review
	assertAuth(formB.ID, formserver.CapSubmit, false) // grant is scoped to Form A

	// The global Owner always manages any form.
	if ok, _ := e.service.Authorize(e.ctx, formB.ID, e.owner, formserver.CapManage); !ok {
		t.Fatal("owner should always manage forms")
	}
}

func TestApprovalsInboxPermissions(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Inbox", DraftSchema: announcementSchema()})
	reviewer := e.insertUser(t, "Rhea", "rhea", "viewer")
	outsider := e.insertUser(t, "Odis", "odis", "viewer")
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: reviewer, Capability: formserver.CapReview}); err != nil {
		t.Fatal(err)
	}
	// Submit a record so it is awaiting review.
	record, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "Please review"}})
	if _, err := e.service.Transition(e.ctx, form.ID, record.ID, e.owner, "submitted", "", record.Version); err != nil {
		t.Fatal(err)
	}

	reviewerItems, err := e.service.PendingApprovals(e.ctx, reviewer, formserver.ApprovalFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(reviewerItems.Items) != 1 || reviewerItems.Total != 1 {
		t.Fatalf("reviewer should see 1 pending item, got %d (total %d)", len(reviewerItems.Items), reviewerItems.Total)
	}
	outsiderItems, _ := e.service.PendingApprovals(e.ctx, outsider, formserver.ApprovalFilter{})
	if len(outsiderItems.Items) != 0 || outsiderItems.Total != 0 {
		t.Fatalf("outsider should see nothing, got %d", len(outsiderItems.Items))
	}
	ownerItems, _ := e.service.PendingApprovals(e.ctx, e.owner, formserver.ApprovalFilter{})
	if len(ownerItems.Items) != 1 || ownerItems.Total != 1 {
		t.Fatalf("owner should see 1 pending item, got %d", len(ownerItems.Items))
	}
}

func TestSavedViewFilteringSortingAndNamedDatasets(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Views", DraftSchema: announcementSchema()})
	// A second view that only includes high-rank records, sorted descending, limited to 2.
	if _, err := e.service.UpsertView(e.ctx, form.ID, e.owner, formserver.ViewInput{
		Key: "priority", Name: "High priority", IncludedStates: []string{"approved"},
		FieldFilters: []formserver.FieldFilter{{Field: "rank", Operator: "greater_than", Value: "5"}},
		Sort:         []formserver.SortRule{{Field: "rank", Direction: "desc"}},
		OutputFields: []string{"title", "rank"}, RecordLimit: 2,
	}); err != nil {
		t.Fatalf("upsert view: %v", err)
	}
	for _, rank := range []float64{3, 6, 8, 9} {
		e.submitAndApprove(t, form.ID, map[string]any{"title": "R", "rank": rank})
	}
	payload := e.readPayload(t, form.ID)
	// Named datasets: one per view.
	if _, ok := datasetByID(payload, "approved"); !ok {
		t.Fatal("missing approved dataset")
	}
	priority, ok := datasetByID(payload, "priority")
	if !ok {
		t.Fatal("missing priority dataset")
	}
	// rank>5 -> {6,8,9}; sorted desc and limited to 2 -> {9,8}.
	if len(priority.Records) != 2 {
		t.Fatalf("expected 2 filtered+limited records, got %d", len(priority.Records))
	}
	if priority.Records[0].Values["rank"] != "9" || priority.Records[1].Values["rank"] != "8" {
		t.Fatalf("unexpected sort/filter result: %#v", priority.Records)
	}
}

func TestTimeBasedViewActivationAndBoundary(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Active", DraftSchema: announcementSchema()})
	if _, err := e.service.UpsertView(e.ctx, form.ID, e.owner, formserver.ViewInput{
		Key: "active", Name: "Active now", IncludedStates: []string{"approved"},
		TimeFilter:   formserver.TimeFilter{Enabled: true, StartField: "startAt", EndField: "endAt", StartBeforeNow: true, EndAfterNow: true},
		OutputFields: []string{"title", "startAt", "endAt"}, RecordLimit: 100,
	}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	rfc := func(t time.Time) string { return t.Format(time.RFC3339) }
	// Active: started an hour ago, ends in an hour.
	e.submitAndApprove(t, form.ID, map[string]any{"title": "Active", "startAt": rfc(now.Add(-time.Hour)), "endAt": rfc(now.Add(time.Hour))})
	// Expired: ended an hour ago.
	e.submitAndApprove(t, form.ID, map[string]any{"title": "Expired", "startAt": rfc(now.Add(-2 * time.Hour)), "endAt": rfc(now.Add(-time.Hour))})
	// Upcoming: starts in an hour.
	e.submitAndApprove(t, form.ID, map[string]any{"title": "Upcoming", "startAt": rfc(now.Add(time.Hour)), "endAt": rfc(now.Add(2 * time.Hour))})

	payload := e.readPayload(t, form.ID)
	active, _ := datasetByID(payload, "active")
	if len(active.Records) != 1 || active.Records[0].Values["title"] != "Active" {
		t.Fatalf("only the active record should project, got %#v", active.Records)
	}
	// next_refresh_at should be scheduled at the next boundary, not the far future.
	var nextRefresh time.Time
	if err := e.pool.QueryRow(e.ctx, `SELECT next_refresh_at FROM data_source_refresh_states WHERE data_source_id=$1`, form.ID).Scan(&nextRefresh); err != nil {
		t.Fatal(err)
	}
	if nextRefresh.After(now.Add(48 * time.Hour)) {
		t.Fatalf("expected a near-term boundary refresh, got %v", nextRefresh)
	}
}

func TestManifestInvalidationOnApproval(t *testing.T) {
	e := setupForms(t)
	form, _ := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Invalidate", DraftSchema: announcementSchema()})
	record, _ := e.service.CreateRecord(e.ctx, form.ID, e.owner, formserver.RecordInput{Values: map[string]any{"title": "Ship it"}})
	record, _ = e.service.Transition(e.ctx, form.ID, record.ID, e.owner, "submitted", "", record.Version)
	before := e.readPayload(t, form.ID)
	if ds, _ := datasetByID(before, "approved"); len(ds.Records) != 0 {
		t.Fatalf("submitted record must not project before approval, got %d records", len(ds.Records))
	}
	if _, err := e.service.Transition(e.ctx, form.ID, record.ID, e.owner, "approved", "", record.Version); err != nil {
		t.Fatal(err)
	}
	// Approval re-projects through the normal Data Source revision path, so
	// the approved record appears in the cached payload (manifest bumps for
	// bound screens are the playlist service's path and are covered there).
	after := e.readPayload(t, form.ID)
	if ds, _ := datasetByID(after, "approved"); len(ds.Records) != 1 {
		t.Fatalf("approval did not re-project the form, got %d records", len(ds.Records))
	}
}

func testWorkflow() formserver.Workflow {
	return formserver.Workflow{
		States: []formserver.WorkflowState{
			{Key: "draft", Label: "Draft", Position: 0, Initial: true},
			{Key: "submitted", Label: "Submitted", Position: 1},
			{Key: "changes_requested", Label: "Changes requested", Position: 2},
			{Key: "approved", Label: "Approved", Position: 3, EligibleForOutput: true},
			{Key: "rejected", Label: "Rejected", Position: 4, Terminal: true},
			{Key: "expired", Label: "Expired", Position: 5, Terminal: true},
		},
		Transitions: []formserver.WorkflowTransition{
			{From: "draft", To: "submitted", Label: "Submit", RequiredCapability: formserver.CapSubmit, Position: 0},
			{From: "submitted", To: "approved", Label: "Approve", RequiredCapability: formserver.CapApprove, Position: 1},
			{From: "submitted", To: "rejected", Label: "Reject", RequiredCapability: formserver.CapApprove, Position: 2},
			{From: "submitted", To: "changes_requested", Label: "Request changes", RequiredCapability: formserver.CapReview, Position: 3},
			{From: "changes_requested", To: "submitted", Label: "Resubmit", RequiredCapability: formserver.CapSubmit, Position: 4},
			{From: "approved", To: "expired", Label: "Expire", RequiredCapability: formserver.CapManage, Position: 5},
		},
	}
}
