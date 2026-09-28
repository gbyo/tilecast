/**
 * Authored setup: the Studio guidance copy a declarative Data Source
 * module ships. The shape mirrors Go's `Setup` in contentdefs: flat
 * presentation strings, nothing executable and no reference system.
 * There is no connection-records system; a field that carries a
 * connection ID is an ordinary configuration field, and the guide
 * describes it in prose like any other field.
 */

/** Authored setup guidance for a Data Source module. */
export interface SetupGuide {
  readonly eyebrow?: string;
  readonly tip?: string;
  readonly steps?: readonly string[];
  readonly emptyState?: string;
}

const MAX_EYEBROW = 80;
const MAX_TIP = 500;
const MAX_STEPS = 12;
const MAX_STEP = 280;
const MAX_EMPTY_STATE = 280;

/**
 * Validate authored setup copy bounds. Returns diagnostics; empty means
 * the guide fits the same limits the manifest schema enforces.
 */
export function setupGuideProblems(guide: SetupGuide | undefined): string[] {
  if (!guide) return [];
  const problems: string[] = [];
  if (guide.eyebrow !== undefined && guide.eyebrow.length > MAX_EYEBROW) {
    problems.push(`setup eyebrow is longer than ${MAX_EYEBROW} characters`);
  }
  if (guide.tip !== undefined && guide.tip.length > MAX_TIP) {
    problems.push(`setup tip is longer than ${MAX_TIP} characters`);
  }
  const steps = guide.steps ?? [];
  if (steps.length > MAX_STEPS) {
    problems.push(`setup declares more than ${MAX_STEPS} steps`);
  }
  for (const [index, step] of steps.entries()) {
    if (step.length === 0 || step.length > MAX_STEP) {
      problems.push(`setup step ${index} must be 1 to ${MAX_STEP} characters`);
    }
  }
  if (
    guide.emptyState !== undefined &&
    guide.emptyState.length > MAX_EMPTY_STATE
  ) {
    problems.push(
      `setup empty state is longer than ${MAX_EMPTY_STATE} characters`,
    );
  }
  return problems;
}
