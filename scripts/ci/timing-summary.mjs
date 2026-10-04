import { appendFile, readFile } from "node:fs/promises";

const xmlDecode = (value) =>
  value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => {
    const decoded = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
    };
    return decoded[entity];
  });

const attributes = (source) =>
  Object.fromEntries(
    [...source.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(
      ([, name, , value]) => [name, xmlDecode(value)],
    ),
  );

export function parseJUnit(xml) {
  const files = [];
  const tests = [];
  for (const [, rawAttributes, body] of xml.matchAll(
    /<testsuite\b([^>]*?)>([\s\S]*?)<\/testsuite\s*>/g,
  )) {
    const suite = attributes(rawAttributes);
    const file = suite.name ?? suite.package ?? "(unknown file)";
    const duration = Number(suite.time);
    if (Number.isFinite(duration))
      files.push({ name: file, seconds: duration });
    for (const [, rawTestAttributes] of body.matchAll(
      /<testcase\b([^>]*?)\/?\s*>/g,
    )) {
      const test = attributes(rawTestAttributes);
      const seconds = Number(test.time);
      if (!Number.isFinite(seconds)) continue;
      tests.push({
        file: test.classname ?? file,
        name: test.name ?? "(unnamed test)",
        seconds,
      });
    }
  }
  return { files: sortSlowest(files), tests: sortSlowest(tests) };
}

export function parseGoTestJSON(jsonLines) {
  const packages = new Map();
  const tests = [];
  for (const line of jsonLines.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Number.isFinite(event.Elapsed)) continue;
    if (event.Test) {
      if (["pass", "fail", "skip"].includes(event.Action)) {
        tests.push({
          package: event.Package ?? "(unknown package)",
          name: event.Test,
          seconds: event.Elapsed,
          result: event.Action,
        });
      }
    } else if (["pass", "fail"].includes(event.Action)) {
      packages.set(event.Package ?? "(unknown package)", {
        name: event.Package ?? "(unknown package)",
        seconds: event.Elapsed,
        result: event.Action,
      });
    }
  }
  return {
    packages: sortSlowest([...packages.values()]),
    tests: sortSlowest(tests),
  };
}

function sortSlowest(entries) {
  return entries.sort((left, right) => right.seconds - left.seconds);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ].join("\n");
}

async function addTestTimings(lines, args) {
  if (args.junit) {
    try {
      const report = parseJUnit(await readFile(args.junit, "utf8"));
      if (report.files.length) {
        lines.push("### Slowest Dashboard test files");
        lines.push(
          table(
            ["File", "Duration"],
            report.files
              .slice(0, 5)
              .map((file) => [file.name, formatDuration(file.seconds)]),
          ),
        );
        lines.push("### Slowest Dashboard tests");
        lines.push(
          table(
            ["Test", "Duration"],
            report.tests
              .slice(0, 5)
              .map((test) => [
                `${test.file}: ${test.name}`,
                formatDuration(test.seconds),
              ]),
          ),
        );
      }
    } catch (error) {
      lines.push(`Dashboard test timings unavailable: ${error.message}`);
    }
  }
  if (args.goJson) {
    try {
      const report = parseGoTestJSON(await readFile(args.goJson, "utf8"));
      if (report.packages.length) {
        lines.push("### Slowest Server test packages");
        lines.push(
          table(
            ["Package", "Result", "Duration"],
            report.packages
              .slice(0, 5)
              .map((pkg) => [
                pkg.name,
                pkg.result,
                formatDuration(pkg.seconds),
              ]),
          ),
        );
        lines.push("### Slowest Server tests");
        lines.push(
          table(
            ["Test", "Result", "Duration"],
            report.tests
              .slice(0, 5)
              .map((test) => [
                `${test.package}: ${test.name}`,
                test.result,
                formatDuration(test.seconds),
              ]),
          ),
        );
      }
    } catch (error) {
      lines.push(`Server test timings unavailable: ${error.message}`);
    }
  }
}

async function writeTimingSummary(args) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    `## Validation timing: ${process.env.TILECAST_TIMING_JOB_NAME ?? process.env.GITHUB_JOB ?? "job"}`,
    "",
    "Step durations come from the GitHub Actions job record. Total job time is elapsed time when this summary step runs; it excludes queue time.",
    "",
  ];
  try {
    const repository = process.env.GITHUB_REPOSITORY;
    const runId = process.env.GITHUB_RUN_ID;
    const token = process.env.GH_TOKEN;
    const expectedName = process.env.TILECAST_TIMING_JOB_NAME;
    if (!repository || !runId || !token || !expectedName) {
      throw new Error("GitHub Actions timing metadata is unavailable.");
    }
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=100&filter=latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok)
      throw new Error(`GitHub API returned ${response.status}.`);
    const { jobs = [] } = await response.json();
    const job = jobs.find((candidate) => candidate.name.includes(expectedName));
    if (!job)
      throw new Error(`Job '${expectedName}' was not found in this run.`);
    const now = Date.now();
    const steps = (job.steps ?? []).filter((step) => step.started_at);
    lines.push(
      table(
        ["Step", "Result", "Duration"],
        steps.map((step) => [
          step.name,
          step.conclusion ?? step.status ?? "unknown",
          formatDuration(
            (Date.parse(step.completed_at ?? new Date(now).toISOString()) -
              Date.parse(step.started_at)) /
              1000,
          ),
        ]),
      ),
    );
    const startedAt = Date.parse(job.started_at);
    if (Number.isFinite(startedAt)) {
      lines.push("");
      lines.push(
        `**Job elapsed at summary:** ${formatDuration((now - startedAt) / 1000)}.`,
      );
    }
  } catch (error) {
    lines.push(`Timing metadata unavailable: ${error.message}`);
  }
  await addTestTimings(lines, args);
  await appendFile(summaryPath, `${lines.join("\n")}\n\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--junit") args.junit = argv[++index];
    else if (option === "--go-json") args.goJson = argv[++index];
    else throw new Error(`Unknown option '${option}'.`);
  }
  return args;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  writeTimingSummary(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
