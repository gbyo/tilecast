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
import type { ManagedUser, User } from "../api/types";
import {
  createUser,
  deactivateUser,
  listUsers,
  permanentlyDeleteUser,
  updateUser,
} from "../api/domains/system";
import { resetUserSecurity } from "../api/domains/auth";
import { ApiError, FALLBACK_REQUEST_MESSAGE } from "../api/errors";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Avatar, AvatarFallback } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
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
// Server envelope errors already carry a message; anything else (network
// failure, malformed payload) falls back to localized page text.
async function withUserError<T>(
  promise: Promise<T>,
  fallbackMessage: string,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status > 0 &&
      error.message !== FALLBACK_REQUEST_MESSAGE
    ) {
      throw error;
    }
    throw new Error(fallbackMessage, { cause: error });
  }
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
    queryFn: () => withUserError(listUsers(), t("users.errors.requestFailed")),
    enabled: canManage,
  });
  const [editing, setEditing] = useState<ManagedUser>();
  const [createOpen, setCreateOpen] = useState(false);

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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <Plus size={16} aria-hidden="true" /> {t("users.addForm.submit")}
        </Button>
      </div>

      {createOpen && (
        <UserCreateDialog
          allowedRoles={allowedRoles}
          csrf={csrf}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            await client.invalidateQueries({ queryKey: ["users"] });
            setCreateOpen(false);
          }}
        />
      )}

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
              <Item key={user.id} variant="outline">
                <ItemMedia variant="icon" className="size-9">
                  <Avatar className="size-9" aria-hidden="true">
                    <AvatarFallback>{nameInitials(user.name)}</AvatarFallback>
                  </Avatar>
                </ItemMedia>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle className="truncate">{user.name}</ItemTitle>
                  <ItemDescription>{user.username}</ItemDescription>
                  <ItemDescription className="text-xs">
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
                  </ItemDescription>
                  <ItemDescription className="inline-flex items-center gap-1 text-xs">
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
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
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
                </ItemActions>
              </Item>
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

function UserCreateDialog({
  allowedRoles,
  csrf,
  onClose,
  onCreated,
}: {
  allowedRoles: UserRole[];
  csrf: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { t } = useTranslation(["account", "common"]);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("viewer");
  const create = useMutation({
    mutationFn: (input: UserInput) =>
      withUserError(
        createUser(
          {
            name: input.name,
            username: input.username,
            password: input.password ?? "",
            role: input.role,
            ...(input.active === undefined ? {} : { active: input.active }),
          },
          csrf,
        ),
        t("users.errors.requestFailed"),
      ),
    onSuccess: async () => {
      toast.add({ title: t("users.toasts.created"), type: "success" });
      await onCreated();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("users.addForm.title")}</DialogTitle>
          <DialogDescription>
            {t("users.addForm.passwordHint")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({
              name: name.trim(),
              username: username.trim(),
              password,
              role,
            });
          }}
        >
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
              <FieldDescription>
                {t(roleDescriptionKeys[role])}
              </FieldDescription>
            </Field>
          </div>
          {create.error && (
            <Alert variant="destructive">
              <AlertDescription role="alert">
                {create.error.message}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={
                create.isPending ||
                name.trim().length < 2 ||
                username.trim().length < 3 ||
                password.length < 12
              }
            >
              <Plus size={16} aria-hidden="true" />{" "}
              {create.isPending
                ? t("users.addForm.submitting")
                : t("users.addForm.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function nameInitials(name: string) {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0]?.toLocaleUpperCase() ?? "")
    .join("");
  return initials || "?";
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
      withUserError(
        updateUser(
          user.id,
          {
            name: name.trim(),
            username: username.trim(),
            role,
            active,
            ...(password ? { password } : {}),
          },
          csrf,
        ),
        t("users.errors.requestFailed"),
      ),
    onSuccess: async () => {
      toast.add({ title: t("users.toasts.updated"), type: "success" });
      await onChanged();
    },
  });
  const deactivate = useMutation({
    mutationFn: () =>
      withUserError(
        deactivateUser(user.id, csrf),
        t("users.errors.requestFailed"),
      ),
    onSuccess: async () => {
      toast.add({ title: t("users.toasts.disabled"), type: "success" });
      await onChanged();
    },
  });
  const permanentlyDelete = useMutation({
    mutationFn: () =>
      withUserError(
        permanentlyDeleteUser(user.id, csrf),
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
      withUserError(
        resetUserSecurity(user.id, csrf),
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
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto">
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
