package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func weeklyConfig() Config {
	target := "12:00"
	return Config{Message: "Lunch ends in", ScheduleType: "weekly", TargetTime: &target, DaysOfWeek: []int{1, 2, 3},
		Timezone: "UTC", LeadTimeSeconds: 900, DisplayMode: "overlay", HeightPX: 72, ProgressFill: "none",
		ContentPadding: 4, TextScale: 100, StartingSoonSeconds: 300, UrgentSeconds: 60, PulseSeconds: 10}
}

func TestValidateHoldsTheRulesTheSchemaCannotState(t *testing.T) {
	if err := weeklyConfig().Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Config){
		"weekly without time":   func(c *Config) { c.TargetTime = nil },
		"weekly without days":   func(c *Config) { c.DaysOfWeek = nil },
		"one-time without time": func(c *Config) { c.ScheduleType = "one_time" },
		"stages out of order":   func(c *Config) { c.UrgentSeconds = 400 },
		"pulse after urgent":    func(c *Config) { c.PulseSeconds = 60 },
		"long message":          func(c *Config) { c.Message = strings.Repeat("é", 281) },
		"unknown schedule":      func(c *Config) { c.ScheduleType = "monthly" },
	} {
		config := weeklyConfig()
		mutate(&config)
		if err := config.Validate(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	// 280 characters are allowed even when they take more than 280 bytes.
	config := weeklyConfig()
	config.Message = strings.Repeat("é", 280)
	if err := config.Validate(); err != nil {
		t.Fatalf("280 characters: %v", err)
	}
}

func TestManifestKeepsOnlyTheFieldsOfItsScheduleType(t *testing.T) {
	config := weeklyConfig()
	at := time.Date(2026, 12, 1, 15, 0, 0, 0, time.UTC)
	config.OneTimeAt = &at
	weekly, _ := json.Marshal(config.Manifest("Lunch", 5))
	if strings.Contains(string(weekly), "oneTimeAt") || !strings.Contains(string(weekly), `"daysOfWeek":[1,2,3]`) || !strings.Contains(string(weekly), `"priority":5`) {
		t.Fatalf("weekly projection = %s", weekly)
	}
	config.ScheduleType = "one_time"
	oneTime, _ := json.Marshal(config.Manifest("Lunch", 0))
	if strings.Contains(string(oneTime), "targetTime") || strings.Contains(string(oneTime), "daysOfWeek") || !strings.Contains(string(oneTime), "2026-12-01T15:00:00Z") {
		t.Fatalf("one-time projection = %s", oneTime)
	}
}
