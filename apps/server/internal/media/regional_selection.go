package media

import (
	"context"
	"encoding/json"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/regional"
	"github.com/tilecast/tilecast/apps/server/internal/settings"
)

func (s *Service) organizationFirstDayOfWeek(ctx context.Context) time.Weekday {
	values := settings.Defaults(settings.ScopeOrganization)
	if s != nil && s.db != nil {
		var encoded []byte
		if err := s.db.QueryRow(ctx, `SELECT settings FROM organization_runtime_settings`).Scan(&encoded); err == nil {
			var stored map[string]any
			if json.Unmarshal(encoded, &stored) == nil {
				for key, value := range stored {
					values[key] = value
				}
			}
		}
	}
	day, _ := values["organization.first_day_of_week"].(string)
	locale, _ := values["organization.locale"].(string)
	return firstDayForRegionalSettings(day, locale)
}

func firstDayForRegionalSettings(day, locale string) time.Weekday {
	if day == "locale" {
		if canonical, err := regional.CanonicalLocale(locale); err == nil {
			day = regional.FirstDayOfWeek(canonical)
		}
	}
	switch day {
	case "sunday":
		return time.Sunday
	case "tuesday":
		return time.Tuesday
	case "wednesday":
		return time.Wednesday
	case "thursday":
		return time.Thursday
	case "friday":
		return time.Friday
	case "saturday":
		return time.Saturday
	case "monday":
		return time.Monday
	default:
		return time.Monday
	}
}
