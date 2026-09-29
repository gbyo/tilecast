package client

import gen "github.com/tilecast/tilecast/packages/api-client/internal/generated"

// Contract-typed screen resources, generated from docs/openapi.yaml. The
// CLI decodes stable resources into these types instead of generic maps so
// a contract change that renames or removes a field breaks the build at
// the use site instead of silently rendering empty output.
type (
	Screen       = gen.Screen
	ScreenStatus = gen.ScreenStatus
	ScreenList   = gen.ScreenList
)
