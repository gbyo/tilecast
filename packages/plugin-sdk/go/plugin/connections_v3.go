package plugin

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"

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

// Connection types. Stream and socket types arrive in later phases.
const (
	ConnectionHTTP   = "http"
	ConnectionOAuth2 = "oauth2"
)

// Token endpoint authentication methods of an OAuth 2.0 connection.
const (
	ClientSecretBasic = "client_secret_basic"
	ClientSecretPost  = "client_secret_post"
	ClientAuthNone    = "none"
)

// Token request body encodings. RFC 6749 uses a form; some providers take
// JSON.
const (
	TokenRequestForm = "form"
	TokenRequestJSON = "json"
)

// OAuth declaration bounds. Sixteen scopes is more than any read-only
// provider integration needs; eight extra authorization parameters covers
// access_type, prompt, and provider hints.
const (
	MaxOAuthScopes         = 16
	MaxOAuthScopeLength    = 256
	MaxOAuthParameters     = 8
	MaxOAuthParameterValue = 256
	MaxOAuthEndpointLength = 2048
)

// reservedOAuthParameters are set by the host. A declaration cannot replace
// them.
var reservedOAuthParameters = set("response_type", "client_id", "client_secret", "redirect_uri", "scope", "state",
	"code", "code_challenge", "code_challenge_method", "code_verifier", "grant_type", "refresh_token", "nonce")

var oauthParameterPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

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
	// OAuth is required for type oauth2 and refused otherwise.
	OAuth *OAuthDeclaration `json:"oauth,omitempty"`
}

// OAuthDeclaration is the provider side of an OAuth 2.0 connection. The
// host runs the authorization code flow with PKCE S256 against these
// endpoints. Plugin code never replaces them at runtime and never receives
// a token.
type OAuthDeclaration struct {
	AuthorizationEndpoint string   `json:"authorizationEndpoint"`
	TokenEndpoint         string   `json:"tokenEndpoint"`
	RevocationEndpoint    string   `json:"revocationEndpoint,omitempty"`
	Scopes                []string `json:"scopes"`
	// TokenEndpointAuthMethod is client_secret_basic, client_secret_post, or
	// none. With none the operator enters no client secret.
	TokenEndpointAuthMethod string `json:"tokenEndpointAuthMethod"`
	// TokenRequestFormat is form (default) or json.
	TokenRequestFormat string `json:"tokenRequestFormat,omitempty"`
	// AuthorizationParameters are extra fixed query parameters of the
	// authorization request, such as access_type=offline.
	AuthorizationParameters map[string]string `json:"authorizationParameters,omitempty"`
}

// NeedsClientSecret reports whether the operator enters a client secret.
func (o OAuthDeclaration) NeedsClientSecret() bool {
	return o.TokenEndpointAuthMethod != ClientAuthNone
}

// JSONTokenRequests reports whether token requests send JSON.
func (o OAuthDeclaration) JSONTokenRequests() bool { return o.TokenRequestFormat == TokenRequestJSON }

// IsOAuth reports whether the connection is an OAuth 2.0 connection.
func (c Connection) IsOAuth() bool { return c.Type == ConnectionOAuth2 && c.OAuth != nil }

func validateOAuthEndpoint(where, name, raw string, required bool) error {
	if raw == "" {
		if required {
			return fmt.Errorf("%s oauth needs %s", where, name)
		}
		return nil
	}
	if len(raw) > MaxOAuthEndpointLength {
		return fmt.Errorf("%s oauth %s is too long", where, name)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != SchemeHTTPS || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery ||
		parsed.Fragment != "" || strings.Contains(raw, "#") || parsed.Opaque != "" {
		return fmt.Errorf("%s oauth %s must be an https URL without a query, a fragment, or a user name", where, name)
	}
	origin, err := OriginOf(parsed)
	if err != nil || origin.Scheme != SchemeHTTPS {
		return fmt.Errorf("%s oauth %s must be an https URL", where, name)
	}
	return nil
}

func (o OAuthDeclaration) validate(where string) error {
	if err := validateOAuthEndpoint(where, "authorizationEndpoint", o.AuthorizationEndpoint, true); err != nil {
		return err
	}
	if err := validateOAuthEndpoint(where, "tokenEndpoint", o.TokenEndpoint, true); err != nil {
		return err
	}
	if err := validateOAuthEndpoint(where, "revocationEndpoint", o.RevocationEndpoint, false); err != nil {
		return err
	}
	if len(o.Scopes) < 1 || len(o.Scopes) > MaxOAuthScopes {
		return fmt.Errorf("%s oauth needs 1 to %d scopes", where, MaxOAuthScopes)
	}
	seen := map[string]bool{}
	for _, scope := range o.Scopes {
		if scope == "" || len(scope) > MaxOAuthScopeLength || seen[scope] {
			return fmt.Errorf("%s oauth has an empty, long, or repeated scope", where)
		}
		for _, r := range scope {
			// RFC 6749 section 3.3: %x21 / %x23-5B / %x5D-7E.
			if r < 0x21 || r > 0x7e || r == '"' || r == '\\' {
				return fmt.Errorf("%s oauth scope %q holds a character a scope cannot hold", where, scope)
			}
		}
		seen[scope] = true
	}
	switch o.TokenEndpointAuthMethod {
	case ClientSecretBasic, ClientSecretPost, ClientAuthNone:
	default:
		return fmt.Errorf("%s oauth tokenEndpointAuthMethod must be %s, %s, or %s", where, ClientSecretBasic, ClientSecretPost, ClientAuthNone)
	}
	switch o.TokenRequestFormat {
	case "", TokenRequestForm, TokenRequestJSON:
	default:
		return fmt.Errorf("%s oauth tokenRequestFormat must be %s or %s", where, TokenRequestForm, TokenRequestJSON)
	}
	if len(o.AuthorizationParameters) > MaxOAuthParameters {
		return fmt.Errorf("%s oauth declares more than %d authorization parameters", where, MaxOAuthParameters)
	}
	for key, value := range o.AuthorizationParameters {
		if !oauthParameterPattern.MatchString(key) || reservedOAuthParameters[key] {
			return fmt.Errorf("%s oauth authorization parameter %q is invalid or set by the host", where, key)
		}
		if value == "" || len(value) > MaxOAuthParameterValue {
			return fmt.Errorf("%s oauth authorization parameter %q needs a value of 1 to %d bytes", where, key, MaxOAuthParameterValue)
		}
		for _, r := range value {
			if r < 0x20 || r > 0x7e {
				return fmt.Errorf("%s oauth authorization parameter %q holds a control or non-ASCII character", where, key)
			}
		}
	}
	return nil
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
	members := map[string]any{
		"type":                 c.Type,
		"operator":             c.Origins.Operator,
		"origins":              origins,
		"privateNetwork":       c.AllowsPrivateNetwork(),
		"plainHttp":            c.AllowsPlainHTTP(),
		"allowPlaintextSecret": c.AllowPlaintextSecret,
	}
	if c.OAuth != nil {
		scopes := append([]string(nil), c.OAuth.Scopes...)
		sort.Strings(scopes)
		members["oauth"] = map[string]any{
			"authorization": c.OAuth.AuthorizationEndpoint, "token": c.OAuth.TokenEndpoint,
			"revocation": c.OAuth.RevocationEndpoint, "scopes": scopes,
			"auth": c.OAuth.TokenEndpointAuthMethod, "format": c.OAuth.TokenRequestFormat,
			"parameters": c.OAuth.AuthorizationParameters,
		}
	}
	document, _ := json.Marshal(members)
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
	switch c.Type {
	case ConnectionHTTP:
		if c.OAuth != nil {
			return fmt.Errorf("%s declares oauth; only type %q takes it", where, ConnectionOAuth2)
		}
	case ConnectionOAuth2:
		if c.OAuth == nil {
			return fmt.Errorf("%s has type %q and needs oauth", where, ConnectionOAuth2)
		}
		if err := c.OAuth.validate(where); err != nil {
			return err
		}
		// OAuth never uses plain HTTP or a private address: an
		// authorization response over plain HTTP is not permitted (RFC 9700
		// section 2.6), and the API origins are fixed provider origins.
		if c.Origins.Operator || c.PrivateNetwork == NetworkAllowed || c.PlainHTTP == NetworkAllowed || c.AllowPlaintextSecret {
			return fmt.Errorf("%s is an OAuth connection; it needs fixed https origins and refuses the private network and plain HTTP", where)
		}
	default:
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
