import { promises as fs } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readNetworkLinkStatus } from "./system-probe";

const ETHERNET_DEFAULT_ROUTE = `Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0
`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("network link metrics", () => {
  it("does not report Ethernet speed as Wi-Fi link speed", async () => {
    const readFile = vi.spyOn(fs, "readFile");
    readFile.mockImplementation(
      (async (path: Parameters<typeof fs.readFile>[0]) => {
        const filename = String(path);
        if (filename === "/proc/net/route") return ETHERNET_DEFAULT_ROUTE;
        if (filename === "/sys/class/net/eth0/speed") return "1000\n";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }) as typeof fs.readFile,
    );
    vi.spyOn(fs, "stat").mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const status = await readNetworkLinkStatus();

    expect(status.networkLinkType).toBe("ethernet");
    expect(status.wifiLinkSpeedMbps).toBeUndefined();
    expect(readFile).not.toHaveBeenCalledWith(
      "/sys/class/net/eth0/speed",
      "utf8",
    );
  });
});
