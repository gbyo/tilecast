package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
)

func TestPermanentlyDeleteUserRequiresDeactivationAndPreservesHistory(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}

	organizationID, ownerID, targetID := uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'User deletion test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO users(id,name,username,password_hash,role,active) VALUES
		($1,'Owner','owner','unused','owner',TRUE),
		($2,'Former Editor','former-editor','unused','editor',TRUE)`, ownerID, targetID); err != nil {
		t.Fatal(err)
	}

	s := &server{db: pool, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	owner := auth.Session{User: auth.User{ID: ownerID, Name: "Owner", Username: "owner", Role: "owner", Active: true}}
	callDelete := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodDelete, "/api/v1/users/"+targetID.String()+"/permanent", nil)
		routeContext := chi.NewRouteContext()
		routeContext.URLParams.Add("id", targetID.String())
		request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
		request = requestWithTestPrincipal(request, owner)
		response := httptest.NewRecorder()
		s.permanentlyDeleteUser(response, request)
		return response
	}

	if response := callDelete(); response.Code != http.StatusConflict {
		t.Fatalf("active account deletion status = %d, want %d; body=%s", response.Code, http.StatusConflict, response.Body.String())
	}
	if _, err = pool.Exec(ctx, `UPDATE users SET active=FALSE WHERE id=$1`, targetID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO user_preferences(user_id) VALUES($1)`, targetID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO upload_sessions(
			id,organization_id,created_by,original_filename,declared_mime_type,
			expected_size,temporary_storage_key,status,expires_at
		) VALUES($1,$2,$3,'old.png','image/png',1,$4,'pending',now()+interval '1 hour')`,
		uuid.New(), organizationID, targetID, "uploads/test-"+uuid.NewString(),
	); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO audit_logs(id,user_id,action,resource_type,resource_id)
		VALUES($1,$2,'user.test_history','user',$3)`,
		uuid.New(), targetID, targetID.String(),
	); err != nil {
		t.Fatal(err)
	}

	if response := callDelete(); response.Code != http.StatusNoContent {
		t.Fatalf("inactive account deletion status = %d, want %d; body=%s", response.Code, http.StatusNoContent, response.Body.String())
	}
	var users, preferences, nullUploadAttribution, nullAuditAttribution, deletionAudits int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id=$1`, targetID).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM user_preferences WHERE user_id=$1`, targetID).Scan(&preferences); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM upload_sessions WHERE created_by IS NULL`).Scan(&nullUploadAttribution); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action='user.test_history' AND user_id IS NULL`).Scan(&nullAuditAttribution); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE action='user.deleted' AND user_id=$1 AND resource_id=$2`, ownerID, targetID.String()).Scan(&deletionAudits); err != nil {
		t.Fatal(err)
	}
	if users != 0 || preferences != 0 || nullUploadAttribution != 1 || nullAuditAttribution != 1 || deletionAudits != 1 {
		t.Fatalf(
			"unexpected deletion result: users=%d preferences=%d uploadAttribution=%d auditAttribution=%d deletionAudits=%d",
			users, preferences, nullUploadAttribution, nullAuditAttribution, deletionAudits,
		)
	}
}

func TestUserScreenScopesRoundTrip(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users,locations CASCADE`); err != nil {
		t.Fatal(err)
	}

	organizationID, ownerID, targetID, locationID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Scope test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO users(id,name,username,password_hash,role,active) VALUES
		($1,'Owner','owner','unused','owner',TRUE),
		($2,'Scoped Editor','scoped-editor','unused','editor',TRUE)`, ownerID, targetID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'Library')`, locationID, organizationID); err != nil {
		t.Fatal(err)
	}

	s := &server{db: pool, devices: devices.NewService(pool, devices.NewPresenceHub(), ""), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	owner := auth.Session{User: auth.User{ID: ownerID, Name: "Owner", Username: "owner", Role: "owner", Active: true}}

	withID := func(request *http.Request, id uuid.UUID) *http.Request {
		routeContext := chi.NewRouteContext()
		routeContext.URLParams.Add("id", id.String())
		return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
	}
	callGet := func(session auth.Session, id uuid.UUID) *httptest.ResponseRecorder {
		request := withID(httptest.NewRequest(http.MethodGet, "/api/v1/users/"+id.String()+"/screen-scopes", nil), id)
		request = requestWithTestPrincipal(request, session)
		response := httptest.NewRecorder()
		s.getUserScreenScopes(response, request)
		return response
	}
	callPut := func(session auth.Session, id uuid.UUID, body string) *httptest.ResponseRecorder {
		request := withID(httptest.NewRequest(http.MethodPut, "/api/v1/users/"+id.String()+"/screen-scopes", bytes.NewBufferString(body)), id)
		request.Header.Set("Content-Type", "application/json")
		request = requestWithTestPrincipal(request, session)
		response := httptest.NewRecorder()
		s.putUserScreenScopes(response, request)
		return response
	}
	decodeData := func(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var envelope struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("decode response: %v; body=%s", err, response.Body.String())
		}
		return envelope.Data
	}

	if response := callGet(owner, targetID); response.Code != http.StatusOK {
		t.Fatalf("initial GET status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	} else if data := decodeData(t, response); data["wholeFleet"] != true {
		t.Fatalf("initial scopes = %v, want wholeFleet=true", data)
	}

	putBody := `{"scopes":[{"type":"location","id":"` + locationID.String() + `"}]}`
	if response := callPut(owner, targetID, putBody); response.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	} else if data := decodeData(t, response); data["wholeFleet"] != false {
		t.Fatalf("replaced scopes = %v, want wholeFleet=false", data)
	}

	if response := callGet(owner, targetID); response.Code != http.StatusOK {
		t.Fatalf("second GET status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	} else if data := decodeData(t, response); data["wholeFleet"] != false {
		t.Fatalf("persisted scopes = %v, want wholeFleet=false", data)
	}

	editor := auth.Session{User: auth.User{ID: targetID, Name: "Scoped Editor", Username: "scoped-editor", Role: "editor", Active: true}}
	if response := callPut(editor, targetID, putBody); response.Code != http.StatusForbidden {
		t.Fatalf("self-scope PUT status = %d, want %d; body=%s", response.Code, http.StatusForbidden, response.Body.String())
	}
	if response := callPut(owner, ownerID, putBody); response.Code != http.StatusForbidden {
		t.Fatalf("owner-scope PUT status = %d, want %d; body=%s", response.Code, http.StatusForbidden, response.Body.String())
	}
	bogus := `{"scopes":[{"type":"location","id":"` + uuid.NewString() + `"}]}`
	if response := callPut(owner, targetID, bogus); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bogus-scope PUT status = %d, want %d; body=%s", response.Code, http.StatusUnprocessableEntity, response.Body.String())
	}
}

func TestConcurrentOwnerDeactivationKeepsOneActiveOwner(t *testing.T) {
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
	if _, err = pool.Exec(ctx, `TRUNCATE organization_settings,users CASCADE`); err != nil {
		t.Fatal(err)
	}

	organizationID, firstOwnerID, secondOwnerID := uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO organization_settings(singleton,organization_name,id) VALUES(TRUE,'Owner race test',$1)`, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO users(id,name,username,password_hash,role,active) VALUES
		($1,'First Owner','first-owner','unused','owner',TRUE),
		($2,'Second Owner','second-owner','unused','owner',TRUE)`, firstOwnerID, secondOwnerID); err != nil {
		t.Fatal(err)
	}

	s := &server{db: pool, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	firstOwner := auth.Session{User: auth.User{ID: firstOwnerID, Name: "First Owner", Username: "first-owner", Role: "owner", Active: true}}
	secondOwner := auth.Session{User: auth.User{ID: secondOwnerID, Name: "Second Owner", Username: "second-owner", Role: "owner", Active: true}}
	deactivate := func(actor auth.Session, targetID uuid.UUID) int {
		request := httptest.NewRequest(http.MethodDelete, "/api/v1/users/"+targetID.String(), nil)
		routeContext := chi.NewRouteContext()
		routeContext.URLParams.Add("id", targetID.String())
		request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
		request = requestWithTestPrincipal(request, actor)
		response := httptest.NewRecorder()
		s.deleteUser(response, request)
		return response.Code
	}

	// Each round, both Owners deactivate each other while the invariant lock is
	// held. A correct implementation queues both requests behind that lock, so
	// exactly one succeeds and the other sees the last-Owner refusal.
	for round := 0; round < 5; round++ {
		if _, err = pool.Exec(ctx, `UPDATE users SET role='owner', active=TRUE WHERE id IN ($1,$2)`, firstOwnerID, secondOwnerID); err != nil {
			t.Fatal(err)
		}
		holder, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = holder.Exec(ctx, `SELECT pg_advisory_lock(hashtext('tilecast.users.active-owner'))`); err != nil {
			holder.Release()
			t.Fatal(err)
		}
		codes := make(chan int, 2)
		go func() { codes <- deactivate(firstOwner, secondOwnerID) }()
		go func() { codes <- deactivate(secondOwner, firstOwnerID) }()
		time.Sleep(200 * time.Millisecond)
		if _, err = holder.Exec(ctx, `SELECT pg_advisory_unlock(hashtext('tilecast.users.active-owner'))`); err != nil {
			holder.Release()
			t.Fatal(err)
		}
		holder.Release()
		first, second := <-codes, <-codes
		succeeded := 0
		refused := 0
		for _, code := range []int{first, second} {
			switch code {
			case http.StatusNoContent:
				succeeded++
			case http.StatusConflict:
				refused++
			default:
				t.Fatalf("round %d: unexpected status %d", round, code)
			}
		}
		if succeeded != 1 || refused != 1 {
			t.Fatalf("round %d: statuses = %d and %d, want one %d and one %d", round, first, second, http.StatusNoContent, http.StatusConflict)
		}
		var activeOwners int
		if err = pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE role='owner' AND active=TRUE`).Scan(&activeOwners); err != nil {
			t.Fatal(err)
		}
		if activeOwners != 1 {
			t.Fatalf("round %d: active owners = %d, want 1", round, activeOwners)
		}
	}
}
