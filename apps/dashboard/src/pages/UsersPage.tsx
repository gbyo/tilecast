import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Pencil,
  Plus,
  Save,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserRoundX,
} from "lucide-react";
import type { User } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { ItemGroup } from "../components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import { useFormatLocale } from "../i18n";

type UserRole = User["role"];
type UserInput = {
  name: string;
  username: string;
  role: UserRole;
  active?: boolean;
  password?: string;
};
type ErrorResponse = { error?: { message?: string } };

async function userRequest<T>(
  path: string,
  csrfToken: string,
  init?: RequestInit,
  fallbackMessage?: string,
) {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(body.error?.message ?? fallbackMessage);
  }
  if (response.status === 204) return undefined as T;
  return ((await response.json()) as { data: T }).data;
}

// The list carries each account's multi-factor state so an administrator can
// see who is still unenrolled under a policy without opening every account.
type ManagedUser = User & { mfaEnrolled: boolean; mfaRequired: boolean };

function listUsers(fallbackMessage: string) {
  return userRequest<{ items: ManagedUser[]; total: number }>(
    "/users",
    "",
    undefined,
    fallbackMessage,
  );
}

import { ScreenScopeEditor } from "./ScreenScopeEditor";

// Role structures hold translation keys, never rendered text. Labels are
// resolved with t() at render so the page follows language changes.
const roleKeys = {
  owner: "roles.owner",
  administrator: "roles.administrator",
  editor: "roles.editor",
  contributor: "roles.contributor",
  viewer: "roles.viewer",
} as const satisfies Record<UserRole, string>;

// Roles are a hierarchy of what an account can put in front of people, so the
// difference between the two content roles is worth spelling out where somebody
// is choosing between them.
const roleDescriptionKeys = {
  owner: "roles.descriptions.owner",
  administrator: "roles.descriptions.administrator",
  editor: "roles.descriptions.editor",
  contributor: "roles.descriptions.contributor",
  viewer: "roles.descriptions.viewer",
} as const satisfies Record<UserRole, string>;

export function UsersPage() {
  const { t } = useTranslation(["account", "common"]);
  const locale = useFormatLocale();
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const currentUser = auth.status?.user;
  const canManage = ["owner", "administrator"].includes(
    currentUser?.role ?? "",
  );
  const isOwner = currentUser?.role === "owner";
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => listUsers(t("users.errors.requestFailed")),
    enabled: canManage,
  });
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("viewer");
  const [editing, setEditing] = useState<ManagedUser>();
  const create = useMutation({
    mutationFn: (input: UserInput) =>
      userRequest<User>(
        "/users",
        csrf,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        t("users.errors.requestFailed"),
      ),
    onSuccess: async () => {
      toast.add({ title: t("users.toasts.created"), type: "success" });
      setName("");
      setUsername("");
      setPassword("");
      setRole("viewer");
      await client.invalidateQueries({ queryKey: ["users"] });
    },
  });

  if (!canManage) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("users.accessDenied")}</AlertDescription>
      </Alert>
    );
  }

  const allowedRoles: UserRole[] = isOwner
    ? ["owner", "administrator", "editor", "contributor", "viewer"]
    : ["editor", "contributor", "viewer"];

  return (
    <section className="grid content-start gap-4">
      <section
        className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5"
        aria-labelledby="add-user-title"
      >
        <div className="grid gap-0.5">
          <h2 id="add-user-title" className="text-sm font-semibold">
            {t("users.addForm.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("users.addForm.passwordHint")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="users-add-name">
              {t("users.addForm.nameLabel")}
            </FieldLabel>
            <Input
              id="users-add-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="users-add-username">
              {t("users.addForm.usernameLabel")}
            </FieldLabel>
            <Input
              id="users-add-username"
              value={username}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="users-add-password">
              {t("users.addForm.passwordLabel")}
            </FieldLabel>
            <Input
              id="users-add-password"
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="users-add-role">
              {t("users.addForm.roleLabel")}
            </FieldLabel>
            <Select
              items={allowedRoles.map((value) => ({
                value,
                label: t(roleKeys[value]),
              }))}
              value={role}
              onValueChange={(value) => setRole(value ?? "viewer")}
            >
              <SelectTrigger id="users-add-role">
                <SelectValue>{t(roleKeys[role])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {allowedRoles.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(roleKeys[value])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{t(roleDescriptionKeys[role])}</FieldDescription>
          </Field>
        </div>
        <div>
          <Button
            type="button"
            variant="default"
            disabled={
              create.isPending ||
              name.trim().length < 2 ||
              username.trim().length < 3 ||
              password.length < 12
            }
            onClick={() =>
              create.mutate({
                name: name.trim(),
                username: username.trim(),
                password,
                role,
              })
            }
          >
            <Plus size={16} aria-hidden="true" />{" "}
            {create.isPending
              ? t("users.addForm.submitting")
              : t("users.addForm.submit")}
          </Button>
        </div>
        {create.error && (
          <Alert variant="destructive">
            <AlertDescription role="alert">
              {create.error.message}
            </AlertDescription>
          </Alert>
        )}
      </section>

      {users.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" /> {t("users.list.loading")}
        </p>
      ) : users.error ? (
        <Alert variant="destructive">
          <AlertDescription role="alert">
            {users.error.message}
          </AlertDescription>
        </Alert>
      ) : (
        <ItemGroup className="gap-2">
          {users.data?.items?.map((user) => {
            const canEdit =
              currentUser?.role === "owner" ||
              (currentUser?.role === "administrator" &&
                ["editor", "contributor", "viewer"].includes(user.role));
            return (
              <article
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-4"
                key={user.id}
              >
                <span
                  className="grid size-9 flex-none place-items-center rounded-full bg-muted text-sm font-semibold"
                  aria-hidden="true"
                >
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="grid min-w-0 flex-1 gap-px">
                  <strong className="truncate text-sm font-semibold">
                    {user.name}
                  </strong>
                  <span className="truncate text-sm text-muted-foreground">
                    {user.username}
                  </span>
                  <small className="text-xs text-muted-foreground">
                    {t(roleKeys[user.role])} ·{" "}
                    {user.active
                      ? t("users.list.status.active")
                      : t("users.list.status.inactive")}
                    {user.lastLoginAt ? (
                      <>
                        {" · "}
                        {t("users.list.lastSignedIn", {
                          date: new Intl.DateTimeFormat(locale, {
                            dateStyle: "medium",
                          }).format(new Date(user.lastLoginAt)),
                        })}
                      </>
                    ) : (
                      <>
                        {" · "}
                        {t("users.list.neverSignedIn")}
                      </>
                    )}
                  </small>
                  <small className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    {user.mfaEnrolled ? (
                      <>
                        <ShieldCheck size={13} aria-hidden="true" />{" "}
                        {t("users.list.mfa.on")}
                      </>
                    ) : user.mfaRequired ? (
                      <>
                        <ShieldAlert size={13} aria-hidden="true" />{" "}
                        {t("users.list.mfa.required")}
                      </>
                    ) : (
                      <>
                        <ShieldOff size={13} aria-hidden="true" />{" "}
                        {t("users.list.mfa.off")}
                      </>
                    )}
                  </small>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!canEdit}
                  onClick={() => setEditing(user)}
                >
                  <Pencil size={15} aria-hidden="true" />{" "}
                  {t("common:actions.edit")}
                </Button>
              </article>
            );
          })}
        </ItemGroup>
      )}

      {editing && currentUser && (
        <UserEditorDialog
          user={editing}
          currentUser={currentUser}
          allowedRoles={
            isOwner ||
            ["editor", "contributor", "viewer"].includes(editing.role)
              ? allowedRoles
              : [editing.role]
          }
          csrf={csrf}
          onClose={() => setEditing(undefined)}
          onChanged={async () => {
            await client.invalidateQueries({ queryKey: ["users"] });
            setEditing(undefined);
          }}
        />
      )}
    </section>
  );
}

function UserEditorDialog({
  user,
  currentUser,
  allowedRoles,
  csrf,
  onClose,
  onChanged,
}: {
  user: ManagedUser;
  currentUser: User;
  allowedRoles: UserRole[];
  csrf: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation(["account", "common"]);
  const [name, setName] = useState(user.name);
  const [username, setUsername] = useState(user.username);
  const [role, setRole] = useState<UserRole>(user.role);
  const [active, setActive] = useState(user.active);
  const [password, setPassword] = useState("");
  useEffect(() => {
    setName(user.name);
    setUsername(user.username);
    setRole(user.role);
    setActive(user.active);
    setPassword("");
  }, [user]);
  const update = useMutation({
    mutationFn: () =>
      userRequest<User>(
        `/users/${user.id}`,
        csrf,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(),
            username: username.trim(),
            role,
            active,
            ...(password ? { password } : {}),
          }),
        },
        t("users.errors.requestFailed"),
      ),
    onSuccess: async () => {
      toast.add({ title: t("users.toasts.updated"), type: "success" });
      await onChanged();
    },
  });
  const deactivate = useMutation({
    mutationFn: () =>
      userRequest<void>(
        `/users/${user.id}`,
        csrf,
        { method: "DELETE" },
        t("users.errors.requestFailed"),
      ),
    onSuccess: async () => {
      toast.add({ title: t("users.toasts.disabled"), type: "success" });
      await onChanged();
    },
  });
  const permanentlyDelete = useMutation({
    mutationFn: () =>
      userRequest<void>(
        `/users/${user.id}/permanent`,
        csrf,
        {
          method: "DELETE",
        },
        t("users.errors.requestFailed"),
      ),
    onSuccess: async () => {
      toast.add({ title: t("users.toasts.deleted"), type: "success" });
      await onChanged();
    },
  });
  // Tilecast has no email delivery, so there is no self-service factor reset.
  // An administrator clearing the factors is the ordinary recovery path.
  const resetSecurity = useMutation({
    mutationFn: () =>
      userRequest<void>(
        `/users/${user.id}/security/reset`,
        csrf,
        {
          method: "POST",
        },
        t("users.errors.requestFailed"),
      ),
    onSuccess: async () => {
      toast.add({ title: t("users.toasts.securityReset"), type: "success" });
      await onChanged();
    },
  });
  const isSelf = user.id === currentUser.id;
  const { confirm, dialog: confirmDialog } = useConfirm();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        {confirmDialog}
        <DialogHeader>
          <DialogTitle>
            {t("users.editDialog.title", { name: user.name })}
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="users-edit-name">
                {t("users.editDialog.nameLabel")}
              </FieldLabel>
              <Input
                id="users-edit-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="users-edit-username">
                {t("users.editDialog.usernameLabel")}
              </FieldLabel>
              <Input
                id="users-edit-username"
                value={username}
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="users-edit-role">
                {t("users.editDialog.roleLabel")}
              </FieldLabel>
              <Select
                items={allowedRoles.map((value) => ({
                  value,
                  label: t(roleKeys[value]),
                }))}
                value={role}
                onValueChange={(value) => setRole(value ?? user.role)}
              >
                <SelectTrigger id="users-edit-role">
                  <SelectValue>{t(roleKeys[role])}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {allowedRoles.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(roleKeys[value])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="users-edit-password">
                {t("users.editDialog.passwordLabel")}
              </FieldLabel>
              <Input
                id="users-edit-password"
                type="password"
                value={password}
                placeholder={t("users.editDialog.passwordPlaceholder")}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldDescription>
                {t("users.editDialog.passwordHint")}
              </FieldDescription>
            </Field>
          </div>
          <Field
            data-disabled={isSelf}
            orientation="horizontal"
            className="items-center"
          >
            <Checkbox
              id="users-edit-active"
              checked={active}
              disabled={isSelf}
              onCheckedChange={(checked) => setActive(checked === true)}
            />
            <FieldLabel htmlFor="users-edit-active">
              {t("users.editDialog.activeLabel")}
            </FieldLabel>
          </Field>
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/50 p-4">
            <div className="grid gap-0.5">
              <strong className="text-sm font-semibold">
                {t("users.editDialog.mfaTitle")}
              </strong>
              <p className="text-sm text-muted-foreground">
                {user.mfaEnrolled
                  ? t("users.editDialog.mfaEnrolled")
                  : t("users.editDialog.mfaNotEnrolled")}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={!user.mfaEnrolled || resetSecurity.isPending}
              onClick={() => {
                void confirm({
                  title: t("users.editDialog.resetConfirmTitle", {
                    name: user.name,
                  }),
                  body: t("users.editDialog.resetConfirmBody"),
                  action: t("users.editDialog.resetAction"),
                  destructive: true,
                }).then((ok) => {
                  if (ok) resetSecurity.mutate();
                });
              }}
            >
              <ShieldOff size={15} aria-hidden="true" />{" "}
              {resetSecurity.isPending
                ? t("users.editDialog.resetting")
                : t("users.editDialog.resetAction")}
            </Button>
          </section>
          {(update.error ||
            deactivate.error ||
            permanentlyDelete.error ||
            resetSecurity.error) && (
            <Alert variant="destructive">
              <AlertDescription role="alert">
                {
                  (
                    update.error ??
                    deactivate.error ??
                    permanentlyDelete.error ??
                    resetSecurity.error
                  )?.message
                }
              </AlertDescription>
            </Alert>
          )}
          <section className="grid gap-2 border-t border-border py-3">
            <h4 className="text-[13px] font-semibold">
              {t("users.editDialog.scopeTitle")}
            </h4>
            <ScreenScopeEditor
              userId={user.id}
              userRole={role}
              csrf={csrf}
              disabled={role === "owner"}
            />
          </section>
          <DialogFooter className="flex-wrap">
            {user.active ? (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-destructive hover:text-destructive"
                disabled={isSelf || deactivate.isPending}
                onClick={() => {
                  void confirm({
                    title: t("users.editDialog.deactivateTitle", {
                      name: user.name,
                    }),
                    action: t("users.editDialog.deactivateAction"),
                    destructive: true,
                  }).then((ok) => {
                    if (ok) deactivate.mutate();
                  });
                }}
              >
                <UserRoundX size={15} aria-hidden="true" />{" "}
                {deactivate.isPending
                  ? t("users.editDialog.deactivating")
                  : t("users.editDialog.deactivateAction")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-destructive hover:text-destructive"
                disabled={isSelf || permanentlyDelete.isPending}
                onClick={() => {
                  void confirm({
                    title: t("users.editDialog.deleteTitle", {
                      name: user.name,
                    }),
                    body: t("users.editDialog.deleteBody"),
                    action: t("users.editDialog.deleteAction"),
                    destructive: true,
                  }).then((ok) => {
                    if (ok) permanentlyDelete.mutate();
                  });
                }}
              >
                <Trash2 size={15} aria-hidden="true" />{" "}
                {permanentlyDelete.isPending
                  ? t("users.editDialog.deleting")
                  : t("users.editDialog.deleteAction")}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={
                update.isPending ||
                name.trim().length < 2 ||
                username.trim().length < 3 ||
                (password.length > 0 && password.length < 12)
              }
            >
              <Save size={15} aria-hidden="true" />{" "}
              {update.isPending
                ? t("common:actions.saving")
                : t("common:actions.saveChanges")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
