import { execFileSync } from "node:child_process";

// Job execution time excludes queue time. Record cold/warm-cache context
// separately; selection savings and build-cache speed are different claims.
for (const id of process.argv.slice(2)) {
  if (!/^\d+$/.test(id)) throw new Error("Expected a GitHub Actions run ID.");
  const run = JSON.parse(
    execFileSync("gh", ["api", `repos/gbyo/tilecast/actions/runs/${id}`], {
      encoding: "utf8",
    }),
  );
  const { jobs } = JSON.parse(
    execFileSync(
      "gh",
      ["api", `repos/gbyo/tilecast/actions/runs/${id}/jobs?per_page=100`],
      { encoding: "utf8" },
    ),
  );
  const measured = jobs
    .filter(
      (job) =>
        job.conclusion !== "skipped" && job.completed_at && job.started_at,
    )
    .map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      seconds: Math.max(
        0,
        (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000,
      ),
    }));
  console.log(
    JSON.stringify(
      {
        id,
        url: run.html_url,
        sha: run.head_sha,
        conclusion: run.conclusion,
        elapsedSeconds:
          (Date.parse(run.updated_at) - Date.parse(run.created_at)) / 1000,
        runnerSeconds: measured.reduce((total, job) => total + job.seconds, 0),
        jobs: measured,
      },
      null,
      2,
    ),
  );
}
