package server

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

func intPointer(value int) *int {
	return &value
}

func validInput() Input {
	target := "12:00"
	return Input{
		Name: "Lunch", Message: "Lunch ends in", ScheduleType: "weekly",
		TargetTime: &target, DaysOfWeek: []int{1, 2, 3, 4, 5},
		Timezone: "America/New_York", LeadTimeSeconds: 900,
		DisplayMode: "overlay", HeightPX: 72, ProgressFill: "none",
		ContentPadding: intPointer(4), TextScale: 100, Enabled: true,
		StartingSoonSeconds: 300, UrgentSeconds: 60, PulseSeconds: 10,
		TargetScope: "all", TargetIDs: []uuid.UUID{},
	}
}

func TestValidateCountdownBar(t *testing.T) {
	if err := Validate(validInput()); err != nil {
		t.Fatalf("valid weekly input rejected: %v", err)
	}
	drain := validInput()
	drain.ProgressFill = "drain"
	if err := Validate(drain); err != nil {
		t.Fatalf("draining fill rejected: %v", err)
	}
	omitted := validInput()
	omitted.ProgressFill = ""
	if err := Validate(Normalize(omitted)); err != nil {
		t.Fatalf("omitted progressFill should default to none, got %v", err)
	}
	if got := Normalize(omitted).ProgressFill; got != "none" {
		t.Fatalf("expected omitted progressFill to normalize to none, got %q", got)
	}
	urgencyDefaults := Normalize(Input{})
	if urgencyDefaults.StartingSoonSeconds != 300 || urgencyDefaults.UrgentSeconds != 60 || urgencyDefaults.PulseSeconds != 10 {
		t.Fatalf("unexpected urgency defaults: %#v", urgencyDefaults)
	}
	omitted.ContentPadding = nil
	defaulted := Normalize(omitted)
	if defaulted.ContentPadding == nil || *defaulted.ContentPadding != 4 {
		t.Fatalf("expected omitted contentPadding to default to 4, got %#v", defaulted.ContentPadding)
	}
	// Zero padding is a real choice; a zero scale is an omission.
	metrics := validInput()
	metrics.ContentPadding = intPointer(0)
	metrics.TextScale = 0
	normalized := Normalize(metrics)
	if normalized.ContentPadding == nil || *normalized.ContentPadding != 0 || normalized.TextScale != 100 {
		t.Fatalf("expected padding 0 to survive and scale 0 to default, got %d and %d",
			*normalized.ContentPadding, normalized.TextScale)
	}
	if err := Validate(normalized); err != nil {
		t.Fatalf("zero padding with a defaulted scale rejected: %v", err)
	}
	oneTime := validInput()
	oneTime.ScheduleType = "one_time"
	oneTime.TargetTime = nil
	oneTime.DaysOfWeek = nil
	at := time.Date(2026, 8, 1, 16, 0, 0, 0, time.UTC)
	oneTime.OneTimeAt = &at
	if err := Validate(oneTime); err != nil {
		t.Fatalf("valid one-time input rejected: %v", err)
	}
}

func TestValidateCountdownBarRejectsInvalidScheduleAndTargets(t *testing.T) {
	input := validInput()
	input.DaysOfWeek = []int{1, 1}
	if err := Validate(input); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("expected duplicate days to be invalid, got %v", err)
	}
	input = validInput()
	input.TargetScope = "screens"
	if err := Validate(input); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("expected empty screen targets to be invalid, got %v", err)
	}
	input = validInput()
	input.TargetScope = "screens"
	duplicate := uuid.New()
	input.TargetIDs = []uuid.UUID{duplicate, duplicate}
	if err := Validate(input); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("expected duplicate targets to be invalid, got %v", err)
	}
	input = validInput()
	input.ContentPadding = intPointer(41)
	if err := Validate(input); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("expected an out-of-range contentPadding to be rejected, got %v", err)
	}
	input = validInput()
	input.TextScale = 501
	if err := Validate(input); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("expected an out-of-range textScale to be rejected, got %v", err)
	}
	input = validInput()
	input.ProgressFill = "sideways"
	if err := Validate(input); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("expected an unknown progressFill to be rejected, got %v", err)
	}
	input = validInput()
	input.UrgencyEnabled = true
	input.UrgentSeconds = input.StartingSoonSeconds
	if err := Validate(input); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("expected unordered urgency thresholds to be rejected, got %v", err)
	}
	input = validInput()
	input.Timezone = "not/a-zone"
	if err := Validate(input); !errors.Is(err, plugin.ErrInvalid) {
		t.Fatalf("expected invalid timezone to be rejected, got %v", err)
	}
}
