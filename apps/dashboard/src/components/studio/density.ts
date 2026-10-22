export type StudioDensity = "comfortable" | "compact";

export function studioDensity(value: unknown): StudioDensity {
  return value === "compact" ? "compact" : "comfortable";
}
