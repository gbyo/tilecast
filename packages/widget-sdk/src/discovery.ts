/**
 * Build-time Widget discovery. A host (the Player Runtime, Studio,
 * Storybook) resolves two `import.meta.glob` patterns when it is built and
 * passes the results here:
 *
 *   widgets/<name>/tilecast.widget.json
 *   widgets/<name>/runtime/index.ts
 *
 * Every definition must agree with its manifest. A Widget that does not is
 * left out with a diagnostic instead of being allowed to destabilize a
 * display, and each host's tests fail on any diagnostic, so a mismatch
 * never reaches a release. Nothing central lists Widgets.
 *
 * This module imports no validation library: it runs inside the Player
 * bundle. widgetctl validates manifests fully with ./manifest.ts.
 */
import {
  definitionProblem,
  WidgetRegistry,
  type AnyWidgetDefinition,
} from "./definition.ts";
import type { WidgetManifestInput } from "./manifest.ts";

export interface DiscoveredWidget {
  /** Directory below widgets/. */
  readonly dir: string;
  readonly manifest: WidgetManifestInput;
  readonly definition: AnyWidgetDefinition;
}

export interface WidgetDiscovery {
  readonly widgets: readonly DiscoveredWidget[];
  readonly problems: readonly string[];
  readonly registry: WidgetRegistry;
}

type ManifestModules = Record<string, WidgetManifestInput>;
type RuntimeModules = Record<string, { default?: unknown }>;

function directoryOf(path: string): string {
  const match = /\/widgets\/([^/]+)\//.exec(path);
  if (!match?.[1]) throw new Error(`not a Widget path: ${path}`);
  return match[1];
}

export function discoverWidgets(
  manifests: ManifestModules,
  modules: RuntimeModules,
): WidgetDiscovery {
  const problems: string[] = [];
  const manifestByDir = new Map<string, WidgetManifestInput>();
  for (const [path, manifest] of Object.entries(manifests)) {
    manifestByDir.set(directoryOf(path), manifest);
  }
  const moduleByDir = new Map<string, unknown>();
  for (const [path, module] of Object.entries(modules)) {
    moduleByDir.set(directoryOf(path), module.default);
  }

  const widgets: DiscoveredWidget[] = [];
  const types = new Map<string, string>();
  const tags = new Map<string, string>();
  const dirs = [...new Set([...manifestByDir.keys(), ...moduleByDir.keys()])];
  for (const dir of dirs.sort()) {
    const problem = (message: string) =>
      problems.push(`widgets/${dir}: ${message}`);
    const manifest = manifestByDir.get(dir);
    const definition = moduleByDir.get(dir);
    if (!manifest) {
      problem("has runtime/index.ts but no tilecast.widget.json");
      continue;
    }
    const component = manifest.component;
    if (!component) {
      problem("tilecast.widget.json declares no component");
      continue;
    }
    if (!moduleByDir.has(dir)) {
      problem(`declares ${component.entrypoint} but it does not exist`);
      continue;
    }
    const invalid = definitionProblem(definition);
    if (invalid) {
      problem(invalid);
      continue;
    }
    const typed = definition as AnyWidgetDefinition;
    const mismatch = [
      typed.type !== component.type && `type ${typed.type} ≠ ${component.type}`,
      typed.version !== component.version &&
        `version ${typed.version} ≠ ${component.version}`,
      typed.tagName !== component.tagName &&
        `tag ${typed.tagName} ≠ ${component.tagName}`,
    ].filter(Boolean);
    if (mismatch.length > 0) {
      problem(`definition does not match its manifest: ${mismatch.join("; ")}`);
      continue;
    }
    const typeOwner = types.get(typed.type);
    if (typeOwner) {
      problem(`type ${typed.type} is also declared by widgets/${typeOwner}`);
      continue;
    }
    const tagOwner = tags.get(typed.tagName);
    if (tagOwner) {
      problem(`tag ${typed.tagName} is also used by widgets/${tagOwner}`);
      continue;
    }
    types.set(typed.type, dir);
    tags.set(typed.tagName, dir);
    widgets.push({ dir, manifest, definition: typed });
  }
  const registry = new WidgetRegistry(widgets.map((w) => w.definition));
  return { widgets, problems, registry };
}
