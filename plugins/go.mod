module github.com/tilecast/tilecast/plugins

go 1.25.7

require github.com/tilecast/tilecast/packages/plugin-sdk/go v0.0.0

require (
	github.com/google/uuid v1.6.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/pgx/v5 v5.10.0 // indirect
	golang.org/x/text v0.40.0 // indirect
)

replace github.com/tilecast/tilecast/packages/plugin-sdk/go => ../packages/plugin-sdk/go
