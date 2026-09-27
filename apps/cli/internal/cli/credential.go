// Credential resolution for tilecast commands: where the server address
// and the Bearer [REDACTED] come from, in order.
//
// Precedence is explicit flag, then environment, then the current context:
//
//	--server / TILECAST_URL / context serverURL
//	TILECAST_TOKEN / OS credential store for the context
//	--context / TILECAST_CONTEXT / stored current context
//
// A stored credential is a JSON envelope holding either an OAuth token
// pair (rotated when its access token expires) or a personal access
// token. Raw secrets never reach the config file, logs, or process
// arguments; TILECAST_TOKEN and --token-stdin exist so scripts can
// provide one safely. There is deliberately no --token flag: process
// arguments are visible to other users via process inspection and
// persist in shell history.
//
// A stored credential belongs to the context it was saved for. When the
// caller overrides the server address (--server or TILECAST_URL) to a
// different server than the context's saved address, resolution refuses
// to send the stored credential there and asks for an explicit
// TILECAST_TOKEN instead. An explicit Bearer [REDACTED] be used with an
// explicitly supplied server. The saved InstallationID is verified at
// login; per-request identity probing is avoided so normal commands do
// not pay for redundant discovery calls.
//
// Every resolved server URL passes through serverurl.Normalize before an
// authenticated request is sent, so public plaintext HTTP is rejected
// centrally rather than per command.
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
	"github.com/tilecast/tilecast/apps/cli/internal/serverurl"
	apiclient "github.com/tilecast/tilecast/packages/api-client"
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

// rotateTokens trades a refresh token for a fresh pair. It is a variable
// so concurrency tests can stub rotation and count redemptions.
var rotateTokens = authflow.Rotate

// Resolved is one command's server and credential answer.
type Resolved struct {
	Context    config.Context
	ServerURL  string
	Bearer     string
	Credential storedCredential
	FromStore  bool
	HasStored  bool

	// provider supplies the Bearer [REDACTED] request. For explicit
	// credentials it returns a fixed value; for stored OAuth it re-reads
	// the pair and refreshes under the cross-process lock when needed.
	// Transports and long-lived processes must use this, not the frozen
	// Bearer [REDACTED], so a 15-minute access token can rotate mid-process.
	provider CredentialProvider
}

// CredentialProvider returns the current Bearer [REDACTED] one request.
type CredentialProvider func(ctx context.Context) (string, error)

// BearerFunc adapts the provider to the api-client transport shape.
func (r Resolved) BearerFunc() apiclient.BearerFunc {
	if r.provider != nil {
		return apiclient.BearerFunc(r.provider)
	}
	fixed := r.Bearer
	return func(context.Context) (string, error) { return fixed, nil }
}

// Resolver carries the flag, environment, config, and store inputs one
// command resolves.
type Resolver struct {
	ServerFlag  string
	ContextFlag string
	Store       *config.Store
	Secrets     secret.Store
}

// Resolve applies the precedence chain. requireCredential asks for a
// Bearer [REDACTED]; without it only the server address resolves.
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
	rawServer, explicitServer := resolveServerRaw(r.ServerFlag)
	if rawServer == "" {
		rawServer = current.ServerURL
	}
	if strings.TrimSpace(rawServer) == "" {
		return Resolved{}, errors.New("no server address; pass --server, set TILECAST_URL, or log in first")
	}
	serverURL, err := serverurl.Normalize(rawServer)
	if err != nil {
		return Resolved{}, err
	}
	resolved := Resolved{Context: current, ServerURL: serverURL}
	if !requireCredential {
		return resolved, nil
	}
	if env := strings.TrimSpace(os.Getenv("TILECAST_TOKEN")); env != "" {
		resolved.Bearer = env
		fixed := env
		resolved.provider = func(context.Context) (string, error) { return fixed, nil }
		return resolved, nil
	}
	if explicitServer {
		if !serverBelongsToContext(serverURL, current.ServerURL) {
			return Resolved{}, fmt.Errorf("stored credential for context %q belongs to %q; --server/TILECAST_URL points elsewhere, so pass TILECAST_TOKEN explicitly rather than sending that credential to another server", current.Name, current.ServerURL)
		}
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
			rotated, err := refreshLocked(r.Store, r.Secrets, current.Name, serverURL)
			if err != nil {
				return Resolved{}, err
			}
			stored = storedCredential{Kind: credentialOAuth, AccessToken: rotated.AccessToken, RefreshToken: rotated.RefreshToken, ExpiresAt: rotated.ExpiresAt}
			resolved.Credential = stored
		}
		if resolved.Credential.AccessToken == "" {
			return Resolved{}, fmt.Errorf("stored credential for context %q is empty; run \"tilecast auth login\" again", current.Name)
		}
		resolved.Bearer = resolved.Credential.AccessToken
	default:
		return Resolved{}, fmt.Errorf("stored credential for context %q is not readable; run \"tilecast auth login\" again", current.Name)
	}
	resolved.provider = lockedProvider(r.Store, r.Secrets, current.Name, serverURL, resolved.Bearer)
	return resolved, nil
}

// resolveServerRaw applies the server precedence and reports whether the
// address came from an explicit override (--server or TILECAST_URL).
func resolveServerRaw(flag string) (string, bool) {
	if strings.TrimSpace(flag) != "" {
		return strings.TrimSpace(flag), true
	}
	if env := strings.TrimSpace(os.Getenv("TILECAST_URL")); env != "" {
		return env, true
	}
	return "", false
}

// serverBelongsToContext reports whether an explicitly supplied server is
// the context's saved server. Both sides normalize so trailing slashes,
// case, and default ports do not cause false mismatches. An
// un-normalizable saved address never matches: the safe answer is to ask
// for an explicit token.
func serverBelongsToContext(explicitNormalized, savedRaw string) bool {
	if strings.TrimSpace(savedRaw) == "" {
		return false
	}
	savedNormalized, err := serverurl.Normalize(savedRaw)
	if err != nil {
		return false
	}
	return savedNormalized == explicitNormalized
}

// lockedProvider builds the per-request Bearer [REDACTED] Ordinary
// short-lived commands and the long-lived MCP process share this: every
// request re-reads the store and refreshes under the cross-process lock
// when the access token expired, so rotation mid-process keeps working.
// OAuth refresh logic lives here, never in MCP itself.
func lockedProvider(store *config.Store, secrets secret.Store, contextName, serverURL, initial string) CredentialProvider {
	return func(ctx context.Context) (string, error) {
		raw, err := secrets.Get(credentialAccount(contextName))
		if err != nil {
			if errors.Is(err, keyring.ErrNotFound) {
				return "", fmt.Errorf("no credential for context %q; run \"tilecast auth login\" or set TILECAST_TOKEN", contextName)
			}
			return "", unavailableStoreError(err)
		}
		var stored storedCredential
		if err := json.Unmarshal([]byte(raw), &stored); err != nil {
			return "", fmt.Errorf("stored credential for context %q is not readable; run \"tilecast auth login\" again", contextName)
		}
		switch stored.Kind {
		case credentialPAT:
			if stored.AccessToken == "" {
				return "", fmt.Errorf("stored credential for context %q is empty; run \"tilecast auth login\" again", contextName)
			}
			return stored.AccessToken, nil
		case credentialOAuth:
			tokens := authflow.Tokens{AccessToken: stored.AccessToken, RefreshToken: stored.RefreshToken, ExpiresAt: stored.ExpiresAt}
			if !tokens.Expired() {
				if stored.AccessToken == "" {
					return "", fmt.Errorf("stored credential for context %q is empty; run \"tilecast auth login\" again", contextName)
				}
				return stored.AccessToken, nil
			}
			rotated, err := refreshLocked(store, secrets, contextName, serverURL)
			if err != nil {
				return "", err
			}
			return rotated.AccessToken, nil
		default:
			return "", fmt.Errorf("stored credential for context %q is not readable; run \"tilecast auth login\" again", contextName)
		}
	}
}

// refreshLocked rotates an expired OAuth pair under a per-context
// cross-process critical section. Inside the lock it re-reads the store:
// another process may already have refreshed, in which case the fresh
// access token is reused and the same refresh token is never redeemed
// twice. The rotated pair persists before the lock releases. Server-side
// refresh-token reuse detection stays unchanged.
func refreshLocked(store *config.Store, secrets secret.Store, contextName, serverURL string) (authflow.Tokens, error) {
	var result authflow.Tokens
	if err := withRefreshLock(store, contextName, func() error {
		raw, err := secrets.Get(credentialAccount(contextName))
		if err != nil {
			if errors.Is(err, keyring.ErrNotFound) {
				return fmt.Errorf("no credential for context %q; run \"tilecast auth login\" or set TILECAST_TOKEN", contextName)
			}
			return unavailableStoreError(err)
		}
		var stored storedCredential
		if err := json.Unmarshal([]byte(raw), &stored); err != nil {
			return fmt.Errorf("stored credential for context %q is not readable; run \"tilecast auth login\" again", contextName)
		}
		if stored.Kind != credentialOAuth {
			return fmt.Errorf("stored credential for context %q is not readable; run \"tilecast auth login\" again", contextName)
		}
		current := authflow.Tokens{AccessToken: stored.AccessToken, RefreshToken: stored.RefreshToken, ExpiresAt: stored.ExpiresAt}
		if !current.Expired() {
			result = current
			return nil
		}
		rotated, err := rotateTokens(context.Background(), serverURL, stored.RefreshToken)
		if err != nil {
			return fmt.Errorf("stored credential for context %q expired and rotation failed; run \"tilecast auth login\" again: %v", contextName, err)
		}
		next := storedCredential{Kind: credentialOAuth, AccessToken: rotated.AccessToken, RefreshToken: rotated.RefreshToken, ExpiresAt: rotated.ExpiresAt}
		if err := saveCredential(secrets, contextName, next); err != nil {
			return err
		}
		result = rotated
		return nil
	}); err != nil {
		return authflow.Tokens{}, err
	}
	return result, nil
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
