import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FormAccessEntry,
  FormCapability,
  FormDataSource,
  FormDirectoryUser,
} from "../api/types";
import { api } from "../api/client";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Notice,
  Spinner,
  StatusBadge,
  TableContainer,
} from "../components/legacy-ui";
import { expandCapabilities } from "./capabilities";

// Grantable capabilities in lattice order (broadest first), each with a plain-language implication.
const CAPABILITIES: {
  value: FormCapability;
  label: string;
  implies: string;
}[] = [
  {
    value: "manage",
    label: "Manage",
    implies: "Full control — includes every ability below.",
  },
  {
    value: "approve",
    label: "Approve",
    implies: "Approve or reject — includes Review and View all.",
  },
  {
    value: "review",
    label: "Review",
    implies: "Request changes — includes View all.",
  },
  {
    value: "view_all",
    label: "View all responses",
    implies: "Includes View own.",
  },
  { value: "view_own", label: "View own responses", implies: "" },
  { value: "submit", label: "Submit responses", implies: "" },
];

// AccessPanel manages per-user access: one row per user with effective access, plus a searchable
// directory for granting access. Grants are replaced atomically; implied capabilities are shown as
// included rather than as separate required grants. The creator and global Owners are always
// Managers and cannot be edited.
export function AccessPanel({
  form,
  csrf,
}: {
  form: FormDataSource;
  csrf: string;
}) {
  const queryClient = useQueryClient();
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [error, setError] = useState("");

  const access = useQuery({
    queryKey: ["form-access", form.id],
    queryFn: () => api.listFormAccess(form.id),
  });

  const replace = useMutation({
    mutationFn: ({
      userId,
      caps,
    }: {
      userId: string;
      caps: FormCapability[];
    }) => api.replaceFormGrants(form.id, userId, caps, csrf),
    onSuccess: (entries) => {
      queryClient.setQueryData(["form-access", form.id], entries);
      void queryClient.invalidateQueries({
        queryKey: ["form-data-source", form.id],
      });
      setEditingUser(null);
      setError("");
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Could not update access."),
  });

  if (access.isLoading) return <Spinner label="Loading access…" />;
  if (access.isError || !access.data) {
    return (
      <Notice variant="danger" title="Could not load access">
        {access.error instanceof Error
          ? access.error.message
          : "Please try again."}
      </Notice>
    );
  }
  const entries = access.data;
  const grantedUserIds = new Set(entries.map((entry) => entry.userId));

  return (
    <div className="form-access">
      {error && (
        <Notice variant="danger" title="Access change failed">
          {error}
        </Notice>
      )}

      <TableContainer>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Global role</th>
              <th scope="col">Access</th>
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <AccessRow
                key={entry.userId}
                entry={entry}
                editing={editingUser === entry.userId}
                saving={replace.isPending}
                onEdit={() => {
                  setEditingUser(entry.userId);
                  setError("");
                }}
                onCancel={() => setEditingUser(null)}
                onSave={(caps) =>
                  replace.mutate({ userId: entry.userId, caps })
                }
              />
            ))}
          </tbody>
        </table>
      </TableContainer>

      <GrantAccess
        formId={form.id}
        excludeUserIds={grantedUserIds}
        saving={replace.isPending}
        onGrant={(userId, caps) => replace.mutate({ userId, caps })}
      />
    </div>
  );
}

function AccessRow({
  entry,
  editing,
  saving,
  onEdit,
  onCancel,
  onSave,
}: {
  entry: FormAccessEntry;
  editing: boolean;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (caps: FormCapability[]) => void;
}) {
  const implicitManager = entry.isCreator || entry.isGlobalOwner;
  return (
    <>
      <tr>
        <td>
          <strong>{entry.name || entry.username}</strong>
          <div className="form-access__username">@{entry.username}</div>
        </td>
        <td>{entry.role}</td>
        <td>
          {implicitManager ? (
            <StatusBadge
              label={entry.isCreator ? "Manager (creator)" : "Manager (Owner)"}
              tone="info"
            />
          ) : (
            <span className="form-access__caps">
              {entry.capabilities.map((cap) => (
                <StatusBadge
                  key={cap}
                  label={capabilityLabel(cap)}
                  tone="neutral"
                />
              ))}
            </span>
          )}
        </td>
        <td className="form-access__actions">
          {implicitManager ? (
            <span className="form-access__locked">Always a manager</span>
          ) : editing ? null : (
            <Button variant="quiet" compact onClick={onEdit}>
              Edit access
            </Button>
          )}
        </td>
      </tr>
      {editing && !implicitManager && (
        <tr>
          <td colSpan={4}>
            <CapabilityEditor
              initial={entry.capabilities}
              saving={saving}
              onCancel={onCancel}
              onSave={onSave}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function GrantAccess({
  formId,
  excludeUserIds,
  saving,
  onGrant,
}: {
  formId: string;
  excludeUserIds: Set<string>;
  saving: boolean;
  onGrant: (userId: string, caps: FormCapability[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<FormDirectoryUser | null>(null);
  const directory = useQuery({
    queryKey: ["form-user-directory", formId, search],
    queryFn: () => api.searchFormUsers(formId, search),
    enabled: search.trim().length > 0,
  });

  return (
    <section className="form-access__grant" aria-label="Grant access">
      <h3>Grant access</h3>
      <Field label="Find a user" description="Search by name or username.">
        <Input
          value={search}
          placeholder="Search users"
          onChange={(event) => {
            setSearch(event.target.value);
            setSelected(null);
          }}
        />
      </Field>
      {selected ? (
        <div className="form-access__grant-selected">
          <p>
            Granting access to{" "}
            <strong>{selected.name || selected.username}</strong> (@
            {selected.username})
          </p>
          <CapabilityEditor
            initial={["submit"]}
            saving={saving}
            onCancel={() => setSelected(null)}
            onSave={(caps) => {
              onGrant(selected.id, caps);
              setSelected(null);
              setSearch("");
            }}
          />
        </div>
      ) : search.trim().length > 0 ? (
        directory.isLoading ? (
          <Spinner label="Searching…" />
        ) : (directory.data ?? []).filter(
            (user) => !excludeUserIds.has(user.id),
          ).length === 0 ? (
          <EmptyState
            title="No matching users"
            message="Try a different search."
          />
        ) : (
          <ul className="form-access__directory">
            {(directory.data ?? [])
              .filter((user) => !excludeUserIds.has(user.id))
              .map((user) => (
                <li key={user.id}>
                  <button type="button" onClick={() => setSelected(user)}>
                    <strong>{user.name || user.username}</strong>
                    <span>
                      @{user.username} · {user.role}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

// CapabilityEditor renders the six grantable capabilities as checkboxes, showing implied ones as
// included (checked + disabled) so redundant grants are never presented as separate requirements.
function CapabilityEditor({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  initial: FormCapability[];
  saving: boolean;
  onCancel: () => void;
  onSave: (caps: FormCapability[]) => void;
}) {
  const [checked, setChecked] = useState<Set<FormCapability>>(
    () => new Set(initial),
  );
  const implied = useMemo(() => {
    const expanded = expandCapabilities([...checked]);
    for (const cap of checked) expanded.delete(cap);
    return expanded;
  }, [checked]);

  const toggle = (cap: FormCapability) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  };

  return (
    <div className="form-access__editor">
      <ul className="form-access__cap-list">
        {CAPABILITIES.map((cap) => {
          const isImplied = implied.has(cap.value);
          const isChecked = checked.has(cap.value) || isImplied;
          return (
            <li key={cap.value}>
              <Checkbox
                label={cap.label}
                checked={isChecked}
                disabled={isImplied || saving}
                onChange={() => toggle(cap.value)}
              />
              <span className="form-access__cap-implies">
                {isImplied ? "Included by a broader capability." : cap.implies}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="form-access__editor-actions">
        <Button variant="quiet" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={saving}
          onClick={() => onSave([...checked])}
        >
          Save access
        </Button>
      </div>
    </div>
  );
}

function capabilityLabel(cap: FormCapability): string {
  return CAPABILITIES.find((entry) => entry.value === cap)?.label ?? cap;
}
