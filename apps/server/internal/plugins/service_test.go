package plugins

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func intPointer(value int) *int {
	return &value
}

func validInput() CountdownBarInput {
	target := "12:00"
	return CountdownBarInput{
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
	if err := validateCountdownBar(validInput()); err != nil {
		t.Fatalf("valid weekly input rejected: %v", err)
	}
	drain := validInput()
	drain.ProgressFill = "drain"
	if err := validateCountdownBar(drain); err != nil {
		t.Fatalf("draining fill rejected: %v", err)
	}
	omitted := validInput()
	omitted.ProgressFill = ""
	if err := validateCountdownBar(normalizeCountdownBar(omitted)); err != nil {
		t.Fatalf("omitted progressFill should default to none, got %v", err)
	}
	if got := normalizeCountdownBar(omitted).ProgressFill; got != "none" {
		t.Fatalf("expected omitted progressFill to normalize to none, got %q", got)
	}
	urgencyDefaults := normalizeCountdownBar(CountdownBarInput{})
	if urgencyDefaults.StartingSoonSeconds != 300 || urgencyDefaults.UrgentSeconds != 60 || urgencyDefaults.PulseSeconds != 10 {
		t.Fatalf("unexpected urgency defaults: %#v", urgencyDefaults)
	}
	omitted.ContentPadding = nil
	defaulted := normalizeCountdownBar(omitted)
	if defaulted.ContentPadding == nil || *defaulted.ContentPadding != 4 {
		t.Fatalf("expected omitted contentPadding to default to 4, got %#v", defaulted.ContentPadding)
	}
	// Zero padding is a real choice; a zero scale is an omission.
	metrics := validInput()
	metrics.ContentPadding = intPointer(0)
	metrics.TextScale = 0
	normalized := normalizeCountdownBar(metrics)
	if normalized.ContentPadding == nil || *normalized.ContentPadding != 0 || normalized.TextScale != 100 {
		t.Fatalf("expected padding 0 to survive and scale 0 to default, got %d and %d",
			*normalized.ContentPadding, normalized.TextScale)
	}
	if err := validateCountdownBar(normalized); err != nil {
		t.Fatalf("zero padding with a defaulted scale rejected: %v", err)
	}
	oneTime := validInput()
	oneTime.ScheduleType = "one_time"
	oneTime.TargetTime = nil
	oneTime.DaysOfWeek = nil
	at := time.Date(2026, 8, 1, 16, 0, 0, 0, time.UTC)
	oneTime.OneTimeAt = &at
	if err := validateCountdownBar(oneTime); err != nil {
		t.Fatalf("valid one-time input rejected: %v", err)
	}
}

func TestValidateCountdownBarRejectsInvalidScheduleAndTargets(t *testing.T) {
	input := validInput()
	input.DaysOfWeek = []int{1, 1}
	if err := validateCountdownBar(input); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected duplicate days to be invalid, got %v", err)
	}
	input = validInput()
	input.TargetScope = "screens"
	if err := validateCountdownBar(input); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected empty screen targets to be invalid, got %v", err)
	}
	input = validInput()
	input.TargetScope = "screens"
	duplicate := uuid.New()
	input.TargetIDs = []uuid.UUID{duplicate, duplicate}
	if err := validateCountdownBar(input); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected duplicate targets to be invalid, got %v", err)
	}
	input = validInput()
	input.ContentPadding = intPointer(41)
	if err := validateCountdownBar(input); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected an out-of-range contentPadding to be rejected, got %v", err)
	}
	input = validInput()
	input.TextScale = 501
	if err := validateCountdownBar(input); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected an out-of-range textScale to be rejected, got %v", err)
	}
	input = validInput()
	input.ProgressFill = "sideways"
	if err := validateCountdownBar(input); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected an unknown progressFill to be rejected, got %v", err)
	}
	input = validInput()
	input.UrgencyEnabled = true
	input.UrgentSeconds = input.StartingSoonSeconds
	if err := validateCountdownBar(input); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected unordered urgency thresholds to be rejected, got %v", err)
	}
	input = validInput()
	input.Timezone = "not/a-zone"
	if err := validateCountdownBar(input); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected invalid timezone to be rejected, got %v", err)
	}
}

// installPluginsForTest records plugins as installed for the singleton
// organization, as an administrator's Install action would.
func installPluginsForTest(t *testing.T, pool *pgxpool.Pool, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if _, err := pool.Exec(context.Background(), `INSERT INTO plugin_installations(organization_id,plugin_id)
			SELECT id,$1 FROM organization_settings WHERE singleton ON CONFLICT DO NOTHING`, id); err != nil {
			t.Fatal(err)
		}
	}
}
