module github.com/tilecast/tilecast/apps/cli

go 1.25.7

require (
	github.com/spf13/cobra v1.10.2
	github.com/tilecast/tilecast/packages/api-client v0.0.0-00010101000000-000000000000
	github.com/zalando/go-keyring v0.2.8
)

require (
	github.com/apapsch/go-jsonmerge/v2 v2.0.0 // indirect
	github.com/danieljoos/wincred v1.2.3 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/oapi-codegen/runtime v1.7.0 // indirect
	github.com/spf13/pflag v1.0.9 // indirect
	golang.org/x/sys v0.39.0 // indirect
)

replace github.com/tilecast/tilecast/packages/api-client => ../../packages/api-client
