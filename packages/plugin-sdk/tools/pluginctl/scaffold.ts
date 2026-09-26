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
  pluginCategories,
  pluginIdPattern,
} from "../../src/manifest.ts";
import { dirForId } from "./repo.ts";

export interface ScaffoldOptions {
  id: string;
  name?: string;
  category: string;
  maintainer: string;
  api: boolean;
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

  const manifest: Record<string, unknown> = {
    $schema: "../../packages/plugin-sdk/schema/tilecast-plugin.schema.json",
    apiVersion: 1,
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
    studio: {
      route: `/plugins/${dir}`,
      entrypoint: conventionalEntrypoints.studio,
    },
    docs: {
      pages: [
        { source: "./docs/index.mdx", slug: `operations/plugins/${dir}` },
      ],
    },
  };
  files.set("tilecast.plugin.json", JSON.stringify(manifest, null, 2) + "\n");

  files.set(
    "plugin.go",
    `// Package ${pkg} is the ${name} plugin.
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
