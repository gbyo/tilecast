package demo

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tilecast/tilecast/apps/server/internal/auth"
)

// AuthMethod is recorded on every session Demo Mode issues, so audit history
// and Studio can tell a demo sign-in from a password sign-in.
const AuthMethod = "demo"

// Options configure the runtime from the process configuration.
type Options struct {
	Scenario     string
	ResetOnStart bool
	Players      bool
	// BaseURL is the loopback address of this server. The simulator connects
	// to it like any player on the network would.
	BaseURL string
}

// State is the public description of the running demo.
type State struct {
	Scenario  string         `json:"scenario"`
	Scenarios []string       `json:"scenarios"`
	SeededAt  time.Time      `json:"seededAt"`
	Players   []PlayerStatus `json:"players"`
}

// Runtime is the whole Demo Mode boundary inside the server process. The HTTP
// layer receives one only when TILECAST_ENV is demo, and every demo-specific
// behavior goes through it.
type Runtime struct {
	svc    Services
	opts   Options
	logger *slog.Logger
	ctx    context.Context

	// mu serializes resets and keeps sessions from being issued mid-reset.
	mu       sync.RWMutex
	scenario string
	seededAt time.Time
	sim      *Simulator
}

// NewRuntime prepares Demo Mode. Start must run before the server accepts
// traffic.
func NewRuntime(svc Services, opts Options, logger *slog.Logger) (*Runtime, error) {
	if _, ok := Lookup(opts.Scenario); !ok {
		return nil, UnknownScenarioError{Name: opts.Scenario}
	}
	return &Runtime{svc: svc, opts: opts, logger: logger, scenario: opts.Scenario}, nil
}

// Start seeds the configured scenario, or keeps an existing demo dataset when
// resets on start are off. Simulated players start in the background and
// connect once the HTTP listener is up.
func (r *Runtime) Start(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ctx = ctx
	seeded, err := isSeeded(ctx, r.svc.DB)
	if err != nil {
		return err
	}
	var players []Player
	if r.opts.ResetOnStart || !seeded {
		if players, err = Seed(ctx, r.svc, r.scenario); err != nil {
			return err
		}
		r.logger.Info("demo scenario seeded", "scenario", r.scenario)
	} else {
		if err = guardDisposable(ctx, r.svc.DB); err != nil {
			return err
		}
		if players, err = Reenroll(ctx, r.svc, r.scenario); err != nil {
			return err
		}
		r.logger.Info("kept the existing demo dataset", "scenario", r.scenario)
	}
	r.seededAt = time.Now().UTC()
	r.startPlayers(players)
	return nil
}

// Stop ends the simulated players.
func (r *Runtime) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sim.Stop()
	r.sim = nil
}

func (r *Runtime) startPlayers(players []Player) {
	if !r.opts.Players || len(players) == 0 {
		return
	}
	r.sim = StartSimulator(r.ctx, r.opts.BaseURL, players, r.logger)
}

// Session issues a normal dashboard session for the seeded Owner. Role checks,
// CSRF, screen scopes, and audit attribution then apply exactly as for a
// password sign-in.
func (r *Runtime) Session(ctx context.Context) (auth.Session, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.svc.Auth.IssueSession(ctx, IDs.Owner, AuthMethod)
}

// Reset replaces the dataset with a scenario and waits until its simulated
// players have connected, so a caller sees the complete state on return.
func (r *Runtime) Reset(ctx context.Context, scenario string) (State, error) {
	if scenario == "" {
		scenario = r.opts.Scenario
	}
	if _, ok := Lookup(scenario); !ok {
		return State{}, UnknownScenarioError{Name: scenario}
	}
	r.mu.Lock()
	r.sim.Stop()
	r.sim = nil
	r.disconnectAll(ctx)
	players, err := Seed(ctx, r.svc, scenario)
	if err == nil {
		r.scenario = scenario
		r.seededAt = time.Now().UTC()
		r.startPlayers(players)
		r.logger.Info("demo scenario reset", "scenario", scenario)
	}
	sim := r.sim
	r.mu.Unlock()
	if err != nil {
		return State{}, err
	}
	waitCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err = sim.AwaitConnected(waitCtx); err != nil {
		return r.State(), err
	}
	return r.State(), nil
}

// disconnectAll closes every live player socket before the wipe, including a
// real player someone paired to the demo, so no stale presence survives into
// the new dataset under a reused screen ID.
func (r *Runtime) disconnectAll(ctx context.Context) {
	if r.svc.Presence == nil {
		return
	}
	rows, err := r.svc.DB.Query(ctx, `SELECT id FROM screens`)
	if err != nil {
		return
	}
	screens, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return
	}
	for _, id := range screens {
		r.svc.Presence.Disconnect(id)
	}
	// Each socket handler unregisters itself as it exits. Wait for that, so a
	// handler finishing late cannot mark a freshly seeded screen disconnected.
	deadline := time.Now().Add(3 * time.Second)
	for _, id := range screens {
		for r.svc.Presence.Connected(id) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// State reports the scenario and what the simulated players have observed.
func (r *Runtime) State() State {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return State{Scenario: r.scenario, Scenarios: Scenarios(), SeededAt: r.seededAt, Players: r.sim.Statuses()}
}

// LoopbackURL turns a listen address such as ":8080" into the URL the
// in-process simulator uses to reach this server.
func LoopbackURL(listenAddress string) (string, error) {
	host, port, err := net.SplitHostPort(listenAddress)
	if err != nil {
		return "", fmt.Errorf("parse TILECAST_HTTP_ADDR: %w", err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port), nil
}

// IsUnknownScenario reports whether err names a scenario that does not exist.
func IsUnknownScenario(err error) bool { return errors.As(err, new(UnknownScenarioError)) }
