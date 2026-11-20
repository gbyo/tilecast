package installer

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func (f *installerFixture) lockContribution(t *testing.T, kind, id, digest string) bool {
	t.Helper()
	ctx := context.Background()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	available, err := f.service.LockPackageContribution(ctx, tx, "acme.athletics", kind, id, digest)
	if err != nil {
		t.Fatal(err)
	}
	return available
}

func TestLockPackageContributionRevalidatesInstallation(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()
	const source = "acme.athletics.schedule"

	if f.lockContribution(t, "dataSource", source, testDigestV1) {
		t.Fatal("an uninstalled package reported its contribution available")
	}
	if _, err := f.service.Activate(ctx, testActivation("2.4.1", testDigestV1)); err != nil {
		t.Fatal(err)
	}
	if !f.lockContribution(t, "dataSource", source, testDigestV1) {
		t.Fatal("an installed contribution reported unavailable")
	}
	if !f.lockContribution(t, "dataSource", source, "") {
		t.Fatal("an empty digest must skip the activation comparison")
	}
	if f.lockContribution(t, "widget", source, testDigestV1) {
		t.Fatal("a contribution matched under the wrong kind")
	}
	if f.lockContribution(t, "dataSource", "acme.athletics.unknown", testDigestV1) {
		t.Fatal("an undeclared contribution reported available")
	}

	if _, err := f.service.Activate(ctx, testActivation("2.5.0", testDigestV2)); err != nil {
		t.Fatal(err)
	}
	if f.lockContribution(t, "dataSource", source, testDigestV1) {
		t.Fatal("a definition from a replaced activation reported available")
	}
	if !f.lockContribution(t, "dataSource", source, testDigestV2) {
		t.Fatal("the current activation reported unavailable")
	}

	if err := f.service.Remove(ctx, "acme.athletics", f.userID); err != nil {
		t.Fatal(err)
	}
	if f.lockContribution(t, "dataSource", source, testDigestV2) {
		t.Fatal("a removed package reported its contribution available")
	}
}

// A creation that locked the package before Remove started keeps Remove
// waiting until it commits, and Remove then counts the new content.
func TestRemoveWaitsForInFlightContentCreation(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()
	if _, err := f.service.Activate(ctx, testActivation("2.4.1", testDigestV1)); err != nil {
		t.Fatal(err)
	}
	var organizationID uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM organization_settings LIMIT 1`).Scan(&organizationID); err != nil {
		t.Fatal(err)
	}

	creation, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer creation.Rollback(ctx) //nolint:errcheck
	available, err := f.service.LockPackageContribution(ctx, creation, "acme.athletics", "dataSource", "acme.athletics.schedule", testDigestV1)
	if err != nil || !available {
		t.Fatalf("gate = %v, %v", available, err)
	}

	removed := make(chan error, 1)
	go func() { removed <- f.service.Remove(ctx, "acme.athletics", f.userID) }()
	select {
	case err := <-removed:
		t.Fatalf("Remove did not wait for the in-flight creation: %v", err)
	case <-time.After(300 * time.Millisecond):
	}

	if _, err := creation.Exec(ctx, `INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by)
		VALUES($1,$2,'Schedule','acme.athletics.schedule','{}'::jsonb,$3)`, uuid.New(), organizationID, f.userID); err != nil {
		t.Fatal(err)
	}
	if err := creation.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-removed:
		var inUse *InUseError
		if !errors.As(err, &inUse) {
			t.Fatalf("Remove after the creation committed = %#v, want InUseError", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Remove stayed blocked after the creation committed")
	}
	if _, err := f.service.Get(ctx, "acme.athletics"); err != nil {
		t.Fatalf("blocked removal deleted the installation: %v", err)
	}
}

// A creation that starts while Remove holds the package waits for it and
// then sees the package gone.
func TestContentCreationWaitsForRemoval(t *testing.T) {
	f := newInstallerFixture(t)
	ctx := context.Background()
	if _, err := f.service.Activate(ctx, testActivation("2.4.1", testDigestV1)); err != nil {
		t.Fatal(err)
	}

	removal, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer removal.Rollback(ctx) //nolint:errcheck
	if _, err := removal.Exec(ctx, `SELECT 1 FROM installed_packages WHERE package_id='acme.athletics' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}

	type answer struct {
		available bool
		err       error
	}
	gated := make(chan answer, 1)
	go func() {
		tx, err := f.pool.Begin(ctx)
		if err != nil {
			gated <- answer{err: err}
			return
		}
		defer tx.Rollback(ctx) //nolint:errcheck
		available, err := f.service.LockPackageContribution(ctx, tx, "acme.athletics", "widget", "acme.athletics.scoreboard", testDigestV1)
		gated <- answer{available, err}
	}()
	select {
	case got := <-gated:
		t.Fatalf("the gate did not wait for the removal lock: %+v", got)
	case <-time.After(300 * time.Millisecond):
	}
	if _, err := removal.Exec(ctx, `DELETE FROM installed_packages WHERE package_id='acme.athletics'`); err != nil {
		t.Fatal(err)
	}
	if err := removal.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-gated:
		if got.err != nil || got.available {
			t.Fatalf("gate after removal = %+v, want unavailable", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the gate stayed blocked after the removal committed")
	}
}
