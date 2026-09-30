package httpapi

import (
	"context"
	"log/slog"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/approvals"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/contenthealth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/devices"
	"github.com/tilecast/tilecast/apps/server/internal/fleetops"
	"github.com/tilecast/tilecast/apps/server/internal/integrations"
	"github.com/tilecast/tilecast/apps/server/internal/notify"
	"github.com/tilecast/tilecast/apps/server/internal/playlists"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
	"github.com/tilecast/tilecast/apps/server/internal/snapshots"
)

// Every query added by the new features, run against a real PostgreSQL server
// with rows present so the scans execute.
//
// These are hand-written CTEs, UNION ALLs, FILTER aggregates, and a
// string-built scope predicate. None of that can be validated by a unit test:
// a wrong column name or a mistyped scan is a runtime error only.
func TestNewFeatureQueries(t *testing.T) {
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
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(ctx, `TRUNCATE
		screen_snapshots,playlist_revisions,content_reviews,user_screen_scopes,
		integration_tokens,bulk_operations,notification_deliveries,notification_webhooks,
		incidents,screen_group_playlist_assignments,screen_group_memberships,screen_groups,
		screen_playlist_assignments,playlist_items,playlists,data_source_refresh_states,
		data_sources,widgets,asset_variants,assets,device_credentials,screens,locations,
		sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}

	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{
		OrganizationName: "Query Test", OwnerName: "Owner",
		Username: "owner", Password: "correct horse battery staple",
	})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}

	// A location, a sync group, two screens in it, and a credential each, so the
	// scope predicate and the group expansion have something to resolve.
	locationID := uuid.New()
	if _, err = pool.Exec(ctx,
		`INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'Main Building')`,
		locationID, org); err != nil {
		t.Fatal(err)
	}
	groupID := uuid.New()
	if _, err = pool.Exec(ctx,
		`INSERT INTO screen_groups(id,organization_id,name,created_by) VALUES($1,$2,'North Wing',$3)`,
		groupID, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	screenA, screenB := uuid.New(), uuid.New()
	for i, screen := range []uuid.UUID{screenA, screenB} {
		name := []string{"Cafeteria", "Gym"}[i]
		if _, err = pool.Exec(ctx, `
			INSERT INTO screens(id,organization_id,player_installation_id,name,platform,
				device_manufacturer,device_model,android_version,player_version,
				screen_width,screen_height,density,locale,timezone,location_id,last_heartbeat_at)
			VALUES($1,$2,$3,$4,'android-tv','Google','ADT-3','14','0.18.0',
				1920,1080,2,'en-US','UTC',$5,now())`,
			screen, org, uuid.NewString(), name, locationID); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `
			INSERT INTO device_credentials(id,screen_id,public_id,secret_hash)
			VALUES($1,$2,$3,$4)`,
			uuid.New(), screen, uuid.NewString(), make([]byte, 32)); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx,
			`INSERT INTO screen_group_memberships(screen_group_id,screen_id) VALUES($1,$2)`,
			groupID, screen); err != nil {
			t.Fatal(err)
		}
	}

	// A playlist assigned to the group, so the empty-playlist sweep and the
	// review queue both see assigned content.
	playlistService := playlists.NewService(pool, nil)
	playlist, err := playlistService.Create(ctx, owner.User.ID, "Menu", "", "static")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO screen_group_playlist_assignments(screen_group_id,playlist_id,assigned_by)
		VALUES($1,$2,$3)`, groupID, playlist.ID, owner.User.ID); err != nil {
		t.Fatal(err)
	}

	// A Data Source with a stale refresh state, referenced by a widget, so the
	// stale-source sweep has a candidate.
	sourceID := uuid.New()
	if _, err = pool.Exec(ctx, `
		INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by)
		VALUES($1,$2,'District Calendar','calendar','{}'::jsonb,$3)`,
		sourceID, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at,last_success_at,using_cached_data,error_code)
		VALUES($1,now(),now()-interval '5 days',TRUE,'http_500')`, sourceID); err != nil {
		t.Fatal(err)
	}
	widgetAsset := uuid.New()
	if _, err = pool.Exec(ctx, `
		INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,
			sha256,original_size,processing_status,created_by,origin)
		VALUES($1,$2,'Agenda','image','agenda.png','image/png',$3,10,'ready',$4,'library')`,
		widgetAsset, org, make([]byte, 32), owner.User.ID); err != nil {
		t.Fatal(err)
	}
	// widgets is keyed by its asset, not by an id of its own.
	if _, err = pool.Exec(ctx, `
		INSERT INTO widgets(asset_id,provider,configuration)
		VALUES($1,'agenda',jsonb_build_object('dataSourceId',$2::text))`,
		widgetAsset, sourceID.String()); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	settingsService := settings.NewService(pool, nil, settings.HardLimits{})
	deviceService := devices.NewService(pool, devices.NewPresenceHub(), "http://localhost:8080")

	t.Run("content health sweep and report", func(t *testing.T) {
		service := contenthealth.NewService(pool, settingsService)
		if err := service.Sweep(ctx); err != nil {
			t.Fatalf("Sweep: %v", err)
		}
		report, err := service.Report(ctx)
		if err != nil {
			t.Fatalf("Report: %v", err)
		}
		// The fixture has a source stale for five days and a playlist with no
		// items assigned to a group, so both conditions must be found.
		if len(report.StaleSources) == 0 {
			t.Error("the stale Data Source was not reported")
		}
		if len(report.EmptyPlaylists) == 0 {
			t.Error("the assigned empty playlist was not reported")
		}
		t.Logf("stale sources %d, empty playlists %d, unassigned screens %d",
			len(report.StaleSources), len(report.EmptyPlaylists), len(report.UnassignedScreens))
	})

	t.Run("notification outbox scan", func(t *testing.T) {
		service := notify.NewService(pool, settingsService, notify.DefaultConfig(), nil, nil, logger)
		count, err := service.ScanIncidents(ctx)
		if err != nil {
			t.Fatalf("ScanIncidents: %v", err)
		}
		if _, err := service.DeliverDue(ctx); err != nil {
			t.Fatalf("DeliverDue: %v", err)
		}
		if _, err := service.RecentDeliveries(ctx, 10); err != nil {
			t.Fatalf("RecentDeliveries: %v", err)
		}
		if _, err := service.ListWebhooks(ctx); err != nil {
			t.Fatalf("ListWebhooks: %v", err)
		}
		if err := service.Cleanup(ctx); err != nil {
			t.Fatalf("Cleanup: %v", err)
		}
		// The content health sweep opened two incidents just now, one of them
		// backdated to when the Data Source actually went stale. Both must be
		// offered for notification: freshness is judged on when Tilecast noticed
		// the condition, not on when the condition began, or a source stale for
		// longer than the window would silently never notify.
		if count != 2 {
			t.Errorf("scanned %d transitions, want 2 including the backdated one", count)
		}
		t.Logf("incident transitions scanned: %d", count)
	})

	t.Run("bulk operation preview expands the sync group", func(t *testing.T) {
		service := fleetops.NewService(pool, playlistService, deviceService, logger)
		preview, err := service.Build(ctx, fleetops.Request{
			ScreenIDs:  []uuid.UUID{screenA},
			Action:     fleetops.ActionAssignPlaylist,
			PlaylistID: &playlist.ID,
		})
		if err != nil {
			t.Fatalf("Build: %v", err)
		}
		// Selecting one member of a sync group must pull in the other.
		if len(preview.Screens) != 2 {
			t.Errorf("preview covers %d screens, want 2 through the group", len(preview.Screens))
		}
		if preview.GroupAddedCount != 1 {
			t.Errorf("group added %d screens, want 1", preview.GroupAddedCount)
		}
		if _, err := service.Recent(ctx, owner.User.ID, "administrator", 5); err != nil {
			t.Fatalf("Recent: %v", err)
		}
		t.Logf("preview: %d screens, %d added by the group, %d change",
			len(preview.Screens), preview.GroupAddedCount, preview.ChangeCount)

		// The operation-id paths must be scoped too. Preview and apply are
		// checked on the way in, but an operation id would otherwise be a way to
		// read or rewrite screens the caller cannot reach.
		service.SetScopeAuthorizer(deviceService)
		otherLocation := uuid.New()
		if _, err := pool.Exec(ctx,
			`INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'Elsewhere')`,
			otherLocation, org); err != nil {
			t.Fatal(err)
		}
		if err := deviceService.ReplaceScopes(ctx, owner.User.ID, owner.User.ID,
			[]devices.Scope{{Type: "location", ID: otherLocation}}); err != nil {
			t.Fatal(err)
		}
		if _, err := service.Undo(ctx, owner.User.ID, "administrator", uuid.New()); err == nil {
			t.Error("undo must not run for a caller outside the scope")
		}
		if err := deviceService.ReplaceScopes(ctx, owner.User.ID, owner.User.ID, nil); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("review queue and gate", func(t *testing.T) {
		service := approvals.NewService(pool, settingsService)
		queue, err := service.Queue(ctx, "")
		if err != nil {
			t.Fatalf("Queue: %v", err)
		}
		if len(queue) == 0 {
			t.Fatal("the assigned playlist is not in the review queue")
		}
		pending, err := service.Queue(ctx, "pending")
		if err != nil {
			t.Fatalf("Queue(pending): %v", err)
		}
		if len(pending) == 0 {
			t.Error("an unreviewed playlist must read as pending")
		}
		// Approval is off in the fixture, so the gate must pass.
		if err := service.Gate(ctx, approvals.TypePlaylist, playlist.ID); err != nil {
			t.Errorf("Gate with approval off = %v, want nil", err)
		}
		review, err := service.Decide(ctx, owner.User.ID, approvals.TypePlaylist, playlist.ID, true, "", 0)
		if err != nil {
			t.Fatalf("Decide: %v", err)
		}
		after, err := service.Queue(ctx, "approved")
		if err != nil {
			t.Fatalf("Queue(approved): %v", err)
		}
		if len(after) == 0 {
			t.Error("the approved revision is not reported as approved")
		}
		t.Logf("queue %d, approved revision %d", len(queue), review.Revision)
	})

	t.Run("command quota serializes concurrent inserts", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `DELETE FROM player_commands WHERE screen_id=$1`, screenA); err != nil {
			t.Fatal(err)
		}
		commandServer := &server{
			db: pool, devices: deviceService,
			operations: OperationsConfig{MaxPendingCommands: 1, DefaultCommandExpiryMinutes: 5},
		}
		results := make(chan error, 8)
		for range 8 {
			go func() {
				_, _, queueErr := commandServer.queueCommand(ctx, screenA, owner.User.ID, "sync_now", []byte(`{}`), uuid.New())
				results <- queueErr
			}()
		}
		succeeded, limited := 0, 0
		for range 8 {
			switch queueErr := <-results; queueErr {
			case nil:
				succeeded++
			case errCommandLimit:
				limited++
			default:
				t.Fatalf("queue command: %v", queueErr)
			}
		}
		if succeeded != 1 || limited != 7 {
			t.Fatalf("concurrent queue results: succeeded=%d limited=%d, want 1/7", succeeded, limited)
		}
		var pending int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM player_commands WHERE screen_id=$1 AND state='pending'`, screenA).Scan(&pending); err != nil {
			t.Fatal(err)
		}
		if pending != 1 {
			t.Fatalf("pending commands=%d, want 1", pending)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM player_commands WHERE screen_id=$1`, screenA); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("takeover list does not claim expiration", func(t *testing.T) {
		takeoverID := uuid.New()
		if _, err := pool.Exec(ctx, `
			INSERT INTO takeovers(id,organization_id,name,playlist_id,status,activated_by,activated_at,expires_at,created_at)
			VALUES($1,$2,'Expired but unreconciled',$3,'active',$4,now()-interval '2 hours',now()-interval '1 hour',now()-interval '3 hours')`,
			takeoverID, org, playlist.ID, owner.User.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO takeover_screen_states(takeover_id,screen_id,manifest_version,state)
			VALUES($1,$2,1,'active')`, takeoverID, screenA); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM takeovers WHERE id=$1`, takeoverID)
		})
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("GET", "/api/v1/takeovers", nil)
		(&server{db: pool}).listTakeovers(recorder, request)
		if recorder.Code != 200 {
			t.Fatalf("list takeovers status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		var status string
		if err := pool.QueryRow(ctx, `SELECT status FROM takeovers WHERE id=$1`, takeoverID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status != "active" {
			t.Fatalf("list read changed takeover status to %q, want active for canonical reconciler", status)
		}
	})

	t.Run("screen scopes", func(t *testing.T) {
		// Unscoped: the whole fleet, and every screen authorized.
		all, err := deviceService.ListScreensForUser(ctx, owner.User.ID, "administrator")
		if err != nil {
			t.Fatalf("ListScreensForUser unscoped: %v", err)
		}
		if len(all) != 2 {
			t.Errorf("unscoped list has %d screens, want 2", len(all))
		}
		if err := deviceService.AuthorizeScreens(ctx, owner.User.ID, "administrator",
			[]uuid.UUID{screenA, screenB}); err != nil {
			t.Errorf("unscoped authorization = %v, want nil", err)
		}

		// Scope to the location: both screens are in it.
		if err := deviceService.ReplaceScopes(ctx, owner.User.ID, owner.User.ID,
			[]devices.Scope{{Type: "location", ID: locationID}}); err != nil {
			t.Fatalf("ReplaceScopes: %v", err)
		}
		scoped, err := deviceService.ListScreensForUser(ctx, owner.User.ID, "administrator")
		if err != nil {
			t.Fatalf("ListScreensForUser scoped: %v", err)
		}
		if len(scoped) != 2 {
			t.Errorf("location-scoped list has %d screens, want 2", len(scoped))
		}
		// An Owner is never scoped even with grants present.
		if scopedOwner, err := deviceService.Scoped(ctx, owner.User.ID, "owner"); err != nil || scopedOwner {
			t.Errorf("Scoped(owner) = %v, %v; an Owner must never be scoped", scopedOwner, err)
		}

		// Scope to a location holding neither screen: both must be refused.
		otherLocation := uuid.New()
		if _, err = pool.Exec(ctx,
			`INSERT INTO locations(id,organization_id,name) VALUES($1,$2,'Annex')`,
			otherLocation, org); err != nil {
			t.Fatal(err)
		}
		if err := deviceService.ReplaceScopes(ctx, owner.User.ID, owner.User.ID,
			[]devices.Scope{{Type: "location", ID: otherLocation}}); err != nil {
			t.Fatalf("ReplaceScopes: %v", err)
		}
		err = deviceService.AuthorizeScreens(ctx, owner.User.ID, "administrator",
			[]uuid.UUID{screenA})
		if err == nil {
			t.Error("a screen outside the scope must be refused")
		}
		scopeServer := &server{db: pool, devices: deviceService}
		groupAllowed, err := scopeServer.screenTargetsWithinScope(ctx, owner.User.ID, "administrator", nil, []uuid.UUID{groupID})
		if err != nil {
			t.Fatalf("group scope authorization: %v", err)
		}
		if groupAllowed {
			t.Error("a Display Group containing only out-of-scope screens must be refused")
		}
		narrowed, err := deviceService.ListScreensForUser(ctx, owner.User.ID, "administrator")
		if err != nil {
			t.Fatalf("ListScreensForUser narrowed: %v", err)
		}
		if len(narrowed) != 0 {
			t.Errorf("narrowed list has %d screens, want 0", len(narrowed))
		}

		// A group grant must resolve through membership.
		if err := deviceService.ReplaceScopes(ctx, owner.User.ID, owner.User.ID,
			[]devices.Scope{{Type: "group", ID: groupID}}); err != nil {
			t.Fatalf("ReplaceScopes(group): %v", err)
		}
		viaGroup, err := deviceService.ListScreensForUser(ctx, owner.User.ID, "administrator")
		if err != nil {
			t.Fatalf("ListScreensForUser via group: %v", err)
		}
		if len(viaGroup) != 2 {
			t.Errorf("group-scoped list has %d screens, want 2", len(viaGroup))
		}
		groupAllowed, err = scopeServer.screenTargetsWithinScope(ctx, owner.User.ID, "administrator", nil, []uuid.UUID{groupID})
		if err != nil {
			t.Fatalf("group-granted authorization: %v", err)
		}
		if !groupAllowed {
			t.Error("an explicitly group-scoped account must reach every member of that group")
		}
		if _, err := deviceService.ScopesFor(ctx, owner.User.ID); err != nil {
			t.Fatalf("ScopesFor: %v", err)
		}
		// Leave the account unscoped so later subtests are unaffected.
		if err := deviceService.ReplaceScopes(ctx, owner.User.ID, owner.User.ID, nil); err != nil {
			t.Fatalf("ReplaceScopes(clear): %v", err)
		}
	})

	t.Run("integration token health and metrics", func(t *testing.T) {
		service := integrations.NewService(pool)
		token, secret, err := service.Create(ctx, owner.User.ID, "Monitoring",
			[]string{integrations.ScopeActivityRead}, nil, nil)
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		principal, err := service.Authenticate(ctx, "Bearer "+secret)
		if err != nil {
			t.Fatalf("Authenticate with the issued token: %v", err)
		}
		if principal.TokenID != token.ID {
			t.Error("authentication resolved the wrong token")
		}
		if !principal.HasScope(integrations.ScopeActivityRead) {
			t.Error("the issued scope was not carried")
		}
		if principal.MayWrite(uuid.New()) {
			t.Error("a read token must not be able to write")
		}
		if _, err := service.Authenticate(ctx, "Bearer "+secret+"x"); err == nil {
			t.Error("a wrong secret must not authenticate")
		}
		if err := service.Revoke(ctx, token.ID); err != nil {
			t.Fatalf("Revoke: %v", err)
		}
		if _, err := service.Authenticate(ctx, "Bearer "+secret); err == nil {
			t.Error("a revoked token must not authenticate")
		}

		health, err := service.Health(ctx)
		if err != nil {
			t.Fatalf("Health: %v", err)
		}
		if health.Screens.Total != 2 {
			t.Errorf("health reports %d screens, want 2", health.Screens.Total)
		}
		if metrics := health.Prometheus(); metrics == "" {
			t.Error("Prometheus output is empty")
		}
		t.Logf("health: total %d, recent %d, incidents %d",
			health.Screens.Total, health.Screens.Recent, health.Incidents.Open)
	})

	t.Run("snapshot sweep and reads", func(t *testing.T) {
		service := snapshots.NewService(pool, settingsService, nil, logger)
		// Disabled in the fixture, so Sweep must prune without asking for a
		// capture -- which is also why a nil capturer is safe here.
		if err := service.Sweep(ctx); err != nil {
			t.Fatalf("Sweep: %v", err)
		}
		if _, err := service.List(ctx, screenA, 10); err != nil {
			t.Fatalf("List: %v", err)
		}
		bytes, count, err := service.Usage(ctx)
		if err != nil {
			t.Fatalf("Usage: %v", err)
		}
		t.Logf("snapshot usage: %d bytes across %d rows", bytes, count)
	})
}
