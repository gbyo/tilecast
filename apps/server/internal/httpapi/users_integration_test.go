package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
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
