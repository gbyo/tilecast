package plugins

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/apps/server/internal/pluginsecrets"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

// API models of Plugin Manifest API 3 host-owned instances and settings.
// Database rows are never public contracts; these are.

// ErrRevisionConflict answers an update whose expectedRevision is stale.
var ErrRevisionConflict = errors.New("the instance changed since it was read")

// InstanceDocument is one instance as the API returns it: the host members
// and the kind's configuration fields side by side, in one flat object.
// Host member names are reserved, so a field can never shadow one.
type InstanceDocument struct {
	ID            uuid.UUID
	Kind          string
	Name          string
	Enabled       bool
	Priority      *int
	TargetScope   *string
	TargetIDs     []uuid.UUID
	Schedule      *plugin.InstanceSchedule
	Revision      int64
	Secrets       map[string]pluginsecrets.State
	Configuration map[string]any
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// MarshalJSON writes the flat document.
func (d InstanceDocument) MarshalJSON() ([]byte, error) {
	out := make(map[string]any, len(d.Configuration)+12)
	for key, value := range d.Configuration {
		out[key] = value
	}
	out["id"] = d.ID
	out["kind"] = d.Kind
	out["name"] = d.Name
	out["enabled"] = d.Enabled
	if d.Priority != nil {
		out["priority"] = *d.Priority
	}
	if d.TargetScope != nil {
		out["targetScope"] = *d.TargetScope
		ids := d.TargetIDs
		if ids == nil {
			ids = []uuid.UUID{}
		}
		out["targetIds"] = ids
	}
	if d.Schedule != nil {
		out["schedule"] = d.Schedule
	}
	if len(d.Secrets) > 0 {
		out["secrets"] = d.Secrets
	}
	out["revision"] = d.Revision
	out["createdAt"] = d.CreatedAt
	out["updatedAt"] = d.UpdatedAt
	return json.Marshal(out)
}

// instanceWrite is one create or update request after decoding.
type instanceWrite struct {
	Name             *string
	Enabled          *bool
	Priority         *int
	Target           *plugin.Target
	Schedule         *plugin.InstanceSchedule
	ExpectedRevision *int64
	Secrets          map[string]string
	ClearSecrets     []string
	Configuration    map[string]any
}

// MaxInstanceBodyBytes bounds one instance request.
const MaxInstanceBodyBytes = 96 << 10

// decodeInstanceWrite splits a flat request into host members and
// configuration. Unknown configuration keys fail later, in the schema
// normalizer. An explicit null configuration value means "not set".
func decodeInstanceWrite(w http.ResponseWriter, r *http.Request) (instanceWrite, error) {
	var raw map[string]json.RawMessage
	if err := plugin.DecodeJSONLimit(w, r, &raw, MaxInstanceBodyBytes); err != nil {
		return instanceWrite{}, err
	}
	var out instanceWrite
	out.Configuration = map[string]any{}
	decode := func(key string, target any) error {
		decoder := json.NewDecoder(bytes.NewReader(raw[key]))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(target); err != nil {
			return plugin.Invalidf("%s is not valid", key)
		}
		return nil
	}
	var targetScope *string
	var targetIDs []uuid.UUID
	for key := range raw {
		var err error
		switch key {
		case "name":
			err = decode(key, &out.Name)
		case "enabled":
			err = decode(key, &out.Enabled)
		case "priority":
			err = decode(key, &out.Priority)
		case "targetScope":
			err = decode(key, &targetScope)
		case "targetIds":
			err = decode(key, &targetIDs)
		case "schedule":
			err = decode(key, &out.Schedule)
		case "expectedRevision":
			err = decode(key, &out.ExpectedRevision)
		case "secrets":
			err = decode(key, &out.Secrets)
		case "clearSecrets":
			err = decode(key, &out.ClearSecrets)
		case "id", "kind", "plugin", "revision", "createdAt", "updatedAt", "createdBy":
			// Read-only members a client may send back unchanged.
		default:
			var value any
			if err = json.Unmarshal(raw[key], &value); err != nil {
				err = plugin.Invalidf("%s is not valid", key)
			} else if value != nil {
				out.Configuration[key] = value
			}
		}
		if err != nil {
			return instanceWrite{}, err
		}
	}
	if targetScope != nil || targetIDs != nil {
		target := plugin.Target{IDs: targetIDs}
		if targetScope != nil {
			target.Scope = *targetScope
		}
		if target.IDs == nil {
			target.IDs = []uuid.UUID{}
		}
		out.Target = &target
	}
	return out, nil
}

func normalizeInstanceName(value *string) (string, error) {
	if value == nil {
		return "", plugin.Invalidf("name is required")
	}
	name := strings.TrimSpace(*value)
	if count := utf8.RuneCountInString(name); count < 1 || count > 180 {
		return "", plugin.Invalidf("name must be 1 to 180 characters")
	}
	return name, nil
}

// SettingsDocument is one settings scope as the API returns it.
type SettingsDocument struct {
	Scope     string                         `json:"scope"`
	ScreenID  *uuid.UUID                     `json:"screenId,omitempty"`
	Values    map[string]any                 `json:"values"`
	Secrets   map[string]pluginsecrets.State `json:"secrets,omitempty"`
	Revision  int64                          `json:"revision"`
	UpdatedAt *time.Time                     `json:"updatedAt,omitempty"`
}

type settingsWrite struct {
	Values           map[string]any    `json:"values"`
	Secrets          map[string]string `json:"secrets"`
	ClearSecrets     []string          `json:"clearSecrets"`
	ExpectedRevision *int64            `json:"expectedRevision"`
}

// changedKeys lists the keys whose values differ, sorted.
func changedKeys(before, after map[string]any) []string {
	keys := map[string]bool{}
	for key := range before {
		keys[key] = true
	}
	for key := range after {
		keys[key] = true
	}
	out := []string{}
	for key := range keys {
		left, _ := json.Marshal(before[key])
		right, _ := json.Marshal(after[key])
		if !bytes.Equal(left, right) {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

func conflictError(current int64) error {
	return &plugin.APIError{Status: http.StatusConflict, Code: "plugin_instance_revision_conflict",
		Message: "Someone else saved a newer version. Reload it, then make your change again.",
		Details: map[string]any{"currentRevision": current}}
}

func revisionRequiredError() error {
	return &plugin.APIError{Status: http.StatusPreconditionRequired, Code: "expected_revision_required",
		Message: "Send expectedRevision with the revision you read, so a newer change is never overwritten."}
}

func settingsConflictError(current int64) error {
	return &plugin.APIError{Status: http.StatusConflict, Code: "plugin_settings_revision_conflict",
		Message: "Someone else saved newer settings. Reload them, then make your change again.",
		Details: map[string]any{"currentRevision": current}}
}
