#!/usr/bin/env node
// Generates the iOS app's Lucide icon assets from Studio, so native
// navigation and native action menus show the same icons as Studio.
//
// Inputs:
//   apps/dashboard/src/navigation/NavigationIcon.tsx  token -> Lucide icon
//   apps/dashboard/src/components/studio/actionIcons.tsx  token -> Lucide icon
//   lucide-react (the version in package-lock.json)  icon geometry
// Outputs:
//   apps/ios/Tilecast/Resources/Assets.xcassets/Lucide/
//   apps/ios/TilecastKit/Sources/TilecastCore/Navigation/NavigationIconImages.gen.swift
//   apps/ios/Tilecast/App/AppIcon.gen.swift
//
// Run with `npm run ios:icons:generate`. `make generated-check` fails when
// the outputs are out of date.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const catalog = join(
  root,
  "apps/ios/Tilecast/Resources/Assets.xcassets/Lucide",
);
const coreOutput = join(
  root,
  "apps/ios/TilecastKit/Sources/TilecastCore/Navigation/NavigationIconImages.gen.swift",
);
const appOutput = join(root, "apps/ios/Tilecast/App/AppIcon.gen.swift");

// Icons for the app's own controls in native navigation. They have no
// Studio token, so they are listed here by Lucide component name.
const appIcons = {
  more: "Ellipsis",
  server: "Server",
  add: "Plus",
  manage: "Settings",
  reload: "RotateCw",
  current: "Check",
};

const require = createRequire(join(root, "apps/dashboard/package.json"));
const lucideRoot = dirname(require.resolve("lucide-react/package.json"));
const lucideVersion = JSON.parse(
  readFileSync(join(lucideRoot, "package.json"), "utf8"),
).version;

// Component name (including aliases such as Home) -> icon file name.
const index = readFileSync(
  join(lucideRoot, "dist/esm/lucide-react.mjs"),
  "utf8",
);
const files = new Map();
for (const match of index.matchAll(
  /export \{([^}]*)\} from '\.\/icons\/([a-z0-9-]+)\.mjs'/g,
)) {
  for (const alias of match[1].matchAll(/default as (\w+)/g))
    files.set(alias[1], match[2]);
}
function iconFile(component) {
  const file = files.get(component);
  if (!file)
    throw new Error(`lucide-react ${lucideVersion} has no icon ${component}`);
  return file;
}

const source = readFileSync(
  join(root, "apps/dashboard/src/navigation/NavigationIcon.tsx"),
  "utf8",
);
const block = source.match(/navigationIcons[^=]*=\s*\{([^}]*)\}/);
const generic = source.match(
  /genericNavigationIcon\s*:\s*LucideIcon\s*=\s*(\w+)/,
);
if (!block || !generic)
  throw new Error(
    "NavigationIcon.tsx no longer has navigationIcons and genericNavigationIcon",
  );
const tokens = [
  ...block[1].matchAll(/^\s*([a-z][a-z0-9-]*)\s*:\s*(\w+)\s*,?\s*$/gm),
].map(([, token, component]) => [token, iconFile(component)]);
if (tokens.length === 0) throw new Error("NavigationIcon.tsx maps no tokens");

// Action menu tokens share the catalog and the images map, so one
// generator covers both vocabularies. An action reuses a navigation
// token's icon by naming it; only new tokens are listed here.
const actionSource = readFileSync(
  join(root, "apps/dashboard/src/components/studio/actionIcons.tsx"),
  "utf8",
);
const actionBlock = actionSource.match(/actionIcons[^=]*=\s*\{([^}]*)\}/);
if (!actionBlock) throw new Error("actionIcons.tsx no longer has actionIcons");
const actionTokens = [
  ...actionBlock[1].matchAll(/^\s*([a-z][a-z0-9-]*)\s*:\s*(\w+)\s*,?\s*$/gm),
].map(([, token, component]) => [token, iconFile(component)]);
if (actionTokens.length === 0)
  throw new Error("actionIcons.tsx maps no tokens");
for (const [token] of actionTokens) {
  if (tokens.some(([known]) => known === token))
    throw new Error(`action token ${token} duplicates a navigation token`);
}
tokens.push(...actionTokens);
const genericFile = iconFile(generic[1]);
const app = Object.entries(appIcons).map(([name, component]) => [
  name,
  iconFile(component),
]);

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
async function svg(file) {
  const module = await import(
    pathToFileURL(join(lucideRoot, `dist/esm/icons/${file}.mjs`)).href
  );
  const node = module.__iconData?.node ?? module.__iconNode;
  if (!Array.isArray(node))
    throw new Error(`cannot read the geometry of ${file}`);
  const children = node
    .map(([tag, attributes]) => {
      const list = Object.entries(attributes)
        .filter(([name]) => name !== "key")
        .map(([name, value]) => ` ${kebab(name)}="${escape(value)}"`)
        .join("");
      return `  <${tag}${list}/>`;
    })
    .join("\n");
  // Lucide's default attributes, with black for currentColor: the asset
  // renders as a template image, so the tint colors it.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n${children}\n</svg>\n`;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
rmSync(catalog, { recursive: true, force: true });
mkdirSync(catalog, { recursive: true });
writeFileSync(
  join(catalog, "Contents.json"),
  json({
    info: { author: "xcode", version: 1 },
    properties: { "provides-namespace": true },
  }),
);
const all = [
  ...new Set([
    ...tokens.map(([, file]) => file),
    genericFile,
    ...app.map(([, file]) => file),
  ]),
].sort();
for (const file of all) {
  const set = join(catalog, `${file}.imageset`);
  mkdirSync(set);
  writeFileSync(join(set, `${file}.svg`), await svg(file));
  writeFileSync(
    join(set, "Contents.json"),
    json({
      images: [{ filename: `${file}.svg`, idiom: "universal" }],
      info: { author: "xcode", version: 1 },
      properties: {
        "preserves-vector-representation": true,
        "template-rendering-intent": "template",
      },
    }),
  );
}

const header = `// Generated by apps/ios/scripts/generate-navigation-icons.mjs from Lucide
// ${lucideVersion}. Do not edit; run \`npm run ios:icons:generate\`.
`;
const asset = (file) => `"Lucide/${file}"`;
writeFileSync(
  coreOutput,
  `${header}
extension NavigationIcon {
    /// The Lucide icon Studio shows for each token, as an asset name in the
    /// app's catalog. From apps/dashboard/src/navigation/NavigationIcon.tsx
    /// and apps/dashboard/src/components/studio/actionIcons.tsx.
    static let images: [String: String] = [
${tokens.map(([token, file]) => `        "${token}": ${asset(file)},`).join("\n")}
    ]

    /// Studio's generic navigation icon.
    public static let generic = ${asset(genericFile)}
}
`,
);
writeFileSync(
  appOutput,
  `${header}
/// Lucide icons for the app's own controls in native navigation.
enum AppIcon {
${app.map(([name, file]) => `    static let ${name} = ${asset(file)}`).join("\n")}
}
`,
);
console.log(
  `Wrote ${all.length} Lucide ${lucideVersion} icons for ${tokens.length - actionTokens.length} navigation and ${actionTokens.length} action tokens.`,
);
