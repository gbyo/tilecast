# Tilecast remote CLI (`tilecast`)

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

Management commands (login, contexts, status, screens, settings, plugins,
and the generated API client) arrive stacked on this foundation.
