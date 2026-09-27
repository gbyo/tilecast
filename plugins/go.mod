module github.com/tilecast/tilecast/plugins

go 1.25.7

require (
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.10.0
	github.com/tilecast/tilecast/apps/server v0.0.0
	github.com/tilecast/tilecast/packages/plugin-sdk/go v0.0.0
)

require (
	github.com/go-chi/chi/v5 v5.3.1 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/mfridman/interpolate v0.0.2 // indirect
	github.com/pressly/goose/v3 v3.27.3 // indirect
	github.com/sethvargo/go-retry v0.4.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/text v0.40.0 // indirect
)

// Plugin integration tests use the server's plugin test harness
// (apps/server/pluginharness). Production plugin code never imports it.
replace (
	github.com/tilecast/tilecast/apps/server => ../apps/server
	github.com/tilecast/tilecast/packages/plugin-sdk/go => ../packages/plugin-sdk/go
)
