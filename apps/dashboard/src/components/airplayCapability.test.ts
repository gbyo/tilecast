import { describe, expect, it } from "vitest";
import type { ReliabilityStatus } from "../api/types";
import { i18n } from "../i18n";
import {
  airplayCapabilityBlockDetail,
  missingAirplayComponents,
} from "./airplayCapability";

const t = i18n.getFixedT("en", "alerts");

describe("AirPlay capability diagnostics", () => {
  it("uses a player limitation only when every blocked display agrees", () => {
    expect(
      airplayCapabilityBlockDetail(
        [
          { airplayLimitation: "UxPlay is missing." } as ReliabilityStatus,
          { airplayLimitation: "UxPlay is missing." } as ReliabilityStatus,
        ],
        t,
      ),
    ).toBe("UxPlay is missing.");

    expect(
      airplayCapabilityBlockDetail(
        [
          { airplayLimitation: "UxPlay is missing." } as ReliabilityStatus,
          { airplayLimitation: "Avahi is unavailable." } as ReliabilityStatus,
        ],
        t,
      ),
    ).toContain("/install-airplay.sh");
  });

  it("falls back to reported component flags for older players", () => {
    expect(
      missingAirplayComponents(
        [
          { airplayUxPlayInstalled: false, airplayGstreamerInstalled: false },
        ] as ReliabilityStatus[],
        t,
      ),
    ).toBe(
      "Missing UxPlay and GStreamer. Run the server's /install-airplay.sh installer as root.",
    );
  });
});
