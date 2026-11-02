// Assembles the static setup page in build/. The page takes the Tilecast logo
// from Studio's component and the Geist font from the same package Studio
// uses, so it cannot drift from the Studio brand.
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "build");
const logoSource = join(root, "../dashboard/src/components/TilecastLogo.tsx");

export function logoSvg(source) {
  const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1];
  const paths = source.match(/<path d="[^"]+" \/>/g) ?? [];
  if (viewBox === undefined || paths.length === 0) {
    throw new Error("TilecastLogo.tsx no longer has the expected SVG shape.");
  }
  return [
    `<svg class="brand" viewBox="${viewBox}" fill="currentColor" role="img" aria-label="Tilecast">`,
    ...paths,
    "</svg>",
  ].join("");
}

function build() {
  rmSync(out, { recursive: true, force: true });
  cpSync(join(root, "public"), out, { recursive: true });

  const page = readFileSync(join(out, "index.html"), "utf8");
  const marker = "<!-- tilecast-logo -->";
  if (!page.includes(marker)) throw new Error(`index.html has no ${marker}`);
  writeFileSync(
    join(out, "index.html"),
    page.replace(marker, logoSvg(readFileSync(logoSource, "utf8"))),
  );

  const require = createRequire(import.meta.url);
  const font = dirname(require.resolve("@fontsource-variable/geist/index.css"));
  mkdirSync(join(out, "fonts/files"), { recursive: true });
  copyFileSync(join(font, "index.css"), join(out, "fonts/geist.css"));
  for (const file of readdirSync(join(font, "files"))) {
    if (file.endsWith("-normal.woff2")) {
      copyFileSync(join(font, "files", file), join(out, "fonts/files", file));
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
