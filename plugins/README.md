# Bundled plugins

Each directory below `plugins/` is one first-party Tilecast plugin. Everything
that is unique to a plugin is in its directory: the manifest, the server code,
the migrations, the API description, the Studio pages, the Player runtime
code, the public documentation, and the tests.

- Read [`docs/plugin-api.md`](../docs/plugin-api.md) for the contract.
- Read [`docs/plugins.md`](../docs/plugins.md) for the behavior of each plugin.
- Create a plugin with `npm run plugins:new -- <plugin_id>`.
- Run `npm run plugins:check` before you commit.

`registry_gen.go` is generated. Do not edit it. Run
`npm run plugins:generate`.

Anybody can contribute to any plugin. The `maintainers` in a manifest are
stewards for that subject. They are requested for review through the generated
`.github/CODEOWNERS` file when GitHub allows it.
