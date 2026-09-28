import type { FormWorkflow, FormWorkflowState } from "../types";

type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

// stateLabel resolves a workflow state key to its configured human label, falling back to the key.
export function stateLabel(
  workflow: FormWorkflow | undefined,
  key: string,
): string {
  const state = workflow?.states.find((candidate) => candidate.key === key);
  return state?.label ?? key;
}

// stateTone maps a workflow state to a StatusBadge tone using its configured semantics rather than
// hardcoded keys: output-eligible states read as success, terminal states as danger/neutral, the
// initial state as neutral, and everything else (in review) as info. The default "changes_requested"
// key is treated as a warning because it asks the submitter to act.
export function stateTone(
  workflow: FormWorkflow | undefined,
  key: string,
): StatusTone {
  const state = workflow?.states.find((candidate) => candidate.key === key);
  if (!state) return key === "changes_requested" ? "warning" : "neutral";
  if (state.eligibleForOutput) return "success";
  if (key === "changes_requested") return "warning";
  if (state.terminal) return key === "rejected" ? "danger" : "neutral";
  if (state.initial) return "neutral";
  return "info";
}

// isEditableState reports whether a state lets a submitter edit (it has an outgoing submit
// transition), mirroring the server's submitter-editable definition.
export function isEditableState(
  workflow: FormWorkflow | undefined,
  key: string,
): boolean {
  return Boolean(
    workflow?.transitions.some(
      (transition) =>
        transition.from === key && transition.requiredCapability === "submit",
    ),
  );
}

export function initialState(
  workflow: FormWorkflow | undefined,
): FormWorkflowState | undefined {
  return workflow?.states.find((state) => state.initial);
}
