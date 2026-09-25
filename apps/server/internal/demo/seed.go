package demo

import (
	"context"
	"fmt"
	"sort"

	"github.com/tilecast/tilecast/apps/server/internal/auth"
	"github.com/tilecast/tilecast/apps/server/internal/media"
)

const (
	organizationName = "Tilecast Demo District"
	ownerName        = "Dana Whitfield"
	ownerUsername    = "demo"
	demoTimezone     = "America/Chicago"
)

// Scenario is a named dataset. Scenarios compose the builder's primitives, so
// a new one is a new function rather than a new seeding mechanism.
type Scenario struct {
	Name        string
	Description string
	seed        func(*builder) error
	// screens lists the seeded screens, so a restart without a reset can
	// enroll the simulated players again.
	screens func() []ScreenSpec
}

var scenarios = map[string]Scenario{}

func register(scenario Scenario) { scenarios[scenario.Name] = scenario }

// Scenarios lists the available scenario names in a stable order.
func Scenarios() []string {
	names := make([]string, 0, len(scenarios))
	for name := range scenarios {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Lookup returns a scenario by name.
func Lookup(name string) (Scenario, bool) {
	scenario, ok := scenarios[name]
	return scenario, ok
}

// UnknownScenarioError names a scenario that does not exist.
type UnknownScenarioError struct{ Name string }

func (e UnknownScenarioError) Error() string {
	return fmt.Sprintf("unknown demo scenario %q; available scenarios: %v", e.Name, Scenarios())
}

// Seed replaces the database contents with a scenario and returns the players
// the simulator should run. It refuses a database that is not disposable.
func Seed(ctx context.Context, svc Services, name string) ([]Player, error) {
	scenario, ok := Lookup(name)
	if !ok {
		return nil, UnknownScenarioError{Name: name}
	}
	if err := guardDisposable(ctx, svc.DB); err != nil {
		return nil, err
	}
	var storage media.Storage
	if svc.Media != nil {
		storage = svc.Media.Storage()
	}
	if err := wipe(ctx, svc.DB, storage); err != nil {
		return nil, err
	}
	// First-run setup is the real one-time path, which creates the
	// organization and its Owner together.
	owner, err := svc.Auth.Setup(b0(ctx), auth.SetupInput{
		OrganizationName: organizationName, OwnerName: ownerName, Username: ownerUsername, Password: randomPassword(),
	})
	if err != nil {
		return nil, fmt.Errorf("set up demo organization: %w", err)
	}
	if err = expect("owner", IDs.Owner, owner.User.ID); err != nil {
		return nil, err
	}
	// Setup signs the new Owner in. Demo Mode issues its own sessions, so the
	// setup session is not kept.
	if _, err = svc.DB.Exec(ctx, `DELETE FROM sessions`); err != nil {
		return nil, err
	}
	if err = markInstallation(ctx, svc.DB); err != nil {
		return nil, err
	}
	b := &builder{ctx: ctx, svc: svc, owner: IDs.Owner}
	if err = scenario.seed(b); err != nil {
		return nil, fmt.Errorf("seed demo scenario %s: %w", name, err)
	}
	return b.players, nil
}

func b0(ctx context.Context) context.Context { return (&builder{ctx: ctx}).with(IDs.Owner) }

// Reenroll issues fresh credentials to the simulated screens of a scenario
// already in the database, for a restart that keeps the data. Credentials
// live only in memory, so a restarted process has to repair them through the
// approved credential-replacement path, as a real player would.
func Reenroll(ctx context.Context, svc Services, name string) ([]Player, error) {
	scenario, ok := Lookup(name)
	if !ok {
		return nil, UnknownScenarioError{Name: name}
	}
	b := &builder{ctx: ctx, svc: svc, owner: IDs.Owner}
	players := []Player{}
	for _, spec := range scenario.screens() {
		if !spec.State.simulated() {
			continue
		}
		if _, err := svc.Devices.GetScreen(ctx, spec.ID); err != nil {
			continue
		}
		credential, err := b.enroll(spec, true)
		if err != nil {
			return nil, err
		}
		players = append(players, playerFor(spec, credential))
	}
	return players, nil
}
