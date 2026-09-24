package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/forms"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

// TestUpdateFormMetadataEndpoint exercises the metadata endpoint through the requireCSRF middleware
// and the handler: manager success, submit-only forbidden, CSRF rejection, and a non-Form source.
func TestUpdateFormMetadataEndpoint(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE form_record_attachments,form_record_comments,form_record_events,form_records,form_views,form_grants,form_workflow_transitions,form_workflow_states,form_revisions,data_source_refresh_states,data_sources,widgets,website_assets,asset_variants,assets,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}

	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "District", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	// Forms is an installable plugin; these tests exercise an installation that has added it.
	if _, err = pool.Exec(ctx, `INSERT INTO plugin_installations(organization_id,plugin_id) SELECT id,'forms' FROM organization_settings WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	formsSvc := forms.NewService(pool, media.NewService(pool, nil, media.Config{}))
	form, err := formsSvc.CreateForm(ctx, owner.User.ID, forms.FormInput{
		Name: "Original", Description: "d",
		DraftSchema: forms.FormSchema{Fields: []forms.FormField{
			{Key: "title", Label: "Title", Control: forms.ControlShortText, Required: true},
		}},
	})
	if err != nil {
		t.Fatalf("create form: %v", err)
	}

	// A submit-only user on this form.
	submitter := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role) VALUES($1,'Sam','sam','x','viewer')`, submitter); err != nil {
		t.Fatal(err)
	}
	if _, err = formsSvc.SetGrant(ctx, form.ID, owner.User.ID, forms.GrantInput{UserID: submitter, Capability: forms.CapSubmit}); err != nil {
		t.Fatal(err)
	}

	// A non-Form Data Source.
	var organizationID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings WHERE singleton`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}
	manualID := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,description,provider,config_version,configuration,created_by)
		VALUES($1,$2,'Manual','','manual',1,'{}'::jsonb,$3)`, manualID, organizationID, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	s := &server{forms: formsSvc, db: pool, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	const csrf = "csrf-token"
	ownerSession := auth.Session{User: auth.User{ID: owner.User.ID, Role: "owner"}, CSRFToken: csrf}
	submitterSession := auth.Session{User: auth.User{ID: submitter, Role: "viewer"}, CSRFToken: csrf}

	do := func(id string, session auth.Session, csrfHeader, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/data-sources/"+id+"/form", strings.NewReader(body))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", id)
		reqCtx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
		reqCtx = context.WithValue(reqCtx, sessionContextKey, session)
		req = req.WithContext(reqCtx)
		if csrfHeader != "" {
			req.Header.Set("X-CSRF-Token", csrfHeader)
		}
		rec := httptest.NewRecorder()
		s.requireCSRF(http.HandlerFunc(s.updateFormMetadata)).ServeHTTP(rec, req)
		return rec
	}

	validBody := `{"name":"Staff Announcements","description":"By staff."}`

	// Manager: 200 and the parent Data Source is updated.
	if rec := do(form.ID.String(), ownerSession, csrf, validBody); rec.Code != http.StatusOK {
		t.Fatalf("manager update: got %d body=%s", rec.Code, rec.Body.String())
	}
	var name string
	if err = pool.QueryRow(ctx, `SELECT name FROM data_sources WHERE id=$1`, form.ID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Staff Announcements" {
		t.Fatalf("metadata not persisted: %q", name)
	}

	// Submit-only user: 403.
	if rec := do(form.ID.String(), submitterSession, csrf, validBody); rec.Code != http.StatusForbidden {
		t.Fatalf("submit-only update: got %d body=%s", rec.Code, rec.Body.String())
	}

	// Missing CSRF: 403.
	if rec := do(form.ID.String(), ownerSession, "", validBody); rec.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF: got %d", rec.Code)
	}
	// Invalid CSRF: 403.
	if rec := do(form.ID.String(), ownerSession, "wrong-token", validBody); rec.Code != http.StatusForbidden {
		t.Fatalf("invalid CSRF: got %d", rec.Code)
	}

	// Non-Form Data Source: 404.
	if rec := do(manualID.String(), ownerSession, csrf, validBody); rec.Code != http.StatusNotFound {
		t.Fatalf("non-form source: got %d body=%s", rec.Code, rec.Body.String())
	}

	// Invalid body (empty name): 422.
	if rec := do(form.ID.String(), ownerSession, csrf, `{"name":"   "}`); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid name: got %d body=%s", rec.Code, rec.Body.String())
	}
}

// TestFormUserDirectoryAuthorization confirms the manager-scoped user directory is available to a
// form manager and denied to a non-manager, without touching the Owner/Admin /users endpoint.
func TestFormUserDirectoryAuthorization(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer lockPool.Close()
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE form_record_attachments,form_record_comments,form_record_events,form_records,form_views,form_grants,form_workflow_transitions,form_workflow_states,form_revisions,data_source_refresh_states,data_sources,widgets,website_assets,asset_variants,assets,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "District", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	// Forms is an installable plugin; these tests exercise an installation that has added it.
	if _, err = pool.Exec(ctx, `INSERT INTO plugin_installations(organization_id,plugin_id) SELECT id,'forms' FROM organization_settings WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	formsSvc := forms.NewService(pool, media.NewService(pool, nil, media.Config{}))
	form, err := formsSvc.CreateForm(ctx, owner.User.ID, forms.FormInput{Name: "Form", DraftSchema: forms.FormSchema{Fields: []forms.FormField{{Key: "title", Label: "Title", Control: forms.ControlShortText, Required: true}}}})
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	submitter := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,name,username,password_hash,role) VALUES($1,'Sam','sam','x','viewer')`, submitter); err != nil {
		t.Fatal(err)
	}
	if _, err = formsSvc.SetGrant(ctx, form.ID, owner.User.ID, forms.GrantInput{UserID: submitter, Capability: forms.CapSubmit}); err != nil {
		t.Fatal(err)
	}

	s := &server{forms: formsSvc, db: pool, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	do := func(session auth.Session) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/data-sources/"+form.ID.String()+"/user-directory?search=owner", nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", form.ID.String())
		reqCtx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
		reqCtx = context.WithValue(reqCtx, sessionContextKey, session)
		rec := httptest.NewRecorder()
		s.searchFormUsers(rec, req.WithContext(reqCtx))
		return rec
	}

	// Manager (owner) gets the directory.
	if rec := do(auth.Session{User: auth.User{ID: owner.User.ID, Role: "owner"}}); rec.Code != http.StatusOK {
		t.Fatalf("manager directory: got %d body=%s", rec.Code, rec.Body.String())
	}
	// A submit-only grantee is denied.
	if rec := do(auth.Session{User: auth.User{ID: submitter, Role: "viewer"}}); rec.Code != http.StatusForbidden {
		t.Fatalf("submit-only directory: got %d body=%s", rec.Code, rec.Body.String())
	}
}
