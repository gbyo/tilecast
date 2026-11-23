package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/activityreport"
	"github.com/tilecast/tilecast/apps/server/internal/auth"

	"github.com/google/uuid"
)

const (
	activityDefaultLimit = 50
	activityMaximumLimit = 250
)

// activityWindow is the reporting range owned by activityreport.
type activityWindow = activityreport.Window

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

// activityVisibility is how much of the activity record a caller may see.
// Sensitive details (addresses, request IDs, raw error metadata) and exports
// need activity.manage; everyone who can read activity sees the rest.
type activityVisibility struct{ sensitive bool }

// activityVisibilityOf returns the caller's activity visibility.
func activityVisibilityOf(r *http.Request) (activityVisibility, bool) {
	principal, ok := activityPrincipal(r)
	if !ok {
		return activityVisibility{}, false
	}
	return activityVisibility{sensitive: principal.Can(auth.CapActivityManage)}, true
}

func activityCanSeeSensitive(visibility activityVisibility) bool {
	return visibility.sensitive
}

func activityCanExport(visibility activityVisibility) bool {
	return visibility.sensitive
}

func parseActivityWindow(r *http.Request) (activityWindow, error) {
	return activityreport.ParseWindow(r.URL.Query().Get("from"), r.URL.Query().Get("to"), time.Now())
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

func activityMetadata(raw []byte, sensitive bool, visibility activityVisibility) map[string]any {
	if sensitive && !activityCanSeeSensitive(visibility) {
		return map[string]any{"redacted": true}
	}
	value := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &value)
	}
	return sanitizeActivityMap(value, activityCanSeeSensitive(visibility))
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
