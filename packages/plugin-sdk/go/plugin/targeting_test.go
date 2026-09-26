package plugin

import (
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestTargetValidate(t *testing.T) {
	one := uuid.New()
	tooMany := make([]uuid.UUID, MaxTargets+1)
	for index := range tooMany {
		tooMany[index] = uuid.New()
	}
	cases := []struct {
		name   string
		target Target
		ok     bool
	}{
		{"all", Target{Scope: TargetAll}, true},
		{"all with ids", Target{Scope: TargetAll, IDs: []uuid.UUID{one}}, false},
		{"screens", Target{Scope: TargetScreens, IDs: []uuid.UUID{one}}, true},
		{"screens empty", Target{Scope: TargetScreens}, false},
		{"duplicate", Target{Scope: TargetLocations, IDs: []uuid.UUID{one, one}}, false},
		{"too many", Target{Scope: TargetSyncGroups, IDs: tooMany}, false},
		{"unknown scope", Target{Scope: "groups", IDs: []uuid.UUID{one}}, false},
	}
	for _, tc := range cases {
		err := tc.target.Validate()
		if tc.ok != (err == nil) {
			t.Fatalf("%s: got %v", tc.name, err)
		}
		if err != nil && !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: error does not wrap ErrInvalid", tc.name)
		}
	}
}

func TestScreenTargetFilterRejectsNonLiterals(t *testing.T) {
	if !strings.Contains(ScreenTargetFilter("widget_instances", "widget_targets"), "FROM widget_instances i") {
		t.Fatal("filter does not select from the instances table")
	}
	defer func() {
		if recover() == nil {
			t.Fatal("expected a panic for a non-literal table name")
		}
	}()
	ScreenTargetFilter("x; DROP TABLE screens", "t")
}
