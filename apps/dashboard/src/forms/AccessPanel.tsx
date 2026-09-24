import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FormAccessEntry,
  FormCapability,
  FormDataSource,
  FormDirectoryUser,
} from "../api/types";
import { api } from "../api/client";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Checkbox } from "../components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { toast } from "../components/ui/toast";
import { expandCapabilities } from "./capabilities";
import { formToneBadgeProps } from "./formBadge";

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
      toast.add({ title: "Form access updated.", type: "success" });
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

  if (access.isLoading) return <Spinner aria-label="Loading access…" />;
  if (access.isError || !access.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load access</AlertTitle>
        <AlertDescription>
          {access.error instanceof Error
            ? access.error.message
            : "Please try again."}
        </AlertDescription>
      </Alert>
    );
  }
  const entries = access.data;
  const grantedUserIds = new Set(entries.map((entry) => entry.userId));

  return (
    <div className="grid gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Access change failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="overflow-x-auto rounded-xl border border-border">
        <Table className="w-full text-sm">
          <TableHeader>
            <TableRow className="border-b border-border text-left text-xs text-muted-foreground">
              <TableHead scope="col" className="px-3 py-2 font-medium">
                User
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Global role
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                Access
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
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
          </TableBody>
        </Table>
      </div>

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
      <TableRow className="border-b border-border last:border-0">
        <TableCell className="px-3 py-2">
          <div className="grid gap-0.5">
            <strong>{entry.name || entry.username}</strong>
            <div className="text-xs text-muted-foreground">
              @{entry.username}
            </div>
          </div>
        </TableCell>
        <TableCell className="px-3 py-2">{entry.role}</TableCell>
        <TableCell className="px-3 py-2">
          {implicitManager ? (
            <Badge {...formToneBadgeProps("info")}>
              {entry.isCreator ? "Manager (creator)" : "Manager (Owner)"}
            </Badge>
          ) : (
            <span className="flex flex-wrap gap-1">
              {entry.capabilities.map((cap) => (
                <Badge key={cap} {...formToneBadgeProps("neutral")}>
                  {capabilityLabel(cap)}
                </Badge>
              ))}
            </span>
          )}
        </TableCell>
        <TableCell className="px-3 py-2 text-right">
          {implicitManager ? (
            <span className="text-sm text-muted-foreground">
              Always a manager
            </span>
          ) : editing ? null : (
            <Button variant="ghost" size="sm" onClick={onEdit}>
              Edit access
            </Button>
          )}
        </TableCell>
      </TableRow>
      {editing && !implicitManager && (
        <TableRow className="border-b border-border last:border-0">
          <TableCell colSpan={4} className="px-3 py-2">
            <CapabilityEditor
              initial={entry.capabilities}
              saving={saving}
              onCancel={onCancel}
              onSave={onSave}
            />
          </TableCell>
        </TableRow>
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
    <section
      className="grid gap-3 rounded-xl border border-border p-4"
      aria-label="Grant access"
    >
      <h3 className="text-base font-semibold">Grant access</h3>
      <Field>
        <FieldLabel htmlFor="form-access-search">Find a user</FieldLabel>
        <Input
          id="form-access-search"
          value={search}
          placeholder="Search users"
          onChange={(event) => {
            setSearch(event.target.value);
            setSelected(null);
          }}
        />
        <FieldDescription>Search by name or username.</FieldDescription>
      </Field>
      {selected ? (
        <div className="grid gap-2 rounded-xl border border-border p-3">
          <p className="text-sm">
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
          <Spinner aria-label="Searching…" />
        ) : (directory.data ?? []).filter(
            (user) => !excludeUserIds.has(user.id),
          ).length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No matching users</EmptyTitle>
              <EmptyDescription>Try a different search.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-1">
            {(directory.data ?? [])
              .filter((user) => !excludeUserIds.has(user.id))
              .map((user) => (
                <Item
                  key={user.id}
                  variant="outline"
                  size="sm"
                  render={
                    <button
                      type="button"
                      className="w-full text-left hover:bg-muted"
                    />
                  }
                  onClick={() => setSelected(user)}
                >
                  <ItemContent>
                    <ItemTitle>{user.name || user.username}</ItemTitle>
                    <ItemDescription>
                      @{user.username} · {user.role}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
          </ItemGroup>
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
    <div className="grid gap-3">
      <ul className="grid gap-2">
        {CAPABILITIES.map((cap) => {
          const isImplied = implied.has(cap.value);
          const isChecked = checked.has(cap.value) || isImplied;
          return (
            <li key={cap.value} className="grid gap-0.5">
              {/* Base UI names the span from the wrapping label. */}
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={isChecked}
                  disabled={isImplied || saving}
                  onCheckedChange={() => toggle(cap.value)}
                />
                <span>{cap.label}</span>
              </label>
              <span className="pl-6 text-xs text-muted-foreground">
                {isImplied ? "Included by a broader capability." : cap.implies}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="default"
          disabled={saving}
          aria-busy={saving || undefined}
          onClick={() => onSave([...checked])}
        >
          {saving && <Spinner aria-hidden="true" />}
          Save access
        </Button>
      </div>
    </div>
  );
}

function capabilityLabel(cap: FormCapability): string {
  return CAPABILITIES.find((entry) => entry.value === cap)?.label ?? cap;
}
