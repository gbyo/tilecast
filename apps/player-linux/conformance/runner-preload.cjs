// Conformance runner preload: publishes the runner object and the shared
// fixture host into the runtime page before any runtime script runs.
const { ipcRenderer } = require("electron");
const fs = require("node:fs");

const arg = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

window.__tilecastConformanceRunner = Object.freeze({
  fixture: JSON.parse(fs.readFileSync(arg("tc-fixture"), "utf8")),
  snapshot: (name) => ipcRenderer.invoke("conformance-snapshot", name),
  finish: (result) => ipcRenderer.send("conformance-finish", result),
});
// The fixture host is an ordinary script; it is loaded by Node's module
// loader here, so the runtime page's CSP (script-src 'self') is untouched.
require(arg("tc-host-script"));
