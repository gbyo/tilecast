import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Avatar, AvatarFallback } from "../components/ui/avatar";
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
    throw new Error(
      body.error?.message ?? "Tilecast could not update this account.",
    );
  }
  if (response.status === 204) return undefined as T;
  return ((await response.json()) as { data: T }).data;
}

// The list carries each account's multi-factor state so an administrator can
// see who is still unenrolled under a policy without opening every account.
type ManagedUser = User & { mfaEnrolled: boolean; mfaRequired: boolean };

function listUsers() {
  return userRequest<{ items: ManagedUser[]; total: number }>("/users", "");
}

import { ScreenScopeEditor } from "./ScreenScopeEditor";

const roleLabels: Record<UserRole, string> = {
  owner: "Owner",
  administrator: "Administrator",
  editor: "Editor",
  contributor: "Contributor",
  viewer: "Viewer",
};

// Roles are a hierarchy of what an account can put in front of people, so the
// difference between the two content roles is worth spelling out where somebody
// is choosing between them.
const roleDescriptions: Record<UserRole, string> = {
  owner: "Everything, including backups and integration tokens.",
  administrator: "Everything except Owner-only system operations.",
  editor: "Creates content, publishes it, and manages screens and playback.",
  contributor:
    "Creates and edits content, but cannot publish a Layout, delete anything, or put content on a screen.",
  viewer: "Reads only.",
};

export function UsersPage() {
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
    queryFn: listUsers,
    enabled: canManage,
  });
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("viewer");
  const [editing, setEditing] = useState<ManagedUser>();
  const create = useMutation({
    mutationFn: (input: UserInput) =>
      userRequest<User>("/users", csrf, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      toast.add({ title: "User created.", type: "success" });
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
        <AlertDescription>
          Owner or Administrator access is required to manage Studio users.
        </AlertDescription>
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
            Add a user
          </h2>
          <p className="text-sm text-muted-foreground">
            Passwords must contain at least 12 characters.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="users-add-name">Name</FieldLabel>
            <Input
              id="users-add-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="users-add-username">Username</FieldLabel>
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
              Temporary password
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
            <FieldLabel htmlFor="users-add-role">Role</FieldLabel>
            <Select
              items={allowedRoles.map((value) => ({
                value,
                label: roleLabels[value],
              }))}
              value={role}
              onValueChange={(value) => setRole(value ?? "viewer")}
            >
              <SelectTrigger id="users-add-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allowedRoles.map((value) => (
                  <SelectItem key={value} value={value}>
                    {roleLabels[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{roleDescriptions[role]}</FieldDescription>
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
            {create.isPending ? "Adding…" : "Add user"}
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
          <Spinner aria-hidden="true" /> Loading users…
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
                    {roleLabels[user.role]} ·{" "}
                    {user.active ? "Active" : "Inactive"}
                    {user.lastLoginAt
                      ? ` · Last signed in ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(user.lastLoginAt))}`
                      : " · Never signed in"}
                  </ItemDescription>
                  <ItemDescription className="inline-flex items-center gap-1 text-xs">
                    {user.mfaEnrolled ? (
                      <>
                        <ShieldCheck size={13} aria-hidden="true" /> Two-step
                        verification on
                      </>
                    ) : user.mfaRequired ? (
                      <>
                        <ShieldAlert size={13} aria-hidden="true" /> Two-step
                        verification required, not yet enrolled
                      </>
                    ) : (
                      <>
                        <ShieldOff size={13} aria-hidden="true" /> No two-step
                        verification
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
                    <Pencil size={15} aria-hidden="true" /> Edit
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
      userRequest<User>(`/users/${user.id}`, csrf, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          username: username.trim(),
          role,
          active,
          ...(password ? { password } : {}),
        }),
      }),
    onSuccess: () => {
      toast.add({ title: "User updated.", type: "success" });
      void onChanged();
    },
  });
  const deactivate = useMutation({
    mutationFn: () =>
      userRequest<void>(`/users/${user.id}`, csrf, { method: "DELETE" }),
    onSuccess: () => {
      toast.add({ title: "User disabled.", type: "success" });
      void onChanged();
    },
  });
  const permanentlyDelete = useMutation({
    mutationFn: () =>
      userRequest<void>(`/users/${user.id}/permanent`, csrf, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.add({ title: "User permanently deleted.", type: "success" });
      void onChanged();
    },
  });
  // Tilecast has no email delivery, so there is no self-service factor reset.
  // An administrator clearing the factors is the ordinary recovery path.
  const resetSecurity = useMutation({
    mutationFn: () =>
      userRequest<void>(`/users/${user.id}/security/reset`, csrf, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.add({ title: "User sign-in factors reset.", type: "success" });
      void onChanged();
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
          <DialogTitle>Edit {user.name}</DialogTitle>
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
              <FieldLabel htmlFor="users-edit-name">Name</FieldLabel>
              <Input
                id="users-edit-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="users-edit-username">Username</FieldLabel>
              <Input
                id="users-edit-username"
                value={username}
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="users-edit-role">Role</FieldLabel>
              <Select
                items={allowedRoles.map((value) => ({
                  value,
                  label: roleLabels[value],
                }))}
                value={role}
                onValueChange={(value) => setRole(value ?? user.role)}
              >
                <SelectTrigger id="users-edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {allowedRoles.map((value) => (
                    <SelectItem key={value} value={value}>
                      {roleLabels[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="users-edit-password">
                New password
              </FieldLabel>
              <Input
                id="users-edit-password"
                type="password"
                value={password}
                placeholder="Leave unchanged"
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldDescription>At least 12 characters.</FieldDescription>
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
            <FieldLabel htmlFor="users-edit-active">Account active</FieldLabel>
          </Field>
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/50 p-4">
            <div className="grid gap-0.5">
              <strong className="text-sm font-semibold">
                Two-step verification
              </strong>
              <p className="text-sm text-muted-foreground">
                {user.mfaEnrolled
                  ? "This account has an authenticator app or a passkey enrolled."
                  : "This account has no second factor enrolled."}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={!user.mfaEnrolled || resetSecurity.isPending}
              onClick={() => {
                void confirm({
                  title: `Clear every authenticator, passkey, and recovery code for ${user.name}?`,
                  body: "They will be signed out everywhere and must enroll again.",
                  action: "Reset",
                  destructive: true,
                }).then((ok) => {
                  if (ok) resetSecurity.mutate();
                });
              }}
            >
              <ShieldOff size={15} aria-hidden="true" />
              {resetSecurity.isPending ? "Resetting…" : "Reset"}
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
            <h4 className="text-[13px] font-semibold">Screen scope</h4>
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
                    title: `Deactivate ${user.name}?`,
                    action: "Deactivate",
                    destructive: true,
                  }).then((ok) => {
                    if (ok) deactivate.mutate();
                  });
                }}
              >
                <UserRoundX size={15} aria-hidden="true" />
                {deactivate.isPending ? "Deactivating…" : "Deactivate"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto text-destructive hover:text-destructive"
                disabled={isSelf || permanentlyDelete.isPending}
                onClick={() => {
                  void confirm({
                    title: `Permanently delete ${user.name}?`,
                    body: "This removes their login, preferences, and security credentials. This cannot be undone.",
                    action: "Delete permanently",
                    destructive: true,
                  }).then((ok) => {
                    if (ok) permanentlyDelete.mutate();
                  });
                }}
              >
                <Trash2 size={15} aria-hidden="true" />
                {permanentlyDelete.isPending
                  ? "Deleting…"
                  : "Delete permanently"}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
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
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
