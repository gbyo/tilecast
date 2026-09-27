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
- `tilecast status` shows the server identity and the signed-in user.
- `tilecast screen list` and `tilecast screen get <id-or-name>` list and
  inspect the screens visible to the credential. Names resolve only when
  unique; ambiguous names are errors, never guesses. Name resolution
  returns the full record, so management commands prefill from it.
- `tilecast screen update <id-or-name>` replaces screen details.
  Unset flags keep current values (the server requires a complete valid
  row); at least one detail flag is required. `screen disable`,
  `screen enable`, and `screen revoke [--reason]` manage status and the
  device credential. All four confirm on a TTY (`--yes` skips).
- `tilecast pairing list|resolve|approve|reject` runs the enrollment
  ceremony: resolve turns the visible six-character code into a session,
  approve names the screen (`--name`, `--room-name`, `--room-number`,
  `--description` required), reject records an optional reason.
  Approve and reject confirm like the screen mutations.
- `tilecast settings get`, `settings set key=value [...]`, and
  `settings effective <screen>` read and change organization settings.
  `set` keeps the document revision, changes only the requested keys,
  and surfaces a clean retry message on conflict. The server stays
  authoritative: no inheritance or validation lives here.

Output conventions: `--json` renders result data as JSON on stdout,
`--plain` drops table framing, `--quiet` leaves data and errors only,
and `--timeout` bounds server calls (default 30s). Progress and warnings
go to stderr. Read-only commands never prompt, so non-TTY runs are safe;
explicit mutations prompt on a TTY and refuse off-TTY unless `--yes`
is given.

- `tilecast plugin list|get|install|remove` manages the plugin catalog.
  Install and remove are idempotent, confirm on a TTY (`--yes` skips),
  and surface typed server errors (`plugin_not_found`, `plugin_in_use`).
- Installed plugins with an automation mapping contribute their own
  command roots, built at runtime from the server's resolved documents:
  `tilecast countdown-bar instance list`, for example. Nothing about any
  plugin is handwritten here; adding a plugin with an API and an
  `automation.yaml` needs no CLI change. Path parameters fill
  positionally in path order, request bodies travel as `--input` JSON or
  `--file`, `sensitive` and higher risk confirms like install/remove,
  and generic commands always emit JSON. Shell completion covers the
  handwritten tree only.

Further management commands (fleet bulk operations, media uploads,
users, activity) arrive in later control-plane phases.
See `docs/programmable-control-plane.md`.

- `tilecast playlist list|get|publish` covers playlist drafts.
  Publish reads the draft first and carries its revision, so a
  concurrent publish is a clean conflict with a retry hint instead of
  a silent win; already-published drafts report as such. Under
  editorial review the server answers 202 and the CLI keeps the
  submission. Publishing confirms on a TTY (`--yes` skips).
- `tilecast schedule list|get|create` covers schedules. Create takes a
  full JSON document (`--input` or `--file`); the server validates it.
- `tilecast token list|create` manages personal access tokens.
  Creation confirms, validates scopes and lifetimes against the API
  contract before anything travels, and prints the secret exactly
  once with a stderr reminder the server never shows it again.

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
