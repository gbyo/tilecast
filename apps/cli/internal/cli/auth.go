package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/zalando/go-keyring"

	"github.com/tilecast/tilecast/apps/cli/internal/authflow"
	"github.com/tilecast/tilecast/apps/cli/internal/config"
	"github.com/tilecast/tilecast/apps/cli/internal/serverurl"
)

// openBrowserFunc opens the approval URL. It is a variable so tests can
// stub the browser out; headless runs print the URL and wait regardless.
var openBrowserFunc = openBrowser

func openBrowser(target string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", target).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
	default:
		return exec.Command("xdg-open", target).Start()
	}
}

func newAuthCommand(env *environment) *cobra.Command {
	auth := &cobra.Command{Use: "auth", Short: "Sign in, out, and check sign-in state"}
	auth.AddCommand(newAuthLoginCommand(env), newAuthLogoutCommand(env), newAuthStatusCommand(env))
	return auth
}

func newAuthLoginCommand(env *environment) *cobra.Command {
	var contextName, scopes string
	var tokenStdin, noBrowser bool
	login := &cobra.Command{
		Use:   "login <server>",
		Short: "Sign in to a Tilecast server in the browser",
		Long: `Sign in with the normal Tilecast login in the system browser, approve
this CLI, and keep the resulting credential in the OS credential store.

The server address is normalized and verified first, and the installation
identity is checked before anything secret moves. --token-stdin skips the
browser for headless setups: it reads a personal access token from standard
input instead. A secret is never taken as a command argument.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runAuthLogin(cmd, env, args[0], contextName, scopes, tokenStdin, noBrowser)
		},
	}
	login.Flags().StringVar(&contextName, "context-name", "", "Name for the saved context (defaults to the server host)")
	login.Flags().StringVar(&scopes, "scopes", "read write", "Space-separated OAuth scopes to request (read, write, admin)")
	login.Flags().BoolVar(&tokenStdin, "token-stdin", false, "Read a personal access token from standard input instead of opening the browser")
	login.Flags().BoolVar(&noBrowser, "no-browser", false, "Print the approval URL instead of opening the browser")
	return login
}

func runAuthLogin(cmd *cobra.Command, env *environment, rawServer, contextName, scopes string, tokenStdin, noBrowser bool) error {
	ctx := cmd.Context()
	serverURL, err := serverurl.Normalize(rawServer)
	if err != nil {
		return err
	}
	identity, err := authflow.FetchIdentity(ctx, serverURL)
	if err != nil {
		return err
	}
	if identity.APIVersion != "" && identity.APIVersion != "v1" {
		return fmt.Errorf("unsupported Tilecast API version %q", identity.APIVersion)
	}
	status, err := authflow.FetchStatus(ctx, serverURL, "")
	if err != nil {
		return err
	}
	if status.SetupRequired {
		return fmt.Errorf("this server still needs its one-time setup; finish it in the browser first, then log in")
	}
	if contextName == "" {
		contextName = defaultContextName(serverURL)
	}
	if existing, err := env.config.Get(contextName); err == nil && existing.InstallationID != "" && existing.InstallationID != identity.InstallationID {
		return fmt.Errorf("context %q points at installation %q, but this server reports %q; rename or remove the context first", contextName, existing.InstallationID, identity.InstallationID)
	}
	if tokenStdin {
		return runTokenStdinLogin(cmd, env, serverURL, contextName, identity.OrganizationName)
	}
	if err := env.secrets.Check(); err != nil {
		return fmt.Errorf("cannot keep a credential here: %w", err)
	}
	requested, err := parseScopes(scopes)
	if err != nil {
		return err
	}
	verifier, err := authflow.NewVerifier()
	if err != nil {
		return err
	}
	state, err := authflow.NewState()
	if err != nil {
		return err
	}
	listener, err := authflow.Listen()
	if err != nil {
		return err
	}
	redirectURI := authflow.RedirectURI(listener)
	approvalURL := authflow.AuthorizeURL(serverURL, redirectURI, strings.Join(requested, " "), state, authflow.Challenge(verifier))
	// The callback server starts before the browser opens: a fast
	// approval (or a scripted opener) must never arrive before anyone
	// listens.
	waitCtx, cancel := context.WithTimeout(ctx, authflow.WaitTimeout)
	defer cancel()
	type waiterResult struct {
		code string
		err  error
	}
	waited := make(chan waiterResult, 1)
	go func() {
		code, err := authflow.WaitForCode(waitCtx, listener, state)
		waited <- waiterResult{code: code, err: err}
	}()
	cmd.Printf("Opening the browser to sign in to %s.\nIf nothing opens, visit:\n\n  %s\n\n", serverURL, approvalURL)
	if !noBrowser {
		if err := openBrowserFunc(approvalURL); err != nil {
			cmd.Printf("Could not open the browser (%v); use the URL above.\n", err)
		}
	}
	result := <-waited
	if result.err != nil {
		return result.err
	}
	code := result.code
	tokens, err := authflow.Exchange(ctx, serverURL, code, redirectURI, verifier)
	if err != nil {
		return err
	}
	who, err := authflow.FetchStatus(ctx, serverURL, tokens.AccessToken)
	if err != nil || !who.Authenticated {
		return fmt.Errorf("sign-in did not complete; run \"tilecast auth login\" again")
	}
	if err := saveCredential(env.secrets, contextName, storedCredential{
		Kind: credentialOAuth, AccessToken: tokens.AccessToken,
		RefreshToken: tokens.RefreshToken, ExpiresAt: tokens.ExpiresAt,
	}); err != nil {
		return err
	}
	if err := env.config.Upsert(config.Context{Name: contextName, ServerURL: serverURL, InstallationID: identity.InstallationID}, true); err != nil {
		return err
	}
	cmd.Printf("Signed in to %s (%s) as %s (%s). Context %q is current.\n",
		identity.OrganizationName, serverURL, who.User.Username, who.User.Role, contextName)
	return nil
}

// runTokenStdinLogin stores a personal access token read from standard
// input for headless and CI setups. The token is verified before it is
// kept, and it is never echoed or logged.
func runTokenStdinLogin(cmd *cobra.Command, env *environment, serverURL, contextName, _ string) error {
	ctx := cmd.Context()
	raw, err := io.ReadAll(io.LimitReader(cmd.InOrStdin(), 1<<16))
	if err != nil {
		return fmt.Errorf("read token from standard input: %w", err)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return fmt.Errorf("no token on standard input")
	}
	if !strings.HasPrefix(token, "tcp_") {
		return fmt.Errorf("standard input setup takes a personal access token (tcp_…); OAuth tokens come from the browser flow")
	}
	who, err := authflow.FetchStatus(ctx, serverURL, token)
	if err != nil || !who.Authenticated {
		return fmt.Errorf("the server rejected this token; create a fresh one in Studio and try again")
	}
	if err := env.secrets.Check(); err != nil {
		return fmt.Errorf("cannot keep a credential here: %w", err)
	}
	if err := saveCredential(env.secrets, contextName, storedCredential{Kind: credentialPAT, AccessToken: token}); err != nil {
		return err
	}
	identity, err := authflow.FetchIdentity(ctx, serverURL)
	if err != nil {
		return err
	}
	if err := env.config.Upsert(config.Context{Name: contextName, ServerURL: serverURL, InstallationID: identity.InstallationID}, true); err != nil {
		return err
	}
	cmd.Printf("Token stored for %s (%s) as %s (%s). Context %q is current.\n",
		identity.OrganizationName, serverURL, who.User.Username, who.User.Role, contextName)
	return nil
}

// parseScopes validates the requested OAuth scope list.
func parseScopes(raw string) ([]string, error) {
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		return nil, fmt.Errorf("at least one scope is required (read, write, admin)")
	}
	seen := map[string]bool{}
	for _, scope := range fields {
		if scope != "read" && scope != "write" && scope != "admin" {
			return nil, fmt.Errorf("unknown scope %q (read, write, admin)", scope)
		}
		if seen[scope] {
			return nil, fmt.Errorf("duplicate scope %q", scope)
		}
		seen[scope] = true
	}
	return fields, nil
}

// defaultContextName derives the context name from the server host.
func defaultContextName(serverURL string) string {
	parsed, err := url.Parse(serverURL)
	if err != nil || parsed.Hostname() == "" {
		return "default"
	}
	return parsed.Hostname()
}

func newAuthLogoutCommand(env *environment) *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Forget this context's credential and retire it server-side",
		RunE: func(cmd *cobra.Command, args []string) error {
			resolved, err := env.resolver(cmd).Resolve(false)
			if err != nil {
				return err
			}
			stored, storeErr := readStored(env, resolved.Context.Name)
			if storeErr == nil {
				token := stored.RefreshToken
				if stored.Kind == credentialPAT {
					token = stored.AccessToken
				}
				if token != "" {
					if err := authflow.Revoke(cmd.Context(), resolved.ServerURL, token); err != nil {
						cmd.Printf("Server revocation failed (%v); the local credential is still forgotten.\n", err)
					}
				}
			}
			if err := env.secrets.Delete(credentialAccount(resolved.Context.Name)); err != nil {
				return err
			}
			cmd.Printf("Logged out of context %q (%s).\n", resolved.Context.Name, resolved.ServerURL)
			return nil
		},
	}
}

// readStored decodes the stored envelope, if any.
func readStored(env *environment, contextName string) (storedCredential, error) {
	var stored storedCredential
	raw, err := env.secrets.Get(credentialAccount(contextName))
	if err != nil {
		return stored, err
	}
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		return stored, err
	}
	return stored, nil
}

func newAuthStatusCommand(env *environment) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the current context and whether a credential is kept",
		RunE: func(cmd *cobra.Command, args []string) error {
			resolved, err := env.resolver(cmd).Resolve(false)
			if err != nil {
				return err
			}
			cmd.Printf("Context:\t%s\nServer:\t%s\n", resolved.Context.Name, resolved.ServerURL)
			if resolved.Context.InstallationID != "" {
				cmd.Printf("Installation:\t%s\n", resolved.Context.InstallationID)
			}
			if cmd.Flags().Changed("token") || os.Getenv("TILECAST_TOKEN") != "" {
				cmd.Printf("Credential:\texplicit bearer (not stored)\n")
				return nil
			}
			stored, err := readStored(env, resolved.Context.Name)
			if err != nil {
				if errors.Is(err, keyring.ErrNotFound) {
					cmd.Printf("Credential:\tnone (run \"tilecast auth login\")\n")
					return nil
				}
				return unavailableStoreError(err)
			}
			switch stored.Kind {
			case credentialPAT:
				cmd.Printf("Credential:\tpersonal access token (stored)\n")
			case credentialOAuth:
				if time.Now().After(stored.ExpiresAt) {
					cmd.Printf("Credential:\tOAuth pair (stored, access expired — rotates on next use)\n")
				} else {
					cmd.Printf("Credential:\tOAuth pair (stored, access valid until %s)\n", stored.ExpiresAt.Format(time.RFC3339))
				}
			default:
				cmd.Printf("Credential:\tunreadable (run \"tilecast auth login\" again)\n")
			}
			return nil
		},
	}
}
