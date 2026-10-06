package scheduling_test

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/database"
	"github.com/tilecast/tilecast/apps/server/internal/scheduling"
)

type scheduleFixture struct {
	name         string
	kind         scheduling.Kind
	presentation string
	enabled      bool
	priority     int
	ageHours     int
}

// libraryFixtures spans every facet value. Updated order is by ageHours
// ascending: the smallest age is the most recently updated.
var libraryFixtures = []scheduleFixture{
	{"Morning Broadcast", scheduling.Weekly, scheduling.PresentationPlaylist, true, 40, 1},
	{"Lunch Service", scheduling.Weekly, scheduling.PresentationLayout, true, 50, 2},
	{"Friday Night Lights", scheduling.OneTime, scheduling.PresentationPlaylist, true, 500, 3},
	{"Screens Off After Hours", scheduling.Weekly, scheduling.PresentationDisplayControl, false, 100, 4},
	{"Open House", scheduling.OneTime, scheduling.PresentationLayout, false, 50, 5},
	{"Holiday Closure", scheduling.OneTime, scheduling.PresentationDisplayControl, true, 0, 6},
	{"afternoon announcements", scheduling.Weekly, scheduling.PresentationPlaylist, false, 40, 7},
}

func openLibraryService(t *testing.T) (*scheduling.Service, map[string]uuid.UUID) {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	lockPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lockPool.Close)
	lock, err := lockPool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(lock.Release)
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_lock(7421999)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = lock.Exec(ctx, `SELECT pg_advisory_unlock(7421999)`) })
	if err = database.Migrate(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	pool, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `TRUNCATE schedule_targets,schedules,layout_revisions,layouts,playlist_items,playlists,screens,sessions,audit_logs,users,organization_settings CASCADE`); err != nil {
		t.Fatal(err)
	}
	owner, err := auth.NewService(pool, time.Hour).Setup(ctx, auth.SetupInput{OrganizationName: "Schedule Library Test", OwnerName: "Owner", Username: "owner", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	var org uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM organization_settings`).Scan(&org); err != nil {
		t.Fatal(err)
	}
	playlist, layout := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO playlists(id,organization_id,name,description,source_type,created_by)VALUES($1,$2,'Announcements','','static',$3)`, playlist, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO layouts(id,organization_id,name,orientation,canvas_width,canvas_height,draft_document,created_by)VALUES($1,$2,'Menu board','landscape',1920,1080,'{}'::jsonb,$3)`, layout, org, owner.User.ID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	ids := map[string]uuid.UUID{}
	for _, f := range libraryFixtures {
		id := uuid.New()
		ids[f.name] = id
		var playlistID, layoutID *uuid.UUID
		var action *string
		switch f.presentation {
		case scheduling.PresentationPlaylist:
			playlistID = &playlist
		case scheduling.PresentationLayout:
			layoutID = &layout
		default:
			value := `{"type":"display_power_off"}`
			action = &value
		}
		updated := now.Add(-time.Duration(f.ageHours) * time.Hour)
		if f.kind == scheduling.Weekly {
			_, err = pool.Exec(ctx, `INSERT INTO schedules(id,organization_id,name,playlist_id,layout_id,display_action,type,timezone,priority,enabled,daily_start,daily_end,days_of_week,created_by,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6::jsonb,'weekly','America/Chicago',$7,$8,'07:15','08:15','{1,2,3,4,5}',$9,$10,$10)`, id, org, f.name, playlistID, layoutID, action, f.priority, f.enabled, owner.User.ID, updated)
		} else {
			_, err = pool.Exec(ctx, `INSERT INTO schedules(id,organization_id,name,playlist_id,layout_id,display_action,type,timezone,priority,enabled,one_time_start,one_time_end,created_by,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6::jsonb,'one_time','America/New_York',$7,$8,$10,$11,$9,$10,$10)`, id, org, f.name, playlistID, layoutID, action, f.priority, f.enabled, owner.User.ID, updated, updated.Add(time.Hour))
		}
		if err != nil {
			t.Fatalf("insert %s: %v", f.name, err)
		}
	}
	return scheduling.NewService(pool, nil, scheduling.Limits{}), ids
}

func listNames(t *testing.T, service *scheduling.Service, filter scheduling.ListFilter, page, size int) ([]string, scheduling.List) {
	t.Helper()
	result, err := service.List(context.Background(), filter, page, size)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(result.Items))
	for _, item := range result.Items {
		names = append(names, item.Name)
	}
	return names, result
}

func ptr(value bool) *bool { return &value }

func TestScheduleLibraryFilters(t *testing.T) {
	service, _ := openLibraryService(t)

	cases := []struct {
		name   string
		filter scheduling.ListFilter
		want   []string
	}{
		{"no filters keeps the updated order", scheduling.ListFilter{}, []string{"Morning Broadcast", "Lunch Service", "Friday Night Lights", "Screens Off After Hours", "Open House", "Holiday Closure", "afternoon announcements"}},
		{"search is case-insensitive on the name", scheduling.ListFilter{Search: "  LUNCH "}, []string{"Lunch Service"}},
		{"search matches several", scheduling.ListFilter{Search: "n"}, []string{"Morning Broadcast", "Lunch Service", "Friday Night Lights", "Screens Off After Hours", "Open House", "afternoon announcements"}},
		{"enabled", scheduling.ListFilter{Enabled: ptr(true)}, []string{"Morning Broadcast", "Lunch Service", "Friday Night Lights", "Holiday Closure"}},
		{"disabled", scheduling.ListFilter{Enabled: ptr(false)}, []string{"Screens Off After Hours", "Open House", "afternoon announcements"}},
		{"weekly", scheduling.ListFilter{Type: scheduling.Weekly}, []string{"Morning Broadcast", "Lunch Service", "Screens Off After Hours", "afternoon announcements"}},
		{"one time", scheduling.ListFilter{Type: scheduling.OneTime}, []string{"Friday Night Lights", "Open House", "Holiday Closure"}},
		{"playlist", scheduling.ListFilter{PresentationType: scheduling.PresentationPlaylist}, []string{"Morning Broadcast", "Friday Night Lights", "afternoon announcements"}},
		{"layout", scheduling.ListFilter{PresentationType: scheduling.PresentationLayout}, []string{"Lunch Service", "Open House"}},
		{"display control", scheduling.ListFilter{PresentationType: scheduling.PresentationDisplayControl}, []string{"Screens Off After Hours", "Holiday Closure"}},
		{"combined facets", scheduling.ListFilter{Enabled: ptr(true), Type: scheduling.Weekly, PresentationType: scheduling.PresentationLayout}, []string{"Lunch Service"}},
		{"search narrows facets", scheduling.ListFilter{Search: "announce", Enabled: ptr(false)}, []string{"afternoon announcements"}},
		{"no results", scheduling.ListFilter{Search: "zzz"}, []string{}},
		{"facets that exclude each other", scheduling.ListFilter{Enabled: ptr(true), Type: scheduling.OneTime, PresentationType: scheduling.PresentationLayout}, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			names, result := listNames(t, service, tc.filter, 1, 50)
			if !slices.Equal(names, tc.want) {
				t.Fatalf("names=%v want %v", names, tc.want)
			}
			// The total comes from the same predicate as the rows.
			if result.Total != len(tc.want) {
				t.Fatalf("total=%d want %d", result.Total, len(tc.want))
			}
			if result.Items == nil {
				t.Fatal("items must be an empty list, not null")
			}
		})
	}
}

func TestScheduleLibraryPresentationTypeMatchesRecord(t *testing.T) {
	service, _ := openLibraryService(t)
	for _, kind := range []string{scheduling.PresentationPlaylist, scheduling.PresentationLayout, scheduling.PresentationDisplayControl} {
		result, err := service.List(context.Background(), scheduling.ListFilter{PresentationType: kind}, 1, 50)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range result.Items {
			if item.PresentationType != kind {
				t.Errorf("%s filter returned %s record %q", kind, item.PresentationType, item.Name)
			}
		}
	}
}

func TestScheduleLibrarySorts(t *testing.T) {
	service, _ := openLibraryService(t)
	cases := []struct {
		sort string
		want []string
	}{
		{scheduling.SortUpdated, []string{"Morning Broadcast", "Lunch Service", "Friday Night Lights", "Screens Off After Hours", "Open House", "Holiday Closure", "afternoon announcements"}},
		// Name sort ignores case, so the lower-case "afternoon" is not last.
		{scheduling.SortName, []string{"afternoon announcements", "Friday Night Lights", "Holiday Closure", "Lunch Service", "Morning Broadcast", "Open House", "Screens Off After Hours"}},
		// Priority ties fall back to the most recently updated: 50 (Lunch before
		// Open House) and 40 (Morning before afternoon).
		{scheduling.SortPriority, []string{"Friday Night Lights", "Screens Off After Hours", "Lunch Service", "Open House", "Morning Broadcast", "afternoon announcements", "Holiday Closure"}},
	}
	for _, tc := range cases {
		t.Run(tc.sort, func(t *testing.T) {
			names, _ := listNames(t, service, scheduling.ListFilter{Sort: tc.sort}, 1, 50)
			if !slices.Equal(names, tc.want) {
				t.Fatalf("names=%v\nwant  %v", names, tc.want)
			}
		})
	}
	t.Run("an omitted sort is the updated sort", func(t *testing.T) {
		omitted, _ := listNames(t, service, scheduling.ListFilter{}, 1, 50)
		updated, _ := listNames(t, service, scheduling.ListFilter{Sort: scheduling.SortUpdated}, 1, 50)
		if !slices.Equal(omitted, updated) {
			t.Fatalf("omitted=%v updated=%v", omitted, updated)
		}
	})
}

func TestScheduleLibraryTieBreaksByID(t *testing.T) {
	service, ids := openLibraryService(t)
	// Identical name, priority, and timestamp: only the id can order them.
	pool, err := database.Open(context.Background(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = pool.Exec(context.Background(), `UPDATE schedules SET name='Same', priority=7, updated_at='2026-01-01T00:00:00Z' WHERE id=ANY($1)`, []uuid.UUID{ids["Morning Broadcast"], ids["Lunch Service"], ids["Open House"]}); err != nil {
		t.Fatal(err)
	}
	want := []uuid.UUID{ids["Morning Broadcast"], ids["Lunch Service"], ids["Open House"]}
	slices.SortFunc(want, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	for _, sort := range []string{scheduling.SortName, scheduling.SortPriority, scheduling.SortUpdated} {
		result, err := service.List(context.Background(), scheduling.ListFilter{Search: "Same", Sort: sort}, 1, 50)
		if err != nil {
			t.Fatal(err)
		}
		got := make([]uuid.UUID, 0, len(result.Items))
		for _, item := range result.Items {
			got = append(got, item.ID)
		}
		if !slices.Equal(got, want) {
			t.Fatalf("sort=%s got=%v want id order %v", sort, got, want)
		}
	}
}

func TestScheduleLibraryPaginationUnderFilters(t *testing.T) {
	service, _ := openLibraryService(t)
	filter := scheduling.ListFilter{Enabled: ptr(true), Sort: scheduling.SortName}
	var all []string
	for page := 1; page <= 3; page++ {
		names, result := listNames(t, service, filter, page, 3)
		if result.Total != 4 || result.Page != page || result.PageSize != 3 {
			t.Fatalf("page %d meta: %+v", page, result)
		}
		all = append(all, names...)
	}
	want := []string{"Friday Night Lights", "Holiday Closure", "Lunch Service", "Morning Broadcast"}
	if !slices.Equal(all, want) {
		t.Fatalf("paged names=%v want %v (no duplicates or gaps across pages)", all, want)
	}
	if names, _ := listNames(t, service, filter, 3, 3); len(names) != 0 {
		t.Fatalf("a page past the end returned %v", names)
	}
}

func TestScheduleLibraryRejectsInvalidFilter(t *testing.T) {
	service, _ := openLibraryService(t)
	if _, err := service.List(context.Background(), scheduling.ListFilter{Sort: "newest"}, 1, 50); err == nil {
		t.Fatal("an unknown sort was accepted")
	}
}
