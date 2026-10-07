import { expect, it } from "vitest";
import { takeRecoverySecret } from "./bootstrap";

it("scrubs history before reading the recovery capability", () => {
  const steps: string[] = [];
  const location = {
    hash: "#r=" + "a".repeat(43),
    pathname: "/player/slot",
    search: "",
  } as Location;
  const history = {
    replaceState: (_data: unknown, _unused: string, url: string) =>
      steps.push(url),
  } as unknown as History;
  expect(takeRecoverySecret(location, history)).toHaveLength(43);
  expect(steps).toEqual(["/player/slot"]);
});

it("also scrubs malformed or ambiguous recovery fragments", () => {
  let scrubbed = false;
  const location = {
    hash: "#r=invalid&r=other",
    pathname: "/player",
    search: "",
  } as Location;
  const history = {
    replaceState: () => {
      scrubbed = true;
    },
  } as unknown as History;
  expect(takeRecoverySecret(location, history)).toBeNull();
  expect(scrubbed).toBe(true);
});
