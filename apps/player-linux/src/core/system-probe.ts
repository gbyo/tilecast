/**
 * Linux system facts for telemetry.
 *
 * Everything here reads procfs and sysfs — no subprocesses, because these run
 * on a reporting cadence on hardware where spawning a process per minute is a
 * real cost. Parsing is separated from reading so the formats can be tested
 * against real file contents without a Linux host.
 *
 * A fact this cannot establish is returned as undefined, never guessed. A
 * fabricated "mains" reading on a box whose power supply is invisible to sysfs
 * would be worse than no reading: it is the same value a healthy box reports.
 */

import { promises as fs } from "fs";
import { networkInterfaces as osNetworkInterfaces } from "os";
import { logger } from "./log";
import type { TelemetryGauges } from "./telemetry";

/**
 * The shape of one entry from os.networkInterfaces(). Declared locally so the
 * selection logic can be tested against literal fixtures — Node reports `family`
 * as the string "IPv4" on current releases and as the number 4 on some older
 * ones, and both are accepted.
 */
export interface NodeInterfaceInfo {
  address: string;
  family: string | number;
  internal: boolean;
}

const log = logger("system-probe");

type LinkType = NonNullable<TelemetryGauges["networkLinkType"]>;

/**
 * The interface carrying the default route, which is the only one whose link
 * quality describes the player's actual path to the server. A box with three
 * interfaces up otherwise reports whichever one enumerated first.
 */
export function parseDefaultRouteInterface(
  procNetRoute: string,
): string | undefined {
  for (const line of procNetRoute.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    // Iface Destination Gateway Flags RefCnt Use Metric Mask ...
    if (fields.length < 3) continue;
    // A destination of all zeroes is the default route.
    if (fields[1] === "00000000") return fields[0];
  }
  return undefined;
}

/**
 * Interface class from its name and whether sysfs exposes a wireless directory
 * for it. The name alone is not enough — predictable names put wireless
 * interfaces under `wl*` but a renamed or bridged interface can be anything —
 * so the sysfs evidence wins where it exists.
 */
export function classifyLinkType(
  interfaceName: string,
  hasWirelessDirectory: boolean,
): LinkType {
  if (hasWirelessDirectory) return "wifi";
  if (/^(en|eth|em|eno|ens|enp)/.test(interfaceName)) return "ethernet";
  if (/^(wl|wlan|wlp)/.test(interfaceName)) return "wifi";
  if (/^(ww|wwan|ppp|usb)/.test(interfaceName)) return "cellular";
  if (interfaceName === "lo") return "other";
  return "unknown";
}

/**
 * Signal strength for one interface from /proc/net/wireless. The `level` column
 * is already in dBm on every driver that reports it, which is what the server's
 * range check assumes.
 */
export function parseWirelessSignalDbm(
  procNetWireless: string,
  interfaceName: string,
): number | undefined {
  for (const line of procNetWireless.split("\n")) {
    const [name, rest] = line.split(":");
    if (!rest || name === undefined || name.trim() !== interfaceName) continue;
    const fields = rest.trim().split(/\s+/);
    // status, link, level, noise — the trailing dot is part of the format.
    const level = Number.parseFloat((fields[2] ?? "").replace(/\.$/, ""));
    if (!Number.isFinite(level)) return undefined;
    // Some drivers report an unsigned byte instead of a signed dBm value.
    const dbm = level > 0 ? level - 256 : level;
    return dbm >= -120 && dbm <= 0 ? Math.round(dbm) : undefined;
  }
  return undefined;
}

/** Link speed in Mbit/s from a sysfs `speed` file. */
export function parseLinkSpeedMbps(value: string): number | undefined {
  const speed = Number.parseInt(value.trim(), 10);
  // The kernel writes -1 when the speed is unknown, which is not a speed.
  return Number.isFinite(speed) && speed > 0 ? speed : undefined;
}

export interface PowerSupplyReading {
  type: string;
  online?: boolean;
  capacityPercent?: number;
}

/**
 * Power source from the set of supplies sysfs exposes. A battery present and
 * discharging is the only case reported as battery: a signage box on mains with
 * a topped-up battery is on mains, and saying otherwise would make every
 * laptop-class device look like it was about to die.
 */
export function classifyPowerSource(supplies: PowerSupplyReading[]): {
  powerSource?: TelemetryGauges["powerSource"];
  batteryPercent?: number;
} {
  const battery = supplies.find((supply) => supply.type === "Battery");
  const mains = supplies.find((supply) => supply.type === "Mains");
  const ups = supplies.find((supply) => supply.type === "UPS");

  const batteryPercent = battery?.capacityPercent;
  if (ups?.online === true) return { powerSource: "ups", batteryPercent };
  if (mains?.online === true) return { powerSource: "mains", batteryPercent };
  if (mains?.online === false && battery) {
    return { powerSource: "battery", batteryPercent };
  }
  // No supply is visible at all: most fixed-install signage boxes report
  // nothing here, and "mains" would be an assumption rather than a reading.
  if (supplies.length === 0) return {};
  return { powerSource: "unknown", batteryPercent };
}

export interface NetworkLinkStatus {
  networkLinkType?: LinkType;
  wifiSignalDbm?: number;
  wifiLinkSpeedMbps?: number;
  /** The interface name, for logging only. Never reported to the server. */
  interfaceName?: string;
}

async function readFile(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The link the default route uses, or an empty reading off Linux. */
export async function readNetworkLinkStatus(): Promise<NetworkLinkStatus> {
  const route = await readFile("/proc/net/route");
  if (route === undefined) return {};
  const interfaceName = parseDefaultRouteInterface(route);
  if (!interfaceName) {
    // No default route is itself a fact: there is a stack but no path out.
    return { networkLinkType: "unknown" };
  }

  const wireless = await directoryExists(
    `/sys/class/net/${interfaceName}/wireless`,
  );
  const status: NetworkLinkStatus = {
    interfaceName,
    networkLinkType: classifyLinkType(interfaceName, wireless),
  };
  if (status.networkLinkType === "wifi") {
    const table = await readFile("/proc/net/wireless");
    if (table !== undefined) {
      status.wifiSignalDbm = parseWirelessSignalDbm(table, interfaceName);
    }
    const speed = await readFile(`/sys/class/net/${interfaceName}/speed`);
    if (speed !== undefined) {
      status.wifiLinkSpeedMbps = parseLinkSpeedMbps(speed);
    }
  }
  return status;
}

export interface WiredInterfaceStatus {
  /** A managed Ethernet interface exists and is up. */
  available: boolean;
  /** Its usable unicast IPv4 address, or "" when there is none. */
  ipv4: string;
  /** The interface name, for logging only. Never reported to the server. */
  interfaceName?: string;
}

/**
 * Pick the Ethernet interface whose IPv4 address group AirPlay RTP is sent to.
 *
 * This is deliberately separate from readNetworkLinkStatus above. That function
 * describes the *default-route* path, which is what the fleet's link-quality
 * telemetry means and must keep meaning; a temporary Wi-Fi sidecar must never
 * make those metrics describe the wrong interface. This one answers a different
 * question — "where can another display send this room's video" — and it has to
 * stay correct while a second, non-default Wi-Fi address exists.
 *
 * The default-route interface wins when it is itself Ethernet, because that is
 * the interface actually carrying Tilecast traffic. Otherwise the first
 * Ethernet-classified interface with a usable address is used, and the interfaces
 * are considered in name order so two probes on the same box agree.
 *
 * Nothing is guessed. A box with no Ethernet address reports none, and the server
 * then gives a precise AirPlay readiness error instead of being handed a
 * destination that cannot work.
 */
export function selectWiredInterface(
  interfaces: readonly {
    name: string;
    ipv4: string;
    linkType: LinkType;
  }[],
  defaultRouteInterface?: string,
): WiredInterfaceStatus {
  const ethernet = interfaces
    .filter((item) => item.linkType === "ethernet" && usableIpv4(item.ipv4))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (ethernet.length === 0) {
    // Distinguish "an Ethernet interface exists but has no address" from "no
    // Ethernet interface at all": the first is a DHCP or cabling problem and the
    // second is a hardware fact.
    const anyEthernet = interfaces.some((item) => item.linkType === "ethernet");
    return { available: anyEthernet, ipv4: "" };
  }
  const preferred =
    ethernet.find((item) => item.name === defaultRouteInterface) ??
    ethernet[0]!;
  return {
    available: true,
    ipv4: preferred.ipv4,
    interfaceName: preferred.name,
  };
}

/**
 * A usable group-RTP destination. Kept identical to the server's own check and to
 * the player's validIpv4 in presentation-network.ts, because a disagreement
 * between the two boundaries is how an unusable address gets through one of them.
 */
export function usableIpv4(value: string): boolean {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return false;
    const octet = Number(part);
    if (octet > 255) return false;
    octets.push(octet);
  }
  const [first, second] = octets as [number, number, number, number];
  // 0.x, loopback, multicast/reserved, and link-local are all addresses a
  // dual-homed box can hold and none of them is reachable from another display.
  return !(
    first === 0 ||
    first === 127 ||
    first >= 224 ||
    (first === 169 && second === 254)
  );
}

/** Read the wired Ethernet facts from the OS, with no subprocess. */
export async function readWiredInterfaceStatus(
  enumerate: () => Record<string, NodeInterfaceInfo[] | undefined> = () =>
    osNetworkInterfaces(),
): Promise<WiredInterfaceStatus> {
  const route = await readFile("/proc/net/route");
  // Off Linux there is no procfs and no wired fact to report. Returning nothing
  // is correct: a guessed address here would become a GStreamer destination.
  if (route === undefined) return { available: false, ipv4: "" };
  const defaultRouteInterface = parseDefaultRouteInterface(route);
  const candidates: { name: string; ipv4: string; linkType: LinkType }[] = [];
  const table = enumerate();
  for (const [name, addresses] of Object.entries(table)) {
    if (!addresses) continue;
    const wireless = await directoryExists(`/sys/class/net/${name}/wireless`);
    const linkType = classifyLinkType(name, wireless);
    const ipv4 = addresses.find(
      (address) =>
        (address.family === "IPv4" || address.family === 4) &&
        !address.internal,
    );
    candidates.push({ name, ipv4: ipv4?.address ?? "", linkType });
  }
  return selectWiredInterface(candidates, defaultRouteInterface);
}

/**
 * Whether the system clock is synchronized, from systemd-timesyncd's marker
 * file. Its absence means "not synchronized or not managed by timesyncd", which
 * is why an unreadable /run says unknown rather than unsynchronized.
 */
export async function readTimeSyncState(): Promise<
  TelemetryGauges["timeSyncState"]
> {
  if (!(await directoryExists("/run/systemd"))) return "unknown";
  try {
    await fs.stat("/run/systemd/timesync/synchronized");
    return "synchronized";
  } catch {
    return "unsynchronized";
  }
}

export async function readPowerStatus(): Promise<{
  powerSource?: TelemetryGauges["powerSource"];
  batteryPercent?: number;
}> {
  let names: string[];
  try {
    names = await fs.readdir("/sys/class/power_supply");
  } catch {
    return {};
  }
  const supplies: PowerSupplyReading[] = [];
  for (const name of names) {
    const base = `/sys/class/power_supply/${name}`;
    const type = (await readFile(`${base}/type`))?.trim();
    if (!type) continue;
    const online = (await readFile(`${base}/online`))?.trim();
    const capacity = (await readFile(`${base}/capacity`))?.trim();
    const percent =
      capacity === undefined ? NaN : Number.parseInt(capacity, 10);
    supplies.push({
      type,
      online: online === undefined ? undefined : online === "1",
      capacityPercent:
        Number.isFinite(percent) && percent >= 0 && percent <= 100
          ? percent
          : undefined,
    });
  }
  return classifyPowerSource(supplies);
}

/**
 * Every probe at once, for the reporting tick. One failing probe must not cost
 * the others: a box with no /proc/net/wireless still has a usable clock and
 * power reading.
 */
export async function readSystemDiagnostics(): Promise<TelemetryGauges> {
  const [link, timeSyncState, power] = await Promise.all([
    readNetworkLinkStatus().catch(() => ({}) as NetworkLinkStatus),
    readTimeSyncState().catch(
      () => "unknown" as TelemetryGauges["timeSyncState"],
    ),
    readPowerStatus().catch(() => ({})),
  ]);
  const { interfaceName, ...reportable } = link;
  if (interfaceName) {
    log.debug("default route interface", { interfaceName });
  }
  return { ...reportable, timeSyncState, ...power };
}
