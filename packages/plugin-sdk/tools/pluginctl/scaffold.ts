/**
 * `plugins:new`: a first-party plugin that already passes plugins:check and
 * the conformance suites. Everything it creates is inside plugins/<dir>/;
 * the generated registry, CODEOWNERS, and OpenAPI document follow from
 * `plugins:generate`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  conventionalEntrypoints,
  playerContributionProblems,
  pluginCategories,
  pluginIdPattern,
  surfaceSlots,
  surfaceTiers,
} from "../../src/manifest.ts";
import { dirForId } from "./repo.ts";

/** A visual contribution for player.surface@1, from `--surface id:slots:tier`. */
export interface ScaffoldSurface {
  id: string;
  slots: (typeof surfaceSlots)[number][];
  tier: (typeof surfaceTiers)[number];
}

export interface ScaffoldOptions {
  id: string;
  name?: string;
  category: string;
  maintainer: string;
  /** Dashboard API routes and an OpenAPI fragment. */
  api: boolean;
  /** Plugin API version; new plugins use 2. */
  pluginApi?: 1 | 2;
  /** Studio pages. Default true. */
  studio?: boolean;
  /**
   * A Plugin API v2 Player contribution in the Shared Runtime. Omit it for a
   * plugin without Player behavior: it then gets no Player files at all.
   */
  player?: {
    required: string[];
    optional?: string[];
    surfaces?: ScaffoldSurface[];
  };
}

/** Parse `--surface ticker:strip.top,strip.bottom:scheduled`. */
export function parseSurface(value: string): ScaffoldSurface {
  const [id, slots, tier] = value.split(":");
  if (!id || !slots || !tier)
    throw new Error("--surface must be <id>:<slot>[,<slot>...]:<tier>");
  for (const slot of slots.split(","))
    if (!(surfaceSlots as readonly string[]).includes(slot))
      throw new Error(`unknown surface slot ${slot}`);
  if (!(surfaceTiers as readonly string[]).includes(tier))
    throw new Error(`unknown surface tier ${tier}`);
  return {
    id,
    slots: slots.split(",") as ScaffoldSurface["slots"],
    tier: tier as ScaffoldSurface["tier"],
  };
}

function title(id: string): string {
  return id
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function goPackageFor(id: string): string {
  return id.replaceAll("_", "");
}

export function scaffold(root: string, options: ScaffoldOptions): string[] {
  const { id } = options;
  if (!pluginIdPattern.test(id))
    throw new Error("plugin id must be snake_case, for example transit_alerts");
  if (!(pluginCategories as readonly string[]).includes(options.category)) {
    throw new Error(`category must be one of ${pluginCategories.join(", ")}`);
  }
  const dir = dirForId(id);
  const base = join(root, "plugins", dir);
  if (existsSync(base)) throw new Error(`plugins/${dir} already exists`);
  const name = options.name ?? title(id);
  const pkg = goPackageFor(id);
  const files = new Map<string, string>();

  const pluginApi = options.pluginApi ?? 2;
  const studio = options.studio ?? true;
  const player = options.player;
  if (player && pluginApi !== 2)
    throw new Error("a Player contribution needs Plugin API 2");
  const surfaces = player?.surfaces ?? [];
  const playerManifest = player
    ? {
        state: [{ type: id, version: 1 }],
        runtime: {
          entrypoint: conventionalEntrypoints.runtime,
          services: {
            required: player.required,
            optional: player.optional ?? [],
          },
          ...(surfaces.length > 0 ? { surfaces } : {}),
        },
      }
    : undefined;
  const problems = playerContributionProblems(playerManifest);
  if (problems.length > 0) throw new Error(problems.join("; "));

  const manifest: Record<string, unknown> = {
    $schema: "../../packages/plugin-sdk/schema/tilecast-plugin.schema.json",
    apiVersion: pluginApi,
    id,
    definitionVersion: 1,
    name,
    description: `Describe what ${name} does in one sentence.`,
    category: options.category,
    icon: "puzzle",
    maintainers: [options.maintainer],
    instanceNoun: { singular: "instance", plural: "instances" },
    requirements: [],
    uses: [],
    capabilities: {},
    server: { entrypoint: conventionalEntrypoints.server },
    ...(options.api
      ? {
          api: {
            basePaths: [`/plugins/${dir}`],
            openapi: "./api/openapi.yaml",
          },
        }
      : {}),
    ...(studio
      ? {
          studio: {
            route: `/plugins/${dir}`,
            entrypoint: conventionalEntrypoints.studio,
          },
        }
      : {}),
    ...(playerManifest ? { player: playerManifest } : {}),
    docs: {
      pages: [
        { source: "./docs/index.mdx", slug: `operations/plugins/${dir}` },
      ],
    },
  };
  files.set("tilecast.plugin.json", JSON.stringify(manifest, null, 2) + "\n");

  files.set(
    "plugin.go",
    player
      ? `// Package ${pkg} is the ${name} plugin.
package ${pkg}

import (
	"context"
	_ "embed"

	"github.com/google/uuid"
	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

//go:embed tilecast.plugin.json
var manifest []byte

// Plugin is the ${name} server contribution. Implement only the contribution
// interfaces the plugin needs (see packages/plugin-sdk/go/plugin).
type Plugin struct {
	plugin.Bundle
	host plugin.Host
}

func New() plugin.Plugin {
	return &Plugin{Bundle: plugin.NewBundle(manifest, nil)}
}

func (p *Plugin) Init(_ context.Context, host plugin.Host) error {
	p.host = host
	return nil
}

// ProjectPlayerState sends the Player its ${id} state. A Player activates
// the plugin's Player contribution only while it receives state.
func (p *Plugin) ProjectPlayerState(context.Context, uuid.UUID) ([]plugin.PlayerState, error) {
	return []plugin.PlayerState{}, nil
}
`
      : `// Package ${pkg} is the ${name} plugin.
package ${pkg}

import (
	"context"
	_ "embed"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugin"
)

//go:embed tilecast.plugin.json
var manifest []byte

// Plugin is the ${name} server contribution. Implement only the contribution
// interfaces the plugin needs (see packages/plugin-sdk/go/plugin).
type Plugin struct {
	plugin.Bundle
	host plugin.Host
}

func New() plugin.Plugin {
	return &Plugin{Bundle: plugin.NewBundle(manifest, nil)}
}

func (p *Plugin) Init(_ context.Context, host plugin.Host) error {
	p.host = host
	return nil
}
`,
  );

  files.set(
    "plugin_test.go",
    `package ${pkg}

import (
	"testing"

	"github.com/tilecast/tilecast/packages/plugin-sdk/go/plugintest"
)

func TestConformance(t *testing.T) {
	plugintest.Conformance(t, New())
}
`,
  );

  if (studio) {
    files.set(
      "studio/index.tsx",
      `import { Puzzle } from "lucide-react";
import { defineStudioPlugin, PluginPage } from "@tilecast/studio";

function ${pkg.charAt(0).toUpperCase() + pkg.slice(1)}Page() {
  return <PluginPage pluginId="${id}" />;
}

export default defineStudioPlugin({
  id: "${id}",
  icon: Puzzle,
  routes: [{ index: true, element: <${pkg.charAt(0).toUpperCase() + pkg.slice(1)}Page /> }],
});
`,
    );
  }

  if (player) files.set("runtime/index.ts", runtimeModule(id, player));

  files.set(
    "docs/index.mdx",
    `---
title: ${name}
description: Describe what ${name} does for an operator.
---

Explain what ${name} shows or does, who uses it, and how to set it up in
Tilecast Studio. Follow apps/docs/STYLE.md, and link to the engineering
contract instead of restating it.
`,
  );

  if (options.api) {
    files.set(
      "api/openapi.yaml",
      `openapi: 3.1.0
info:
  title: ${name} plugin API
  version: "1"
paths: {}
`,
    );
  }

  const created: string[] = [];
  for (const [path, content] of files) {
    const full = join(base, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    created.push(relative(root, full));
  }
  return created;
}

/**
 * A Plugin API v2 Shared Runtime module that requests exactly the declared
 * services and, when it has visual contributions, opens them.
 */
function runtimeModule(
  id: string,
  player: NonNullable<ScaffoldOptions["player"]>,
): string {
  const list = (values: string[]) =>
    values.map((value) => JSON.stringify(value)).join(", ");
  const surfaces = player.surfaces ?? [];
  const opens = surfaces
    .map(
      (
        surface,
      ) => `    const ${camel(surface.id)} = context.services["player.surface@1"].open(
      ${JSON.stringify(surface.id)},
      (grant) => {
        // Show or hide your elements for grant.shown.
        void grant;
      },
    );
    void ${camel(surface.id)};`,
    )
    .join("\n");
  return `import { definePlayerPlugin } from "@tilecast/plugin-sdk/player";

export default definePlayerPlugin({
  id: ${JSON.stringify(id)},
  services: {
    required: [${list(player.required)}],
    optional: [${list(player.optional ?? [])}],
  },
  activate(context) {
${opens ? `${opens}\n` : ""}    return {
      stateChanged(entries) {
        // React to the plugin's current Player state.
        void entries;
        void context;
      },
    };
  },
});
`;
}

function camel(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}
