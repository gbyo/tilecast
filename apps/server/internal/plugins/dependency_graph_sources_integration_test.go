package plugins

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/contentdefs"
	"github.com/tilecast/tilecast/apps/server/internal/contenthealth"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

func TestDependencyGraphAndContentHealthUseNestedAndManagedSources(t *testing.T) {
	withInstallationDatabase(t, func(env installationEnvironment) {
		base := pluginWidgetCatalog(t)
		definition := base.Widgets[0]
		definition.ConfigurationSchema.Fields = append(definition.ConfigurationSchema.Fields,
			contentdefs.FieldDefinition{Key: "sections", Label: "Sections", Control: "repeating_group", MaximumItems: 4,
				ItemFields: []contentdefs.FieldDefinition{{Key: "source", Label: "Source", Control: "data_source"}}})
		catalog, err := contentdefs.New([]contentdefs.WidgetDefinition{definition}, base.DataSources)
		if err != nil {
			t.Fatal(err)
		}
		env.service.SetContentDefinitions(catalog)
		nested, managed, decoy, deleted, legacy := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
		for _, id := range []uuid.UUID{nested, managed, decoy, deleted, legacy} {
			if _, err = env.pool.Exec(env.ctx, `INSERT INTO data_sources(id,organization_id,name,provider,configuration,created_by)
				VALUES($1,$2,$3,'manual_records','{}',$4)`, id, env.orgID, id.String(), env.userID); err != nil {
				t.Fatal(err)
			}
			if _, err = env.pool.Exec(env.ctx, `INSERT INTO data_source_refresh_states(data_source_id,next_refresh_at,last_success_at)
				VALUES($1,now(),now()-interval '5 days')`, id); err != nil {
				t.Fatal(err)
			}
		}
		if _, err = env.pool.Exec(env.ctx, `UPDATE data_sources SET deleted_at=now() WHERE id=$1`, deleted); err != nil {
			t.Fatal(err)
		}
		widget, ownedWidget, legacyWidget, deletedWidget := uuid.New(), uuid.New(), uuid.New(), uuid.New()
		for _, id := range []uuid.UUID{widget, ownedWidget, legacyWidget, deletedWidget} {
			if _, err = env.pool.Exec(env.ctx, `INSERT INTO assets(id,organization_id,name,type,original_filename,detected_mime_type,
				sha256,original_size,processing_status,created_by,origin)
				VALUES($1,$2,'Dependency fixture','widget','','application/json',$3,0,'ready',$4,'library')`,
				id, env.orgID, make([]byte, 32), env.userID); err != nil {
				t.Fatal(err)
			}
		}
		raw, _ := json.Marshal(map[string]any{"title": decoy.String(), "sections": []any{
			map[string]string{"source": nested.String()}, map[string]string{"source": nested.String()},
			map[string]string{"source": deleted.String()}}})
		if _, err = env.pool.Exec(env.ctx, `INSERT INTO widgets(asset_id,provider,configuration) VALUES($1,$2,$3)`, widget, definition.ID, raw); err != nil {
			t.Fatal(err)
		}
		if _, err = env.pool.Exec(env.ctx, `INSERT INTO widgets(asset_id,provider,configuration,managed_data_source_id)
			VALUES($1,$2,'{}',$3)`, ownedWidget, definition.ID, managed); err != nil {
			t.Fatal(err)
		}
		if _, err = env.pool.Exec(env.ctx, `INSERT INTO widgets(asset_id,provider,configuration)
			VALUES($1,'agenda',jsonb_build_object('dataSourceId',$2::text))`, legacyWidget, legacy.String()); err != nil {
			t.Fatal(err)
		}
		if _, err = env.pool.Exec(env.ctx, `INSERT INTO widgets(asset_id,provider,configuration)
			VALUES($1,'agenda',jsonb_build_object('dataSourceId',$2::text))`, deletedWidget, decoy.String()); err != nil {
			t.Fatal(err)
		}
		if _, err = env.pool.Exec(env.ctx, `UPDATE assets SET deleted_at=now() WHERE id=$1`, deletedWidget); err != nil {
			t.Fatal(err)
		}

		graph, err := env.service.DependencyGraph(env.ctx, []uuid.UUID{env.screenID})
		if err != nil {
			t.Fatal(err)
		}
		got := map[uuid.UUID]uuid.UUID{}
		for _, edge := range graph.Edges {
			if edge.FromType != "data_source" || edge.ToType != "widget" {
				continue
			}
			if _, duplicate := got[edge.FromID]; duplicate {
				t.Fatalf("duplicate source edge: %+v", edge)
			}
			got[edge.FromID] = edge.ToID
		}
		if len(got) != 3 || got[nested] != widget || got[managed] != ownedWidget || got[legacy] != legacyWidget {
			t.Fatalf("source graph = %v", got)
		}
		health := contenthealth.NewService(env.pool, settings.NewService(env.pool, nil, settings.HardLimits{}))
		health.SetContentDefinitions(catalog)
		for range 2 {
			if err = health.Sweep(env.ctx); err != nil {
				t.Fatal(err)
			}
		}
		rows, err := env.pool.Query(env.ctx, `SELECT related_id FROM incidents WHERE incident_type='data_source' AND status='open'`)
		if err != nil {
			t.Fatal(err)
		}
		incidents := map[uuid.UUID]bool{}
		for rows.Next() {
			var id uuid.UUID
			if err = rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			incidents[id] = true
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			t.Fatal(err)
		}
		if len(incidents) != 3 || !incidents[nested] || !incidents[managed] || !incidents[legacy] {
			t.Fatalf("stale source incidents = %v", incidents)
		}
		if _, err = env.pool.Exec(env.ctx, `UPDATE data_source_refresh_states SET last_success_at=now() WHERE data_source_id=$1`, nested); err != nil {
			t.Fatal(err)
		}
		if err = health.Sweep(env.ctx); err != nil {
			t.Fatal(err)
		}
		var status string
		if err = env.pool.QueryRow(env.ctx, `SELECT status FROM incidents WHERE related_id=$1 AND incident_type='data_source'`, nested.String()).Scan(&status); err != nil || status != "recovered" {
			t.Fatalf("refreshed nested source status=%q: %v", status, err)
		}
	})
}
