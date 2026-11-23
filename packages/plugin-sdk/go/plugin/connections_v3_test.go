package plugin

import "testing"

func TestConnectionDefaultsAndFingerprint(t *testing.T) {
	base := Connection{ID: "gateway", Title: "Gateway", Type: ConnectionHTTP, Origins: ConnectionOrigins{Operator: true},
		PrivateNetwork: NetworkAllowed, PlainHTTP: NetworkAllowed}
	if base.ResponseLimit() != DefaultMaxResponseBytes || base.Timeout() != DefaultTimeoutSeconds {
		t.Fatal("defaults")
	}
	if err := base.validate(); err != nil {
		t.Fatal(err)
	}
	// Limits do not change where data goes, so they keep the fingerprint.
	limited := base
	limited.MaxResponseBytes, limited.TimeoutSeconds = MaxMaxResponseBytes, MaxTimeoutSeconds
	if limited.SecurityFingerprint() != base.SecurityFingerprint() {
		t.Fatal("a limit changed the fingerprint")
	}
	// Each security member changes it.
	for name, change := range map[string]func(*Connection){
		"plaintext": func(c *Connection) { c.AllowPlaintextSecret = true },
		"plain":     func(c *Connection) { c.PlainHTTP = NetworkRefused },
		"private":   func(c *Connection) { c.PrivateNetwork, c.PlainHTTP = NetworkRefused, NetworkRefused },
		"origins":   func(c *Connection) { c.Origins = ConnectionOrigins{Fixed: []string{"https://example.com"}} },
	} {
		changed := base
		change(&changed)
		if changed.SecurityFingerprint() == base.SecurityFingerprint() {
			t.Errorf("%s did not change the fingerprint", name)
		}
	}
	// Origin order does not matter.
	a := Connection{ID: "a", Title: "A", Type: ConnectionHTTP, Origins: ConnectionOrigins{Fixed: []string{"https://a.example", "https://b.example"}}}
	b := a
	b.Origins = ConnectionOrigins{Fixed: []string{"https://b.example", "https://a.example"}}
	if a.SecurityFingerprint() != b.SecurityFingerprint() {
		t.Fatal("origin order changed the fingerprint")
	}
}

func TestConnectionOriginsJSON(t *testing.T) {
	var origins ConnectionOrigins
	if err := origins.UnmarshalJSON([]byte(`"operator"`)); err != nil || !origins.Operator {
		t.Fatalf("operator: %+v %v", origins, err)
	}
	if err := origins.UnmarshalJSON([]byte(`"anywhere"`)); err == nil {
		t.Fatal("accepted another string")
	}
	if err := origins.UnmarshalJSON([]byte(`["https://example.com"]`)); err != nil || origins.Operator || len(origins.Fixed) != 1 {
		t.Fatalf("list: %+v %v", origins, err)
	}
	if text, _ := (ConnectionOrigins{Operator: true}).MarshalJSON(); string(text) != `"operator"` {
		t.Fatalf("marshal = %s", text)
	}
}
