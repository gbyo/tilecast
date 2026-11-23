package webhookplugins

import (
	"testing"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

func TestDeclarationsAreValid(t *testing.T) {
	if err := plugin.CheckDeclarations(New()); err != nil {
		t.Fatal(err)
	}
}
