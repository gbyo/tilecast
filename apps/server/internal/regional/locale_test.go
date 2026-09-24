package regional

import "testing"

func TestCanonicalLocale(t *testing.T) {
	for _, test := range []struct {
		input string
		want  string
	}{
		{input: "de-de", want: "de-DE"},
		{input: "ja-JP", want: "ja-JP"},
		{input: "ru-ru", want: "ru-RU"},
		{input: "und", want: "und"},
	} {
		t.Run(test.input, func(t *testing.T) {
			got, err := CanonicalLocale(test.input)
			if err != nil || got != test.want {
				t.Fatalf("CanonicalLocale(%q) = %q, %v; want %q", test.input, got, err, test.want)
			}
		})
	}
	for _, input := range []string{"", "not a locale", "en--US"} {
		if got, err := CanonicalLocale(input); err == nil {
			t.Errorf("CanonicalLocale(%q) = %q, want invalid-tag error", input, got)
		}
	}
}

func TestFirstDayOfWeekUsesCLDRAndLocaleExtensions(t *testing.T) {
	for _, test := range []struct {
		locale string
		want   string
	}{
		{locale: "en-US", want: "sunday"},
		{locale: "en-GB", want: "monday"},
		{locale: "de-DE", want: "monday"},
		{locale: "dv-MV", want: "friday"},
		{locale: "en-IQ", want: "saturday"},
		{locale: "en", want: "sunday"},
		{locale: "de", want: "monday"},
		{locale: "en-u-fw-fri", want: "friday"},
		{locale: "en-u-rg-mvzzzz", want: "friday"},
		{locale: "en-u-ca-iso8601", want: "monday"},
		{locale: "en-u-sd-mvun", want: "friday"},
	} {
		t.Run(test.locale, func(t *testing.T) {
			if got := FirstDayOfWeek(test.locale); got != test.want {
				t.Fatalf("FirstDayOfWeek(%q) = %q, want %q", test.locale, got, test.want)
			}
		})
	}
}
