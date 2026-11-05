package plugin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Bounds of Plugin API v2 Player state. They match the external plugin
// state bounds, and Player Core enforces the same limits on the wire.
const (
	MaxPlayerStateBytes   = 16 * 1024
	MaxPlayerStateDepth   = 16
	MaxPlayerStateValues  = 2048
	MaxPlayerStateMedia   = 16
	MaxPlayerStateEntries = 64
	// MaxPlayerStateLifetime bounds ValidUntil so a cached manifest cannot
	// keep stale state for long; plugins that need longer state omit it.
	MaxPlayerStateLifetime = 366 * 24 * time.Hour
)

// PlayerStateEntry is the wire form of one plugin_state member of the Player
// manifest's plugins array (manifest schema 21).
type PlayerStateEntry struct {
	ID                uuid.UUID       `json:"id"`
	Type              string          `json:"type"`
	Version           int             `json:"version"`
	Plugin            string          `json:"plugin"`
	DefinitionVersion int             `json:"definitionVersion"`
	StateType         string          `json:"stateType"`
	StateVersion      int             `json:"stateVersion"`
	State             json.RawMessage `json:"state"`
	Media             []MediaRef      `json:"media"`
	ValidUntil        *time.Time      `json:"validUntil,omitempty"`
}

// PlayerStateEntryType and PlayerStateEntryVersion discriminate a v2 entry
// from v1 manifest types and external plugin entries.
const (
	PlayerStateEntryType    = "plugin_state"
	PlayerStateEntryVersion = 1
)

// EncodePlayerState validates what a plugin projected against its manifest
// and the wire bounds, and wraps each value in a plugin_state entry. The host
// calls it; plugintest uses it so a plugin's own tests see the same refusal.
func EncodePlayerState(m Manifest, states []PlayerState, now time.Time) ([]PlayerStateEntry, error) {
	fail := func(format string, args ...any) error {
		return fmt.Errorf("plugin %s: %s", m.ID, fmt.Sprintf(format, args...))
	}
	if m.Player == nil {
		return nil, fail("projects Player state without a player contribution")
	}
	if len(states) > MaxPlayerStateEntries {
		return nil, fail("projected %d Player state values; the limit is %d", len(states), MaxPlayerStateEntries)
	}
	ids := map[uuid.UUID]bool{}
	entries := make([]PlayerStateEntry, 0, len(states))
	for _, state := range states {
		if state.ID == uuid.Nil || ids[state.ID] {
			return nil, fail("Player state needs a unique, non-nil id")
		}
		ids[state.ID] = true
		declared := false
		for _, version := range m.PlayerStateVersions(state.Type) {
			declared = declared || version == state.Version
		}
		if !declared {
			return nil, fail("projected undeclared Player state %s@%d", state.Type, state.Version)
		}
		raw, err := json.Marshal(state.State)
		if err != nil {
			return nil, fail("Player state %s: %v", state.ID, err)
		}
		if err := checkStateDocument(raw); err != nil {
			return nil, fail("Player state %s: %v", state.ID, err)
		}
		if len(state.Media) > MaxPlayerStateMedia {
			return nil, fail("Player state %s declares more than %d media variants", state.ID, MaxPlayerStateMedia)
		}
		for _, media := range state.Media {
			if media.AssetID == uuid.Nil || media.VariantID == uuid.Nil {
				return nil, fail("Player state %s declares an empty media reference", state.ID)
			}
		}
		var validUntil *time.Time
		if state.ValidUntil != nil {
			at := state.ValidUntil.UTC().Truncate(time.Second)
			if at.After(now.Add(MaxPlayerStateLifetime)) {
				return nil, fail("Player state %s is valid for more than %s", state.ID, MaxPlayerStateLifetime)
			}
			validUntil = &at
		}
		media := append([]MediaRef{}, state.Media...)
		entries = append(entries, PlayerStateEntry{
			ID: state.ID, Type: PlayerStateEntryType, Version: PlayerStateEntryVersion,
			Plugin: m.ID, DefinitionVersion: m.DefinitionVersion,
			StateType: state.Type, StateVersion: state.Version,
			State: raw, Media: media, ValidUntil: validUntil,
		})
	}
	return entries, nil
}

// checkStateDocument requires a JSON object inside the size, depth, and
// value-count bounds that Player Core applies to the same entry, so a state
// value the Server accepts is never refused by a Player.
func checkStateDocument(raw []byte) error {
	if len(raw) > MaxPlayerStateBytes {
		return fmt.Errorf("state is larger than %d bytes", MaxPlayerStateBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var object map[string]any
	if err := decoder.Decode(&object); err != nil || object == nil {
		return fmt.Errorf("state must be a JSON object")
	}
	nodes := 0
	var visit func(any, int) error
	visit = func(value any, depth int) error {
		nodes++
		if depth > MaxPlayerStateDepth || nodes > MaxPlayerStateValues {
			return fmt.Errorf("state exceeds %d levels or %d values", MaxPlayerStateDepth, MaxPlayerStateValues)
		}
		switch value := value.(type) {
		case map[string]any:
			for _, child := range value {
				if err := visit(child, depth+1); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range value {
				if err := visit(child, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return visit(object, 0)
}
