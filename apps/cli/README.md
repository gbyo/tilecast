# Tilecast remote CLI (`tilecast`)

This module is the remote management CLI for a Tilecast installation. It
talks to Tilecast Server over the supported HTTP API. It is a separate Go
module on purpose: nothing here may import Server internals, PostgreSQL
code, or plugin implementation packages. The boundary test in
`internal/cli` fails the build if that dependency ever appears.

Local server administration is out of scope. `serve`, `backup`, `restore`,
and `mfa reset` belong to the `tilecast-server` utility in
`apps/server/cmd/tilecast-server`, which runs on the server host with
direct database access.

## Current commands

- `tilecast version` prints the CLI version (release builds inject version,
  commit, and date with `-ldflags`).
- `tilecast help` prints command help (built in).
- `tilecast completion [bash|zsh|fish|powershell]` prints a shell
  completion script.
- `tilecast auth login <server>` signs in with the normal Tilecast login
  in the system browser (PKCE loopback flow, explicit approval in Studio)
  and keeps the credential in the OS credential store. `--token-stdin`
  reads a personal access token from standard input for headless setups;
  a secret is never taken as a command argument.
- `tilecast auth logout` retires the grant server-side and forgets the
  local credential. `tilecast auth status` shows the current context and
  whether a credential is kept, without touching the network.
- `tilecast context list|current|use|rename|remove` manages saved servers.
- `tilecast whoami` shows who the resolved credential signs in as.

Management commands (screens, settings, plugins, and the rest) arrive in
later control-plane phases. See `docs/programmable-control-plane.md`.

## Authentication and storage

Server addresses are normalized and verified before anything secret moves:
`https` is the default, plain HTTP works only for local and private
addresses, and the installation identity must check out. Precedence is
explicit flag (`--server`, `--token`, `--context`), then environment
(`TILECAST_URL`, `TILECAST_TOKEN`, `TILECAST_CONTEXT`), then the current
context.

Credentials live only in the OS-native store (macOS Keychain, Windows
Credential Manager, Linux Secret Service via `zalando/go-keyring`, a pure-Go
binding with no cgo). There is no plaintext fallback: where no secure store
answers — headless servers, minimal CI images — login fails with guidance
instead of writing the secret to disk, and non-interactive use sets
`TILECAST_URL` plus `TILECAST_TOKEN`. The config file
(`~/.config/tilecast/config.json`, overridable with `TILECAST_CONFIG`)
holds only context names, server URLs, and installation IDs.

OAuth pairs rotate: an expired access token is refreshed and re-stored on
next use. Reusing an already-rotated refresh token revokes the whole grant
server-side, so a second machine racing the same context must log in again.

## Build and test

```sh
cd apps/cli
go vet ./...
go test ./...
go build ./cmd/tilecast
```
