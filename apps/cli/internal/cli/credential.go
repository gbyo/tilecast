// Credential resolution for tilecast commands: where the server address
// and the bearer credential come from, in order.
//
// Precedence is explicit flag, then environment, then the current context:
//
//	--server / TILECAST_URL / context serverURL
//	--token / TILECAST_TOKEN / OS credential store for the context
//	--context / TILECAST_CONTEXT / stored current context
//
// A stored credential is a JSON envelope holding either an OAuth token
// pair (rotated when its access token expires) or a personal access
// token. Raw secrets never reach the config file, logs, or process
// arguments; --token-stdin exists so scripts can provide one safely.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/zalando/go-keyring"

	"github.com/tilecast/tilecast/apps/cli/internal/authflow"
	"github.com/tilecast/tilecast/apps/cli/internal/config"
	"github.com/tilecast/tilecast/apps/cli/internal/secret"
)

// storedCredential is the keyring envelope for one context.
type storedCredential struct {
	Kind         string    `json:"kind"`
	AccessToken  string    `json:"accessToken,omitempty"`
	RefreshToken string    `json:"refreshToken,omitempty"`
	ExpiresAt    time.Time `json:"expiresAt,omitempty"`
}

const (
	credentialOAuth = "oauth"
	credentialPAT   = "pat"
)

// credentialAccount names the keyring entry for a context.
func credentialAccount(contextName string) string {
	return "context/" + contextName
}

// Resolved is one command's server and credential answer.
type Resolved struct {
	Context    config.Context
	ServerURL  string
	Bearer     string
	Credential storedCredential
	FromStore  bool
	HasStored  bool
}

// Resolver carries the flag, environment, config, and store inputs one
// command resolves.
type Resolver struct {
	ServerFlag  string
	TokenFlag   string
	ContextFlag string
	Store       *config.Store
	Secrets     secret.Store
}

// Resolve applies the precedence chain. requireCredential asks for a
// bearer credential; without it only the server address resolves.
func (r Resolver) Resolve(requireCredential bool) (Resolved, error) {
	contextName := r.ContextFlag
	if contextName == "" {
		contextName = os.Getenv("TILECAST_CONTEXT")
	}
	var current config.Context
	if contextName != "" {
		found, err := r.Store.Get(contextName)
		if err != nil {
			return Resolved{}, err
		}
		current = found
	} else {
		found, err := r.Store.Current()
		if err != nil {
			return Resolved{}, err
		}
		current = found
	}
	serverURL := r.ServerFlag
	if serverURL == "" {
		serverURL = os.Getenv("TILECAST_URL")
	}
	if serverURL == "" {
		serverURL = current.ServerURL
	}
	if serverURL == "" {
		return Resolved{}, errors.New("no server address; pass --server, set TILECAST_URL, or log in first")
	}
	resolved := Resolved{Context: current, ServerURL: serverURL}
	if !requireCredential {
		return resolved, nil
	}
	if r.TokenFlag != "" {
		resolved.Bearer = strings.TrimSpace(r.TokenFlag)
		return resolved, nil
	}
	if env := strings.TrimSpace(os.Getenv("TILECAST_TOKEN")); env != "" {
		resolved.Bearer = env
		return resolved, nil
	}
	raw, err := r.Secrets.Get(credentialAccount(current.Name))
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return Resolved{}, fmt.Errorf("no credential for context %q; run \"tilecast auth login\" or set TILECAST_TOKEN", current.Name)
		}
		return Resolved{}, unavailableStoreError(err)
	}
	var stored storedCredential
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		return Resolved{}, fmt.Errorf("stored credential for context %q is not readable; run \"tilecast auth login\" again", current.Name)
	}
	resolved.Credential = stored
	resolved.FromStore = true
	resolved.HasStored = true
	switch stored.Kind {
	case credentialPAT:
		if stored.AccessToken == "" {
			return Resolved{}, fmt.Errorf("stored credential for context %q is empty; run \"tilecast auth login\" again", current.Name)
		}
		resolved.Bearer = stored.AccessToken
	case credentialOAuth:
		tokens := authflow.Tokens{AccessToken: stored.AccessToken, RefreshToken: stored.RefreshToken, ExpiresAt: stored.ExpiresAt}
		if tokens.Expired() {
			rotated, err := authflow.Rotate(context.Background(), serverURL, stored.RefreshToken)
			if err != nil {
				return Resolved{}, fmt.Errorf("stored credential for context %q expired and rotation failed; run \"tilecast auth login\" again: %v", current.Name, err)
			}
			stored = storedCredential{Kind: credentialOAuth, AccessToken: rotated.AccessToken, RefreshToken: rotated.RefreshToken, ExpiresAt: rotated.ExpiresAt}
			if err := saveCredential(r.Secrets, current.Name, stored); err != nil {
				return Resolved{}, err
			}
			resolved.Credential = stored
		}
		resolved.Bearer = resolved.Credential.AccessToken
	default:
		return Resolved{}, fmt.Errorf("stored credential for context %q is not readable; run \"tilecast auth login\" again", current.Name)
	}
	return resolved, nil
}

// saveCredential persists one context credential envelope.
func saveCredential(store secret.Store, contextName string, credential storedCredential) error {
	raw, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	if err := store.Set(credentialAccount(contextName), string(raw)); err != nil {
		return unavailableStoreError(err)
	}
	return nil
}

// unavailableStoreError translates a backend failure into the actionable
// message: the store is unavailable, so use TILECAST_TOKEN. It never
// suggests a plaintext file.
func unavailableStoreError(err error) error {
	return fmt.Errorf("OS credential store unavailable (%v); non-interactive use can set TILECAST_URL and TILECAST_TOKEN instead", err)
}
