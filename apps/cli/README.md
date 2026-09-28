# Tilecast remote CLI (`tilecast`)

User guides: [command-line interface](https://tilecast.org/integrations/cli/)
and [MCP](https://tilecast.org/integrations/mcp/).

This module is the remote management CLI for a Tilecast installation. It
talks to Tilecast Server over the supported HTTP API. It is a separate Go
module on purpose: nothing here may import server internals, PostgreSQL
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

## Remote management

- `tilecast auth login <server>` opens the system browser for PKCE approval
  and stores the resulting credential in the OS credential store. Headless
  use can supply a PAT through `--token-stdin` or `TILECAST_TOKEN`.
- `tilecast auth logout|status`, `context list|current|use|rename|remove`,
  `whoami`, and `status` manage identity and server selection.
- `screen list|get|update|disable|enable|revoke` and
  `pairing list|resolve|approve|reject` manage the fleet and enrollment.
- `settings get|set|effective`, `plugin list|get|install|remove`,
  `playlist list|get|publish`, `schedule list|get|create`,
  `token list|create`, and `activity overview|uptime|incidents|compliance`
  cover the current handwritten core command set.
- Installed plugins with `automation.yaml` add commands below
  `tilecast plugin` and MCP tools at runtime. The CLI has no bundled
  plugin identifier table.
- `tilecast mcp [--read-only]` serves semantic tools over MCP stdio.
  Sensitive tools require an explicit confirmation argument. Break-glass
  administration is excluded.

Result data goes to stdout. `--json` prints it as JSON; `screen list
--plain` drops column alignment; `--quiet` suppresses progress and
warnings. Read commands do not prompt.
Mutations that require confirmation refuse a non-TTY unless `--yes` is
supplied. Progress and warnings go to stderr, leaving MCP stdout reserved
for protocol frames.

The CLI uses `packages/api-client` for generated core routes, bearer
headers, request IDs, and envelope/error decoding. Its only raw JSON
dispatch is for plugin automation paths discovered from the installed
plugin's resolved contract. The browser authorization redirect and local
callback listener belong to `internal/authflow`.

Credentials use macOS Keychain, Windows Credential Manager, or Linux
Secret Service. There is no plaintext fallback; the context file stores
server URLs and installation IDs, not credentials. Server identity is
checked before a stored credential is used against a server.
