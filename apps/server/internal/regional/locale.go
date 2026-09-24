package regional

import (
	"errors"
	"strings"

	"golang.org/x/text/language"
)

// CanonicalLocale validates and canonicalizes a BCP-47 language tag using the
// Unicode language-tag parser used by the Go standard ecosystem.
func CanonicalLocale(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("locale must be a BCP-47 language tag")
	}
	tag, err := language.Parse(value)
	if err != nil {
		return "", err
	}
	tag, err = language.All.Canonicalize(tag)
	if err != nil {
		return "", err
	}
	return tag.String(), nil
}

// FirstDayOfWeek returns the CLDR calendar week start for a locale. The
// compact region table below is copied from CLDR supplemental/weekData.json;
// Monday is the CLDR 001 default. Locale extensions follow CLDR's precedence:
// fw, rg, iso8601 calendar, explicit region, subdivision, then likely region.
func FirstDayOfWeek(locale string) string {
	tag, err := language.Parse(locale)
	if err != nil || tag.IsRoot() {
		return "monday"
	}
	if name, valid := cldrWeekday[tag.TypeForKey("fw")]; valid {
		return name
	}
	if override := tag.TypeForKey("rg"); len(override) >= 2 {
		return firstDayForRegion(strings.ToUpper(override[:2]))
	}
	if tag.TypeForKey("ca") == "iso8601" {
		return "monday"
	}
	resolved, confidence := tag.Region()
	if confidence == language.Exact {
		return firstDayForRegion(resolved.String())
	}
	if subdivision := tag.TypeForKey("sd"); len(subdivision) >= 2 {
		return firstDayForRegion(strings.ToUpper(subdivision[:2]))
	}
	return firstDayForRegion(resolved.String())
}

func firstDayForRegion(region string) string {
	if day, ok := cldrFirstDay[region]; ok {
		return cldrWeekday[day]
	}
	return "monday"
}

var cldrWeekday = map[string]string{
	"sun": "sunday", "mon": "monday", "tue": "tuesday", "wed": "wednesday",
	"thu": "thursday", "fri": "friday", "sat": "saturday",
}

// Regions whose CLDR week start differs from 001 (Monday), from CLDR 48.
var cldrFirstDay = map[string]string{
	"AF": "sat", "AG": "sun", "AS": "sun", "BD": "sun", "BH": "sat",
	"BR": "sun", "BS": "sun", "BT": "sun", "BW": "sun", "BZ": "sun",
	"CA": "sun", "CO": "sun", "DJ": "sat", "DM": "sun", "DO": "sun",
	"DZ": "sat", "EG": "sat", "ET": "sun", "GT": "sun", "GU": "sun",
	"HK": "sun", "HN": "sun", "ID": "sun", "IL": "sun", "IN": "sun",
	"IQ": "sat", "IR": "sat", "IS": "sun", "JM": "sun", "JO": "sat",
	"JP": "sun", "KE": "sun", "KH": "sun", "KR": "sun", "KW": "sat",
	"LA": "sun", "LY": "sat", "MH": "sun", "MM": "sun", "MO": "sun",
	"MT": "sun", "MV": "fri", "MX": "sun", "MZ": "sun", "NI": "sun",
	"NP": "sun", "OM": "sat", "PA": "sun", "PE": "sun", "PH": "sun",
	"PK": "sun", "PR": "sun", "PT": "sun", "PY": "sun", "QA": "sat",
	"SA": "sun", "SD": "sat", "SG": "sun", "SV": "sun", "SY": "sat",
	"TH": "sun", "TT": "sun", "TW": "sun", "UM": "sun", "US": "sun",
	"VE": "sun", "VI": "sun", "WS": "sun", "YE": "sun", "ZA": "sun",
	"ZW": "sun",
}
