package settings

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRegistryRejectsUnknownAndUnsafeValues(t *testing.T) {
	if _, err := Validate(map[string]any{"arbitrary.key": true}, ScopeOrganization); err == nil {
		t.Fatal("unknown key accepted")
	}
	if _, err := Validate(map[string]any{"player.sync.status_seconds": 1.0}, ScopePolicy); err == nil {
		t.Fatal("unsafe reporting interval accepted")
	}
	if _, err := Validate(map[string]any{"preference.appearance": "dark"}, ScopePreference); err != nil {
		t.Fatal(err)
	}
}

func TestLanguagePreferenceAcceptsOnlyShippedLocales(t *testing.T) {
	for _, language := range []string{"system", "en", "es", "ru"} {
		if _, err := Validate(map[string]any{"preference.language": language}, ScopePreference); err != nil {
			t.Fatalf("%s rejected: %v", language, err)
		}
	}
	for _, language := range []string{"", "de", "en-US", "RU"} {
		if _, err := Validate(map[string]any{"preference.language": language}, ScopePreference); err == nil {
			t.Fatalf("%q accepted", language)
		}
	}
	if _, err := Validate(map[string]any{"preference.language": "es"}, ScopeOrganization); err == nil {
		t.Fatal("language preference accepted at organization scope")
	}
}

func TestLegacyApprovalRequiredStillEnforcesReviewPolicy(t *testing.T) {
	merged := mergeOrganizationDefaults(map[string]any{"content.approval_required": true})
	if merged["content.review_policy"] != "everyone" {
		t.Fatalf("legacy approval requirement did not migrate to everyone: %#v", merged["content.review_policy"])
	}
	explicit := mergeOrganizationDefaults(map[string]any{
		"content.approval_required": true,
		"content.review_policy":     "off",
	})
	if explicit["content.review_policy"] != "off" {
		t.Fatalf("explicit review policy was overridden: %#v", explicit["content.review_policy"])
	}
}

func TestLegacyLocalTimesNormalizeAndFixedTimezoneNamesFail(t *testing.T) {
	normalized, err := Validate(map[string]any{
		"power.active_hours_start": "06:30:00",
		"power.active_hours_end":   "16:00:00",
	}, ScopePolicy)
	if err != nil {
		t.Fatal(err)
	}
	if normalized["power.active_hours_start"] != "06:30" || normalized["power.active_hours_end"] != "16:00" {
		t.Fatalf("local times were not normalized: %#v", normalized)
	}
	for name, value := range map[string]string{
		"non-zero seconds": "16:00:30",
		"invalid hour":     "25:00:00",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Validate(map[string]any{"power.active_hours_end": value}, ScopePolicy); err == nil {
				t.Fatalf("invalid local time %q accepted", value)
			}
		})
	}
	if _, err := Validate(map[string]any{"organization.timezone": "EST"}, ScopeOrganization); err == nil {
		t.Fatal("fixed timezone abbreviation accepted")
	}
	if _, err := Validate(map[string]any{"organization.timezone": "America/New_York"}, ScopeOrganization); err != nil {
		t.Fatal(err)
	}
}

func TestRegionalLocaleAndWeekdaySettings(t *testing.T) {
	values, err := Validate(map[string]any{
		"organization.locale":            "ja-jp",
		"organization.first_day_of_week": "friday",
	}, ScopeOrganization)
	if err != nil {
		t.Fatal(err)
	}
	if values["organization.locale"] != "ja-JP" {
		t.Fatalf("locale was not canonicalized: %#v", values["organization.locale"])
	}
	for _, day := range []string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "locale"} {
		if _, err := Validate(map[string]any{"organization.first_day_of_week": day}, ScopeOrganization); err != nil {
			t.Errorf("first day %q rejected: %v", day, err)
		}
	}
	for _, locale := range []string{"ru-RU", "ja-JP", "ar-SA", "zh-Hant-TW"} {
		if _, err := Validate(map[string]any{"organization.locale": locale}, ScopeOrganization); err != nil {
			t.Errorf("valid BCP-47 locale %q rejected: %v", locale, err)
		}
	}
	for _, locale := range []string{"", "not a locale", "en--US"} {
		if _, err := Validate(map[string]any{"organization.locale": locale}, ScopeOrganization); err == nil {
			t.Errorf("invalid locale %q accepted", locale)
		}
	}
	defaults := Defaults(ScopeOrganization)
	if defaults["organization.first_day_of_week"] != "locale" {
		t.Fatalf("new-install first-weekday default = %#v, want locale", defaults["organization.first_day_of_week"])
	}
	if profile := regionalFormatting(defaults); profile.FirstDayOfWeek != "sunday" {
		t.Fatalf("default en-US locale resolved first weekday to %q, want sunday", profile.FirstDayOfWeek)
	}
	defaults["organization.locale"] = "de-DE"
	if profile := regionalFormatting(defaults); profile.FirstDayOfWeek != "monday" {
		t.Fatalf("default locale choice for de-DE resolved first weekday to %q, want monday", profile.FirstDayOfWeek)
	}
}

func TestRegionalFormattingResolvesLocaleWeekDefaultsAndOverrides(t *testing.T) {
	for _, test := range []struct {
		name  string
		input map[string]any
		day   string
	}{
		{name: "US locale-derived", input: map[string]any{"organization.locale": "en-US", "organization.first_day_of_week": "locale"}, day: "sunday"},
		{name: "UK locale-derived", input: map[string]any{"organization.locale": "en-GB", "organization.first_day_of_week": "locale"}, day: "monday"},
		{name: "German locale-derived", input: map[string]any{"organization.locale": "de-DE", "organization.first_day_of_week": "locale"}, day: "monday"},
		{name: "Maldives locale-derived", input: map[string]any{"organization.locale": "dv-MV", "organization.first_day_of_week": "locale"}, day: "friday"},
		{name: "omitted choice uses locale default", input: map[string]any{"organization.locale": "dv-MV"}, day: "friday"},
		{name: "explicit override", input: map[string]any{"organization.locale": "de-DE", "organization.first_day_of_week": "saturday"}, day: "saturday"},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := regionalFormatting(test.input)
			if profile.FirstDayOfWeek != test.day {
				t.Fatalf("firstDayOfWeek=%q, want %q", profile.FirstDayOfWeek, test.day)
			}
		})
	}
}

func TestDefinitionJSONUsesPublicContractFieldNames(t *testing.T) {
	encoded, err := json.Marshal(Definitions()[0])
	if err != nil {
		t.Fatal(err)
	}
	jsonText := string(encoded)
	for _, field := range []string{`"key"`, `"category"`, `"scope"`, `"default"`} {
		if !strings.Contains(jsonText, field) {
			t.Fatalf("definition JSON %s does not contain %s", jsonText, field)
		}
	}
	if strings.Contains(jsonText, `"Key"`) || strings.Contains(jsonText, `"Category"`) {
		t.Fatalf("definition JSON exposes Go field names: %s", jsonText)
	}
}

func TestReliabilityPoliciesAreTypedAndBounded(t *testing.T) {
	valid := map[string]any{
		"reliability.mode":                   "managed_kiosk",
		"power.outside_active_hours_display": "bouncing_logo",
		"power.outside_active_hours_text":    "Powered by Weekly Wildcat",
		"power.active_hours_timezone":        "America/New_York",
		"power.active_hours_days":            []any{1.0, 2.0, 5.0},
		"power.active_hours_start":           "22:00",
		"power.active_hours_end":             "02:00",
		"accessibility.allowed_packages":     []any{"com.example.maintenance"},
	}
	if _, err := Validate(valid, ScopePolicy); err != nil {
		t.Fatal(err)
	}
	for name, values := range map[string]map[string]any{
		"bad timezone":       {"power.active_hours_timezone": "EST+5"},
		"bad local time":     {"power.active_hours_start": "25:30"},
		"duplicate weekday":  {"power.active_hours_days": []any{1.0, 1.0}},
		"unsafe package":     {"accessibility.allowed_packages": []any{"../settings"}},
		"restart loop":       {"reliability.maximum_process_restarts": 99.0},
		"bad off-hours mode": {"power.outside_active_hours_display": "dvd"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Validate(values, ScopePolicy); err == nil {
				t.Fatal("unsafe reliability policy accepted")
			}
		})
	}
}

// Retiring a setting must not make the Settings page unsavable. The value of a
// removed setting stays in the stored document until something rewrites it, and
// the dashboard posts back the document it was handed — so a read that returns a
// key the write refuses fails every save, including the unrelated setting the
// operator actually came to change.
//
// These two keys are real: both were retired from the registry while orgs still
// had values stored for them, which is what put "unknown_setting:
// player.sync.website_status_throttle_seconds" on the screen of anyone trying to
// edit Active hours.
func TestRetiredSettingsAreNotHandedBackToBeRejected(t *testing.T) {
	stored := map[string]any{
		"player.sync.website_status_throttle_seconds": 30.0,
		"scheduling.confirm_overnight":                true,
		"power.active_hours_enabled":                  true,
	}
	merged := mergeDefaults(stored, ScopeOrganization)
	for _, retired := range []string{
		"player.sync.website_status_throttle_seconds",
		"scheduling.confirm_overnight",
	} {
		if _, present := merged[retired]; present {
			t.Fatalf("retired setting %q was handed back to the client", retired)
		}
	}
	// The live setting alongside them still reads back, and still reads back the
	// stored value rather than the default.
	if merged["power.active_hours_enabled"] != true {
		t.Fatalf("a live setting was dropped: %v", merged["power.active_hours_enabled"])
	}
	// The contract this protects: everything a read returns, a write accepts.
	if _, err := Validate(merged, ScopeOrganization); err != nil {
		t.Fatalf("the settings document a client is given must be savable: %v", err)
	}
}

// The same contract for user preferences, which share mergeDefaults and would
// fail the same way.
func TestPreferenceDocumentIsAlwaysSavable(t *testing.T) {
	stored := map[string]any{
		"scheduling.confirm_overnight": true,
		// An organization-scope key stored in a preference document: not writable
		// at this scope, so returning it would fail the save just as surely.
		"organization.name": "Greenwood",
	}
	merged := mergeDefaults(stored, ScopePreference)
	if _, err := Validate(merged, ScopePreference); err != nil {
		t.Fatalf("the preference document a client is given must be savable: %v", err)
	}
}
