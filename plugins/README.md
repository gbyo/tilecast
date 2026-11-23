# Bundled plugins

Each directory below `plugins/` is one first-party Tilecast plugin. Everything
that is unique to a plugin is in its directory: the manifest, the server code,
the migrations, the API description, the Studio pages, the Player runtime
code, the public documentation, and the tests.

- Read [`docs/plugin-api.md`](../docs/plugin-api.md) for the contract.
- Read [`docs/plugin-read-services.md`](../docs/plugin-read-services.md) before
  a plugin reads the content library or Activity. Declare only the read
  services the plugin needs: `content.read@2` or `activity.read@1`. A
  `background` or `system` read covers the whole installation under that
  declaration. It is not administrator access.
- Read [`docs/plugins.md`](../docs/plugins.md) for the behavior of each plugin.
- Create a plugin with `npm run plugins:new -- <plugin_id>`. Add
  `--plugin-api 3` for host-owned settings and instances, and
  `--no-instances` for a version 3 plugin without instance kinds.
- Bundle a Widget with `npm run widgets:new -- <name> --plugin <plugin_id>`.
- Bundle a declarative Data Source with `npm run data-sources:new -- <name> --adapter <adapter> --plugin <plugin_id>`.
- Run `npm run extensions:check` before you commit.

`registry_gen.go` is generated. Do not edit it. Run
`npm run plugins:generate`.

Anybody can contribute to any plugin. The `maintainers` in a manifest are
stewards for that subject. They are requested for review through the generated
`.github/CODEOWNERS` file when GitHub allows it.
