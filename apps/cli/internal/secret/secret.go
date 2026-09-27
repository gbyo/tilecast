// Package secret stores CLI credentials in the operating system's native
// credential store through a small abstraction. macOS Keychain, Windows
// Credential Manager, and Linux Secret Service back the same Set, Get,
// and Delete calls; the rest of the CLI never touches a backend directly.
//
// There is deliberately no plaintext fallback. When no secure store is
// available — headless Linux without a Secret Service agent, minimal CI
// images — operations that need a stored credential fail with an error
// that says so and points at TILECAST_TOKEN instead of quietly writing
// the secret to disk. Only non-secret context metadata ever reaches the
// config file.
package secret

import (
	"errors"
	"fmt"

	"github.com/zalando/go-keyring"
)

// Service names the keyring service under which all CLI entries live.
const Service = "tilecast-cli"

// ErrUnavailable reports that no secure store answered. Callers surface
// this with the TILECAST_TOKEN guidance; they never write the secret
// anywhere else.
var ErrUnavailable = errors.New("no OS credential store is available")

// Store is the credential surface the CLI programs against. The memory
// store backs tests; the keyring store is the only production backend.
type Store interface {
	Set(account, secret string) error
	Get(account string) (string, error)
	Delete(account string) error
	// Check probes the backend. Login runs this before opening the
	// browser so a user never approves access the CLI cannot keep.
	Check() error
}

// KeyringStore is the production backend: the OS-native credential store.
type KeyringStore struct{}

// Set saves the secret for the account, creating or replacing the entry.
func (KeyringStore) Set(account, secret string) error {
	if err := keyring.Set(Service, account, secret); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return nil
}

// Get reads the secret for the account.
func (KeyringStore) Get(account string) (string, error) {
	secret, err := keyring.Get(Service, account)
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return "", keyring.ErrNotFound
		}
		return "", fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return secret, nil
}

// Delete forgets the secret for the account. A missing entry is success.
func (KeyringStore) Delete(account string) error {
	if err := keyring.Delete(Service, account); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return nil
}

// Check probes the OS store with an entry that is deleted immediately.
func (KeyringStore) Check() error {
	const probe = "tilecast-availability-probe"
	if err := keyring.Set(Service, probe, "probe"); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	_ = keyring.Delete(Service, probe)
	return nil
}

// Available reports whether the OS store answers at all.
func Available() bool {
	return KeyringStore{}.Check() == nil
}

// MemoryStore is an in-memory Store for tests. It is never used in
// production and never persists anything.
type MemoryStore struct {
	entries map[string]string
}

// NewMemoryStore builds an empty test store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{entries: map[string]string{}}
}

func (m *MemoryStore) Set(account, secret string) error {
	m.entries[account] = secret
	return nil
}

func (m *MemoryStore) Get(account string) (string, error) {
	secret, ok := m.entries[account]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return secret, nil
}

func (m *MemoryStore) Delete(account string) error {
	delete(m.entries, account)
	return nil
}

// Check always succeeds: memory is always available.
func (m *MemoryStore) Check() error {
	return nil
}
