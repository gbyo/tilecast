package media

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
)

func TestMediaUploadProcessingAndDeletionLifecycle(t *testing.T) {
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
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Media Integration", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	storage, err := NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	var content bytes.Buffer
	if err := png.Encode(&content, image.NewRGBA(image.Rect(0, 0, 64, 36))); err != nil {
		t.Fatal(err)
	}
	// The processor still executes an explicit binary without a shell. This tiny test executable
	// emulates FFmpeg by copying the generated fixture to its final argument.
	fixture := filepath.Join(root, "fixture.jpg")
	if err := os.WriteFile(fixture, content.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(root, "fake-ffmpeg")
	script := fmt.Sprintf("#!/bin/sh\nfor last; do :; done\ncp %q \"$last\"\n", fixture)
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, storage, Config{MaxUploadBytes: 1 << 20, ReservedFreeBytes: 1, FFmpegPath: fake, Workers: 1, Profile: CompatibilityProfile{MaxWidth: 1920, MaxHeight: 1080, MaxFrameRate: 60}, Website: WebsitePolicy{DefaultTimeoutSeconds: 20, MaxTimeoutSeconds: 120, MinRefreshSeconds: 30, MaxAllowedHosts: 25, MaxWebsites: 500}, SourceFetch: SourceFetchPolicy{AllowPrivateNetworks: true, Timeout: 5 * time.Second, MaximumBytes: 1 << 20, MaximumRedirects: 3, MinimumRefresh: 5 * time.Minute, MaximumRefresh: 24 * time.Hour}})
	upload, err := service.CreateUpload(ctx, owner.User.ID, FullAccess(owner.User.ID), nil, "misleading-video.mp4", "video/mp4", int64(content.Len()))
	if err != nil {
		t.Fatal(err)
	}
	first := content.Bytes()[:20]
	state, err := service.AppendUpload(ctx, upload.ID, owner.User.ID, 0, bytes.NewReader(first))
	if err != nil || state.CurrentOffset != 20 {
		t.Fatalf("first chunk: %#v %v", state, err)
	}
	if _, err := service.AppendUpload(ctx, upload.ID, owner.User.ID, 3, bytes.NewReader([]byte("wrong"))); !errors.Is(err, ErrOffsetMismatch) {
		t.Fatalf("wrong offset: %v", err)
	}
	state, err = service.GetUpload(ctx, upload.ID, owner.User.ID)
	if err != nil || state.CurrentOffset != 20 {
		t.Fatalf("resume state: %#v %v", state, err)
	}
	if _, err := service.AppendUpload(ctx, upload.ID, owner.User.ID, 20, bytes.NewReader(content.Bytes()[20:])); err != nil {
		t.Fatal(err)
	}
	asset, err := service.FinalizeUpload(ctx, upload.ID, owner.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	if asset.Type != "image" || asset.DetectedMIMEType != "image/png" {
		t.Fatalf("trusted type detection failed: %#v", asset)
	}
	duplicate, err := service.FinalizeUpload(ctx, upload.ID, owner.User.ID)
	if err != nil || duplicate.ID != asset.ID {
		t.Fatalf("duplicate finalization: %#v %v", duplicate, err)
	}
	worker := NewWorkerPool(service, nil)
	if err := worker.inspect(ctx, asset.ID); err != nil {
		t.Fatal(err)
	}
	if err := worker.preview(ctx, asset.ID, false); err != nil {
		t.Fatal(err)
	}
	ready, err := service.GetAsset(ctx, asset.ID)
	if err != nil || ready.ProcessingStatus != StatusReady || ready.ThumbnailURL == nil {
		t.Fatalf("processed asset: %#v %v", ready, err)
	}
	listed, err := service.ListAssets(ctx, ListOptions{Page: 1, PageSize: 24})
	if err != nil || len(listed.Items) != 1 || listed.Items[0].ThumbnailURL == nil {
		t.Fatalf("listed asset thumbnail: %#v %v", listed, err)
	}
	websiteInput := validWebsite()
	websiteInput.FallbackImageAssetID = &ready.ID
	websiteInput.FailureBehavior = "fallback_image"
	website, err := service.CreateWebsite(ctx, owner.User.ID, websiteInput)
	if err != nil {
		t.Fatal(err)
	}
	if website.Type != "widget" || website.Widget == nil || website.Widget.Provider != "website" || website.Website == nil || len(website.Variants) != 0 || website.Website.FallbackImageAssetID == nil {
		t.Fatalf("website=%#v", website)
	}
	if err = service.ArchiveAssets(ctx, []uuid.UUID{ready.ID}, owner.User.ID); err == nil {
		t.Fatal("asset used as a website fallback was archived")
	}
	websiteInput.URL = "https://status.example.org/display"
	websiteInput.AllowedHosts = []string{"cdn.example.org"}
	website, err = service.UpdateWebsite(ctx, website.ID, owner.User.ID, websiteInput)
	if err != nil || len(website.Website.AllowedHosts) != 2 {
		t.Fatalf("updated website=%#v %v", website, err)
	}
	diagnostics, err := service.WebsiteDiagnostics(ctx, website.ID)
	if err != nil || diagnostics.ConfiguredURL != "https://status.example.org/display" {
		t.Fatalf("diagnostics=%#v %v", diagnostics, err)
	}
	if err = service.DeleteAsset(ctx, website.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	calendarServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/calendar")
		start := time.Now().UTC().Add(24 * time.Hour)
		_, _ = fmt.Fprintf(w, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:integration-event\r\nDTSTART:%s\r\nDTEND:%s\r\nSUMMARY:Board meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", start.Format("20060102T150405Z"), start.Add(time.Hour).Format("20060102T150405Z"))
	}))
	defer calendarServer.Close()
	calendarConfiguration, _ := json.Marshal(CalendarConfig{Calendars: []CalendarFeed{{Name: "District", URL: calendarServer.URL}}, DisplayMode: "upcoming", MaxEvents: 10, Fields: CalendarFields{Title: true, StartTime: true, EndTime: true, Location: true}, Timezone: "UTC", RefreshIntervalSeconds: 300, StalenessLimitHours: 168, EmptyState: "No events"})
	calendarAsset, err := service.CreateDataSource(ctx, owner.User.ID, DataSourceInput{Provider: "calendar", Name: "District calendar", Configuration: calendarConfiguration})
	if err != nil {
		t.Fatal(err)
	}
	scheduleBoardConfiguration, _ := json.Marshal(map[string]any{
		"dataSourceId": calendarAsset.ID.String(), "titleField": "title",
		"startField": "startTime", "endField": "endTime", "locationField": "location",
		"upcomingCount": 4, "columns": 2, "foregroundColor": "#ffffff",
		"backgroundColor": "#101f33", "accentColor": "#5dd6c0",
		"emptyState": "No more events scheduled",
	})
	scheduleBoard, err := service.CreateWidget(ctx, owner.User.ID, WidgetInput{
		Provider: "schedule-board", Name: "Daily bell schedule", Configuration: scheduleBoardConfiguration,
	})
	if err != nil || scheduleBoard.Widget == nil || scheduleBoard.Widget.Provider != "schedule-board" {
		t.Fatalf("create Calendar-backed Schedule Board: %#v err=%v", scheduleBoard, err)
	}
	sourceWorker := NewDataSourceRefreshWorker(service, nil)
	worked, err := sourceWorker.runOne(ctx)
	if err != nil || !worked {
		t.Fatalf("calendar refresh worked=%t err=%v", worked, err)
	}
	calendarDiagnostics, err := service.DataSourceRefreshDiagnostics(ctx, calendarAsset.ID)
	if err != nil || calendarDiagnostics.ParseStatus != "success" || calendarDiagnostics.AvailableEventCount != 1 || calendarDiagnostics.LastSuccessfulAt == nil {
		t.Fatalf("calendar diagnostics=%#v err=%v", calendarDiagnostics, err)
	}
	dataSources, err := service.ListDataSources(ctx, DataSourceListOptions{Page: 1, PageSize: 100})
	if err != nil {
		t.Fatal(err)
	}
	var listedCalendar DataSourceListItem
	for _, source := range dataSources.Items {
		if source.ID == calendarAsset.ID {
			listedCalendar = source
			break
		}
	}
	if listedCalendar.ID != calendarAsset.ID || listedCalendar.Status != "ready" || listedCalendar.CachedRecords != 1 {
		t.Fatalf("listed calendar=%#v", listedCalendar)
	}
	projected, err := service.PlayerDataSourceConfiguration(ctx, calendarAsset.ID, "calendar", calendarConfiguration)
	if err != nil || strings.Contains(string(projected), calendarServer.URL) || !strings.Contains(string(projected), "Board meeting") {
		t.Fatalf("calendar projection=%s err=%v", projected, err)
	}
	jsonServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"items":[{"name":"Lunch menu","room":"Cafeteria"}]}`)
	}))
	defer jsonServer.Close()
	structuredConfiguration, _ := json.Marshal(StructuredSourceConfig{URL: jsonServer.URL, Presentation: "list", MaxItems: 10, Fields: StructuredFields{Title: true, Subtitle: true}, Sort: "source", Mapping: &StructuredMapping{RootList: "/items", Title: "/name", Subtitle: "/room"}, RefreshIntervalSeconds: 300, StalenessLimitHours: 168, EmptyState: "No items"})
	structuredAsset, err := service.CreateDataSource(ctx, owner.User.ID, DataSourceInput{Provider: "json", Name: "Lunch data", Configuration: structuredConfiguration})
	if err != nil {
		t.Fatal(err)
	}
	worked, err = sourceWorker.runOne(ctx)
	if err != nil || !worked {
		t.Fatalf("structured refresh worked=%t err=%v", worked, err)
	}
	structuredDiagnostics, err := service.DataSourceRefreshDiagnostics(ctx, structuredAsset.ID)
	if err != nil || structuredDiagnostics.AvailableItemCount != 1 || structuredDiagnostics.ParseStatus != "success" {
		t.Fatalf("structured diagnostics=%#v err=%v", structuredDiagnostics, err)
	}
	structuredProjection, err := service.PlayerDataSourceConfiguration(ctx, structuredAsset.ID, "json", structuredConfiguration)
	if err != nil || strings.Contains(string(structuredProjection), jsonServer.URL) || strings.Contains(string(structuredProjection), "rootList") || !strings.Contains(string(structuredProjection), "Lunch menu") {
		t.Fatalf("structured projection=%s err=%v", structuredProjection, err)
	}
	var compatible Variant
	for _, variant := range ready.Variants {
		if variant.PlayerCompatible {
			compatible = variant
			break
		}
	}
	if compatible.ID.String() == "00000000-0000-0000-0000-000000000000" {
		t.Fatal("missing compatible variant")
	}
	delivery, err := service.Delivery(ctx, asset.ID, compatible.ID)
	if err != nil || delivery.Size != int64(content.Len()) {
		t.Fatalf("delivery: %#v %v", delivery, err)
	}
	previewDelivery, err := service.PlaybackPreview(ctx, asset.ID)
	if err != nil || previewDelivery.AssetID != asset.ID || previewDelivery.VariantID.String() == "00000000-0000-0000-0000-000000000000" {
		t.Fatalf("playback preview: %#v %v", previewDelivery, err)
	}
	if err := os.Remove(delivery.Path); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Delivery(ctx, asset.ID, compatible.ID); !errors.Is(err, ErrVariantUnavailable) {
		t.Fatalf("missing file: %v", err)
	}
	expired, err := service.CreateUpload(ctx, owner.User.ID, FullAccess(owner.User.ID), nil, "expired.png", "image/png", 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE upload_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1`, expired.ID); err != nil {
		t.Fatal(err)
	}
	if err := worker.cleanExpired(ctx); err != nil {
		t.Fatal(err)
	}
	var expiredStatus, expiredFailure string
	if err := pool.QueryRow(ctx, `SELECT status,failure_code FROM upload_sessions WHERE id=$1`, expired.ID).Scan(&expiredStatus, &expiredFailure); err != nil {
		t.Fatal(err)
	}
	if expiredStatus != string(UploadExpired) || expiredFailure != "upload_expired" {
		t.Fatalf("expired upload cleanup state=%q/%q", expiredStatus, expiredFailure)
	}
	if _, err := storage.Stat(UploadKey(expired.ID)); !os.IsNotExist(err) {
		t.Fatalf("expired temporary file remains: %v", err)
	}
	if err := worker.cleanExpired(ctx); err != nil {
		t.Fatalf("repeat expired cleanup: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE assets SET expires_at=now()-interval '1 minute' WHERE id=$1`, asset.ID); err != nil {
		t.Fatal(err)
	}
	findAsset := func(items []Asset, id uuid.UUID) *Asset {
		for index := range items {
			if items[index].ID == id {
				return &items[index]
			}
		}
		return nil
	}
	active, err := service.ListAssets(ctx, ListOptions{Page: 1, PageSize: 24})
	if err != nil || findAsset(active.Items, asset.ID) != nil {
		t.Fatalf("expired asset remained active: %#v %v", active, err)
	}
	archived, err := service.ListAssets(ctx, ListOptions{Page: 1, PageSize: 24, Archived: true, Sort: "updated"})
	expiredAsset := findAsset(archived.Items, asset.ID)
	if err != nil || expiredAsset == nil || expiredAsset.ArchivedAt == nil || expiredAsset.ExpiresAt == nil {
		t.Fatalf("expired asset missing from archive: %#v %v", archived, err)
	}
	if _, err = service.GetAsset(ctx, asset.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired asset visible through active detail: %v", err)
	}
	if err = service.RestoreAssets(ctx, []uuid.UUID{asset.ID}, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := service.GetAsset(ctx, asset.ID)
	if err != nil || restored.ExpiresAt != nil {
		t.Fatalf("restored expired asset kept its elapsed expiration: %#v %v", restored, err)
	}
	if err := service.ArchiveAssets(ctx, []uuid.UUID{asset.ID}, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	active, err = service.ListAssets(ctx, ListOptions{Page: 1, PageSize: 24})
	if err != nil || findAsset(active.Items, asset.ID) != nil {
		t.Fatalf("archived asset remained active: %#v %v", active, err)
	}
	archived, err = service.ListAssets(ctx, ListOptions{Page: 1, PageSize: 24, Archived: true})
	archivedAsset := findAsset(archived.Items, asset.ID)
	if err != nil || archivedAsset == nil || archivedAsset.ArchivedAt == nil {
		t.Fatalf("archive listing: %#v %v", archived, err)
	}
	if _, err = service.GetAsset(ctx, asset.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("archived asset visible through active detail: %v", err)
	}
	if err = service.RestoreAssets(ctx, []uuid.UUID{asset.ID}, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.GetAsset(ctx, asset.ID); err != nil {
		t.Fatalf("restored asset unavailable: %v", err)
	}
	if err := service.DeleteAsset(ctx, asset.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if err := worker.deleteFiles(ctx, asset.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetAsset(ctx, asset.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted asset visible: %v", err)
	}
}
