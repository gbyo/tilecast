import { readFileSync } from "node:fs";

const { total } = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log("### Studio coverage (diagnostic)\n");
console.log(
  "| Metric | Covered | Total | Percent |\n| --- | ---: | ---: | ---: |",
);
for (const key of ["lines", "statements", "functions", "branches"]) {
  const metric = total[key];
  console.log(
    `| ${key} | ${metric.covered} | ${metric.total} | ${metric.pct}% |`,
  );
}
