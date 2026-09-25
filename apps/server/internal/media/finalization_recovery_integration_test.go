package media

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

type finalizationFaultStorage struct {
	Storage
	failCommit       bool
	moveThenFailOnce bool
}

func (s *finalizationFaultStorage) Commit(tempKey, finalKey string) error {
	if s.failCommit {
		return errors.New("injected storage commit failure")
	}
	if s.moveThenFailOnce {
		s.moveThenFailOnce = false
		if err := s.Storage.Commit(tempKey, finalKey); err != nil {
			return err
		}
		return errors.New("injected ambiguous storage commit result")
	}
	return s.Storage.Commit(tempKey, finalKey)
}

func TestUploadFinalizationRecoveryAcrossFailureBoundaries(t *testing.T) {
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
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	defer lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) //nolint:errcheck
	if err := database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `TRUNCATE media_jobs,upload_sessions,asset_variants,assets,device_pairing_sessions,device_credentials,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{
		OrganizationName: "Finalization Recovery",
		OwnerName:        "Owner",
		Username:         "owner",
		Password:         "correct horse battery staple",
	})
	if err != nil {
		t.Fatal(err)
	}
	baseStorage, err := NewLocalStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	storage := &finalizationFaultStorage{Storage: baseStorage}
	service := NewService(pool, storage, Config{
		MaxUploadBytes:    1 << 20,
		ReservedFreeBytes: 1,
		Workers:           1,
	})
	var content bytes.Buffer
	if err := png.Encode(&content, image.NewRGBA(image.Rect(0, 0, 16, 9))); err != nil {
		t.Fatal(err)
	}
	createAndFill := func(name string) Upload {
		upload, createErr := service.CreateUpload(ctx, owner.User.ID, name, "image/png", int64(content.Len()))
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, appendErr := service.AppendUpload(ctx, upload.ID, owner.User.ID, 0, bytes.NewReader(content.Bytes())); appendErr != nil {
			t.Fatal(appendErr)
		}
		return upload
	}
	status := func(id uuid.UUID) (string, *string) {
		var current string
		var finalKey *string
		if err := pool.QueryRow(ctx, `SELECT status,final_storage_key FROM upload_sessions WHERE id=$1`, id).Scan(&current, &finalKey); err != nil {
			t.Fatal(err)
		}
		return current, finalKey
	}

	// A storage error before the move leaves the temporary source and a
	// finalizing journal row; retrying completes the same upload.
	storageFailure := createAndFill("storage-failure.png")
	storage.failCommit = true
	if _, err := service.FinalizeUpload(ctx, storageFailure.ID, owner.User.ID); err == nil {
		t.Fatal("expected injected storage failure")
	}
	current, finalKey := status(storageFailure.ID)
	if current != string(UploadFinalizing) || finalKey == nil {
		t.Fatalf("storage failure state=%q final=%v", current, finalKey)
	}
	if _, err := storage.Stat(UploadKey(storageFailure.ID)); err != nil {
		t.Fatalf("temporary object was lost after storage failure: %v", err)
	}
	storage.failCommit = false
	_, err = service.FinalizeUpload(ctx, storageFailure.ID, owner.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current, _ = status(storageFailure.ID); current != string(UploadFinalized) {
		t.Fatalf("retry did not finalize upload: %q", current)
	}
	if _, err := storage.Stat(*finalKey); err != nil {
		t.Fatalf("final object missing after retry: %v", err)
	}

	// A move that returns an ambiguous error is recovered from the recorded
	// final key; the retry must not attempt to move a missing temp file again.
	ambiguous := createAndFill("ambiguous.png")
	storage.moveThenFailOnce = true
	if _, err := service.FinalizeUpload(ctx, ambiguous.ID, owner.User.ID); err == nil {
		t.Fatal("expected ambiguous storage failure")
	}
	current, finalKey = status(ambiguous.ID)
	if current != string(UploadFinalizing) || finalKey == nil {
		t.Fatalf("ambiguous state=%q final=%v", current, finalKey)
	}
	if _, err := storage.Stat(*finalKey); err != nil {
		t.Fatalf("ambiguous move did not leave final object: %v", err)
	}
	if _, err := service.FinalizeUpload(ctx, ambiguous.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	// A moved object that is later found corrupted is a terminal failure, not a
	// recoverable retry. Its same-sized bytes must be removed so the failed row
	// cannot leave an untracked final object behind.
	corrupt := createAndFill("corrupt-final.png")
	storage.moveThenFailOnce = true
	if _, err := service.FinalizeUpload(ctx, corrupt.ID, owner.User.ID); err == nil {
		t.Fatal("expected ambiguous storage failure before corruption check")
	}
	current, finalKey = status(corrupt.ID)
	if current != string(UploadFinalizing) || finalKey == nil {
		t.Fatalf("corrupt state=%q final=%v", current, finalKey)
	}
	finalPath, err := baseStorage.Path(*finalKey)
	if err != nil {
		t.Fatal(err)
	}
	corruptBytes := bytes.Repeat([]byte{0x7f}, content.Len())
	if err := os.WriteFile(finalPath, corruptBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.FinalizeUpload(ctx, corrupt.ID, owner.User.ID); err == nil {
		t.Fatal("expected final hash mismatch")
	}
	current, finalKey = status(corrupt.ID)
	if current != string(UploadFailed) || finalKey == nil {
		t.Fatalf("corrupt finalization state=%q final=%v", current, finalKey)
	}
	var cleanupPending bool
	if err := pool.QueryRow(ctx, `SELECT finalization_cleanup_pending FROM upload_sessions WHERE id=$1`, corrupt.ID).Scan(&cleanupPending); err != nil {
		t.Fatal(err)
	}
	if cleanupPending {
		t.Fatal("corrupt finalization cleanup did not complete")
	}
	if _, err := storage.Stat(*finalKey); !os.IsNotExist(err) {
		t.Fatalf("corrupt final object was not removed: %v", err)
	}

	// A database failure after the move leaves the object tracked by the
	// finalization journal. The idempotent retry registers it exactly once.
	registration := createAndFill("database-failure.png")
	service.SetFinalizationHooks(FinalizationHooks{
		BeforeRegistrationCommit: func() error { return errors.New("injected database commit failure") },
	})
	if _, err := service.FinalizeUpload(ctx, registration.ID, owner.User.ID); err == nil {
		t.Fatal("expected injected registration failure")
	}
	current, finalKey = status(registration.ID)
	if current != string(UploadFinalizing) || finalKey == nil {
		t.Fatalf("registration state=%q final=%v", current, finalKey)
	}
	service.SetFinalizationHooks(FinalizationHooks{})
	if _, err := service.FinalizeUpload(ctx, registration.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if current, _ = status(registration.ID); current != string(UploadFinalized) {
		t.Fatalf("registration retry did not finalize upload: %q", current)
	}

	// A failure before identity persistence is also safe: no final object is
	// published and the next attempt can continue from the temporary source.
	identity := createAndFill("identity-failure.png")
	service.SetFinalizationHooks(FinalizationHooks{
		BeforeIdentityPersist: func() error { return errors.New("injected identity persistence failure") },
	})
	if _, err := service.FinalizeUpload(ctx, identity.ID, owner.User.ID); err == nil {
		t.Fatal("expected injected identity failure")
	}
	current, finalKey = status(identity.ID)
	if current != string(UploadFinalizing) || finalKey != nil {
		t.Fatalf("identity failure state=%q final=%v", current, finalKey)
	}
	service.SetFinalizationHooks(FinalizationHooks{})
	if _, err := service.FinalizeUpload(ctx, identity.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	// Two callers retrying the same upload at once must converge on one
	// journaled identity and one registered asset. The storage hand-off is
	// deliberately slow in production, so this exercises the cross-system lock
	// rather than relying on the usual sequential idempotence test.
	concurrent := createAndFill("concurrent.png")
	results := make(chan struct {
		asset Asset
		err   error
	}, 2)
	var group sync.WaitGroup
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			asset, finalizeErr := service.FinalizeUpload(ctx, concurrent.ID, owner.User.ID)
			results <- struct {
				asset Asset
				err   error
			}{asset: asset, err: finalizeErr}
		}()
	}
	group.Wait()
	close(results)
	var assetID uuid.UUID
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if assetID == uuid.Nil {
			assetID = result.asset.ID
		} else if result.asset.ID != assetID {
			t.Fatalf("concurrent finalizers returned different assets: %s and %s", assetID, result.asset.ID)
		}
	}
	var registered int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM upload_sessions WHERE id=$1 AND status='finalized' AND resulting_asset_id=$2`, concurrent.ID, assetID).Scan(&registered); err != nil {
		t.Fatal(err)
	}
	if registered != 1 {
		t.Fatalf("concurrent finalizers registered %d upload rows, want 1", registered)
	}
}
