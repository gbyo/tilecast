import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = fileURLToPath(
  new URL("../../../packages/player-runtime/dist/runtime/", import.meta.url),
);
async function list(directory) {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? list(path) : [path];
      }),
    )
  )
    .flat()
    .sort();
}
const runtimeFiles = await list(runtime);
const hash = createHash("sha256");
for (const path of runtimeFiles) {
  hash.update(relative(runtime, path));
  hash.update(await readFile(path));
}
const runtimeVersion = hash.digest("hex").slice(0, 24);
const runtimePath = `/player/runtime/${runtimeVersion}`;
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await build({
  root,
  configFile: false,
  base: "/player/",
  publicDir: false,
  define: {
    __RUNTIME_PATH__: JSON.stringify(runtimePath),
    __HOST_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    modulePreload: false,
  },
});
await cp(runtime, join(root, "dist/runtime", runtimeVersion), {
  recursive: true,
});
await mkdir(join(root, "dist/icons"), { recursive: true });
// PWA icons derive from the existing product logo; no external resource.
const { default: sharp } = await import("sharp");
for (const size of [192, 512]) {
  await sharp(join(runtime, "tilecast-logo-white.svg"))
    .resize(size - 48, size - 48, { fit: "contain" })
    .extend({ top: 24, bottom: 24, left: 24, right: 24, background: "#111827" })
    .png()
    .toFile(join(root, `dist/icons/player-${size}.png`));
}
await writeFile(
  join(root, "dist/manifest.webmanifest"),
  JSON.stringify({
    id: "/player",
    name: "Tilecast Browser Player",
    short_name: "Tilecast Player",
    start_url: "/player/",
    scope: "/player",
    display: "fullscreen",
    background_color: "#111827",
    theme_color: "#111827",
    icons: [192, 512].map((size) => ({
      src: `/player/icons/player-${size}.png`,
      sizes: `${size}x${size}`,
      type: "image/png",
    })),
  }),
);
const shellFiles = [
  "/player/",
  ...(await list(join(root, "dist")))
    .filter((path) => !path.endsWith("index.html"))
    .map(
      (path) =>
        `/player/${relative(join(root, "dist"), path).split("\\").join("/")}`,
    ),
];
const shellHash = createHash("sha256");
for (const path of await list(join(root, "dist")))
  shellHash.update(await readFile(path));
const version = shellHash.digest("hex").slice(0, 24);
await build({
  root,
  configFile: false,
  publicDir: false,
  define: {
    __SHELL_VERSION__: JSON.stringify(version),
    __SHELL_FILES__: JSON.stringify(shellFiles),
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    sourcemap: false,
    lib: {
      entry: join(root, "src/service-worker.ts"),
      formats: ["iife"],
      name: "TilecastPlayerWorker",
      fileName: () => "service-worker.js",
    },
  },
});
await writeFile(
  join(root, "dist/build.json"),
  JSON.stringify({ shell: version, runtime: runtimeVersion }),
);
