// Setup Advisor decision model.
//
// The advisor turns answers into facts, facts into a topology, and a topology
// into an ordered list of documentation steps. This file has no DOM and no
// Astro imports so `node --test` can run it directly (see model.test.ts).
//
// Maintaining it:
// - Questions, choices, and help text live in QUESTIONS.
// - How answers become facts lives in normalizeFacts().
// - Which topology a set of facts selects lives in TOPOLOGY_RULES, in priority
//   order. There is no score; the first rule that applies wins.
// - What each topology says and which guides it links to lives in TOPOLOGIES
//   and STEPS. Every STEPS href must be a real page; model.test.ts checks it.

export type QuestionId =
  | "players"
  | "studio"
  | "outage"
  | "network"
  | "networkControl"
  | "domain"
  | "host"
  | "platform";

export type Answers = Partial<Record<QuestionId, string>>;
export type Stage = "Network" | "Server" | "Players";
export type Tri = "yes" | "no" | "unknown";

export interface Choice {
  value: string;
  label: string;
  /** Short wording used in the plain-text summary. */
  summary: string;
}

export interface Question {
  id: QuestionId;
  stage: Stage;
  text: string;
  help?: string;
  /** Summary line label, for example "Remote Studio access". */
  summaryLabel: string;
  choices: Choice[];
  /** Whether to ask, given the answers to earlier questions. */
  when?: (answers: Answers) => boolean;
}

const has = (answers: Answers, id: QuestionId, ...values: string[]) =>
  values.includes(answers[id] ?? "");

export const QUESTIONS: Question[] = [
  {
    id: "players",
    stage: "Network",
    text: "Will Tilecast Server be on the same network as all of your Players?",
    help: "A Player is the app on each display. “Same network” means the same building or site, connected to the same router or Wi-Fi.",
    summaryLabel: "Player locations",
    choices: [
      {
        value: "same",
        label: "Yes",
        summary: "all Players at the same site as the server",
      },
      {
        value: "mixed",
        label: "Some Players will be somewhere else",
        summary: "some Players at other sites",
      },
      {
        value: "elsewhere",
        label: "No",
        summary: "all Players at other sites",
      },
      { value: "unsure", label: "I’m not sure", summary: "not sure" },
    ],
  },
  {
    id: "studio",
    stage: "Network",
    text: "Do you need to manage Tilecast Studio while you are away from that network?",
    help: "Studio is the web app where you add content and approve displays.",
    summaryLabel: "Remote Studio access",
    when: (a) => has(a, "players", "same", "unsure"),
    choices: [
      { value: "yes", label: "Yes", summary: "needed" },
      { value: "no", label: "No", summary: "not needed" },
      { value: "unsure", label: "I’m not sure", summary: "not sure" },
    ],
  },
  {
    id: "outage",
    stage: "Network",
    text: "Should local Players still reach Tilecast Server if the Internet connection goes down?",
    help: "Players keep playing the content they already downloaded either way. This question is about receiving changes, commands, and status while the Internet is down.",
    summaryLabel: "Local Players during an Internet outage",
    when: (a) => has(a, "players", "same", "unsure") && has(a, "studio", "yes"),
    choices: [
      { value: "yes", label: "Yes", summary: "must still reach the server" },
      {
        value: "no",
        label: "Not important",
        summary: "can wait for the Internet to return",
      },
      { value: "unsure", label: "I’m not sure", summary: "not sure" },
    ],
  },
  {
    id: "network",
    stage: "Network",
    text: "How is your network set up?",
    help: "Choose the closest match. A guest network is usually a separate Wi-Fi name that blocks devices from seeing each other.",
    summaryLabel: "Network",
    when: (a) => has(a, "players", "same", "unsure"),
    choices: [
      {
        value: "flat",
        label: "Everything is on one network",
        summary: "one network",
      },
      {
        value: "vlan",
        label: "Players and the server are on separate VLANs or networks",
        summary: "separate VLANs or networks",
      },
      {
        value: "guest",
        label: "Players use guest or isolated Wi-Fi",
        summary: "guest or isolated Wi-Fi",
      },
      { value: "unsure", label: "I’m not sure", summary: "not sure" },
    ],
  },
  {
    id: "networkControl",
    stage: "Network",
    text: "Can you change firewall, router, or network settings?",
    summaryLabel: "Can change network settings",
    when: (a) => has(a, "network", "vlan", "guest", "unsure"),
    choices: [
      { value: "yes", label: "Yes", summary: "yes" },
      {
        value: "limited",
        label: "I have limited access",
        summary: "limited access",
      },
      { value: "no", label: "No", summary: "no" },
      { value: "unsure", label: "I’m not sure", summary: "not sure" },
    ],
  },
  {
    id: "domain",
    stage: "Network",
    text: "Do you have a domain name you can use for Tilecast?",
    help: "A domain name is an address you own or rent, such as signage.example.org. You need one only when Players or staff reach Tilecast over the Internet.",
    summaryLabel: "Domain name available",
    when: (a) =>
      has(a, "players", "mixed", "elsewhere") || has(a, "studio", "yes"),
    choices: [
      { value: "yes", label: "Yes", summary: "yes" },
      { value: "no", label: "No", summary: "no" },
      {
        value: "unsure",
        label: "I’m not sure what this means",
        summary: "not sure",
      },
    ],
  },
  {
    id: "host",
    stage: "Server",
    text: "Do you already have a computer that can stay on whenever your displays need Tilecast?",
    help: "Tilecast Server runs in Docker on a computer you control. Displays depend on it for new content, so it should not sleep or get switched off.",
    summaryLabel: "Server host",
    choices: [
      {
        value: "yes",
        label: "Yes",
        summary: "an always-on Docker-capable computer is available",
      },
      { value: "no", label: "No", summary: "no always-on computer yet" },
      {
        value: "unsure",
        label: "I’m not sure whether mine is suitable",
        summary: "not sure the available computer is suitable",
      },
    ],
  },
  {
    id: "platform",
    stage: "Players",
    text: "What will your displays run?",
    help: "Tilecast Player runs on Android TV, Google TV, Fire TV, and Linux computers. A native Windows Player preview is in preparation. Apple TV is not supported.",
    summaryLabel: "Players",
    choices: [
      {
        value: "android",
        label: "Android TV, Google TV, or Fire TV",
        summary: "Android TV, Google TV, or Fire TV",
      },
      {
        value: "linux",
        label: "A Linux computer",
        summary: "Linux computer",
      },
      {
        value: "both",
        label: "A mix of Android and Linux",
        summary: "Android TV family and Linux",
      },
      {
        value: "windows",
        label: "A Windows 10 or 11 computer (preview in preparation)",
        summary: "Windows PC (preview)",
      },
      {
        value: "unsure",
        label: "Something else, or I haven’t decided",
        summary: "not decided",
      },
    ],
  },
];

export const STAGES: Stage[] = ["Network", "Server", "Players"];

const questionById = (id: QuestionId) =>
  QUESTIONS.find((question) => question.id === id)!;

export function isValidChoice(id: QuestionId, value: string | undefined) {
  return (
    value !== undefined &&
    questionById(id).choices.some((choice) => choice.value === value)
  );
}

export interface Flow {
  /** Questions to ask, in order, up to and including the first unanswered one. */
  path: Question[];
  /** True when every question on the path has a valid answer. */
  complete: boolean;
}

/**
 * The questions that apply to these answers. A question that an earlier answer
 * makes irrelevant is left out, and so is its stored answer, which stays in
 * the caller's state in case the person changes the earlier answer back.
 */
export function flow(answers: Answers): Flow {
  const path: Question[] = [];
  for (const question of QUESTIONS) {
    if (question.when && !question.when(answers)) continue;
    path.push(question);
    if (!isValidChoice(question.id, answers[question.id])) {
      return { path, complete: false };
    }
  }
  return { path, complete: true };
}

/** Only the answers to questions that apply, so skipped answers never count. */
export function effectiveAnswers(answers: Answers): Answers {
  const result: Answers = {};
  for (const question of flow(answers).path) {
    const value = answers[question.id];
    if (isValidChoice(question.id, value)) result[question.id] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Facts

export type NetworkLayout = "flat" | "vlan" | "isolated" | "unknown";
export type NetworkControl = "yes" | "limited" | "no" | "unknown";
export type Platform = "android" | "linux" | "windows";

export interface Facts {
  allPlayersLocal: Tri;
  /** At least one Player is at the server's site. */
  hasLocalPlayers: Tri;
  hasRemotePlayers: boolean;
  needsRemoteStudio: Tri;
  needsLanOutageResilience: Tri;
  hasDomain: Tri;
  networkLayout: NetworkLayout;
  /** Players and server are on different networks. */
  crossesVlans: boolean;
  /** Guest or isolated Wi-Fi may stop a Player from seeing the server. */
  clientIsolationPossible: boolean;
  networkControl: NetworkControl;
  hasAlwaysOnHost: Tri;
  platforms: Platform[];
  platformKnown: boolean;
}

const tri = (value: string | undefined): Tri =>
  value === "yes" ? "yes" : value === "no" ? "no" : "unknown";

export function normalizeFacts(raw: Answers): Facts {
  const a = effectiveAnswers(raw);
  const layout: NetworkLayout =
    a.network === "flat"
      ? "flat"
      : a.network === "vlan"
        ? "vlan"
        : a.network === "guest"
          ? "isolated"
          : "unknown";
  const platforms: Platform[] =
    a.platform === "android"
      ? ["android"]
      : a.platform === "linux"
        ? ["linux"]
        : a.platform === "both"
          ? ["android", "linux"]
          : a.platform === "windows"
            ? ["windows"]
            : [];
  return {
    allPlayersLocal:
      a.players === "same" ? "yes" : a.players === "unsure" ? "unknown" : "no",
    hasLocalPlayers:
      a.players === "same" || a.players === "mixed"
        ? "yes"
        : a.players === "unsure"
          ? "unknown"
          : "no",
    hasRemotePlayers: a.players === "mixed" || a.players === "elsewhere",
    needsRemoteStudio: tri(a.studio),
    needsLanOutageResilience: tri(a.outage),
    hasDomain: tri(a.domain),
    networkLayout: layout,
    crossesVlans: layout === "vlan",
    clientIsolationPossible: layout === "isolated",
    networkControl:
      a.networkControl === "yes" ||
      a.networkControl === "limited" ||
      a.networkControl === "no"
        ? a.networkControl
        : "unknown",
    hasAlwaysOnHost: tri(a.host),
    platforms,
    platformKnown: platforms.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Steps: the canonical articles every path links to

/** Site-relative page path with a trailing slash, and an optional anchor. */
export interface Step {
  id: string;
  title: string;
  summary: string;
  href: string;
}

export const STEPS = {
  "choose-server": {
    id: "choose-server",
    title: "Choose where to run Tilecast Server",
    summary:
      "Pick a computer that stays on, has Docker, and has room for your media.",
    href: "setup/choose-a-server/",
  },
  "install-server": {
    id: "install-server",
    title: "Install Tilecast Server",
    summary:
      "Copy the environment file, set a database password, and start the containers.",
    href: "installation/",
  },
  "local-network": {
    id: "local-network",
    title: "Set up Tilecast on a local network",
    summary:
      "Choose a stable local address, set it as the public URL, and open the port to your local network only.",
    href: "setup/local-network/",
  },
  "cloudflare-tunnel": {
    id: "cloudflare-tunnel",
    title: "Set up Tilecast with Cloudflare Tunnel",
    summary:
      "Create the tunnel, point it at the server, set the public URL, and start the tunnel profile.",
    href: "setup/cloudflare-tunnel/",
  },
  "local-and-remote": {
    id: "local-and-remote",
    title: "Use a local address for Players and a hostname for Studio",
    summary:
      "Keep local Players on the local network while staff open Studio through the tunnel hostname.",
    href: "setup/local-players-remote-studio/",
  },
  "network-readiness": {
    id: "network-readiness",
    title: "Check that Players can reach the server",
    summary:
      "Test the route from the Players’ network to the server before you install anything on a display.",
    href: "setup/network-readiness/",
  },
  "ask-network-admin": {
    id: "ask-network-admin",
    title: "Ask your network administrator for access",
    summary:
      "Send them the short list of what a Player needs: a route, DNS, HTTP or HTTPS, and WebSockets.",
    href: "setup/network-readiness/#ask-your-network-administrator",
  },
  "install-android": {
    id: "install-android",
    title: "Install Tilecast Player on Android TV",
    summary:
      "Install the signed APK on Android TV, Google TV, or Fire TV and finish the commissioning checklist.",
    href: "players/install-android/",
  },
  "install-linux": {
    id: "install-linux",
    title: "Install Tilecast Player on Linux",
    summary:
      "Run the installer from your server on a 64-bit x86_64 Linux computer with a graphical session.",
    href: "players/install-linux/",
  },
  "install-windows": {
    id: "install-windows",
    title: "Prepare Tilecast Player on Windows (preview)",
    summary:
      "Check Windows 10/11 requirements, package availability, WebView2 and MSIX certificate trust before testing.",
    href: "players/install-windows/",
  },
  "choose-player": {
    id: "choose-player",
    title: "Choose a Player for your display",
    summary:
      "Compare Android, Linux, and the Windows preview before buying or assigning hardware.",
    href: "players/capabilities/",
  },
  pair: {
    id: "pair",
    title: "Pair your first display",
    summary:
      "Enter the server address on the Player, then approve its code in Studio.",
    href: "players/pair-a-display/",
  },
  "assign-content": {
    id: "assign-content",
    title: "Put content on the screen",
    summary:
      "A new screen has nothing to play until you assign a playlist or Layout.",
    href: "studio/",
  },
  "production-readiness": {
    id: "production-readiness",
    title: "Verify before you leave the screens unattended",
    summary:
      "Test a reboot, a server restart, and an outage, then work through the readiness checklist.",
    href: "setup/production-readiness/",
  },
  backups: {
    id: "backups",
    title: "Set up backups",
    summary: "Schedule backups and keep a copy off the server.",
    href: "administration/backups/",
  },
  updates: {
    id: "updates",
    title: "Learn how updates work",
    summary:
      "Server and Player updates are separate. Decide how you will apply each one.",
    href: "administration/server-updates/",
  },
} as const satisfies Record<string, Step>;

export type StepId = keyof typeof STEPS;

// ---------------------------------------------------------------------------
// Topologies

export type TopologyId =
  | "local-network"
  | "cloudflare-tunnel"
  | "local-and-remote-studio"
  | "restricted-network"
  | "choose-server";

export interface Route {
  label: string;
  nodes: string[];
}

export interface Consideration {
  id: string;
  tone: "note" | "caution";
  text: string;
}

export interface TopologyDefinition {
  id: TopologyId;
  title: string;
  summary: string;
  recommended: string[];
  notNeeded: string[];
  routes: Route[];
  /** Text alternative for the diagram. */
  routesText: string;
}

export const TOPOLOGIES: Record<TopologyId, TopologyDefinition> = {
  "local-network": {
    id: "local-network",
    title: "Local network",
    summary:
      "Your Tilecast Server and Players are at the same site, so the setup with the fewest moving parts is to connect them directly over your local network. Nothing has to be reachable from the Internet.",
    recommended: [
      "Tilecast Server on a computer at your site",
      "A fixed local address or a .local hostname for that computer",
      "Players connecting straight to the server over the local network",
    ],
    notNeeded: ["Cloudflare Tunnel", "Port forwarding", "A public domain name"],
    routes: [
      {
        label: "Players",
        nodes: ["Player", "Local network", "Tilecast Server"],
      },
    ],
    routesText:
      "Each Player connects through your local network directly to Tilecast Server. Staff open Studio from the same network.",
  },
  "cloudflare-tunnel": {
    id: "cloudflare-tunnel",
    title: "Cloudflare Tunnel",
    summary:
      "Some Players, or the people who manage Tilecast, are away from the server. They need an address they can reach over the Internet. Tilecast’s optional Cloudflare Tunnel profile gives the server an HTTPS hostname without opening a port on your router.",
    recommended: [
      "Tilecast Server on a computer that stays on, at your site or hosted elsewhere",
      "An HTTPS hostname such as signage.example.org",
      "Tilecast’s optional Cloudflare Tunnel Compose profile",
      "TILECAST_PUBLIC_URL set to that hostname, with TILECAST_COOKIE_SECURE=true",
    ],
    notNeeded: [
      "Port forwarding or an open inbound firewall port",
      "A public IP address for the server",
      "LAN discovery. You type the hostname on each Player.",
    ],
    routes: [
      {
        label: "Players and Studio",
        nodes: [
          "Player or browser",
          "Internet (HTTPS)",
          "Cloudflare",
          "Tunnel, started by the server",
          "Tilecast Server",
        ],
      },
    ],
    routesText:
      "Each Player and each browser connects over the Internet with HTTPS to Cloudflare. The tunnel program on the server host keeps an outbound connection open to Cloudflare and passes the traffic to Tilecast Server.",
  },
  "local-and-remote-studio": {
    id: "local-and-remote-studio",
    title: "Local Players with remote Studio",
    summary:
      "Your Players are at the server’s site and should keep reaching it without the Internet, but staff also need Studio from outside. Run Tilecast on your local network for the Players, and add a Cloudflare Tunnel hostname for Studio. Tilecast has no setting for two addresses, so this setup has limits that the guide explains.",
    recommended: [
      "Tilecast Server on a computer at your site",
      "A fixed local address that you type into each Player",
      "A Cloudflare Tunnel hostname for staff who open Studio from outside",
      "TILECAST_PUBLIC_URL set to the HTTPS hostname, with TILECAST_COOKIE_SECURE=true",
    ],
    notNeeded: [
      "Port forwarding or an open inbound firewall port",
      "Sending local Player traffic through the Internet",
    ],
    routes: [
      {
        label: "Players",
        nodes: ["Player", "Local network", "Tilecast Server"],
      },
      {
        label: "Staff in Studio",
        nodes: [
          "Browser",
          "Internet (HTTPS)",
          "Cloudflare",
          "Tunnel, started by the server",
          "Tilecast Server",
        ],
      },
    ],
    routesText:
      "Players connect through your local network directly to Tilecast Server. Staff outside the site open Studio over the Internet with HTTPS to Cloudflare, and the tunnel program on the server host passes that traffic to the same server.",
  },
  "restricted-network": {
    id: "restricted-network",
    title: "Restricted network",
    summary:
      "Tilecast needs one thing from your network: each Player must be able to reach the server. VLANs, guest Wi-Fi, and client isolation often block that. Tilecast does not bridge networks or work around isolation, so the first job is to get that route opened.",
    recommended: [
      "A network route from the Players’ network to the server",
      "Manual server entry on each Player",
      "A connectivity test before you install anything on a display",
    ],
    notNeeded: [
      "LAN discovery (mDNS). It rarely crosses a VLAN or guest network, and Tilecast works without it.",
      "Cloudflare Tunnel, unless you also need Studio from outside",
    ],
    routes: [
      {
        label: "Players",
        nodes: [
          "Player",
          "Players’ network",
          "Firewall or router rule",
          "Tilecast Server",
        ],
      },
    ],
    routesText:
      "Each Player connects through its own network, then through a firewall or router rule that allows the connection, to Tilecast Server on the server’s network.",
  },
  "choose-server": {
    id: "choose-server",
    title: "Choose a server first",
    summary:
      "Tilecast Server needs a computer that runs Docker and stays on while your displays need new content. Settle that first, then come back to the setup that fits your network.",
    recommended: [
      "A computer or virtual machine with Docker Engine and Docker Compose v2",
      "A location that stays powered and connected",
      "Enough disk space for your media and backups",
    ],
    notNeeded: ["Any other decision until a server is chosen"],
    routes: [],
    routesText: "",
  },
};

// ---------------------------------------------------------------------------
// Rules: facts to topology. First match wins. No scoring.

export interface TopologyRule {
  id: string;
  topology: TopologyId;
  applies: (facts: Facts) => boolean;
}

export const TOPOLOGY_RULES: TopologyRule[] = [
  {
    // Players away from the server need an address reachable from outside.
    id: "remote-players",
    topology: "cloudflare-tunnel",
    applies: (f) => f.hasRemotePlayers,
  },
  {
    // The route from Player to server is the open question; solve it first.
    id: "restricted-network",
    topology: "restricted-network",
    applies: (f) => f.crossesVlans || f.clientIsolationPossible,
  },
  {
    // Local Players that must not depend on the Internet, plus remote Studio.
    id: "local-players-remote-studio",
    topology: "local-and-remote-studio",
    applies: (f) =>
      f.needsRemoteStudio === "yes" && f.needsLanOutageResilience === "yes",
  },
  {
    id: "remote-studio",
    topology: "cloudflare-tunnel",
    applies: (f) => f.needsRemoteStudio === "yes",
  },
  {
    id: "default",
    topology: "local-network",
    applies: () => true,
  },
];

export function selectTopology(facts: Facts): TopologyRule {
  return TOPOLOGY_RULES.find((rule) => rule.applies(facts))!;
}

// ---------------------------------------------------------------------------
// Steps per topology

function playerSteps(facts: Facts): StepId[] {
  if (!facts.platformKnown) return ["choose-player"];
  return facts.platforms.map((p) =>
    p === "android"
      ? "install-android"
      : p === "windows"
        ? "install-windows"
        : "install-linux",
  );
}

function stepIds(topology: TopologyId, facts: Facts): StepId[] {
  const noAdminAccess =
    facts.networkControl === "no" || facts.networkControl === "limited";
  const tail: StepId[] = [
    ...playerSteps(facts),
    "pair",
    "assign-content",
    "production-readiness",
    "backups",
    "updates",
  ];
  switch (topology) {
    case "local-network":
      return [
        "choose-server",
        "install-server",
        "local-network",
        ...(facts.networkLayout === "unknown"
          ? (["network-readiness"] as StepId[])
          : []),
        ...tail,
      ];
    case "cloudflare-tunnel":
      return ["choose-server", "install-server", "cloudflare-tunnel", ...tail];
    case "local-and-remote-studio":
      return [
        "choose-server",
        "install-server",
        "local-network",
        "cloudflare-tunnel",
        "local-and-remote",
        ...tail,
      ];
    case "restricted-network":
      return [
        "choose-server",
        noAdminAccess ? "ask-network-admin" : "network-readiness",
        "install-server",
        "local-network",
        ...(facts.needsRemoteStudio === "yes"
          ? (["cloudflare-tunnel", "local-and-remote"] as StepId[])
          : []),
        ...tail,
      ];
    case "choose-server":
      return ["choose-server"];
  }
}

// ---------------------------------------------------------------------------
// Considerations: warnings that depend on the facts

function considerations(topology: TopologyId, f: Facts): Consideration[] {
  const items: Consideration[] = [];
  const uses = (...ids: TopologyId[]) => ids.includes(topology);

  if (f.hasAlwaysOnHost === "unknown" && topology !== "choose-server") {
    items.push({
      id: "host-unsure",
      tone: "note",
      text: "You were not sure your computer is suitable. Read the server guide first and check it against the list before you install.",
    });
  }
  const tunnel =
    uses("cloudflare-tunnel", "local-and-remote-studio") ||
    (topology === "restricted-network" && f.needsRemoteStudio === "yes");
  if (tunnel) {
    if (f.hasDomain === "no") {
      items.push({
        id: "domain-needed",
        tone: "caution",
        text: "Cloudflare Tunnel needs a domain name that you add to Cloudflare. Get one before you start the tunnel guide. Without one, a public HTTPS address is not available, and Players outside your network cannot connect.",
      });
    } else if (f.hasDomain === "unknown") {
      items.push({
        id: "domain-unsure",
        tone: "note",
        text: "A domain name is an address you own, such as signage.example.org. The Cloudflare Tunnel guide shows how to check whether you have one. If you do not, you need to get one first.",
      });
    }
    items.push({
      id: "access-policy",
      tone: "caution",
      text: "Do not put a Cloudflare Access login policy in front of the hostname that Players use. Players sign in with their own credential and cannot complete an Access login.",
    });
  }
  if (uses("cloudflare-tunnel")) {
    items.push({
      id: "tunnel-optional",
      tone: "note",
      text: "Cloudflare is a convenience, not a requirement. Any reverse proxy that serves HTTPS and forwards WebSockets also works.",
    });
    items.push({
      id: "internet-outage",
      tone: "note",
      text: "If the Internet connection at the server site goes down, Players keep playing content they already downloaded, but they cannot receive changes until it returns.",
    });
    if (f.needsRemoteStudio === "unknown" && !f.hasRemotePlayers) {
      items.push({
        id: "studio-unsure",
        tone: "note",
        text: "You were not sure you need Studio from outside. This setup includes it, and you can still skip the tunnel if you decide you do not.",
      });
    }
  }
  if (
    uses("cloudflare-tunnel") &&
    f.hasLocalPlayers === "yes" &&
    f.hasRemotePlayers
  ) {
    items.push({
      id: "mixed-sites",
      tone: "note",
      text: "Players at the same site as the server can connect to the server’s local address instead, so they do not depend on the Internet. See the guide for local Players with remote Studio.",
    });
  }
  if (uses("local-and-remote-studio")) {
    items.push({
      id: "dual-address-limits",
      tone: "caution",
      text: "Tilecast has no dedicated setting for two addresses. The server accepts a Player on any address that reaches it, but its public URL names only one. LAN discovery advertises that public URL, and the Linux installer writes it into the Player. The guide lists each effect.",
    });
  }
  if (uses("restricted-network")) {
    items.push({
      id: "no-bridging",
      tone: "note",
      text: "Tilecast does not bridge VLANs, relay multicast, or turn off client isolation. Someone with control of the network has to allow the connection.",
    });
    if (f.networkControl === "no" || f.networkControl === "limited") {
      items.push({
        id: "need-network-admin",
        tone: "caution",
        text:
          f.networkControl === "no"
            ? "You cannot change network settings, so you will need your network administrator. The guide has a short message you can send them."
            : "With limited access you may be able to do some of this yourself, but a firewall or VLAN rule usually needs your network administrator. The guide has a short message you can send them.",
      });
    }
    if (f.clientIsolationPossible) {
      items.push({
        id: "isolation",
        tone: "caution",
        text: "Guest and isolated Wi-Fi often stops devices from reaching anything on your own network. Move the Players to a network that can reach the server, or ask for an exception.",
      });
    }
  }
  if (
    uses("local-network") &&
    (f.allPlayersLocal === "unknown" || f.networkLayout === "unknown")
  ) {
    items.push({
      id: "verify-network",
      tone: "note",
      text: "You were not sure about parts of your network. This plan assumes every Player can reach the server. Test that early with the network guide, and switch to the restricted-network or Cloudflare Tunnel plan if it fails.",
    });
  }
  if (uses("local-network") && f.needsRemoteStudio === "unknown") {
    items.push({
      id: "remote-later",
      tone: "note",
      text: "If you later need Studio from outside, the Cloudflare Tunnel guide adds that without port forwarding.",
    });
  }
  if (f.platforms.includes("windows")) {
    items.push({
      id: "windows-preview",
      tone: "caution",
      text: "Windows Player packages are not published yet, and x64 and ARM64 physical qualification is still in progress. Follow the Windows guide for preview availability and do not use it for unattended production screens.",
    });
  }
  if (f.platforms.includes("linux")) {
    items.push({
      id: "edge-preview",
      tone: "note",
      text: "This plan uses the current Linux Player. Tilecast Edge, its replacement, is a preview and not yet qualified for production hardware.",
    });
  }
  if (!f.platformKnown && topology !== "choose-server") {
    items.push({
      id: "player-undecided",
      tone: "note",
      text: "Pick a Player platform before you buy displays. Android TV, Google TV, Fire TV, and Linux are documented production setup paths. Windows preview is being prepared; Apple TV is not supported.",
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Recommendation

export interface Recommendation {
  topology: TopologyDefinition;
  /** Name of the rule that chose the topology. */
  rule: string;
  steps: Step[];
  considerations: Consideration[];
  /** When no server exists yet, the plan to follow after getting one. */
  then?: Recommendation;
}

function describe(
  topology: TopologyId,
  rule: string,
  facts: Facts,
): Recommendation {
  return {
    topology: TOPOLOGIES[topology],
    rule,
    steps: stepIds(topology, facts).map((id) => STEPS[id]),
    considerations: considerations(topology, facts),
  };
}

export function recommend(answers: Answers): Recommendation {
  const facts = normalizeFacts(answers);
  const rule = selectTopology(facts);
  const plan = describe(rule.topology, rule.id, facts);
  if (facts.hasAlwaysOnHost === "no") {
    return {
      ...describe("choose-server", "no-server", facts),
      then: plan,
    };
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Shareable state and plain-text summary

export function encodeAnswers(answers: Answers): string {
  const params = new URLSearchParams();
  for (const [id, value] of Object.entries(effectiveAnswers(answers))) {
    params.set(id, value!);
  }
  return params.toString();
}

export function decodeAnswers(search: string): Answers {
  const params = new URLSearchParams(search);
  const answers: Answers = {};
  for (const question of QUESTIONS) {
    const value = params.get(question.id) ?? undefined;
    if (isValidChoice(question.id, value)) answers[question.id] = value;
  }
  return answers;
}

/**
 * A plain-text description for a support request. It holds only the answers
 * and the recommendation: no addresses, hostnames, or credentials.
 */
export function buildSummary(answers: Answers, link?: string): string {
  const effective = effectiveAnswers(answers);
  const recommendation = recommend(answers);
  const lines = ["Tilecast setup", ""];
  for (const question of flow(effective).path) {
    const choice = question.choices.find(
      (item) => item.value === effective[question.id],
    );
    if (choice) lines.push(`- ${question.summaryLabel}: ${choice.summary}`);
  }
  const plan = recommendation.then ?? recommendation;
  lines.push(`- Recommended topology: ${plan.topology.title}`);
  if (recommendation.then) {
    lines.push("- Next step: choose an always-on server first");
  }
  if (link) lines.push("", link);
  return lines.join("\n");
}
