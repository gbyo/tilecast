import type { TFunction } from "i18next";
import type { ReliabilityStatus } from "../api/types";

// Fallback for a player too old to send its own limitation string, and for the
// group case where several displays fail for different reasons.
export function missingAirplayComponents(
  blocked: ReliabilityStatus[],
  t: TFunction<"alerts">,
) {
  const missing = [
    [
      "UxPlay",
      blocked.some((item) => item.airplayUxPlayInstalled === false),
    ] as const,
    [
      "GStreamer",
      blocked.some((item) => item.airplayGstreamerInstalled === false),
    ] as const,
    [
      t("airplay.missing.h264Decoder"),
      blocked.some((item) => item.airplayH264DecoderAvailable === false),
    ] as const,
    [
      "Avahi/Bonjour",
      blocked.some((item) => item.airplayAvahiAvailable === false),
    ] as const,
  ]
    .filter(([, absent]) => absent)
    .map(([name]) => name);
  if (missing.length === 0) return t("airplay.missing.installerAll");
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(", ")} ${t("airplay.missing.and")} ${missing[missing.length - 1]}`;
  return t("airplay.missing.list", { list });
}

export function airplayCapabilityBlockDetail(
  blocked: ReliabilityStatus[],
  t: TFunction<"alerts">,
) {
  const limitations = blocked
    .map((item) => item.airplayLimitation?.trim())
    .filter((value): value is string => Boolean(value));
  if (
    limitations.length === blocked.length &&
    limitations.every((value) => value === limitations[0])
  ) {
    return limitations[0];
  }
  return missingAirplayComponents(blocked, t);
}
