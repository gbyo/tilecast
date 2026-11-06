package media

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestPlayerProjectionKeepsExpiredTypedDatasetUnavailable(t *testing.T) {
	ctx, pool, _ := setupContributionDB(t)
	service := NewService(pool, nil, Config{})
	configuration := `{"area":"OH","severity":"Severe"}`

	cached := insertSource(t, ctx, pool, "weather-alerts-us", configuration)
	payload := `{"datasets":[{"id":"records","kind":"records","fields":[{"key":"headline","label":"Headline","type":"text"}],"records":[{"id":"row-1","values":{"headline":"Old"}}],"attribution":"NWS"}]}`
	if _, err := pool.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,cache_updated_at,cache_expires_at,cached_payload,error_code) VALUES($1,now()-interval '2 hours',now()-interval '1 hour',$2::jsonb,'source_refresh_failed')`, cached, payload); err != nil {
		t.Fatal(err)
	}
	never := insertSource(t, ctx, pool, "weather-alerts-us", configuration)
	if _, err := pool.Exec(ctx, `INSERT INTO data_source_refresh_states(data_source_id,error_code) VALUES($1,'source_refresh_failed')`, never); err != nil {
		t.Fatal(err)
	}

	for name, id := range map[string]uuid.UUID{"expired cache": cached, "never cached": never} {
		t.Run(name, func(t *testing.T) {
			projected, err := service.PlayerTypedDataSourceConfiguration(ctx, id, "weather-alerts-us", json.RawMessage(configuration))
			if err != nil {
				t.Fatal(err)
			}
			var decoded TypedDatasetPayload
			if err := json.Unmarshal(projected, &decoded); err != nil {
				t.Fatal(err)
			}
			if len(decoded.Datasets) != 1 || decoded.Datasets[0].ID != "records" || len(decoded.Datasets[0].Fields) == 0 {
				t.Fatalf("typed dataset identity was lost: %s", projected)
			}
			if !decoded.Datasets[0].Unavailable || len(decoded.Datasets[0].Records) != 0 {
				t.Fatalf("expired dataset must be unavailable and empty: %s", projected)
			}
		})
	}
}
