// A static file server for the built Widget Storybook, for the visual suite.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../storybook-static/", import.meta.url));
const port = Number(process.env.PORT ?? 6116);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

createServer((request, response) => {
  const path = normalize(
    decodeURIComponent(new URL(request.url, "http://x").pathname),
  );
  let file = join(root, path);
  if (!file.startsWith(root)) return response.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory())
    file = join(file, "index.html");
  if (!existsSync(file)) return response.writeHead(404).end();
  response.writeHead(200, {
    "content-type": types[extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
}).listen(port);
