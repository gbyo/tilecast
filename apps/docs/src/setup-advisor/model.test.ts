import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  QUESTIONS,
  STEPS,
  buildSummary,
  decodeAnswers,
  effectiveAnswers,
  encodeAnswers,
  flow,
  normalizeFacts,
  recommend,
  type Answers,
} from "./model.ts";

const topologyOf = (answers: Answers) => {
  const result = recommend(answers);
  return (result.then ?? result).topology.id;
};
const stepIds = (answers: Answers) =>
  recommend(answers).steps.map((step) => step.id);
const considerationIds = (answers: Answers) =>
  recommend(answers).considerations.map((item) => item.id);

// Enough of github-slugger for plain headings.
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

const base: Answers = { host: "yes", platform: "android" };

test("everything local with no remote access gets the local network plan", () => {
  const answers = {
    ...base,
    players: "same",
    studio: "no",
    network: "flat",
  };
  const result = recommend(answers);
  assert.equal(result.topology.id, "local-network");
  assert.equal(result.rule, "default");
  assert.deepEqual(result.topology.notNeeded.slice(0, 3), [
    "Cloudflare Tunnel",
    "Port forwarding",
    "A public domain name",
  ]);
  assert.deepEqual(stepIds(answers), [
    "choose-server",
    "install-server",
    "local-network",
    "install-android",
    "pair",
    "assign-content",
    "production-readiness",
    "backups",
    "updates",
  ]);
  assert.equal(
    considerationIds(answers).some((id) => id.includes("domain")),
    false,
  );
});

test("a simple local setup asks at most five questions", () => {
  const answers = { ...base, players: "same", studio: "no", network: "flat" };
  assert.equal(flow(answers).path.length, 5);
  assert.equal(flow(answers).complete, true);
});

test("remote Players get Cloudflare Tunnel without asking about the LAN", () => {
  for (const players of ["mixed", "elsewhere"]) {
    const answers = { ...base, players, domain: "yes" };
    assert.equal(topologyOf(answers), "cloudflare-tunnel");
    const asked = flow(answers).path.map((q) => q.id);
    assert.deepEqual(asked, ["players", "domain", "host", "platform"]);
    assert.ok(stepIds(answers).includes("cloudflare-tunnel"));
    assert.ok(considerationIds(answers).includes("access-policy"));
  }
});

test("remote Players override a restricted-network answer", () => {
  const answers = {
    ...base,
    players: "elsewhere",
    domain: "yes",
    network: "vlan",
    networkControl: "no",
  };
  assert.equal(topologyOf(answers), "cloudflare-tunnel");
});

test("Studio from outside alone uses a single tunnel address", () => {
  const answers = {
    ...base,
    players: "same",
    studio: "yes",
    outage: "no",
    network: "flat",
    domain: "yes",
  };
  assert.equal(topologyOf(answers), "cloudflare-tunnel");
});

test("local Players that must survive an outage keep a local address", () => {
  const answers = {
    ...base,
    players: "same",
    studio: "yes",
    outage: "yes",
    network: "flat",
    domain: "yes",
  };
  assert.equal(topologyOf(answers), "local-and-remote-studio");
  assert.ok(stepIds(answers).includes("local-and-remote"));
  assert.ok(considerationIds(answers).includes("dual-address-limits"));
});

test("an unsure outage answer picks the single-address plan", () => {
  const answers = {
    ...base,
    players: "same",
    studio: "yes",
    outage: "unsure",
    network: "flat",
    domain: "yes",
  };
  assert.equal(topologyOf(answers), "cloudflare-tunnel");
});

test("separate VLANs get the restricted network plan", () => {
  const answers = {
    ...base,
    players: "same",
    studio: "no",
    network: "vlan",
    networkControl: "yes",
  };
  const result = recommend(answers);
  assert.equal(result.topology.id, "restricted-network");
  assert.ok(stepIds(answers).includes("network-readiness"));
  assert.equal(stepIds(answers).includes("ask-network-admin"), false);
  assert.ok(
    result.topology.notNeeded.some((item) => item.includes("LAN discovery")),
  );
});

test("guest Wi-Fi warns about client isolation", () => {
  const answers = {
    ...base,
    players: "same",
    studio: "no",
    network: "guest",
    networkControl: "yes",
  };
  assert.equal(topologyOf(answers), "restricted-network");
  assert.ok(considerationIds(answers).includes("isolation"));
});

test("no network access sends the person to their network administrator", () => {
  for (const networkControl of ["no", "limited"]) {
    const answers = {
      ...base,
      players: "same",
      studio: "no",
      network: "vlan",
      networkControl,
    };
    assert.equal(topologyOf(answers), "restricted-network");
    assert.ok(stepIds(answers).includes("ask-network-admin"));
    assert.ok(considerationIds(answers).includes("need-network-admin"));
  }
});

test("a restricted network that also needs Studio from outside adds the tunnel", () => {
  const answers = {
    ...base,
    players: "same",
    studio: "yes",
    outage: "yes",
    network: "vlan",
    networkControl: "yes",
    domain: "yes",
  };
  assert.equal(topologyOf(answers), "restricted-network");
  assert.ok(stepIds(answers).includes("cloudflare-tunnel"));
  assert.ok(considerationIds(answers).includes("access-policy"));
});

test("no always-on computer sends the person to choose a server first", () => {
  const answers = {
    host: "no",
    platform: "android",
    players: "same",
    studio: "no",
    network: "flat",
  };
  const result = recommend(answers);
  assert.equal(result.topology.id, "choose-server");
  assert.deepEqual(
    result.steps.map((step) => step.id),
    ["choose-server"],
  );
  assert.equal(result.then?.topology.id, "local-network");
  assert.equal(
    result.steps.some((step) => step.id === "install-server"),
    false,
  );
});

test("an unsure server answer keeps the plan and adds a warning", () => {
  const answers = {
    players: "same",
    studio: "no",
    network: "flat",
    host: "unsure",
    platform: "android",
  };
  assert.equal(recommend(answers).topology.id, "local-network");
  assert.ok(considerationIds(answers).includes("host-unsure"));
  assert.equal(stepIds(answers)[0], "choose-server");
});

test("unsure answers fall back to a plan that tells the person how to check", () => {
  const answers = {
    players: "unsure",
    studio: "unsure",
    network: "unsure",
    networkControl: "unsure",
    host: "unsure",
    platform: "unsure",
  };
  const result = recommend(answers);
  assert.equal(result.topology.id, "local-network");
  const ids = considerationIds(answers);
  assert.ok(ids.includes("verify-network"));
  assert.ok(ids.includes("host-unsure"));
  assert.ok(ids.includes("player-undecided"));
  assert.ok(stepIds(answers).includes("network-readiness"));
  assert.ok(stepIds(answers).includes("choose-player"));
});

test("not having a domain is called out only where one is needed", () => {
  const remote = { ...base, players: "elsewhere", domain: "no" };
  assert.ok(considerationIds(remote).includes("domain-needed"));
  const unsure = { ...base, players: "elsewhere", domain: "unsure" };
  assert.ok(considerationIds(unsure).includes("domain-unsure"));
  const local = { ...base, players: "same", studio: "no", network: "flat" };
  assert.equal(
    considerationIds(local).some((id) => id.startsWith("domain")),
    false,
  );
});

test("Player platform controls the install steps", () => {
  const local = { host: "yes", players: "same", studio: "no", network: "flat" };
  assert.ok(stepIds({ ...local, platform: "linux" }).includes("install-linux"));
  assert.equal(
    stepIds({ ...local, platform: "linux" }).includes("install-android"),
    false,
  );
  const both = stepIds({ ...local, platform: "both" });
  assert.ok(both.includes("install-android") && both.includes("install-linux"));
  const windows = { ...local, platform: "windows" };
  assert.ok(stepIds(windows).includes("install-windows"));
  assert.ok(!stepIds(windows).includes("install-linux"));
  assert.ok(considerationIds(windows).includes("windows-preview"));
  assert.deepEqual(normalizeFacts(windows).platforms, ["windows"]);
  assert.ok(
    considerationIds({ ...local, platform: "linux" }).includes("edge-preview"),
  );
});

test("Windows preview option survives the shareable URL round trip", () => {
  const answers: Answers = {
    host: "yes",
    players: "same",
    studio: "no",
    network: "flat",
    platform: "windows",
  };
  const encoded = encodeAnswers(answers);
  assert.deepEqual(decodeAnswers(encoded), effectiveAnswers(answers));
  assert.match(buildSummary(answers), /Windows PC \(preview\)/);
});

test("changing an earlier answer changes the final recommendation", () => {
  const answers: Answers = {
    ...base,
    players: "same",
    studio: "no",
    network: "flat",
  };
  assert.equal(topologyOf(answers), "local-network");

  // Some Players move to another site: the later answers no longer count.
  answers.players = "mixed";
  answers.domain = "yes";
  assert.equal(topologyOf(answers), "cloudflare-tunnel");
  assert.equal(effectiveAnswers(answers).network, undefined);

  // Back to one site: the earlier answers return unchanged.
  answers.players = "same";
  assert.equal(topologyOf(answers), "local-network");
  assert.equal(effectiveAnswers(answers).network, "flat");

  // A VLAN answer later in the flow changes the plan again.
  answers.network = "vlan";
  answers.networkControl = "no";
  assert.equal(topologyOf(answers), "restricted-network");
});

test("a skipped question's old answer never affects the result", () => {
  const answers = {
    ...base,
    players: "same",
    studio: "no",
    outage: "yes", // left over from an earlier "yes" for studio
    network: "flat",
  };
  assert.equal(topologyOf(answers), "local-network");
  assert.equal(normalizeFacts(answers).needsLanOutageResilience, "unknown");
});

test("facts describe the answers", () => {
  const facts = normalizeFacts({
    players: "same",
    studio: "no",
    network: "guest",
  });
  assert.equal(facts.allPlayersLocal, "yes");
  assert.equal(facts.hasRemotePlayers, false);
  assert.equal(facts.clientIsolationPossible, true);
  assert.equal(facts.crossesVlans, false);
});

test("the flow stops at the first unanswered question", () => {
  const partial = flow({ players: "same", studio: "yes" });
  assert.equal(partial.complete, false);
  assert.equal(partial.path.at(-1)?.id, "outage");
  assert.equal(flow({}).path.length, 1);
});

test("answers survive a round trip through the URL", () => {
  const answers: Answers = {
    ...base,
    players: "same",
    studio: "no",
    outage: "yes",
    network: "flat",
  };
  const query = encodeAnswers(answers);
  assert.equal(query.includes("outage"), false);
  assert.deepEqual(decodeAnswers(query), effectiveAnswers(answers));
  assert.deepEqual(decodeAnswers("players=nonsense&host=yes"), { host: "yes" });
});

test("the summary has the answers and the topology, and nothing sensitive", () => {
  const summary = buildSummary(
    {
      ...base,
      players: "mixed",
      domain: "yes",
    },
    "https://tilecast.org/setup/?players=mixed",
  );
  assert.match(summary, /^Tilecast setup/);
  assert.match(summary, /Players: Android TV, Google TV, or Fire TV/);
  assert.match(summary, /Player locations: some Players at other sites/);
  assert.match(summary, /Recommended topology: Cloudflare Tunnel/);
  assert.doesNotMatch(summary, /token|password|secret|\b\d+\.\d+\.\d+\.\d+\b/i);
  assert.match(
    buildSummary({
      host: "no",
      players: "same",
      studio: "no",
      network: "flat",
      platform: "linux",
    }),
    /Next step: choose an always-on server first/,
  );
});

test("every question has choices with unique values", () => {
  for (const question of QUESTIONS) {
    const values = question.choices.map((choice) => choice.value);
    assert.equal(new Set(values).size, values.length, question.id);
    assert.ok(values.length >= 2, question.id);
  }
});

// The wizard builds its links at run time, so the site's link checker cannot
// see them. Check each one against the content directory here.
test("every step links to an existing page and heading", () => {
  const docs = fileURLToPath(new URL("../content/docs/", import.meta.url));
  for (const step of Object.values(STEPS)) {
    const [path, anchor] = step.href.split("#");
    assert.ok(path.endsWith("/"), `${step.id} needs a trailing slash`);
    const candidates = [
      `${path.slice(0, -1)}.mdx`,
      `${path.slice(0, -1)}.md`,
      `${path}index.mdx`,
      `${path}index.md`,
    ].map((candidate) => docs + candidate);
    const file = candidates.find((candidate) => existsSync(candidate));
    assert.ok(file, `${step.id}: no page for ${step.href}`);
    if (anchor) {
      const slugs = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /^#{2,6}\s/.test(line))
        .map((line) => slug(line.replace(/^#+\s+/, "")));
      assert.ok(
        slugs.includes(anchor),
        `${step.id}: no heading for #${anchor}`,
      );
    }
  }
});
