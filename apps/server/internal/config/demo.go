package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// EnvironmentDemo is the only TILECAST_ENV value that enables Demo Mode.
// Development and every other environment keep normal behavior.
const EnvironmentDemo = "demo"

// DemoConfig controls the disposable sample installation. It is read only when
// TILECAST_ENV is demo.
type DemoConfig struct {
	// Scenario names the dataset to seed. The demo package validates the name.
	Scenario string
	// ResetOnStart replaces the database contents with the scenario at every
	// start. When false, an existing demo installation is kept and an empty
	// database is seeded.
	ResetOnStart bool
	// Players starts the simulated players that keep the online screens online.
	Players bool
	// AllowRemote permits a public URL that is not a loopback address. Demo
	// Mode signs in every visitor as the Owner, so this is a deliberate choice
	// for a shared, throwaway demonstration host.
	AllowRemote bool
}

// DemoMode reports whether this process runs the disposable demo installation.
func (c Config) DemoMode() bool { return c.Environment == EnvironmentDemo }

func loadDemo(cfg *Config) error {
	demo := DemoConfig{Scenario: strings.TrimSpace(get("TILECAST_DEMO_SCENARIO", "kitchen-sink"))}
	var err error
	if demo.ResetOnStart, err = strconv.ParseBool(get("TILECAST_DEMO_RESET_ON_START", "true")); err != nil {
		return fmt.Errorf("parse TILECAST_DEMO_RESET_ON_START: %w", err)
	}
	if demo.Players, err = strconv.ParseBool(get("TILECAST_DEMO_PLAYERS", "true")); err != nil {
		return fmt.Errorf("parse TILECAST_DEMO_PLAYERS: %w", err)
	}
	if demo.AllowRemote, err = strconv.ParseBool(get("TILECAST_DEMO_ALLOW_REMOTE", "false")); err != nil {
		return fmt.Errorf("parse TILECAST_DEMO_ALLOW_REMOTE: %w", err)
	}
	cfg.Demo = demo
	return validateDemo(*cfg)
}

// validateDemo refuses combinations that would make a sample installation with
// automatic Owner sign-in reachable by other people or able to reach them.
func validateDemo(cfg Config) error {
	if cfg.Demo.Scenario == "" {
		return errors.New("TILECAST_DEMO_SCENARIO must not be empty")
	}
	if !cfg.Demo.AllowRemote {
		parsed, err := url.Parse(cfg.PublicURL)
		if err != nil || !isLoopbackHost(parsed.Hostname()) {
			return errors.New("Demo Mode signs every visitor in as the Owner, so TILECAST_PUBLIC_URL must be a loopback address such as http://localhost:8080; set TILECAST_DEMO_ALLOW_REMOTE=true only for a disposable shared demo host")
		}
	}
	if cfg.MDNSEnabled {
		return errors.New("Demo Mode must not advertise itself to players on the local network; unset TILECAST_MDNS_ENABLED")
	}
	if cfg.Notifications.SMTPHost != "" {
		return errors.New("Demo Mode does not send email; unset TILECAST_SMTP_HOST")
	}
	if strings.TrimSpace(cfg.Updates.GitHubToken) != "" || strings.TrimSpace(cfg.Updates.PublishToken) != "" {
		return errors.New("Demo Mode does not use update credentials; unset TILECAST_GITHUB_TOKEN and TILECAST_RELEASE_PUBLISH_TOKEN")
	}
	return nil
}

// mdnsDefault keeps a demo installation off the local network unless an
// operator asks, and validateDemo then refuses the request.
func mdnsDefault() string {
	if os.Getenv("TILECAST_ENV") == EnvironmentDemo {
		return "false"
	}
	return "true"
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
