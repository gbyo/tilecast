import type {
  CompanionCapabilities,
  CompanionResult,
} from "@tilecast/companion-protocol";

/**
 * One Companion-side capability source. Providers describe versioned
 * Player capabilities and invoke typed operations. The table is empty
 * in this foundation: the first real Companion capability ships with
 * an actual product need, and tests register fakes to prove the
 * bridge. Providers never see raw extension APIs; the worker calls
 * them with plain data and bounds their answers.
 */
export interface CompanionProvider {
  readonly id: string;
  describe(): CompanionCapabilities;
  invoke(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<CompanionResult>;
}

/** The shipped provider table. Empty on purpose; see above. */
export function shippedProviders(): CompanionProvider[] {
  return [];
}
