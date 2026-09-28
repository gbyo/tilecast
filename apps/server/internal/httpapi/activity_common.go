package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	activityDefaultLimit = 50
	activityMaximumLimit = 250
)

type activityWindow struct {
	From time.Time
	To   time.Time
}

type activityPage struct {
	Limit  int
	Cursor *activityCursor
}

type activityCursor struct {
	Time time.Time
	ID   uuid.UUID
}

// activityPrincipal returns the request's management principal for the
// activity reads. Callers fail closed with 401 when it is absent.
func activityPrincipal(r *http.Request) (auth.Principal, bool) {
	return principalOf(r)
}

// activityRole returns the caller's role for activity visibility decisions.
func activityRole(r *http.Request) (string, bool) {
	principal, ok := activityPrincipal(r)
	if !ok {
		return "", false
	}
	return principal.User.Role, true
}

func activityCanSeeSensitive(role string) bool {
	return role == "owner" || role == "administrator"
}

func activityCanExport(role string) bool {
	return role == "owner" || role == "administrator"
}

func parseActivityWindow(r *http.Request) (activityWindow, error) {
	now := time.Now().UTC()
	window := activityWindow{From: now.Add(-24 * time.Hour), To: now}
	if value := strings.TrimSpace(r.URL.Query().Get("from")); value != "" {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return window, errors.New("from must be an RFC 3339 timestamp")
		}
		window.From = parsed.UTC()
	}
	if value := strings.TrimSpace(r.URL.Query().Get("to")); value != "" {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return window, errors.New("to must be an RFC 3339 timestamp")
		}
		window.To = parsed.UTC()
	}
	if !window.From.Before(window.To) {
		return window, errors.New("from must be earlier than to")
	}
	if window.To.Sub(window.From) > 5*365*24*time.Hour {
		return window, errors.New("activity ranges may not exceed five years")
	}
	return window, nil
}

func parseActivityPage(r *http.Request) (activityPage, error) {
	page := activityPage{Limit: activityDefaultLimit}
	if value := strings.TrimSpace(r.URL.Query().Get("limit")); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > activityMaximumLimit {
			return page, fmt.Errorf("limit must be between 1 and %d", activityMaximumLimit)
		}
		page.Limit = limit
	}
	if value := strings.TrimSpace(r.URL.Query().Get("cursor")); value != "" {
		cursor, err := decodeActivityCursor(value)
		if err != nil {
			return page, errors.New("cursor is invalid")
		}
		page.Cursor = &cursor
	}
	return page, nil
}

func encodeActivityCursor(cursor activityCursor) string {
	value := cursor.Time.UTC().Format(time.RFC3339Nano) + "|" + cursor.ID.String()
	return base64.RawURLEncoding.EncodeToString([]byte(value))
}

func decodeActivityCursor(value string) (activityCursor, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return activityCursor{}, err
	}
	parts := strings.SplitN(string(decoded), "|", 2)
	if len(parts) != 2 {
		return activityCursor{}, errors.New("invalid cursor")
	}
	when, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return activityCursor{}, err
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return activityCursor{}, err
	}
	return activityCursor{Time: when.UTC(), ID: id}, nil
}

func queryValue(r *http.Request, key string) string {
	return strings.TrimSpace(r.URL.Query().Get(key))
}

func appendActivityFilter(clauses *[]string, args *[]any, expression, value string) {
	if value == "" {
		return
	}
	*args = append(*args, value)
	*clauses = append(*clauses, fmt.Sprintf(expression, len(*args)))
}

func appendActivityUUIDFilter(clauses *[]string, args *[]any, expression, value string) error {
	if value == "" {
		return nil
	}
	parsed, err := uuid.Parse(value)
	if err != nil {
		return errors.New("identifier filter is invalid")
	}
	*args = append(*args, parsed)
	*clauses = append(*clauses, fmt.Sprintf(expression, len(*args)))
	return nil
}

func activityMetadata(raw []byte, sensitive bool, role string) map[string]any {
	if sensitive && !activityCanSeeSensitive(role) {
		return map[string]any{"redacted": true}
	}
	value := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &value)
	}
	return sanitizeActivityMap(value, activityCanSeeSensitive(role))
}

func sanitizeActivityMap(value map[string]any, privileged bool) map[string]any {
	out := make(map[string]any, len(value))
	for key, item := range value {
		lower := strings.ToLower(key)
		if activitySensitiveKey(lower) {
			continue
		}
		if !privileged && (strings.Contains(lower, "diagnostic") || strings.Contains(lower, "failurepayload") || strings.Contains(lower, "ipaddress")) {
			continue
		}
		switch nested := item.(type) {
		case map[string]any:
			out[key] = sanitizeActivityMap(nested, privileged)
		case []any:
			clean := make([]any, 0, len(nested))
			for _, entry := range nested {
				if object, ok := entry.(map[string]any); ok {
					clean = append(clean, sanitizeActivityMap(object, privileged))
				} else {
					clean = append(clean, entry)
				}
			}
			out[key] = clean
		default:
			out[key] = item
		}
	}
	return out
}

func activitySensitiveKey(key string) bool {
	for _, fragment := range []string{
		"password", "token", "secret", "credential", "authorization", "cookie", "csrf",
		"privatecsv", "csvpayload", "configurationdocument", "fullconfig", "accesskey",
	} {
		if strings.Contains(key, fragment) {
			return true
		}
	}
	return false
}

func safeActivityText(value string, maximum int) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, "\x00", "")
	if len(value) > maximum {
		value = value[:maximum]
	}
	return value
}

func activityContextWithoutCancel(ctx context.Context) context.Context {
	return context.WithoutCancel(ctx)
}
