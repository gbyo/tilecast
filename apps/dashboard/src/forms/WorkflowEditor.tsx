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
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
import { Checkbox as RheaCheckbox } from "../components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { formToneBadgeProps } from "./formBadge";
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
    <div className="grid gap-4">
      {blocker.state === "blocked" && (
        <Alert>
          <AlertTitle>Leave without saving?</AlertTitle>
          <AlertDescription>The workflow has unsaved changes.</AlertDescription>
          <div className="flex flex-wrap gap-2">
            <RheaButton variant="ghost" onClick={() => blocker.reset?.()}>
              Stay
            </RheaButton>
            <RheaButton variant="default" onClick={() => blocker.proceed?.()}>
              Leave
            </RheaButton>
          </div>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Workflow not saved</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {errors.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Fix these before saving</AlertTitle>
          <AlertDescription>
            <ul className="grid gap-1">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <section className="grid gap-3" aria-label="States">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">States</h3>
          <RheaButton variant="secondary" size="sm" onClick={addState}>
            Add state
          </RheaButton>
        </div>
        {states.map((state, index) => {
          const locked = state.removable === false;
          return (
            <div
              key={index}
              className="grid gap-3 rounded-xl border border-border p-4"
            >
              <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
                <Field>
                  <FieldLabel htmlFor={`workflow-state-label-${index}`}>
                    Label
                  </FieldLabel>
                  <Input
                    id={`workflow-state-label-${index}`}
                    value={state.label}
                    onChange={(e) =>
                      updateState(index, { label: e.target.value })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`workflow-state-key-${index}`}>
                    Key
                  </FieldLabel>
                  <Input
                    id={`workflow-state-key-${index}`}
                    value={state.key}
                    disabled={locked}
                    onChange={(e) =>
                      updateState(index, {
                        key: slugifyStateKey(e.target.value),
                      })
                    }
                  />
                  <FieldDescription>
                    {locked ? "In use — locked" : "Lowercase, stable"}
                  </FieldDescription>
                </Field>
                <span className="sm:pb-1">
                  <Badge {...formToneBadgeProps("neutral")}>
                    {`${state.recordCount ?? 0} records`}
                  </Badge>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {/* The wrapping label names the radio; no extra aria-label. */}
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="initial-state"
                    className="size-4 shrink-0 accent-primary"
                    checked={state.initial}
                    onChange={() => setInitial(index)}
                  />
                  <span>Initial</span>
                </label>
                {/* Base UI names the span from the wrapping label. */}
                <label className="flex items-center gap-2 text-sm">
                  <RheaCheckbox
                    checked={state.eligibleForOutput}
                    onCheckedChange={(checked) =>
                      updateState(index, {
                        eligibleForOutput: checked === true,
                      })
                    }
                  />
                  <span>Output-eligible</span>
                </label>
                {/* Base UI names the span from the wrapping label. */}
                <label className="flex items-center gap-2 text-sm">
                  <RheaCheckbox
                    checked={state.terminal}
                    onCheckedChange={(checked) =>
                      updateState(index, { terminal: checked === true })
                    }
                  />
                  <span>Terminal</span>
                </label>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                    aria-label={`Move ${state.label} up`}
                    disabled={index === 0}
                    onClick={() => moveState(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                    aria-label={`Move ${state.label} down`}
                    disabled={index === states.length - 1}
                    onClick={() => moveState(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
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

      <section className="grid gap-3" aria-label="Transitions">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Transitions</h3>
          <RheaButton
            variant="secondary"
            size="sm"
            onClick={addTransition}
            disabled={states.length === 0}
          >
            Add transition
          </RheaButton>
        </div>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  From
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  To
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Label
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Required capability
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {transitions.map((transition, index) => (
                <tr
                  key={index}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-3 py-2">
                    <RheaSelect
                      value={transition.from}
                      onValueChange={(value) =>
                        updateTransition(index, { from: value ?? "" })
                      }
                    >
                      <SelectTrigger aria-label="From state">
                        <SelectValue>
                          {states.find((s) => s.key === transition.from)
                            ?.label ?? transition.from}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {states.map((s) => (
                          <SelectItem key={s.key} value={s.key}>
                            {s.label || s.key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </RheaSelect>
                  </td>
                  <td className="px-3 py-2">
                    <RheaSelect
                      value={transition.to}
                      onValueChange={(value) =>
                        updateTransition(index, { to: value ?? "" })
                      }
                    >
                      <SelectTrigger aria-label="To state">
                        <SelectValue>
                          {states.find((s) => s.key === transition.to)?.label ??
                            transition.to}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {states.map((s) => (
                          <SelectItem key={s.key} value={s.key}>
                            {s.label || s.key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </RheaSelect>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      value={transition.label}
                      onChange={(e) =>
                        updateTransition(index, { label: e.target.value })
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    <RheaSelect
                      value={transition.requiredCapability}
                      onValueChange={(value) =>
                        updateTransition(index, {
                          requiredCapability: value ?? "submit",
                        })
                      }
                    >
                      <SelectTrigger aria-label="Required capability">
                        <SelectValue>
                          {CAPABILITY_OPTIONS.find(
                            (option) =>
                              option.value === transition.requiredCapability,
                          )?.label ?? transition.requiredCapability}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {CAPABILITY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </RheaSelect>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                        aria-label="Move transition up"
                        disabled={index === 0}
                        onClick={() => moveTransition(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                        aria-label="Move transition down"
                        disabled={index === transitions.length - 1}
                        onClick={() => moveTransition(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                        aria-label={`Remove transition ${transition.label || index + 1}`}
                        onClick={() => removeTransition(index)}
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {confirming && warnings.length > 0 && (
        <Alert>
          <AlertTitle>
            This change affects output or submission paths
          </AlertTitle>
          <AlertDescription>
            <ul className="grid gap-1">
              {warnings.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </AlertDescription>
          <div className="flex flex-wrap gap-2">
            <RheaButton variant="ghost" onClick={() => setConfirming(false)}>
              Review again
            </RheaButton>
            <RheaButton
              variant="default"
              disabled={save.isPending}
              aria-busy={save.isPending || undefined}
              onClick={() => save.mutate()}
            >
              {save.isPending && <Spinner aria-hidden="true" />}
              Save anyway
            </RheaButton>
          </div>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <RheaButton
          variant="default"
          disabled={save.isPending || errors.length > 0 || !dirty}
          aria-busy={save.isPending || undefined}
          onClick={attemptSave}
        >
          {save.isPending && <Spinner aria-hidden="true" />}
          Save workflow
        </RheaButton>
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
    const pair = `${transition.from} ${transition.to}`;
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
