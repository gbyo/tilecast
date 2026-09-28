# Tilecast Go API client

Shared transport client for Tilecast API automation, used by the remote CLI
and the MCP server. It is generated from the composed OpenAPI document, so
it always matches the server's typed contract.

## Layout

- `internal/generated/` — output of oapi-codegen. Never edit by hand;
  reproduce it with `go generate ./...` from this directory (requires
  network access for the pinned tool on first run).
- `client.go` — the handwritten layer: server URL, bearer headers,
  per-request IDs, typed API errors, revision conflicts, pagination
  helpers, bulk idempotency keys, streaming upload/download, and
  version/capability detection. It carries no domain or business logic.

Core CLI and MCP operations route through generated OpenAPI methods.
The generic `Call` method accepts only `/api/v1/plugins/` paths from
runtime-discovered installed-plugin automation documents, whose paths
cannot be generated into this core client ahead of time. Streaming
`Upload` and `Download` helpers remain available for large payloads;
the current CLI and MCP do not use them for a core route. Any future
core streaming operation still needs a supported OpenAPI declaration.

## Regenerating

Change `docs/openapi.yaml` (via `docs/openapi/core.yaml` or a plugin
spec, then `npm run plugins:generate`), then run `go generate ./...`
here and commit the result alongside the spec change. If generation
fails on a path parameter or schema reference, the spec is at fault:
fix the declaration, not the generator output.
