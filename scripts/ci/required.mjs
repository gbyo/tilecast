import { pathToFileURL } from "node:url";

export function validateRequired(needs, selections) {
  if (needs.changes?.result !== "success")
    throw new Error("Changed-area detection did not pass.");
  for (const [job, state] of Object.entries(needs)) {
    if (job === "changes") continue;
    const selected = selections[job];
    if (selected === undefined)
      throw new Error(`No selection contract for ${job}.`);
    if (state.result === "success") continue;
    if (!selected && state.result === "skipped") continue;
    throw new Error(`${job} was ${state.result} (selected=${selected}).`);
  }
  for (const job of Object.keys(selections)) {
    if (!(job in needs))
      throw new Error(`${job} is missing from the aggregate dependencies.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  validateRequired(
    JSON.parse(process.env.NEEDS),
    JSON.parse(process.env.SELECTIONS),
  );
  console.log("Every selected validation job passed.");
}
