package plugin

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"

	"github.com/tilecast/tilecast/packages/config-schema/go/configschema"
)

// Host connections of Plugin Manifest API 3 (docs/plugin-connections.md).
//
// A plugin declares each outbound connection it needs. The declaration
// states the security boundary: which origins, whether a private address
// may be reached, whether plain HTTP may be used, and the limits of one
// request. An Owner or Administrator then creates connection records in
// Studio, enters the origin of an operator connection, and gives each
// consent the declaration makes possible. Plugin code names a connection
// record; it never states an origin, an address rule, or a credential.

// Connection types. Phase 2 adds OAuth 2.0 connections in a later change of
// the same phase; stream and socket types arrive in later phases.
const (
	ConnectionHTTP = "http"
)

// Address rules of a connection declaration.
const (
	NetworkRefused = "refused"
	NetworkAllowed = "allowed"
)

// OperatorOrigin is the origins value of a connection whose one origin an
// Owner or Administrator enters in Studio.
const OperatorOrigin = "operator"

// Connection bounds. Eight connections is twice what the proof plugins
// need, and each one is a separate review item at install. Eight fixed
// origins covers a provider with separate API, upload, and content hosts.
const (
	MaxConnections       = 8
	MaxConnectionOrigins = 8
	// MaxFieldConnections bounds the declarations one connection field
	// accepts.
	MaxFieldConnections = MaxConnections
)

// Response and time bounds of one request through a connection. The
// defaults apply when the declaration omits them. The install review shows
// any value above the default.
const (
	DefaultMaxResponseBytes = 1 << 20
	MaxMaxResponseBytes     = 16 << 20
	MinMaxResponseBytes     = 1 << 10
	DefaultTimeoutSeconds   = 10
	MaxTimeoutSeconds       = 60
)

var connectionIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

// Connection is one declared outbound connection.
type Connection struct {
	// ID identifies the declaration inside the plugin. Connection records
	// and connection fields name it. It never changes.
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Type        string `json:"type"`
	// Origins is a fixed list of https origins, or OperatorOrigin.
	Origins ConnectionOrigins `json:"origins"`
	// PrivateNetwork makes private addresses possible. They become usable
	// only after an operator's separate consent.
	PrivateNetwork string `json:"privateNetwork,omitempty"`
	// PlainHTTP makes an operator-entered http origin possible on the local
	// network, after its own consent.
	PlainHTTP string `json:"plainHttp,omitempty"`
	// AllowPlaintextSecret lets a secret header reference travel over plain
	// HTTP, after a third consent.
	AllowPlaintextSecret bool `json:"allowPlaintextSecret,omitempty"`
	MaxResponseBytes     int  `json:"maxResponseBytes,omitempty"`
	TimeoutSeconds       int  `json:"timeoutSeconds,omitempty"`
}

// ConnectionOrigins is the fixed origin list, or the operator marker.
type ConnectionOrigins struct {
	Operator bool
	Fixed    []string
}

// MarshalJSON writes "operator" or the list.
func (o ConnectionOrigins) MarshalJSON() ([]byte, error) {
	if o.Operator {
		return json.Marshal(OperatorOrigin)
	}
	if o.Fixed == nil {
		return []byte("[]"), nil
	}
	return json.Marshal(o.Fixed)
}

// UnmarshalJSON reads "operator" or a list of origins.
func (o *ConnectionOrigins) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return err
		}
		if text != OperatorOrigin {
			return fmt.Errorf("origins must be %q or a list of origins", OperatorOrigin)
		}
		*o = ConnectionOrigins{Operator: true}
		return nil
	}
	var list []string
	if err := json.Unmarshal(trimmed, &list); err != nil {
		return fmt.Errorf("origins must be %q or a list of origins", OperatorOrigin)
	}
	*o = ConnectionOrigins{Fixed: list}
	return nil
}

// ConnectionByID returns a declared connection.
func (m Manifest) ConnectionByID(id string) (Connection, bool) {
	for _, connection := range m.Connections {
		if connection.ID == id {
			return connection, true
		}
	}
	return Connection{}, false
}

// AllowsPrivateNetwork reports the declaration's private network rule.
func (c Connection) AllowsPrivateNetwork() bool { return c.PrivateNetwork == NetworkAllowed }

// AllowsPlainHTTP reports the declaration's plain HTTP rule.
func (c Connection) AllowsPlainHTTP() bool { return c.PlainHTTP == NetworkAllowed }

// ResponseLimit is the declared response bound in bytes, or the default.
func (c Connection) ResponseLimit() int {
	if c.MaxResponseBytes == 0 {
		return DefaultMaxResponseBytes
	}
	return c.MaxResponseBytes
}

// Timeout is the declared time bound in seconds, or the default.
func (c Connection) Timeout() int {
	if c.TimeoutSeconds == 0 {
		return DefaultTimeoutSeconds
	}
	return c.TimeoutSeconds
}

// FixedOrigins parses the fixed origin list. The manifest validator has
// already checked it.
func (c Connection) FixedOrigins() []Origin {
	out := make([]Origin, 0, len(c.Origins.Fixed))
	for _, raw := range c.Origins.Fixed {
		if origin, err := ParseCanonicalOrigin(raw); err == nil {
			out = append(out, origin)
		}
	}
	return out
}

// SecurityFingerprint identifies the security-relevant part of the
// declaration. A consent records the fingerprint it was given for; a
// release that changes the declaration therefore needs the consents again.
// Response and time limits are not part of it: they do not change where
// data goes.
func (c Connection) SecurityFingerprint() string {
	origins := append([]string(nil), c.Origins.Fixed...)
	sort.Strings(origins)
	document, _ := json.Marshal(map[string]any{
		"type":                 c.Type,
		"operator":             c.Origins.Operator,
		"origins":              origins,
		"privateNetwork":       c.AllowsPrivateNetwork(),
		"plainHttp":            c.AllowsPlainHTTP(),
		"allowPlaintextSecret": c.AllowPlaintextSecret,
	})
	sum := sha256.Sum256(document)
	return hex.EncodeToString(sum[:])
}

func (c Connection) validate() error {
	where := fmt.Sprintf("connection %q", c.ID)
	if !connectionIDPattern.MatchString(c.ID) {
		return fmt.Errorf("invalid connection id %q", c.ID)
	}
	if err := bounded(where+" title", c.Title, 80); err != nil {
		return err
	}
	if c.Description != "" {
		if err := bounded(where+" description", c.Description, 280); err != nil {
			return err
		}
	}
	if c.Type != ConnectionHTTP {
		return fmt.Errorf("%s has unknown type %q", where, c.Type)
	}
	for _, rule := range []struct{ name, value string }{{"privateNetwork", c.PrivateNetwork}, {"plainHttp", c.PlainHTTP}} {
		if rule.value != "" && rule.value != NetworkRefused && rule.value != NetworkAllowed {
			return fmt.Errorf("%s %s must be %q or %q", where, rule.name, NetworkRefused, NetworkAllowed)
		}
	}
	if c.Origins.Operator {
		if len(c.Origins.Fixed) > 0 {
			return fmt.Errorf("%s origins is either %q or a list", where, OperatorOrigin)
		}
	} else {
		if len(c.Origins.Fixed) == 0 || len(c.Origins.Fixed) > MaxConnectionOrigins {
			return fmt.Errorf("%s needs 1 to %d origins, or %q", where, MaxConnectionOrigins, OperatorOrigin)
		}
		seen := map[string]bool{}
		for _, raw := range c.Origins.Fixed {
			origin, err := ParseCanonicalOrigin(raw)
			if err != nil {
				return fmt.Errorf("%s: %v", where, err)
			}
			if origin.Scheme != SchemeHTTPS {
				// A plugin never hardcodes a plain HTTP destination. Plain
				// HTTP is possible only on an origin an operator enters.
				return fmt.Errorf("%s declares %s; a fixed origin must use https", where, raw)
			}
			if seen[raw] {
				return fmt.Errorf("%s declares %s twice", where, raw)
			}
			seen[raw] = true
		}
	}
	if c.AllowsPlainHTTP() {
		if !c.Origins.Operator {
			return fmt.Errorf("%s allows plain HTTP; plain HTTP needs origins %q", where, OperatorOrigin)
		}
		if !c.AllowsPrivateNetwork() {
			return fmt.Errorf("%s allows plain HTTP; plain HTTP reaches only private addresses, so privateNetwork must be %q", where, NetworkAllowed)
		}
	}
	if c.AllowPlaintextSecret && !c.AllowsPlainHTTP() {
		return fmt.Errorf("%s allows a plaintext secret without plainHttp %q", where, NetworkAllowed)
	}
	if c.MaxResponseBytes != 0 && (c.MaxResponseBytes < MinMaxResponseBytes || c.MaxResponseBytes > MaxMaxResponseBytes) {
		return fmt.Errorf("%s maxResponseBytes must be from %d to %d", where, MinMaxResponseBytes, MaxMaxResponseBytes)
	}
	if c.TimeoutSeconds != 0 && (c.TimeoutSeconds < 1 || c.TimeoutSeconds > MaxTimeoutSeconds) {
		return fmt.Errorf("%s timeoutSeconds must be from 1 to %d", where, MaxTimeoutSeconds)
	}
	return nil
}

// validateConnections checks the declarations and every connection field
// against them.
func (m Manifest) validateConnections() error {
	if len(m.Connections) > MaxConnections {
		return fmt.Errorf("connections declares %d connections; the limit is %d", len(m.Connections), MaxConnections)
	}
	declared := map[string]bool{}
	for _, connection := range m.Connections {
		if err := connection.validate(); err != nil {
			return err
		}
		if declared[connection.ID] {
			return fmt.Errorf("connection %q is declared twice", connection.ID)
		}
		declared[connection.ID] = true
	}
	check := func(where string, fields []configschema.Field) error {
		for _, field := range fields {
			if field.Control != configschema.ControlConnection {
				continue
			}
			for _, id := range field.Connections {
				if !declared[id] {
					return fmt.Errorf("%s field %q accepts connection %q, which the manifest does not declare", where, field.Key, id)
				}
			}
		}
		return nil
	}
	if m.Settings != nil {
		if err := check("settings.organization", m.Settings.Organization); err != nil {
			return err
		}
		if err := check("settings.screen", m.Settings.Screen); err != nil {
			return err
		}
	}
	for _, kind := range m.Instances {
		if err := check("instances."+kind.Kind, kind.Fields); err != nil {
			return err
		}
	}
	return nil
}
