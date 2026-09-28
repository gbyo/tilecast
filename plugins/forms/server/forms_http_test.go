package server_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	formserver "github.com/tilecast/tilecast/plugins/forms/server"
)

// TestUpdateMetadataHTTP exercises the metadata endpoint through the plugin
// contribution routes: manager success with persistence, submit-only
// forbidden, non-Form source not found, and invalid name rejected. Session
// and CSRF checks belong to the host router and are covered by the server's
// own tests.
func TestUpdateMetadataHTTP(t *testing.T) {
	e := setupForms(t)
	form, err := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Original", Description: "d", DraftSchema: announcementSchema()})
	if err != nil {
		t.Fatalf("create form: %v", err)
	}

	// A submit-only user on this form.
	submitter := e.insertUser(t, "Sam", "sam", "viewer")
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: submitter, Capability: formserver.CapSubmit}); err != nil {
		t.Fatalf("set grant: %v", err)
	}

	// A non-Form Data Source.
	manualID := e.insertManualSource(t)

	const validBody = `{"name":"Staff Announcements","description":"By staff."}`
	metadataPath := "/data-sources/" + form.ID.String() + "/form"

	// Manager: 200 and the parent Data Source is updated.
	if r := e.harness.ServeAs(e.owner, "owner", http.MethodPatch, metadataPath, validBody); r.Status != http.StatusOK {
		t.Fatalf("manager update: got %d body=%v", r.Status, r.Body)
	}
	var name string
	if err := e.pool.QueryRow(e.ctx, `SELECT name FROM data_sources WHERE id=$1`, form.ID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Staff Announcements" {
		t.Fatalf("metadata not persisted: %q", name)
	}

	// Submit-only user: 403.
	if r := e.harness.ServeAs(submitter, "viewer", http.MethodPatch, metadataPath, validBody); r.Status != http.StatusForbidden {
		t.Fatalf("submit-only update: got %d body=%v", r.Status, r.Body)
	}

	// Non-Form Data Source: 404.
	if r := e.harness.ServeAs(e.owner, "owner", http.MethodPatch, "/data-sources/"+manualID.String()+"/form", validBody); r.Status != http.StatusNotFound {
		t.Fatalf("non-form source: got %d body=%v", r.Status, r.Body)
	}

	// Invalid body (empty name): 422.
	if r := e.harness.ServeAs(e.owner, "owner", http.MethodPatch, metadataPath, `{"name":"   "}`); r.Status != http.StatusUnprocessableEntity {
		t.Fatalf("invalid name: got %d body=%v", r.Status, r.Body)
	}
}

// TestUserDirectoryHTTP confirms the manager-scoped user directory is
// available to a form manager and denied to a submit-only grantee, without
// touching the Owner/Admin /users endpoint.
func TestUserDirectoryHTTP(t *testing.T) {
	e := setupForms(t)
	form, err := e.service.CreateForm(e.ctx, e.owner, formserver.FormInput{Name: "Form", DraftSchema: announcementSchema()})
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	submitter := e.insertUser(t, "Sam", "sam", "viewer")
	if _, err := e.service.SetGrant(e.ctx, form.ID, e.owner, formserver.GrantInput{UserID: submitter, Capability: formserver.CapSubmit}); err != nil {
		t.Fatalf("set grant: %v", err)
	}

	directoryPath := "/data-sources/" + form.ID.String() + "/user-directory?search=owner"

	// Manager (owner) gets the directory.
	if r := e.harness.ServeAs(e.owner, "owner", http.MethodGet, directoryPath, ""); r.Status != http.StatusOK {
		t.Fatalf("manager directory: got %d body=%v", r.Status, r.Body)
	}
	// A submit-only grantee is denied.
	if r := e.harness.ServeAs(submitter, "viewer", http.MethodGet, directoryPath, ""); r.Status != http.StatusForbidden {
		t.Fatalf("submit-only directory: got %d body=%v", r.Status, r.Body)
	}
}

// insertManualSource creates a non-Form Data Source for negative-path tests.
func (e formTestEnv) insertManualSource(t *testing.T) (manualID uuid.UUID) {
	t.Helper()
	var organizationID uuid.UUID
	if err := e.pool.QueryRow(e.ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	if err := e.pool.QueryRow(e.ctx, `INSERT INTO data_sources(id,organization_id,name,description,provider,config_version,configuration,created_by)
		VALUES(gen_random_uuid(),$1,'Manual','','manual',1,'{}'::jsonb,$2) RETURNING id`, organizationID, e.owner).Scan(&manualID); err != nil {
		t.Fatal(err)
	}
	return manualID
}
