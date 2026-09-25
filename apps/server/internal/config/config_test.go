package config

import "testing"

func TestLoadRequiresDatabaseURL(t *testing.T) {
	t.Setenv("TILECAST_DATABASE_URL", "")
	t.Setenv("TILECAST_ENV", "development")
	if _, err := Load(); err == nil {
		t.Fatal("expected missing database URL to fail")
	}
}

func TestCookieSecureMustBeBoolean(t *testing.T) {
	t.Setenv("TILECAST_DATABASE_URL", "postgres://example")
	t.Setenv("TILECAST_ENV", "production")
	t.Setenv("TILECAST_COOKIE_SECURE", "sometimes")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid cookie setting to fail")
	}
}

func TestDevelopmentDefaults(t *testing.T) {
	t.Setenv("TILECAST_DATABASE_URL", "postgres://example")
	t.Setenv("TILECAST_ENV", "development")
	t.Setenv("TILECAST_COOKIE_SECURE", "false")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.HTTPAddr != ":8080" || cfg.CookieName != "tilecast_session" {
		t.Fatalf("unexpected defaults: %#v", cfg)
	}
	if cfg.Media.MaxUploadBytes != 10737418240 || cfg.Media.Workers != 2 || cfg.Media.VideoMaxWidth != 1920 {
		t.Fatalf("unexpected media defaults: %#v", cfg.Media)
	}
	if cfg.Website.AllowPrivateHTTP || cfg.Website.DefaultTimeoutSeconds != 20 || cfg.Website.MaxAllowedHosts != 25 {
		t.Fatalf("unexpected website defaults: %#v", cfg.Website)
	}
}

func TestPlaintextSMTPAuthIsItsOwnDecision(t *testing.T) {
	// Trusting a relay certificate a private authority signed is ordinary inside
	// a district. Sending the mail password in readable text is not, so the first
	// flag must not imply the second.
	t.Setenv("TILECAST_DATABASE_URL", "postgres://example")
	t.Setenv("TILECAST_ENV", "development")
	t.Setenv("TILECAST_SMTP_ALLOW_INSECURE", "true")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if !cfg.Notifications.SMTPAllowInsecure {
		t.Error("the certificate flag was not read")
	}
	if cfg.Notifications.SMTPAllowPlaintextAuth {
		t.Error("accepting a private certificate must not also allow credentials in the clear")
	}

	t.Setenv("TILECAST_SMTP_ALLOW_PLAINTEXT_AUTH", "true")
	if cfg, err = Load(); err != nil {
		t.Fatalf("load config: %v", err)
	}
	if !cfg.Notifications.SMTPAllowPlaintextAuth {
		t.Error("the plaintext-auth opt-in was not read")
	}

	t.Setenv("TILECAST_SMTP_ALLOW_PLAINTEXT_AUTH", "sometimes")
	if _, err = Load(); err == nil {
		t.Error("expected an unparseable plaintext-auth flag to fail rather than default to on")
	}
}

func TestWebsiteConfigurationValidation(t *testing.T) {
	t.Setenv("TILECAST_DATABASE_URL", "postgres://example")
	t.Setenv("TILECAST_WEBSITE_ALLOW_PRIVATE_HTTP", "sometimes")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid private HTTP flag")
	}
	t.Setenv("TILECAST_WEBSITE_ALLOW_PRIVATE_HTTP", "false")
	t.Setenv("TILECAST_WEBSITE_DEFAULT_TIMEOUT_SECONDS", "121")
	t.Setenv("TILECAST_WEBSITE_MAX_TIMEOUT_SECONDS", "120")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid website timeout")
	}
}

func TestMediaConfigurationValidation(t *testing.T) {
	t.Setenv("TILECAST_DATABASE_URL", "postgres://example")
	t.Setenv("TILECAST_MEDIA_WORKERS", "0")
	if _, err := Load(); err == nil {
		t.Fatal("expected zero media workers to fail")
	}
	t.Setenv("TILECAST_MEDIA_WORKERS", "2")
	t.Setenv("TILECAST_MAX_UPLOAD_BYTES", "not-a-size")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid upload maximum to fail")
	}
}

func TestPositiveIntParsingRejectsOverflow(t *testing.T) {
	t.Setenv("TILECAST_TEST_INT", "999999999999999999999999999999")
	if _, err := parsePositiveInt("TILECAST_TEST_INT", "1", 0); err == nil {
		t.Fatal("expected platform int overflow to fail")
	}
}

func TestPositiveIntParsingEnforcesMaximum(t *testing.T) {
	t.Setenv("TILECAST_TEST_INT", "11")
	if _, err := parsePositiveInt("TILECAST_TEST_INT", "1", 10); err == nil {
		t.Fatal("expected configured upper bound to fail")
	}
}

func TestDevelopmentIsNotDemoMode(t *testing.T) {
	t.Setenv("TILECAST_DATABASE_URL", "postgres://example")
	t.Setenv("TILECAST_ENV", "development")
	t.Setenv("TILECAST_DEMO_SCENARIO", "basic")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.DemoMode() || cfg.Demo != (DemoConfig{}) {
		t.Fatalf("development must not enable Demo Mode: %#v", cfg.Demo)
	}
	if !cfg.MDNSEnabled {
		t.Fatal("development must keep the mDNS default")
	}
}

func TestDemoDefaults(t *testing.T) {
	t.Setenv("TILECAST_DATABASE_URL", "postgres://example")
	t.Setenv("TILECAST_ENV", "demo")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if !cfg.DemoMode() || cfg.Demo.Scenario != "kitchen-sink" || !cfg.Demo.ResetOnStart || !cfg.Demo.Players || cfg.Demo.AllowRemote {
		t.Fatalf("unexpected demo defaults: %#v", cfg.Demo)
	}
	if cfg.MDNSEnabled {
		t.Fatal("Demo Mode must not advertise itself by default")
	}
}

func TestDemoRefusesUnsafeCombinations(t *testing.T) {
	cases := map[string]map[string]string{
		"public URL":     {"TILECAST_PUBLIC_URL": "https://signage.example.org"},
		"LAN address":    {"TILECAST_PUBLIC_URL": "http://192.168.1.20:8080"},
		"mDNS":           {"TILECAST_MDNS_ENABLED": "true"},
		"email":          {"TILECAST_SMTP_HOST": "smtp.example.org"},
		"update token":   {"TILECAST_GITHUB_TOKEN": "ghp_example"},
		"publish token":  {"TILECAST_RELEASE_PUBLISH_TOKEN": "publish"},
		"empty scenario": {"TILECAST_DEMO_SCENARIO": " "},
	}
	for name, values := range cases {
		t.Run(name, func(t *testing.T) {
			t.Setenv("TILECAST_DATABASE_URL", "postgres://example")
			t.Setenv("TILECAST_ENV", "demo")
			for key, value := range values {
				t.Setenv(key, value)
			}
			if _, err := Load(); err == nil {
				t.Fatalf("expected %s to be refused in Demo Mode", name)
			}
		})
	}
}

func TestDemoAllowsLoopbackAndExplicitRemote(t *testing.T) {
	for _, publicURL := range []string{"http://localhost:8080", "http://127.0.0.1:18080", "http://[::1]:8080"} {
		t.Setenv("TILECAST_DATABASE_URL", "postgres://example")
		t.Setenv("TILECAST_ENV", "demo")
		t.Setenv("TILECAST_PUBLIC_URL", publicURL)
		if _, err := Load(); err != nil {
			t.Fatalf("%s: %v", publicURL, err)
		}
	}
	t.Setenv("TILECAST_PUBLIC_URL", "https://demo.example.org")
	t.Setenv("TILECAST_DEMO_ALLOW_REMOTE", "true")
	if _, err := Load(); err != nil {
		t.Fatalf("explicit remote demo host: %v", err)
	}
}
