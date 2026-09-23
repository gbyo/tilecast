import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  FormCapability,
  FormDataSource,
  FormWorkflowState,
  FormWorkflowTransition,
} from "../api/types";
import { api } from "../api/client";
import {
  Button,
  Checkbox,
  Field,
  Input,
  Notice,
  Select,
  StatusBadge,
  TableContainer,
} from "../components/legacy-ui";
import { slugifyKey } from "./formKeys";

const CAPABILITY_OPTIONS: { value: FormCapability; label: string }[] = [
  { value: "submit", label: "Submit" },
  { value: "review", label: "Review" },
  { value: "approve", label: "Approve" },
  { value: "manage", label: "Manage" },
  { value: "view_all", label: "View all" },
  { value: "view_own", label: "View own" },
];

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

// WorkflowEditor is an accessible workflow editor built from state cards and a transition table (no
// canvas or drag). Keys and deletion are locked for states referenced by records; validation mirrors
// the server; and changes affecting output eligibility or submission paths prompt a warning.
export function WorkflowEditor({
  form,
  csrf,
}: {
  form: FormDataSource;
  csrf: string;
}) {
  const queryClient = useQueryClient();
  const original = useRef(form.workflow);
  const [states, setStates] = useState<FormWorkflowState[]>(() =>
    form.workflow.states.map((s) => ({ ...s })),
  );
  const [transitions, setTransitions] = useState<FormWorkflowTransition[]>(() =>
    form.workflow.transitions.map((t) => ({ ...t })),
  );
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const baseline = useRef(JSON.stringify(form.workflow));
  const current = JSON.stringify({ states, transitions });
  const dirty = current !== baseline.current;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
  );

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const errors = useMemo(
    () => validateWorkflow(states, transitions),
    [states, transitions],
  );
  const warnings = useMemo(
    () =>
      impactWarnings(
        original.current.states,
        original.current.transitions,
        states,
        transitions,
      ),
    [states, transitions],
  );

  const save = useMutation({
    mutationFn: () =>
      api.configureFormWorkflow(
        form.id,
        {
          states: states.map((s, index) => ({ ...s, position: index })),
          transitions: transitions.map((t, index) => ({
            ...t,
            position: index,
          })),
        },
        csrf,
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(["form-data-source", form.id], updated);
      void queryClient.invalidateQueries({
        queryKey: ["form-records", form.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["form-outputs", form.id],
      });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      original.current = updated.workflow;
      baseline.current = JSON.stringify({
        states: updated.workflow.states,
        transitions: updated.workflow.transitions,
      });
      setStates(updated.workflow.states.map((s) => ({ ...s })));
      setTransitions(updated.workflow.transitions.map((t) => ({ ...t })));
      setConfirming(false);
      setError("");
    },
    onError: (err) => {
      setConfirming(false);
      setError(
        err instanceof Error ? err.message : "Could not save the workflow.",
      );
    },
  });

  const attemptSave = () => {
    if (errors.length > 0) return;
    if (warnings.length > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    save.mutate();
  };

  const updateState = (index: number, patch: Partial<FormWorkflowState>) =>
    setStates((prev) =>
      prev.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    );
  const setInitial = (index: number) =>
    setStates((prev) => prev.map((s, i) => ({ ...s, initial: i === index })));
  const moveState = (index: number, delta: number) =>
    setStates((prev) => reorder(prev, index, delta));
  const addState = () =>
    setStates((prev) => [
      ...prev,
      {
        key: "",
        label: "New state",
        position: prev.length,
        eligibleForOutput: false,
        initial: false,
        terminal: false,
        recordCount: 0,
        removable: true,
      },
    ]);
  const removeState = (index: number) =>
    setStates((prev) => prev.filter((_, i) => i !== index));

  const updateTransition = (
    index: number,
    patch: Partial<FormWorkflowTransition>,
  ) =>
    setTransitions((prev) =>
      prev.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    );
  const moveTransition = (index: number, delta: number) =>
    setTransitions((prev) => reorder(prev, index, delta));
  const addTransition = () =>
    setTransitions((prev) => [
      ...prev,
      {
        from: states[0]?.key ?? "",
        to: states[0]?.key ?? "",
        label: "New transition",
        requiredCapability: "submit",
        position: prev.length,
      },
    ]);
  const removeTransition = (index: number) =>
    setTransitions((prev) => prev.filter((_, i) => i !== index));

  return (
    <div className="form-workflow">
      {blocker.state === "blocked" && (
        <Notice
          variant="warning"
          title="Leave without saving?"
          action={
            <div className="form-builder__confirm-actions">
              <Button variant="quiet" onClick={() => blocker.reset?.()}>
                Stay
              </Button>
              <Button variant="primary" onClick={() => blocker.proceed?.()}>
                Leave
              </Button>
            </div>
          }
        >
          The workflow has unsaved changes.
        </Notice>
      )}
      {error && (
        <Notice variant="danger" title="Workflow not saved">
          {error}
        </Notice>
      )}
      {errors.length > 0 && (
        <Notice variant="danger" title="Fix these before saving">
          <ul>
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Notice>
      )}

      <section className="form-workflow__states" aria-label="States">
        <div className="form-workflow__section-head">
          <h3>States</h3>
          <Button variant="secondary" compact onClick={addState}>
            Add state
          </Button>
        </div>
        {states.map((state, index) => {
          const locked = state.removable === false;
          return (
            <div key={index} className="form-workflow__state-card">
              <div className="form-workflow__state-main">
                <Field label="Label">
                  <Input
                    value={state.label}
                    onChange={(e) =>
                      updateState(index, { label: e.target.value })
                    }
                  />
                </Field>
                <Field
                  label="Key"
                  description={locked ? "In use — locked" : "Lowercase, stable"}
                >
                  <Input
                    value={state.key}
                    disabled={locked}
                    onChange={(e) =>
                      updateState(index, {
                        key: slugifyStateKey(e.target.value),
                      })
                    }
                  />
                </Field>
                <span className="form-workflow__count">
                  <StatusBadge
                    label={`${state.recordCount ?? 0} records`}
                    tone="neutral"
                  />
                </span>
              </div>
              <div className="form-workflow__state-flags">
                <label className="checkbox-control">
                  <input
                    type="radio"
                    name="initial-state"
                    checked={state.initial}
                    onChange={() => setInitial(index)}
                  />
                  <span>Initial</span>
                </label>
                <Checkbox
                  label="Output-eligible"
                  checked={state.eligibleForOutput}
                  onChange={(e) =>
                    updateState(index, { eligibleForOutput: e.target.checked })
                  }
                />
                <Checkbox
                  label="Terminal"
                  checked={state.terminal}
                  onChange={(e) =>
                    updateState(index, { terminal: e.target.checked })
                  }
                />
                <div className="form-workflow__state-actions">
                  <button
                    type="button"
                    aria-label={`Move ${state.label} up`}
                    disabled={index === 0}
                    onClick={() => moveState(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${state.label} down`}
                    disabled={index === states.length - 1}
                    onClick={() => moveState(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${state.label}`}
                    disabled={locked}
                    title={locked ? "Referenced by records" : "Delete state"}
                    onClick={() => removeState(index)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <section className="form-workflow__transitions" aria-label="Transitions">
        <div className="form-workflow__section-head">
          <h3>Transitions</h3>
          <Button
            variant="secondary"
            compact
            onClick={addTransition}
            disabled={states.length === 0}
          >
            Add transition
          </Button>
        </div>
        <TableContainer>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Label</th>
                <th scope="col">Required capability</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {transitions.map((transition, index) => (
                <tr key={index}>
                  <td>
                    <Select
                      aria-label="From state"
                      value={transition.from}
                      onChange={(e) =>
                        updateTransition(index, { from: e.target.value })
                      }
                    >
                      {states.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label || s.key}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Select
                      aria-label="To state"
                      value={transition.to}
                      onChange={(e) =>
                        updateTransition(index, { to: e.target.value })
                      }
                    >
                      {states.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label || s.key}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Input
                      aria-label="Transition label"
                      value={transition.label}
                      onChange={(e) =>
                        updateTransition(index, { label: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <Select
                      aria-label="Required capability"
                      value={transition.requiredCapability}
                      onChange={(e) =>
                        updateTransition(index, {
                          requiredCapability: e.target.value as FormCapability,
                        })
                      }
                    >
                      {CAPABILITY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="form-workflow__row-actions">
                    <button
                      type="button"
                      aria-label="Move transition up"
                      disabled={index === 0}
                      onClick={() => moveTransition(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Move transition down"
                      disabled={index === transitions.length - 1}
                      onClick={() => moveTransition(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label="Delete transition"
                      onClick={() => removeTransition(index)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      </section>

      {confirming && warnings.length > 0 && (
        <Notice
          variant="warning"
          title="This change affects output or submission paths"
          action={
            <div className="form-builder__confirm-actions">
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                Review again
              </Button>
              <Button
                variant="primary"
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                Save anyway
              </Button>
            </div>
          }
        >
          <ul>
            {warnings.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="form-workflow__actions">
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={save.isPending || errors.length > 0 || !dirty}
          onClick={attemptSave}
        >
          Save workflow
        </Button>
      </div>
    </div>
  );
}

function reorder<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

function slugifyStateKey(value: string): string {
  return slugifyKey(value).slice(0, 40);
}

// validateWorkflow mirrors the server rules so the editor blocks an invalid save up front.
function validateWorkflow(
  states: FormWorkflowState[],
  transitions: FormWorkflowTransition[],
): string[] {
  const errors: string[] = [];
  if (states.length === 0) errors.push("Add at least one state.");
  const keys = new Set<string>();
  let initialCount = 0;
  let eligibleCount = 0;
  for (const state of states) {
    if (!KEY_PATTERN.test(state.key)) {
      errors.push(
        `State key "${state.key || "(empty)"}" is invalid (lowercase letters, digits, underscores).`,
      );
    }
    if (keys.has(state.key)) errors.push(`Duplicate state key "${state.key}".`);
    keys.add(state.key);
    if (state.label.trim() === "") errors.push("Every state needs a label.");
    if (state.initial) initialCount += 1;
    if (state.eligibleForOutput) eligibleCount += 1;
  }
  if (initialCount !== 1)
    errors.push("Exactly one state must be the initial state.");
  if (eligibleCount === 0)
    errors.push("At least one state must be output-eligible.");
  const seen = new Set<string>();
  for (const transition of transitions) {
    if (!keys.has(transition.from) || !keys.has(transition.to)) {
      errors.push("Every transition must reference existing states.");
    }
    const pair = `${transition.from} ${transition.to}`;
    if (seen.has(pair))
      errors.push(
        `Duplicate transition ${transition.from} → ${transition.to}.`,
      );
    seen.add(pair);
  }
  return Array.from(new Set(errors));
}

// impactWarnings surfaces changes that affect signage output or who can submit, so the manager can
// confirm before applying them.
function impactWarnings(
  originalStates: FormWorkflowState[],
  originalTransitions: FormWorkflowTransition[],
  states: FormWorkflowState[],
  transitions: FormWorkflowTransition[],
): string[] {
  const warnings: string[] = [];
  const originalEligible = new Set(
    originalStates.filter((s) => s.eligibleForOutput).map((s) => s.key),
  );
  const nextEligible = new Set(
    states.filter((s) => s.eligibleForOutput).map((s) => s.key),
  );
  for (const key of originalEligible) {
    if (!nextEligible.has(key))
      warnings.push(
        `State "${key}" is no longer output-eligible; its records will leave signage.`,
      );
  }
  for (const key of nextEligible) {
    if (!originalEligible.has(key))
      warnings.push(
        `State "${key}" is now output-eligible; its records may appear on signage.`,
      );
  }
  const submitKey = (t: FormWorkflowTransition) => `${t.from}→${t.to}`;
  const originalSubmit = new Set(
    originalTransitions
      .filter((t) => t.requiredCapability === "submit")
      .map(submitKey),
  );
  const nextSubmit = new Set(
    transitions.filter((t) => t.requiredCapability === "submit").map(submitKey),
  );
  if (
    originalSubmit.size !== nextSubmit.size ||
    [...nextSubmit].some((k) => !originalSubmit.has(k))
  ) {
    warnings.push(
      "Submission paths changed; this affects how submitters move records.",
    );
  }
  return warnings;
}
