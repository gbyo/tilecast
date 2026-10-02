package playlists

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestPresentationCapabilityEvidenceUsesPublishedWidgetGraph(t *testing.T) {
	f := setupCapabilityFixture(t)
	playlist := f.clockPlaylist(t, map[string]any{"timezone": "Europe/London", "format": "24", "showSeconds": true})
	var widget uuid.UUID
	if err := f.pool.QueryRow(f.ctx, `SELECT asset_id FROM playlist_items WHERE playlist_id=$1`, playlist).Scan(&widget); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, schemas    string
		extra            map[string]int
		status, renderer string
	}{
		{"unreported", "", nil, "unknown", ""},
		{"compatibility", "{1}", nil, "supported", "compatibility"},
		{"older_component_falls_back", "{1,2}", map[string]int{"widget.tilecast.clock": 1}, "supported", "compatibility"},
		{"component", "{1,2}", map[string]int{"widget.tilecast.clock": 2}, "supported", "component"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.schemas != "" {
				f.reportCapabilities(t, test.schemas, test.extra)
			}
			tx, err := f.pool.BeginTx(f.ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(f.ctx)
			report, err := f.service.PresentationCapabilityEvidenceInTx(f.ctx, tx, f.screen, "playlist", playlist)
			if err != nil {
				t.Fatal(err)
			}
			if report.Status != test.status || len(report.Widgets) != 1 || report.Widgets[0].AssetID != widget || report.Widgets[0].Name != "Lobby Clock" || report.Widgets[0].SelectedRenderer != test.renderer {
				t.Fatalf("report=%#v", report)
			}
			rootWidget, err := f.service.PresentationCapabilityEvidenceInTx(f.ctx, tx, f.screen, "asset", widget)
			if err != nil || !reflect.DeepEqual(rootWidget, report) {
				t.Fatalf("direct Widget differs: report=%#v err=%v", rootWidget, err)
			}
			encoded, err := json.Marshal(report)
			if err != nil {
				t.Fatal(err)
			}
			for _, private := range []string{"Europe/London", "showSeconds", "foregroundColor", "configuration"} {
				if strings.Contains(string(encoded), private) {
					t.Fatalf("configuration leaked: %s", private)
				}
			}
			if err = tx.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
	t.Run("reported_profile_is_snapshot_consistent", func(t *testing.T) {
		tx, err := f.pool.BeginTx(f.ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(f.ctx)
		before, err := f.service.PresentationCapabilityEvidenceInTx(f.ctx, tx, f.screen, "playlist", playlist)
		if err != nil {
			t.Fatal(err)
		}
		// Update through another connection while the evidence snapshot is open.
		if _, err = f.pool.Exec(f.ctx, `UPDATE screen_player_status SET presentation_schema_versions='{1}',native_presentation_capabilities='{}' WHERE screen_id=$1`, f.screen); err != nil {
			t.Fatal(err)
		}
		after, err := f.service.PresentationCapabilityEvidenceInTx(f.ctx, tx, f.screen, "playlist", playlist)
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatalf("mixed capability snapshot: report=%#v err=%v", after, err)
		}
		if err = tx.Commit(f.ctx); err != nil {
			t.Fatal(err)
		}
		fresh, err := f.pool.BeginTx(f.ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
		if err != nil {
			t.Fatal(err)
		}
		defer fresh.Rollback(f.ctx)
		blocked, err := f.service.PresentationCapabilityEvidenceInTx(f.ctx, fresh, f.screen, "playlist", playlist)
		if err != nil || blocked.Status != "blocked" || blocked.Widgets[0].Reason != "presentation_requirements_unsupported" {
			t.Fatalf("fresh profile=%#v err=%v", blocked, err)
		}
		if _, err = f.service.PresentationCapabilityEvidenceInTx(f.ctx, fresh, uuid.New(), "playlist", playlist); !errors.Is(err, ErrNotFound) {
			t.Fatalf("missing Screen error=%v", err)
		}
		if _, err = f.service.PresentationCapabilityEvidenceInTx(f.ctx, fresh, f.screen, "asset", uuid.New()); !errors.Is(err, ErrNotFound) {
			t.Fatalf("missing content error=%v", err)
		}
	})
}

func TestCapabilityEvidenceIncludesSourceOnlyManifestRequirement(t *testing.T) {
	f := setupCapabilityFixture(t)
	source := f.createSchoolStatusSource(t, "Source-only status")
	layout := f.createLayoutBoundToSource(t, source)
	unpublished := uuid.New()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO layouts(id,organization_id,name,orientation,canvas_width,canvas_height,draft_document,created_by) SELECT $1,organization_id,'Unpublished','landscape',1920,1080,draft_document,created_by FROM layouts WHERE id=$2`, unpublished, layout); err != nil {
		t.Fatal(err)
	}
	read := func() CapabilityEvidence {
		t.Helper()
		tx, err := f.pool.BeginTx(f.ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(f.ctx)
		if _, err = f.service.PresentationCapabilityEvidenceInTx(f.ctx, tx, f.screen, "layout", unpublished); !errors.Is(err, ErrConflict) {
			t.Fatalf("unpublished Layout evidence error=%v", err)
		}
		evidence, err := f.service.PresentationCapabilityEvidenceInTx(f.ctx, tx, f.screen, "layout", layout)
		if err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(f.ctx); err != nil {
			t.Fatal(err)
		}
		return evidence
	}
	unknown := read()
	if !unknown.RequiresManifestV13 || unknown.Status != "blocked" || unknown.Reason != "manifest_v13_capabilities_not_reported" || len(unknown.Widgets) != 0 {
		t.Fatalf("source-only unreported evidence=%#v", unknown)
	}
	f.reportV13Capabilities(t)
	supported := read()
	if !supported.RequiresManifestV13 || supported.Status != "supported" || !supported.Reported {
		t.Fatalf("source-only reported evidence=%#v", supported)
	}
	encoded, err := json.Marshal(supported)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "Two-hour delay") || strings.Contains(string(encoded), "Buses run late") {
		t.Fatal("Data Source payload leaked into capability evidence")
	}
}
