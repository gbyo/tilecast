// Package config keeps the CLI's non-secret state: the context list and
// which context is current. A context names a server URL and the
// installation ID login verified there, so switching servers can refuse a
// context whose installation changed underneath it. Credentials never live
// here; they stay in the OS credential store (see internal/secret) or in
// TILECAST_TOKEN for non-interactive use.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

var (
	ErrNoCurrentContext  = errors.New("no current context; run \"tilecast auth login <server>\" or \"tilecast context use <name>\"")
	ErrContextExists     = errors.New("a context with that name already exists")
	ErrContextNotFound   = errors.New("no such context")
	ErrContextNameNeeded = errors.New("context name must not be blank")
)

// Context is one saved server: address plus verified installation.
type Context struct {
	Name           string `json:"name"`
	ServerURL      string `json:"serverURL"`
	InstallationID string `json:"installationID,omitempty"`
}

// File is the on-disk shape.
type File struct {
	CurrentContext string    `json:"currentContext,omitempty"`
	Contexts       []Context `json:"contexts"`
}

// Store reads and writes the config file.
type Store struct {
	path string
}

// DefaultPath resolves the config file location. TILECAST_CONFIG wins
// when set, which keeps tests and portable setups off the real home.
func DefaultPath() (string, error) {
	if override := os.Getenv("TILECAST_CONFIG"); override != "" {
		return override, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate user config dir: %w", err)
	}
	return filepath.Join(dir, "tilecast", "config.json"), nil
}

// NewStore opens the config at path, starting empty when no file exists.
func NewStore(path string) *Store {
	return &Store{path: path}
}

func (s *Store) load() (File, error) {
	var file File
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return file, nil
	}
	if err != nil {
		return file, fmt.Errorf("read CLI config: %w", err)
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return file, fmt.Errorf("parse CLI config: %w", err)
	}
	return file, nil
}

func (s *Store) save(file File) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("create CLI config dir: %w", err)
	}
	raw, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.path, append(raw, '\n'), 0o644); err != nil {
		return fmt.Errorf("write CLI config: %w", err)
	}
	return nil
}

// List returns every context in saved order.
func (s *Store) List() ([]Context, error) {
	file, err := s.load()
	if err != nil {
		return nil, err
	}
	return file.Contexts, nil
}

// CurrentName returns the current context name, if any.
func (s *Store) CurrentName() (string, error) {
	file, err := s.load()
	if err != nil {
		return "", err
	}
	return file.CurrentContext, nil
}

// Current resolves the current context.
func (s *Store) Current() (Context, error) {
	file, err := s.load()
	if err != nil {
		return Context{}, err
	}
	if file.CurrentContext == "" {
		return Context{}, ErrNoCurrentContext
	}
	for _, context := range file.Contexts {
		if context.Name == file.CurrentContext {
			return context, nil
		}
	}
	return Context{}, ErrNoCurrentContext
}

// Get finds one context by name.
func (s *Store) Get(name string) (Context, error) {
	file, err := s.load()
	if err != nil {
		return Context{}, err
	}
	for _, context := range file.Contexts {
		if context.Name == name {
			return context, nil
		}
	}
	return Context{}, fmt.Errorf("%w: %q", ErrContextNotFound, name)
}

// Upsert saves the context and makes it current when it is new or when
// makeCurrent asks. Updating an existing context keeps the current
// pointer untouched unless makeCurrent is set.
func (s *Store) Upsert(context Context, makeCurrent bool) error {
	if context.Name == "" {
		return ErrContextNameNeeded
	}
	file, err := s.load()
	if err != nil {
		return err
	}
	found := false
	for index, existing := range file.Contexts {
		if existing.Name == context.Name {
			file.Contexts[index] = context
			found = true
		}
	}
	if !found {
		file.Contexts = append(file.Contexts, context)
	}
	if !found || makeCurrent {
		file.CurrentContext = context.Name
	}
	return s.save(file)
}

// Use switches the current context.
func (s *Store) Use(name string) error {
	file, err := s.load()
	if err != nil {
		return err
	}
	for _, context := range file.Contexts {
		if context.Name == name {
			file.CurrentContext = name
			return s.save(file)
		}
	}
	return fmt.Errorf("%w: %q", ErrContextNotFound, name)
}

// Rename changes a context's name, following the current pointer.
func (s *Store) Rename(oldName, newName string) error {
	if newName == "" {
		return ErrContextNameNeeded
	}
	file, err := s.load()
	if err != nil {
		return err
	}
	at := -1
	for index, context := range file.Contexts {
		if context.Name == newName && newName != oldName {
			return fmt.Errorf("%w: %q", ErrContextExists, newName)
		}
		if context.Name == oldName {
			at = index
		}
	}
	if at < 0 {
		return fmt.Errorf("%w: %q", ErrContextNotFound, oldName)
	}
	file.Contexts[at].Name = newName
	if file.CurrentContext == oldName {
		file.CurrentContext = newName
	}
	return s.save(file)
}

// Remove deletes a context. When it was current, the current pointer moves
// to the first remaining context, or empties when none remain.
func (s *Store) Remove(name string) error {
	file, err := s.load()
	if err != nil {
		return err
	}
	kept := file.Contexts[:0]
	found := false
	for _, context := range file.Contexts {
		if context.Name == name {
			found = true
			continue
		}
		kept = append(kept, context)
	}
	if !found {
		return fmt.Errorf("%w: %q", ErrContextNotFound, name)
	}
	file.Contexts = kept
	if file.CurrentContext == name {
		file.CurrentContext = ""
		if len(kept) > 0 {
			file.CurrentContext = kept[0].Name
		}
	}
	return s.save(file)
}
