package samplev2

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

func TestSampleV2Declarations(t *testing.T) {
	p := New()
	if err := plugin.CheckDeclarations(p); err != nil {
		t.Fatal(err)
	}
	p.Put(Beacon{ID: uuid.New(), Label: "Lobby"})
	states, err := p.ProjectPlayerState(context.Background(), uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := plugin.EncodePlayerState(p.Manifest(), states, time.Now()); err != nil {
		t.Fatal(err)
	}
}
