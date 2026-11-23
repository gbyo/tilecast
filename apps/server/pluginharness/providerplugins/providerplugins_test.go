package providerplugins

import (
	"testing"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

func TestDeclarationsAreValid(t *testing.T) {
	for _, p := range []plugin.Plugin{NewChannel(), NewChecker()} {
		if err := plugin.CheckDeclarations(p); err != nil {
			t.Fatal(err)
		}
	}
}
