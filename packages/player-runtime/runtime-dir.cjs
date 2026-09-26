// Absolute path of the built runtime artifact that hosts serve at
// tilecast://runtime/. Hosts resolve it through this module rather than
// guessing at the package layout.
module.exports = require("node:path").join(__dirname, "dist", "runtime");
