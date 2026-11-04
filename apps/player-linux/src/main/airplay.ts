/**
 * Linux AirPlay process manager.
 *
 * UxPlay and the group GStreamer receiver are external processes on purpose.
 * The player runtime decides when an external presentation owns the screen;
 * this module owns the Linux process lifecycle, fixed ports, decoder choice,
 * and local expiry. No shell is involved: every executable is started with
 * spawn(binary, args), and all values that came from the server are validated
 * before they are placed in a process argument.
 */

import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { logger } from "../core/log";
import {
  describeExecutableResolution,
  resolveLinuxExecutable,
  type ExecutableResolution,
  type ExecutableResolver,
} from "../core/executable";
import {
  AIRPLAY_PORTS,
  isAirplayDeviceId,
  isAirplayPin,
  isAirplayProfile,
  isExpired,
  profileDimensions,
  type AirplayCapabilities,
  type AirplayDestination,
  type AirplayTransport,
  type ExternalPresentationConfig,
  type ExternalPresentationProcessState,
  type ExternalPresentationRole,
  type ExternalPresentationStatus,
} from "../core/external-presentation";
import type { StateStore } from "../core/storage";
import {
  PresentationNetworkError,
  type PresentationNetworkFailureCode,
} from "../core/presentation-network";
import type {
  PresentationNetworkManager,
  PresentationNetworkStatus,
} from "./presentation-network";

const log = logger("airplay");
const SESSION_FILE = "airplay-session.json";
/**
 * Version 1 persisted the bare session config. That could not distinguish a
 * gateway the server had only asked to *prepare* from one it had explicitly
 * *started*, so recovery advertised AirPlay for both — a group gateway could
 * come back from a reboot advertising before the server had finished its
 * all-or-nothing group preparation.
 */
const SESSION_FORMAT = 2;
const UXPLAY_BASELINE = "1.73.6";
const HEALTH_INTERVAL_MS = 2_000;
const RECEIVER_LATENCY_MS = 80;
const MAX_PROCESS_RESTARTS = 2;
const AIRPLAY_INSTALLER_HINT =
  "Run the server's /install-airplay.sh installer as root.";

type SpawnedProcess = ChildProcess;
type SpawnFunction = typeof nodeSpawn;

type UxplayProbeFailure =
  "not_found" | "not_executable" | "command_failed" | "version_unrecognized";

interface CommandProbeResult {
  ok: boolean;
  output: string;
  resolution: ExecutableResolution;
  /** The resolved executable ran but did not complete successfully. */
  commandFailed: boolean;
}

interface ManagedProcess {
  child: SpawnedProcess;
  kind: "uxplay" | "receiver";
  stopping: boolean;
}

/**
 * Local session state that has to survive a reboot.
 *
 * `gatewayStarted` records whether the server has issued the start phase for
 * this session — that is, whether this player is permitted to advertise an
 * AirPlay receiver. A group gateway that has only been prepared holds its RTP
 * receiver ready and waits; only the server decides when the room is complete.
 */
interface PersistedAirplaySession {
  version: number;
  config: ExternalPresentationConfig;
  gatewayStarted: boolean;
}

export interface AirplayManagerOptions {
  store: StateStore;
  spawn?: SpawnFunction;
  resolveExecutable?: ExecutableResolver;
  now?: () => number;
  onStatus?: (status: ExternalPresentationStatus | null) => void;
  /**
   * Owns the temporary Wi-Fi connection when the session has a Presentation
   * Network. Optional: a build without one, or a screen with no assignment,
   * follows exactly the Ethernet-only path this manager always had.
   */
  presentationNetwork?: PresentationNetworkManager;
}

const SUPPORTED_DECODERS = ["vah264dec", "vaapih264dec", "avdec_h264"] as const;
type SupportedDecoder = (typeof SUPPORTED_DECODERS)[number];

function commandOutput(child: SpawnedProcess): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once("error", () => resolve({ code: null, stdout, stderr }));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function probeCommand(
  spawn: SpawnFunction,
  resolveExecutable: ExecutableResolver,
  binary: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<CommandProbeResult> {
  const resolution = await resolveExecutable(binary);
  if (resolution.status !== "resolved" || !resolution.path) {
    return {
      ok: false,
      output: "",
      resolution,
      commandFailed: false,
    };
  }

  let child: SpawnedProcess;
  try {
    child = spawn(resolution.path, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return {
      ok: false,
      output: "",
      resolution,
      commandFailed: true,
    };
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const result = await commandOutput(child);
    return {
      ok: result.code === 0,
      output: `${result.stdout}\n${result.stderr}`,
      resolution,
      commandFailed: result.code !== 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseUxplayVersion(output: string): string | null {
  const match = output.match(
    /(?:UxPlay|uxplay)[^0-9]*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i,
  );
  return match?.[1] ?? null;
}

export function versionAtLeast(
  version: string | null,
  baseline: string,
): boolean {
  if (!version) return false;
  const parse = (value: string) => value.split(".").map((part) => Number(part));
  const actual = parse(version);
  const expected = parse(baseline);
  for (
    let index = 0;
    index < Math.max(actual.length, expected.length);
    index += 1
  ) {
    const left = actual[index] ?? 0;
    const right = expected[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * One operator-facing sentence naming what is missing and what to do about it.
 *
 * Blocking dependencies come first and in provisioning order, because a box
 * missing UxPlay is usually missing GStreamer too and fixing the first is what
 * the operator does next. The remaining cases are quality limitations on a
 * player that can already present. Studio shows this verbatim, so each string
 * has to name the dependency: "not AirPlay-ready" alone sends an operator
 * hunting through five candidates.
 */
export function describeLimitation(probe: {
  uxplayInstalled: boolean;
  uxplayVersion: string | null;
  uxplayFailure?: UxplayProbeFailure;
  uxplayPath?: string | null;
  uxplayCandidates?: string[];
  gstreamerInstalled: boolean;
  decoder: SupportedDecoder | null;
  avahiAvailable: boolean;
  hardware: boolean;
  hardwarePlugin: boolean;
  vainfoAvailable: boolean;
  supported: boolean;
}): string | undefined {
  const location = probe.uxplayPath ? ` at ${probe.uxplayPath}` : "";
  if (probe.uxplayFailure === "not_found") {
    const checked = probe.uxplayCandidates?.length
      ? ` Checked ${probe.uxplayCandidates.slice(0, 5).join(", ")}${probe.uxplayCandidates.length > 5 ? ", …" : ""}.`
      : "";
    return `UxPlay was not found.${checked} AirPlay needs UxPlay ${UXPLAY_BASELINE} or newer. ${AIRPLAY_INSTALLER_HINT}`;
  }
  if (probe.uxplayFailure === "not_executable") {
    return `UxPlay was found${location} but is not executable. AirPlay needs UxPlay ${UXPLAY_BASELINE} or newer; fix the file permissions or ${AIRPLAY_INSTALLER_HINT}`;
  }
  if (probe.uxplayFailure === "command_failed") {
    return `UxPlay was found${location} but its -v version check failed. AirPlay needs UxPlay ${UXPLAY_BASELINE} or newer; ${AIRPLAY_INSTALLER_HINT}`;
  }
  if (probe.uxplayFailure === "version_unrecognized") {
    return `UxPlay was found${location} but did not report a recognizable version with -v. AirPlay needs UxPlay ${UXPLAY_BASELINE} or newer; ${AIRPLAY_INSTALLER_HINT}`;
  }
  if (!probe.uxplayInstalled) {
    return `UxPlay is not installed; AirPlay needs UxPlay ${UXPLAY_BASELINE} or newer. ${AIRPLAY_INSTALLER_HINT}`;
  }
  if (!versionAtLeast(probe.uxplayVersion, UXPLAY_BASELINE)) {
    return `UxPlay ${probe.uxplayVersion ?? "of an unknown version"} is older than the supported baseline ${UXPLAY_BASELINE}. ${AIRPLAY_INSTALLER_HINT}`;
  }
  if (!probe.gstreamerInstalled) {
    return `GStreamer is not installed; AirPlay needs the GStreamer tools and plugins. ${AIRPLAY_INSTALLER_HINT}`;
  }
  if (probe.decoder === null && probe.hardwarePlugin) {
    return `A VA-API decoder plugin is installed but vainfo could not validate the driver, and the avdec_h264 software decoder is not installed. ${AIRPLAY_INSTALLER_HINT}`;
  }
  if (probe.decoder === null) {
    return `No supported H.264 decoder was found; AirPlay needs vah264dec, vaapih264dec, or avdec_h264. ${AIRPLAY_INSTALLER_HINT}`;
  }
  if (!probe.avahiAvailable) {
    return "Avahi/Bonjour support is unavailable; AirPlay cannot be advertised.";
  }
  if (probe.hardwarePlugin && !probe.hardware) {
    return "A VA-API decoder plugin is installed but vainfo could not validate the driver; use 720p30 until the driver is fixed.";
  }
  if (!probe.hardware && probe.decoder === "avdec_h264") {
    return "Intel VA-API H.264 decoding is unavailable; use 720p30 to limit CPU load.";
  }
  if (!probe.vainfoAvailable && probe.supported) {
    return "vainfo is unavailable; hardware decode was inferred from GStreamer plugins only.";
  }
  return undefined;
}

export function selectDecoder(pluginOutput: {
  vah264dec: boolean;
  vaapih264dec: boolean;
  avdec_h264: boolean;
}): SupportedDecoder | null {
  return SUPPORTED_DECODERS.find((decoder) => pluginOutput[decoder]) ?? null;
}

export function buildReceiverArgs(
  config: Pick<ExternalPresentationConfig, "videoPort" | "profile"> & {
    decoder: SupportedDecoder;
    transport?: AirplayTransport;
    multicastAddress?: string;
    videoSink?: "vaapisink" | "autovideosink";
  },
): string[] {
  const { width, height } = profileDimensions(config.profile);
  const source = ["udpsrc", `port=${config.videoPort}`];
  if (config.transport === "multicast" && config.multicastAddress) {
    source.push(
      `multicast-group=${config.multicastAddress}`,
      "auto-multicast=true",
    );
  }
  return [
    "-e",
    ...source,
    "caps=application/x-rtp,media=video,clock-rate=90000,encoding-name=H264,payload=96",
    "!",
    "rtpjitterbuffer",
    `latency=${RECEIVER_LATENCY_MS}`,
    "drop-on-latency=true",
    "!",
    "rtph264depay",
    "!",
    "h264parse",
    "config-interval=-1",
    "!",
    config.decoder,
    "!",
    "videoconvert",
    "!",
    "videoscale",
    "!",
    `video/x-raw,width=${width},height=${height}`,
    "!",
    // fpsdisplaysink gives the manager a low-rate, packet-derived health
    // signal. It also makes the incoming FPS available in the process log
    // without capturing or re-encoding the mirrored frames.
    "fpsdisplaysink",
    `video-sink=\"${config.videoSink === "vaapisink" ? "vaapisink fullscreen=true" : "autovideosink"}\"`,
    "text-overlay=false",
    "silent=false",
    // Let the sink honor RTP timestamps and the local clock. The bounded
    // jitter buffer keeps the group within a few frames without promising
    // frame-perfect synchronization.
    "sync=true",
  ];
}

function validHost(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    /^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(value)
  );
}

function validDestination(destination: AirplayDestination): boolean {
  return (
    typeof destination.screenId === "string" &&
    validHost(destination.host) &&
    Number.isInteger(destination.port) &&
    destination.port === AIRPLAY_PORTS.videoRtp
  );
}

function validateConfig(config: ExternalPresentationConfig): void {
  if (
    config.provider !== "airplay" ||
    !config.sessionId ||
    config.receiverName.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(config.receiverName) ||
    !isAirplayPin(config.pin) ||
    !isAirplayDeviceId(config.deviceId) ||
    !isAirplayProfile(config.profile) ||
    !Number.isInteger(config.videoPort) ||
    config.videoPort !== AIRPLAY_PORTS.videoRtp ||
    !["single", "gateway", "receiver"].includes(config.role) ||
    // A persisted session is read back as ExternalPresentationConfig without
    // going through the command parser, so the audio mode is checked here too.
    // Anything outside the v1 contract — including the "all" the type used to
    // permit — is rejected rather than silently treated as gateway-only.
    !["gateway_only", "none"].includes(config.audioMode)
  ) {
    throw new Error("invalid AirPlay session configuration");
  }
  if (isExpired(config.expiresAt))
    throw new Error("AirPlay session has expired");
  if (config.role === "receiver" && config.targetType !== "group") {
    throw new Error("an AirPlay receiver must belong to a group");
  }
  if (config.role === "single" && config.targetType !== "screen") {
    throw new Error("a single-screen AirPlay session must target a screen");
  }
  if (config.role === "gateway" && config.targetType !== "group") {
    throw new Error("a gateway must belong to a group");
  }
  if (config.transport === "multicast") {
    if (
      !config.multicastAddress ||
      !/^239\.255\.42\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(
        config.multicastAddress,
      )
    ) {
      throw new Error("invalid AirPlay multicast address");
    }
  }
  if (config.role === "gateway" || config.role === "single") {
    for (const destination of config.destinations) {
      if (!validDestination(destination))
        throw new Error("invalid AirPlay RTP destination");
    }
  }
}

function receiverPipeline(
  config: ExternalPresentationConfig,
  decoder: SupportedDecoder,
): string {
  // UxPlay parses this as a GStreamer pipeline fragment, not as a shell
  // command. Hosts are restricted above and spawn() never invokes a shell.
  if (config.transport === "multicast") {
    return `config-interval=1 ! udpsink host=${config.multicastAddress} port=${config.videoPort} auto-multicast=true`;
  }
  const clients = config.destinations
    .filter(validDestination)
    .map((destination) => `${destination.host}:${destination.port}`)
    .join(",");
  if (!clients) throw new Error("unicast AirPlay session has no destinations");
  return `config-interval=1 ! multiudpsink clients=${clients}`;
}

export class AirplayManager {
  private readonly store: StateStore;
  private readonly spawn: SpawnFunction;
  private readonly resolveExecutable: ExecutableResolver;
  private readonly now: () => number;
  private readonly onStatus?: (
    status: ExternalPresentationStatus | null,
  ) => void;
  private config: ExternalPresentationConfig | null = null;
  private status: ExternalPresentationStatus | null = null;
  private uxplay: ManagedProcess | null = null;
  private receiver: ManagedProcess | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private receiverRestarts = 0;
  private gatewayRestarts = 0;
  private senderSeenAt: number | null = null;
  private receiverVideoSink: "vaapisink" | "autovideosink" = "autovideosink";
  private gatewayStarted = false;
  private stopping = false;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly presentationNetwork?: PresentationNetworkManager;
  /**
   * Whether *this* session brought the Presentation Network up. It decides
   * whether stopping the session should disconnect it, so a session that never
   * needed Wi-Fi never tears down a connection it did not create.
   */
  private presentationNetworkJoined = false;

  constructor(options: AirplayManagerOptions) {
    this.store = options.store;
    this.spawn = options.spawn ?? nodeSpawn;
    this.resolveExecutable =
      options.resolveExecutable ?? ((name) => resolveLinuxExecutable(name));
    this.now = options.now ?? Date.now;
    this.onStatus = options.onStatus;
    this.presentationNetwork = options.presentationNetwork;
  }

  async probeCapabilities(): Promise<AirplayCapabilities> {
    const uxplay = await this.probeCommand("uxplay", ["-v"]);
    const uxplayVersion = parseUxplayVersion(uxplay.output);
    const gstreamer = await this.probeCommand("gst-inspect-1.0", ["--version"]);
    const decoderChecks = await Promise.all(
      SUPPORTED_DECODERS.map(
        async (decoder) =>
          [
            decoder,
            (await this.probeCommand("gst-inspect-1.0", [decoder])).ok,
          ] as const,
      ),
    );
    const decoderAvailability = Object.fromEntries(decoderChecks) as Record<
      SupportedDecoder,
      boolean
    >;
    const installedDecoder = selectDecoder(decoderAvailability);
    const [vainfo, avahi, receiverSink, audioSink, fullscreenSink] =
      await Promise.all([
        this.probeCommand("vainfo", []),
        this.probeCommand("avahi-browse", [
          "--all",
          "--resolve",
          "--terminate",
        ]),
        this.probeCommand("gst-inspect-1.0", ["fpsdisplaysink"]),
        this.probeCommand("gst-inspect-1.0", ["autoaudiosink"]),
        this.probeCommand("gst-inspect-1.0", ["vaapisink"]),
      ]);
    this.receiverVideoSink = fullscreenSink.ok ? "vaapisink" : "autovideosink";
    const hardwarePlugin =
      installedDecoder === "vah264dec" || installedDecoder === "vaapih264dec";
    // A missing vainfo binary should not hide a hardware decoder plugin, but a
    // present binary that cannot initialize VA-API means the old box should be
    // treated as software-only until provisioning fixes its driver.
    const hardware =
      hardwarePlugin && (vainfo.ok || vainfo.output.trim().length === 0);
    // Sessions start with this decoder, so an unusable VA-API driver must not
    // leave the hardware element selected.
    const decoder: SupportedDecoder | null =
      hardwarePlugin && !hardware
        ? decoderAvailability.avdec_h264
          ? "avdec_h264"
          : null
        : installedDecoder;
    const gstreamerReady = gstreamer.ok && decoder !== null;
    const supported =
      uxplay.ok &&
      versionAtLeast(uxplayVersion, UXPLAY_BASELINE) &&
      gstreamerReady &&
      avahi.ok;
    const groupReceiverReady = gstreamerReady && receiverSink.ok;
    const maxProfile = !gstreamerReady
      ? "unsupported"
      : hardware
        ? "1080p30"
        : "720p30";
    const uxplayFailure = this.uxplayFailure(uxplay, uxplayVersion);
    return {
      airplaySupported: supported,
      // Presence is separate from successful execution. This keeps Studio
      // from calling an existing but unusable UxPlay binary "missing".
      uxplayInstalled: uxplay.resolution.status !== "not_found",
      uxplayVersion,
      gstreamerInstalled: gstreamer.ok,
      h264DecoderAvailable: decoder !== null,
      hardwareH264Decode: hardware,
      decoder,
      maxProfile,
      // Followers only receive the forwarded RTP stream. They do not need a
      // second UxPlay advertiser or Avahi, while the gateway still must pass
      // the full airplaySupported check above.
      groupAirplaySupported: groupReceiverReady,
      audioAvailable: gstreamerReady && audioSink.ok,
      receiverVideoSink: this.receiverVideoSink,
      avahiAvailable: avahi.ok,
      mdnsAdvertisementAvailable: avahi.ok,
      multicastSupported: null,
      multicastTestStatus: "not_tested",
      limitation: describeLimitation({
        uxplayInstalled: uxplay.resolution.status !== "not_found",
        uxplayVersion,
        uxplayFailure,
        uxplayPath: uxplay.resolution.path,
        uxplayCandidates: uxplay.resolution.candidates,
        gstreamerInstalled: gstreamer.ok,
        decoder,
        avahiAvailable: avahi.ok,
        hardware,
        hardwarePlugin,
        vainfoAvailable: vainfo.ok,
        supported,
      }),
    };
  }

  private probeCommand(
    binary: string,
    args: string[],
  ): Promise<CommandProbeResult> {
    return probeCommand(
      this.spawn,
      (name) => this.resolveTool(name),
      binary,
      args,
    );
  }

  private resolveTool(name: string): Promise<ExecutableResolution> {
    // Do not retain a successful path across probes. An operator may install
    // the pinned /usr/local/bin/uxplay while this Electron process remains
    // alive, and the preferred provisioned candidate must win immediately.
    return this.resolveExecutable(name);
  }

  private async requiredExecutable(name: string): Promise<string> {
    const resolution = await this.resolveTool(name);
    if (resolution.status !== "resolved" || !resolution.path) {
      throw new Error(describeExecutableResolution(resolution));
    }
    return resolution.path;
  }

  private uxplayFailure(
    probe: CommandProbeResult,
    version: string | null,
  ): UxplayProbeFailure | undefined {
    if (probe.resolution.status === "not_found") return "not_found";
    if (probe.resolution.status === "not_executable") return "not_executable";
    if (probe.commandFailed) return "command_failed";
    if (probe.ok && !version) return "version_unrecognized";
    return undefined;
  }

  async prepareSession(
    config: ExternalPresentationConfig,
    decoder: SupportedDecoder,
  ): Promise<ExternalPresentationStatus> {
    return this.runExclusive(() =>
      this.prepareSessionInternal(config, decoder),
    );
  }

  private async prepareSessionInternal(
    config: ExternalPresentationConfig,
    decoder: SupportedDecoder,
    resumeGatewayStarted = false,
  ): Promise<ExternalPresentationStatus> {
    validateConfig(config);
    if (
      this.config &&
      (this.config.sessionId !== config.sessionId ||
        JSON.stringify(this.config) !== JSON.stringify(config))
    ) {
      // Reconfiguration (including multicast -> unicast fallback) must not
      // emit a transient null heartbeat that makes the server mark the same
      // session terminal between the old and new process set.
      await this.stopSessionInternal("replaced", false);
    }
    this.config = config;
    this.stopping = false;
    this.receiverRestarts = 0;
    this.gatewayRestarts = 0;
    this.senderSeenAt = null;
    // Preparing does not grant permission to advertise. Only startGateway does,
    // and only recovery of an already-started session resumes it.
    this.gatewayStarted = resumeGatewayStarted && config.role !== "receiver";
    this.presentationNetworkJoined = false;
    try {
      await this.persistSession(config, this.gatewayStarted);
      this.setStatus({
        provider: "airplay",
        sessionId: config.sessionId,
        role: config.role,
        state: "preparing",
        connected: false,
        receiverAlive: false,
        gatewayAlive: false,
      });
      // The Presentation Network comes first, before any receiver process and
      // long before UxPlay can advertise.
      //
      // Ordering is the whole contract: an AirPlay receiver must never be
      // discoverable before the network it is meant to be discoverable *on* is
      // up. A gateway that advertised first would appear in a sender's picker and
      // then fail to connect, which is worse than taking a few more seconds.
      //
      // A follower never reaches this: the server does not put a Presentation
      // Network in a receiver's payload, and the parser rejects one that appears.
      await this.joinPresentationNetwork(config);
      if (config.role !== "single") {
        await this.startReceiver(config, decoder);
      }
      this.startTimers(decoder);
      this.setStatus({
        ...this.status!,
        state: "waiting",
        receiverAlive: config.role === "single" || this.receiver !== null,
      });
      return this.status!;
    } catch (error) {
      await this.stopSessionInternal("prepare_failed", true);
      throw error;
    }
  }

  /**
   * Bring the session's Presentation Network up, if it has one.
   *
   * Returns quietly when there is nothing to do — no Presentation Network in the
   * payload, or no manager on this build — which is what preserves the existing
   * Ethernet-only behavior byte for byte.
   *
   * A failure here fails preparation. That is deliberate: the server's
   * all-or-nothing group preparation then reports a precise reason and never
   * releases the gateway to advertise, rather than presenting into a VLAN nobody
   * can see it from.
   */
  private async joinPresentationNetwork(
    config: ExternalPresentationConfig,
  ): Promise<void> {
    if (!config.presentationNetworkId || config.role === "receiver") return;
    if (!this.presentationNetwork) {
      throw new PresentationNetworkError(
        "helper_unavailable",
        "This player cannot join a Presentation Network. Re-run the player installer to add the presentation-network helper.",
      );
    }
    const assignment = this.presentationNetwork.getAssignment();
    if (
      !assignment ||
      assignment.presentationNetworkId !== config.presentationNetworkId
    ) {
      // The server asked for a network this player has not been assigned, or has
      // not yet synchronized. Refusing beats provisioning something unassigned.
      throw new PresentationNetworkError(
        "credential_unavailable",
        "This player has not received the assigned Presentation Network configuration yet.",
      );
    }
    this.setStatus({
      ...this.status!,
      presentationNetwork: "joining",
      presentationNetworkName: assignment.name,
    });
    try {
      await this.presentationNetwork.connect(`airplay:${config.sessionId}`);
    } catch (error) {
      const status = this.presentationNetwork.getStatus();
      this.setStatus({
        ...this.status!,
        state: "degraded",
        presentationNetwork: "failed",
        presentationNetworkName: assignment.name,
        failureCode: status.failureCode ?? "presentation_network_failed",
        failureMessage:
          status.failureMessage ??
          `Tilecast could not join ${assignment.name} for this AirPlay session.`,
      });
      throw error;
    }
    this.presentationNetworkJoined = true;
    this.setStatus({
      ...this.status!,
      presentationNetwork: "connected",
      presentationNetworkName: assignment.name,
    });
  }

  /** Mirror the manager's own status into the session status, for Studio. */
  onPresentationNetworkStatus(status: PresentationNetworkStatus): void {
    const current = this.status;
    if (!current || !this.config?.presentationNetworkId) return;
    if (current.role === "receiver") return;
    const mapped: ExternalPresentationStatus["presentationNetwork"] =
      status.state === "connected"
        ? "connected"
        : status.state === "failed"
          ? "failed"
          : status.state === "joining"
            ? "joining"
            : current.presentationNetwork;
    if (mapped === current.presentationNetwork) return;
    this.setStatus({
      ...current,
      presentationNetwork: mapped,
      presentationNetworkName:
        status.networkName || current.presentationNetworkName,
    });
  }

  async startGateway(
    decoder: SupportedDecoder,
  ): Promise<ExternalPresentationStatus> {
    return this.runExclusive(() => this.startGatewayInternal(decoder));
  }

  private async startGatewayInternal(
    decoder: SupportedDecoder,
  ): Promise<ExternalPresentationStatus> {
    const config = this.config;
    if (!config) throw new Error("AirPlay session is not prepared");
    if (config.role === "receiver") {
      throw new Error("A group receiver cannot advertise AirPlay");
    }
    validateConfig(config);
    // Record the server's permission to advertise before the receiver can be
    // seen on the network. A crash between the two must leave a file that says
    // "started" — resuming an authorized receiver is correct, whereas losing
    // the authorization would strand a gateway the server believes is live.
    try {
      this.gatewayStarted = true;
      await this.persistSession(config, true);
    } catch (error) {
      await this.stopSessionInternal("gateway_start_failed", true);
      throw error;
    }
    if (this.uxplay) return this.status!;
    // A session with a Presentation Network may not advertise until the network
    // is actually up. Normally joinPresentationNetwork already did this during
    // preparation; this covers restart recovery, where a previously-started
    // gateway comes back and must reconnect its network *before* UxPlay is
    // restored rather than after.
    if (config.presentationNetworkId && !this.presentationNetworkJoined) {
      await this.joinPresentationNetwork(config);
    }
    try {
      await this.startUxplay(config, decoder);
    } catch (error) {
      await this.stopSessionInternal("gateway_start_failed", true);
      throw error;
    }
    this.setStatus({
      ...this.status!,
      state: "waiting",
      gatewayAlive: true,
      receiverAlive: config.role === "single" || this.receiver !== null,
    });
    return this.status!;
  }

  async stopSession(reason = "stopped"): Promise<void> {
    await this.runExclusive(() => this.stopSessionInternal(reason, true));
  }

  private async stopSessionInternal(
    reason: string,
    notify: boolean,
  ): Promise<void> {
    this.stopping = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.healthTimer = null;
    this.expiryTimer = null;
    const processes = [this.uxplay, this.receiver].filter(
      Boolean,
    ) as ManagedProcess[];
    this.uxplay = null;
    this.receiver = null;
    await Promise.all(processes.map((managed) => this.stopProcess(managed)));
    const releaseNetwork = this.presentationNetworkJoined;
    this.presentationNetworkJoined = false;
    this.config = null;
    this.status = null;
    this.gatewayStarted = false;
    await this.store.delete(SESSION_FILE).catch(() => undefined);
    // Only disconnect a network this session brought up, and only after the
    // media processes are gone. Cleanup is idempotent, so an overlapping stop
    // path (expiry racing a manual stop, a takeover racing a failure) is safe.
    if (releaseNetwork && this.presentationNetwork) {
      await this.presentationNetwork
        .disconnect(`airplay_stopped:${reason}`)
        .catch((error) => {
          log.warn("failed to leave the presentation network", {
            error: String(error),
          });
        });
    }
    log.info("AirPlay session stopped", { reason });
    if (notify) this.onStatus?.(null);
  }

  async recoverSession(
    decoder: SupportedDecoder | null,
  ): Promise<ExternalPresentationStatus | null> {
    return this.runExclusive(() => this.recoverSessionInternal(decoder));
  }

  private async recoverSessionInternal(
    decoder: SupportedDecoder | null,
  ): Promise<ExternalPresentationStatus | null> {
    const persisted = await this.readPersistedSession();
    if (!persisted) {
      // No session at all. A Tilecast presentation network connection that is
      // still up is leftover state from a crash: it holds the radio on and keeps
      // the player on a VLAN it has no reason to be on. Unrelated Wi-Fi profiles
      // are untouched, because the helper can only name Tilecast's own namespace.
      await this.presentationNetwork?.cleanupOrphaned().catch((error) => {
        log.warn(
          "failed to clean up an orphaned presentation network connection",
          {
            error: String(error),
          },
        );
      });
      return null;
    }
    const { config, gatewayStarted } = persisted;
    if (isExpired(config.expiresAt)) {
      // An expired session must never reconnect Wi-Fi. Clean up instead.
      await this.store.delete(SESSION_FILE);
      await this.presentationNetwork?.cleanupOrphaned().catch(() => undefined);
      return null;
    }
    if (!decoder) {
      log.warn("cannot recover AirPlay session without an H.264 decoder");
      await this.store.delete(SESSION_FILE);
      await this.presentationNetwork?.cleanupOrphaned().catch(() => undefined);
      return null;
    }
    try {
      await this.prepareSessionInternal(config, decoder, gatewayStarted);
      if (gatewayStarted && config.role !== "receiver") {
        await this.startGatewayInternal(decoder);
      } else if (config.role !== "receiver") {
        // Prepared, not started. The RTP receiver is back and the display holds
        // the Tilecast ready surface, but nothing is advertised until the
        // server completes group preparation and reissues the start phase.
        log.info("recovered a prepared AirPlay gateway without advertising", {
          sessionId: config.sessionId,
          role: config.role,
        });
      }
    } catch (error) {
      log.warn("failed to reconstruct persisted AirPlay session", {
        error: String(error),
      });
      await this.stopSessionInternal("recovery_failed", true);
      return null;
    }
    return this.status;
  }

  private persistSession(
    config: ExternalPresentationConfig,
    gatewayStarted: boolean,
  ): Promise<void> {
    const persisted: PersistedAirplaySession = {
      version: SESSION_FORMAT,
      config,
      gatewayStarted,
    };
    return this.store.writeJson(SESSION_FILE, persisted);
  }

  /**
   * Read the persisted session, tolerating the pre-2 format.
   *
   * A version 1 file is the bare config and says nothing about whether the
   * server had started the gateway. A single-screen session is prepared and
   * started by the same command, so its answer is knowable; a group gateway's
   * is not, and the conservative reading is "prepared only" — recovering
   * without advertising and letting the server reissue the start decision is
   * recoverable, whereas advertising a receiver the server never released is
   * exactly the failure this format exists to prevent.
   *
   * Anything that is neither this format nor a recognizable version 1 config —
   * including a file written by a newer player after a downgrade — is discarded
   * rather than guessed at.
   */
  private async readPersistedSession(): Promise<PersistedAirplaySession | null> {
    const raw =
      await this.store.readJson<Record<string, unknown>>(SESSION_FILE);
    // No file, or one the store already quarantined as corrupt. Nothing to
    // discard and nothing worth logging on every boot.
    if (raw === null) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      await this.discardPersistedSession("not a session object");
      return null;
    }
    const envelope = raw as Partial<PersistedAirplaySession>;
    if (
      envelope.version === SESSION_FORMAT &&
      envelope.config &&
      typeof envelope.config === "object"
    ) {
      return {
        version: SESSION_FORMAT,
        config: envelope.config,
        gatewayStarted: envelope.gatewayStarted === true,
      };
    }
    // A file written by a newer player is not a legacy bare config and must not
    // be read as one — its fields may mean something else entirely. The same
    // goes for anything that does not have the shape of a version 1 config.
    // Discard it: the server sees the session cleared and ends it, which is
    // recoverable, whereas guessing at an unknown layout is not.
    if (
      Object.prototype.hasOwnProperty.call(raw, "version") ||
      raw["provider"] !== "airplay" ||
      typeof raw["sessionId"] !== "string" ||
      typeof raw["role"] !== "string"
    ) {
      await this.discardPersistedSession("unrecognized format");
      return null;
    }
    const legacy = raw as unknown as ExternalPresentationConfig;
    return {
      version: SESSION_FORMAT,
      config: legacy,
      gatewayStarted: legacy.role === "single",
    };
  }

  private async discardPersistedSession(reason: string): Promise<void> {
    log.warn("discarding a persisted AirPlay session", { reason });
    await this.store.delete(SESSION_FILE).catch(() => undefined);
  }

  getStatus(): ExternalPresentationStatus | null {
    return this.status ? { ...this.status } : null;
  }

  getConfig(): ExternalPresentationConfig | null {
    return this.config
      ? { ...this.config, destinations: [...this.config.destinations] }
      : null;
  }

  private startTimers(decoder: SupportedDecoder): void {
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => {
        void this.healthCheck(decoder);
      }, HEALTH_INTERVAL_MS);
      this.healthTimer.unref?.();
    }
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const config = this.config;
    if (!config) return;
    const delay = Math.max(0, Date.parse(config.expiresAt) - this.now());
    this.expiryTimer = setTimeout(
      () => {
        if (this.config && isExpired(this.config.expiresAt, this.now())) {
          void this.stopSession("expired");
        } else {
          this.scheduleExpiry();
        }
      },
      Math.min(delay + 25, 2_147_000_000),
    );
    this.expiryTimer.unref?.();
  }

  private async startUxplay(
    config: ExternalPresentationConfig,
    decoder: SupportedDecoder,
  ): Promise<void> {
    const executable = await this.requiredExecutable("uxplay");
    const profile = profileDimensions(config.profile);
    const args = [
      "-n",
      config.receiverName,
      "-nh",
      "-pin",
      config.pin,
      "-m",
      config.deviceId,
      "-p",
      AIRPLAY_PORTS.uxplay.join(","),
      "-s",
      `${profile.width}x${profile.height}`,
      "-fps",
      String(profile.fps),
      "-nofreeze",
      "-scrsv",
      "2",
      "-FPSdata",
    ];
    if (config.audioMode === "none") {
      // UxPlay's documented -as 0 path suppresses streamed audio without
      // touching the compressed video path.
      args.push("-as", "0");
    }
    if (config.role === "single") {
      args.push("-vd", decoder, "-fs");
    } else {
      // Group mode must never decode or render on the gateway. UxPlay forwards
      // decrypted compressed H.264 RTP packets to the receivers.
      args.push("-vs", "0", "-vrtp", receiverPipeline(config, decoder));
    }
    const child = this.spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const managed: ManagedProcess = { child, kind: "uxplay", stopping: false };
    this.uxplay = managed;
    this.attachOutput(managed);
    let processEnded = false;
    const handleProcessEnd = () => {
      if (processEnded) return;
      processEnded = true;
      if (this.uxplay?.child !== child) return;
      this.uxplay = null;
      if (!managed.stopping && !this.stopping)
        void this.handleGatewayExit(decoder);
    };
    child.once("error", (error) => {
      if (
        processEnded ||
        this.uxplay?.child !== child ||
        managed.stopping ||
        this.stopping
      )
        return;
      log.warn("UxPlay process failed to start or exited with an error", {
        error: String(error),
      });
      handleProcessEnd();
    });
    child.once("exit", handleProcessEnd);
  }

  private async startReceiver(
    config: ExternalPresentationConfig,
    decoder: SupportedDecoder,
  ): Promise<void> {
    if (this.receiver) return;
    const executable = await this.requiredExecutable("gst-launch-1.0");
    const child = this.spawn(
      executable,
      buildReceiverArgs({
        ...config,
        decoder,
        videoSink: this.receiverVideoSink,
      }),
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const managed: ManagedProcess = {
      child,
      kind: "receiver",
      stopping: false,
    };
    this.receiver = managed;
    this.attachOutput(managed);
    let processEnded = false;
    const handleProcessEnd = () => {
      if (processEnded) return;
      processEnded = true;
      if (this.receiver?.child !== child) return;
      this.receiver = null;
      if (!managed.stopping && !this.stopping)
        void this.handleReceiverExit(decoder);
    };
    child.once("error", (error) => {
      if (
        processEnded ||
        this.receiver?.child !== child ||
        managed.stopping ||
        this.stopping
      )
        return;
      log.warn("GStreamer receiver failed to start or exited with an error", {
        error: String(error),
      });
      handleProcessEnd();
    });
    child.once("exit", handleProcessEnd);
  }

  private attachOutput(managed: ManagedProcess): void {
    const read = (chunk: Buffer | string) => {
      const text = String(chunk);
      const lower = text.toLowerCase();
      if (managed.kind === "uxplay") {
        if (/fps|frames?\s*\/|streaming|mirroring/.test(lower)) {
          const current = this.status;
          if (current) {
            if (current.role !== "single") this.senderSeenAt = this.now();
            this.setStatus({
              ...current,
              // In group mode UxPlay proving that it has a sender is not
              // enough: the gateway's own forwarded RTP receiver must also
              // render a packet before the display is marked connected.
              state: current.role === "single" ? "connected" : current.state,
              connected: current.role === "single" ? true : current.connected,
              gatewayAlive: true,
              lastRtpAt:
                current.role === "single"
                  ? new Date(this.now()).toISOString()
                  : current.lastRtpAt,
            });
          }
        }
        if (
          /teardown|disconnected|stop mirroring|connection closed/.test(lower)
        ) {
          void this.handleSenderDisconnect();
        }
      }
      if (
        managed.kind === "receiver" &&
        /rendered:\s*[1-9][0-9]*/.test(lower)
      ) {
        const current = this.status;
        if (current) {
          this.setStatus({
            ...current,
            state: "connected",
            connected: true,
            lastRtpAt: new Date(this.now()).toISOString(),
          });
        }
      }
      if (/error|missing plugin|could not link|not-negotiated/.test(lower)) {
        log.warn("AirPlay process reported an error", {
          process: managed.kind,
          message: text.trim().slice(0, 240),
        });
        const current = this.status;
        if (current) {
          this.setStatus({
            ...current,
            state: "degraded",
            failureCode: "process_error",
            failureMessage: "An AirPlay media process reported an error.",
          });
        }
      }
    };
    managed.child.stdout?.on("data", read);
    managed.child.stderr?.on("data", read);
  }

  private async handleSenderDisconnect(): Promise<void> {
    await this.runExclusive(() => this.handleSenderDisconnectInternal());
  }

  private async handleSenderDisconnectInternal(): Promise<void> {
    const current = this.status;
    if (!current || this.stopping) return;
    this.setStatus({
      ...current,
      state: "waiting",
      connected: false,
      lastRtpAt: undefined,
    });
    this.senderSeenAt = null;
    if (this.config?.role !== "single" && this.receiver) {
      // Closing the receiver window removes the stale last frame. A new
      // receiver waits behind the Tilecast ready surface for the next sender.
      const old = this.receiver;
      this.receiver = null;
      await this.stopProcess(old);
      const decoder = await this.decoderForRecovery();
      if (decoder && this.config && !this.stopping) {
        try {
          await this.startReceiver(this.config, decoder);
        } catch (error) {
          log.warn("receiver restart after sender disconnect failed", {
            error: String(error),
          });
          await this.stopSessionInternal("receiver_restart_failed", true);
        }
      }
    }
  }

  private async handleGatewayExit(decoder: SupportedDecoder): Promise<void> {
    await this.runExclusive(() => this.handleGatewayExitInternal(decoder));
  }

  private async handleGatewayExitInternal(
    decoder: SupportedDecoder,
  ): Promise<void> {
    const current = this.status;
    if (!current || this.stopping) return;
    if (current.connected || this.gatewayRestarts >= MAX_PROCESS_RESTARTS) {
      await this.stopSessionInternal("gateway_failed", true);
      return;
    }
    this.gatewayRestarts += 1;
    this.setStatus({
      ...current,
      state: "degraded",
      gatewayAlive: false,
      failureCode: "uxplay_waiting_crash",
      failureMessage:
        "UxPlay stopped before a sender connected; restarting it.",
    });
    if (this.config && !this.stopping) {
      try {
        await this.startUxplay(this.config, decoder);
      } catch (error) {
        log.warn("UxPlay restart failed", { error: String(error) });
        await this.stopSessionInternal("gateway_restart_failed", true);
      }
    }
  }

  private async handleReceiverExit(decoder: SupportedDecoder): Promise<void> {
    await this.runExclusive(() => this.handleReceiverExitInternal(decoder));
  }

  private async handleReceiverExitInternal(
    decoder: SupportedDecoder,
  ): Promise<void> {
    const current = this.status;
    if (!current || this.stopping) return;
    if (current.role === "gateway" && current.connected) {
      await this.stopSessionInternal("gateway_receiver_failed", true);
      return;
    }
    if (this.receiverRestarts >= MAX_PROCESS_RESTARTS) {
      if (current.role === "gateway") {
        await this.stopSessionInternal("gateway_receiver_failed", true);
        return;
      }
      this.setStatus({
        ...current,
        state: "degraded",
        receiverAlive: false,
        failureCode: "receiver_failed",
        failureMessage: "The display receiver failed repeatedly.",
      });
      return;
    }
    this.receiverRestarts += 1;
    this.setStatus({
      ...current,
      state: "degraded",
      receiverAlive: false,
      failureCode: "receiver_restart",
      failureMessage:
        "The display receiver stopped; attempting a bounded restart.",
    });
    if (this.config && !this.stopping) {
      try {
        await this.startReceiver(this.config, decoder);
      } catch (error) {
        log.warn("receiver restart failed", { error: String(error) });
        await this.stopSessionInternal("receiver_restart_failed", true);
      }
    }
  }

  private async healthCheck(decoder: SupportedDecoder): Promise<void> {
    await this.runExclusive(() => this.healthCheckInternal(decoder));
  }

  private async healthCheckInternal(decoder: SupportedDecoder): Promise<void> {
    const config = this.config;
    const current = this.status;
    if (!config || !current || this.stopping) return;
    if (isExpired(config.expiresAt, this.now())) {
      await this.stopSessionInternal("expired", true);
      return;
    }
    const gatewayAlive = config.role !== "receiver" && this.uxplay !== null;
    const receiverAlive = config.role === "single" || this.receiver !== null;
    if (
      gatewayAlive !== current.gatewayAlive ||
      receiverAlive !== current.receiverAlive
    ) {
      this.setStatus({ ...current, gatewayAlive, receiverAlive });
    }
    if (current.connected && current.lastRtpAt) {
      const age = this.now() - Date.parse(current.lastRtpAt);
      if (age > 5_000) await this.handleSenderDisconnectInternal();
    }
    if (
      config.role === "gateway" &&
      this.senderSeenAt !== null &&
      !current.connected &&
      this.now() - this.senderSeenAt > 5_000
    ) {
      this.setStatus({
        ...current,
        state: "degraded",
        failureCode: "gateway_rtp_timeout",
        failureMessage:
          "UxPlay has a sender, but the gateway display has not received RTP.",
      });
      if (config.transport !== "multicast") {
        await this.stopSessionInternal("gateway_rtp_timeout", true);
      }
    }
  }

  private async decoderForRecovery(): Promise<SupportedDecoder | null> {
    const capabilities = await this.probeCapabilities();
    return capabilities.decoder as SupportedDecoder | null;
  }

  private async stopProcess(managed: ManagedProcess): Promise<void> {
    managed.stopping = true;
    if (managed.child.exitCode !== null || managed.child.signalCode !== null)
      return;
    managed.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        managed.child.kill("SIGKILL");
        resolve();
      }, 2_000);
      managed.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private setStatus(status: ExternalPresentationStatus): void {
    this.status = { ...status };
    this.onStatus?.(this.status);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export type { SupportedDecoder };
