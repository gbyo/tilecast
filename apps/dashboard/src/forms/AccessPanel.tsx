import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
import type { FormsT } from "./formSchema";

// Grantable capabilities in lattice order (broadest first), each with a plain-language implication.
// Display text lives in the forms locale; render sites translate labelKey/impliesKey.
type CapabilityLabelKey =
  | "access.capabilities.manage.label"
  | "access.capabilities.approve.label"
  | "access.capabilities.review.label"
  | "access.capabilities.viewAll.label"
  | "access.capabilities.viewOwn.label"
  | "access.capabilities.submit.label";

type CapabilityImpliesKey =
  | "access.capabilities.manage.implies"
  | "access.capabilities.approve.implies"
  | "access.capabilities.review.implies"
  | "access.capabilities.viewAll.implies";

const CAPABILITIES: {
  value: FormCapability;
  labelKey: CapabilityLabelKey;
  impliesKey?: CapabilityImpliesKey;
}[] = [
  {
    value: "manage",
    labelKey: "access.capabilities.manage.label",
    impliesKey: "access.capabilities.manage.implies",
  },
  {
    value: "approve",
    labelKey: "access.capabilities.approve.label",
    impliesKey: "access.capabilities.approve.implies",
  },
  {
    value: "review",
    labelKey: "access.capabilities.review.label",
    impliesKey: "access.capabilities.review.implies",
  },
  {
    value: "view_all",
    labelKey: "access.capabilities.viewAll.label",
    impliesKey: "access.capabilities.viewAll.implies",
  },
  { value: "view_own", labelKey: "access.capabilities.viewOwn.label" },
  { value: "submit", labelKey: "access.capabilities.submit.label" },
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
  const { t } = useTranslation(["forms", "common"]);
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
      setError(err instanceof Error ? err.message : t("access.updateError")),
  });

  if (access.isLoading) return <Spinner aria-label={t("access.loading")} />;
  if (access.isError || !access.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("access.loadError")}</AlertTitle>
        <AlertDescription>
          {access.error instanceof Error
            ? access.error.message
            : t("access.loadRetry")}
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
          <AlertTitle>{t("access.changeFailed")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="overflow-x-auto rounded-xl border border-border">
        <Table className="w-full text-sm">
          <TableHeader>
            <TableRow className="border-b border-border text-left text-xs text-muted-foreground">
              <TableHead scope="col" className="px-3 py-2 font-medium">
                {t("access.table.user")}
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                {t("access.table.globalRole")}
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                {t("access.table.access")}
              </TableHead>
              <TableHead scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">{t("access.table.actions")}</span>
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
  const { t } = useTranslation("forms");
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
              {entry.isCreator
                ? t("access.managerCreator")
                : t("access.managerOwner")}
            </Badge>
          ) : (
            <span className="flex flex-wrap gap-1">
              {entry.capabilities.map((cap) => (
                <Badge key={cap} {...formToneBadgeProps("neutral")}>
                  {capabilityLabel(cap, t)}
                </Badge>
              ))}
            </span>
          )}
        </TableCell>
        <TableCell className="px-3 py-2 text-right">
          {implicitManager ? (
            <span className="text-sm text-muted-foreground">
              {t("access.alwaysManager")}
            </span>
          ) : editing ? null : (
            <Button variant="ghost" size="sm" onClick={onEdit}>
              {t("access.editAccess")}
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
  const { t } = useTranslation("forms");
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
      aria-label={t("access.grant.title")}
    >
      <h3 className="text-base font-semibold">{t("access.grant.title")}</h3>
      <Field>
        <FieldLabel htmlFor="form-access-search">
          {t("access.grant.findUser")}
        </FieldLabel>
        <Input
          id="form-access-search"
          value={search}
          placeholder={t("access.grant.searchPlaceholder")}
          onChange={(event) => {
            setSearch(event.target.value);
            setSelected(null);
          }}
        />
        <FieldDescription>{t("access.grant.searchHint")}</FieldDescription>
      </Field>
      {selected ? (
        <div className="grid gap-2 rounded-xl border border-border p-3">
          <p className="text-sm">
            {t("access.grant.grantingTo")}{" "}
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
          <Spinner aria-label={t("access.grant.searching")} />
        ) : (directory.data ?? []).filter(
            (user) => !excludeUserIds.has(user.id),
          ).length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("access.grant.noMatch")}</EmptyTitle>
              <EmptyDescription>
                {t("access.grant.noMatchHint")}
              </EmptyDescription>
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
  const { t } = useTranslation(["forms", "common"]);
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
                <span>{t(cap.labelKey)}</span>
              </label>
              <span className="pl-6 text-xs text-muted-foreground">
                {isImplied
                  ? t("access.includedByBroader")
                  : cap.impliesKey
                    ? t(cap.impliesKey)
                    : null}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          {t("common:actions.cancel")}
        </Button>
        <Button
          variant="default"
          disabled={saving}
          aria-busy={saving || undefined}
          onClick={() => onSave([...checked])}
        >
          {saving && <Spinner aria-hidden="true" />}
          {t("access.saveAccess")}
        </Button>
      </div>
    </div>
  );
}

function capabilityLabel(cap: FormCapability, t: FormsT): string {
  const found = CAPABILITIES.find((entry) => entry.value === cap);
  return found ? t(found.labelKey) : cap;
}
