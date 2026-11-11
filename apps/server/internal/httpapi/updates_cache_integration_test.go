package httpapi

import (
	"context"
	"testing"

	"github.com/tilecast/tilecast/apps/server/internal/updates"
)

func TestCachePlayerReleaseRecordsFailureAfterDeadline(t *testing.T) {
	f := newEdgeFixture(t)
	id := f.edgeRelease(t, "x86_64")
	if _, err := f.pool.Exec(f.ctx, `UPDATE player_releases SET cache_status='downloading',verification_status='verified_manifest' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	service, err := updates.NewService(f.pool, nil, updates.Config{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	f.server.updates = service

	expired, cancel := context.WithTimeout(f.ctx, 0)
	defer cancel()
	f.server.cachePlayerReleaseArtifact(expired, id)

	var cacheStatus, verificationStatus, message string
	if err := f.pool.QueryRow(f.ctx, `SELECT cache_status,verification_status,COALESCE(verification_error,'') FROM player_releases WHERE id=$1`, id).Scan(&cacheStatus, &verificationStatus, &message); err != nil {
		t.Fatal(err)
	}
	if cacheStatus != "failed" || verificationStatus != "failed" || message != "verified player release was not found" {
		t.Fatalf("cache status = %q, verification status = %q, verification error = %q", cacheStatus, verificationStatus, message)
	}
}
