package noisemeter

import (
	"testing"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest"
)

func TestConformance(t *testing.T) {
	plugintest.Conformance(t, New())
}
