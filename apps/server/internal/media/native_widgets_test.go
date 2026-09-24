package media

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestClockAndDateWidgetsDefaultToOrganizationFormatting(t *testing.T) {
	clockValue, err := (clockWidgetProvider{}).Normalize(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("normalize clock: %v", err)
	}
	clock := clockValue.(ClockWidgetConfig)
	if clock.Format != "locale" || clock.Timezone != "" {
		t.Fatalf("clock defaults = format %q timezone %q, want inherited organization settings", clock.Format, clock.Timezone)
	}

	dateValue, err := (dateWidgetProvider{}).Normalize(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("normalize date: %v", err)
	}
	date := dateValue.(DateWidgetConfig)
	if date.Format != "locale" || date.Timezone != "" {
		t.Fatalf("date defaults = format %q timezone %q, want inherited organization settings", date.Format, date.Timezone)
	}
}

func TestClockAndDateWidgetsPreserveExplicitOverrides(t *testing.T) {
	clockValue, err := (clockWidgetProvider{}).Normalize(context.Background(), json.RawMessage(`{"timezone":"Europe/Berlin","format":"12"}`))
	if err != nil {
		t.Fatalf("normalize explicit clock: %v", err)
	}
	clock := clockValue.(ClockWidgetConfig)
	if clock.Format != "12" || clock.Timezone != "Europe/Berlin" {
		t.Fatalf("clock override changed: %#v", clock)
	}

	dateValue, err := (dateWidgetProvider{}).Normalize(context.Background(), json.RawMessage(`{"timezone":"Asia/Tokyo","format":"short"}`))
	if err != nil {
		t.Fatalf("normalize explicit date: %v", err)
	}
	date := dateValue.(DateWidgetConfig)
	if date.Format != "short" || date.Timezone != "Asia/Tokyo" {
		t.Fatalf("date override changed: %#v", date)
	}
}

func TestValidateWidgetSizing(t *testing.T) {
	tooSmall, minimum, maximum, tooLarge := 24, 25, 500, 501
	for _, scale := range []*int{nil, &minimum, &maximum} {
		if err := validateWidgetSizing(scale, nil); err != nil {
			t.Fatalf("validateWidgetSizing(%v): %v", scale, err)
		}
	}
	for _, scale := range []*int{&tooSmall, &tooLarge} {
		if err := validateWidgetSizing(scale, nil); err == nil {
			t.Fatalf("validateWidgetSizing(%d) unexpectedly succeeded", *scale)
		}
	}
	negativePadding, noPadding, maximumPadding, excessivePadding := -1, 0, 40, 41
	for _, padding := range []*int{nil, &noPadding, &maximumPadding} {
		if err := validateWidgetSizing(nil, padding); err != nil {
			t.Fatalf("validateWidgetSizing padding %v: %v", padding, err)
		}
	}
	for _, padding := range []*int{&negativePadding, &excessivePadding} {
		if err := validateWidgetSizing(nil, padding); err == nil {
			t.Fatalf("validateWidgetSizing padding %d unexpectedly succeeded", *padding)
		}
	}
}

func TestNormalizeDisplayWidgetFieldsDropsStaleMenuDefaults(t *testing.T) {
	fields, err := normalizeDisplayWidgetFields(
		"menu",
		[]string{"title", "subtitle", "option_1", "option_2"},
		map[string]bool{"date": true, "option_1": true, "option_2": true},
	)
	if err != nil {
		t.Fatalf("normalize fields: %v", err)
	}
	want := []string{"option_1", "option_2"}
	if !reflect.DeepEqual(fields, want) {
		t.Fatalf("fields = %#v, want %#v", fields, want)
	}
}

func TestNormalizeDisplayWidgetFieldsChoosesMenuValues(t *testing.T) {
	fields, err := normalizeDisplayWidgetFields(
		"menu",
		[]string{"title", "subtitle"},
		map[string]bool{"date": true, "option_1": true, "option_2": true},
	)
	if err != nil {
		t.Fatalf("normalize fields: %v", err)
	}
	want := []string{"option_1", "option_2"}
	if !reflect.DeepEqual(fields, want) {
		t.Fatalf("fields = %#v, want %#v", fields, want)
	}
}

func TestNormalizeDisplayWidgetFieldsStillRejectsUnknownMenuFields(t *testing.T) {
	_, err := normalizeDisplayWidgetFields(
		"menu",
		[]string{"not_a_real_field"},
		map[string]bool{"option_1": true, "option_2": true},
	)
	if err == nil {
		t.Fatal("expected unknown field to be rejected")
	}
}

func TestNormalizeDisplayWidgetFieldsDoesNotRelaxOtherWidgets(t *testing.T) {
	_, err := normalizeDisplayWidgetFields(
		"table",
		[]string{"title"},
		map[string]bool{"option_1": true},
	)
	if err == nil {
		t.Fatal("expected unavailable table field to be rejected")
	}
}
