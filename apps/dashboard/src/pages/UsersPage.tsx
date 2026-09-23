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
import { Dialog, Select } from "../components/legacy-ui";

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
      setName("");
      setUsername("");
      setPassword("");
      setRole("viewer");
      await client.invalidateQueries({ queryKey: ["users"] });
    },
  });

  if (!canManage) {
    return (
      <div className="notice notice--error">
        Owner or Administrator access is required to manage Studio users.
      </div>
    );
  }

  const allowedRoles: UserRole[] = isOwner
    ? ["owner", "administrator", "editor", "contributor", "viewer"]
    : ["editor", "contributor", "viewer"];

  return (
    <section className="user-management">
      <section
        className="user-management__form"
        aria-labelledby="add-user-title"
      >
        <h3 id="add-user-title">Add a user</h3>
        <p>Passwords must contain at least 12 characters.</p>
        <div className="user-management__fields">
          <label>
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Username
            <input
              value={username}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            Temporary password
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label>
            Role
            <Select
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
            >
              {allowedRoles.map((value) => (
                <option key={value} value={value}>
                  {roleLabels[value]}
                </option>
              ))}
            </Select>
            <small className="role-description">{roleDescriptions[role]}</small>
          </label>
          <button
            type="button"
            className="button button--primary"
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
            <Plus size={16} /> {create.isPending ? "Adding…" : "Add user"}
          </button>
        </div>
        {create.error && (
          <div className="notice notice--error" role="alert">
            {create.error.message}
          </div>
        )}
      </section>

      {users.isLoading ? (
        <div className="table-loading">Loading users…</div>
      ) : users.error ? (
        <div className="notice notice--error" role="alert">
          {users.error.message}
        </div>
      ) : (
        <div className="user-management__list">
          {users.data?.items?.map((user) => {
            const canEdit =
              currentUser?.role === "owner" ||
              (currentUser?.role === "administrator" &&
                ["editor", "contributor", "viewer"].includes(user.role));
            return (
              <article className="user-list-row" key={user.id}>
                <span className="avatar" aria-hidden="true">
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="user-list-row__identity">
                  <strong>{user.name}</strong>
                  <span>{user.username}</span>
                  <small>
                    {roleLabels[user.role]} ·{" "}
                    {user.active ? "Active" : "Inactive"}
                    {user.lastLoginAt
                      ? ` · Last signed in ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(user.lastLoginAt))}`
                      : " · Never signed in"}
                  </small>
                  <small className="user-list-row__mfa">
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
                  </small>
                </div>
                <button
                  type="button"
                  className="button button--secondary button--compact"
                  disabled={!canEdit}
                  onClick={() => setEditing(user)}
                >
                  <Pencil size={15} /> Edit
                </button>
              </article>
            );
          })}
        </div>
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
    onSuccess: onChanged,
  });
  const deactivate = useMutation({
    mutationFn: () =>
      userRequest<void>(`/users/${user.id}`, csrf, { method: "DELETE" }),
    onSuccess: onChanged,
  });
  const permanentlyDelete = useMutation({
    mutationFn: () =>
      userRequest<void>(`/users/${user.id}/permanent`, csrf, {
        method: "DELETE",
      }),
    onSuccess: onChanged,
  });
  // Tilecast has no email delivery, so there is no self-service factor reset.
  // An administrator clearing the factors is the ordinary recovery path.
  const resetSecurity = useMutation({
    mutationFn: () =>
      userRequest<void>(`/users/${user.id}/security/reset`, csrf, {
        method: "POST",
      }),
    onSuccess: onChanged,
  });
  const isSelf = user.id === currentUser.id;

  return (
    <Dialog open title={`Edit ${user.name}`} onClose={onClose}>
      <form
        className="user-edit-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate();
        }}
      >
        <div className="user-edit-dialog__fields">
          <label className="field">
            <span className="field__label">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Username</span>
            <input
              value={username}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Role</span>
            <Select
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
            >
              {allowedRoles.map((value) => (
                <option key={value} value={value}>
                  {roleLabels[value]}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span className="field__label">New password</span>
            <input
              type="password"
              value={password}
              placeholder="Leave unchanged"
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
            <span className="field__hint">At least 12 characters.</span>
          </label>
          <label className="checkbox-control">
            <input
              type="checkbox"
              checked={active}
              disabled={isSelf}
              onChange={(event) => setActive(event.target.checked)}
            />
            <span>Account active</span>
          </label>
        </div>
        <section className="user-edit-dialog__security">
          <div>
            <strong>Two-step verification</strong>
            <p>
              {user.mfaEnrolled
                ? "This account has an authenticator app or a passkey enrolled."
                : "This account has no second factor enrolled."}
            </p>
          </div>
          <button
            type="button"
            className="button button--danger-quiet"
            disabled={!user.mfaEnrolled || resetSecurity.isPending}
            onClick={() => {
              if (
                confirm(
                  `Clear every authenticator, passkey, and recovery code for ${user.name}? They will be signed out everywhere and must enroll again.`,
                )
              )
                resetSecurity.mutate();
            }}
          >
            <ShieldOff size={15} />
            {resetSecurity.isPending ? "Resetting…" : "Reset"}
          </button>
        </section>
        {(update.error ||
          deactivate.error ||
          permanentlyDelete.error ||
          resetSecurity.error) && (
          <div className="notice notice--error" role="alert">
            {
              (
                update.error ??
                deactivate.error ??
                permanentlyDelete.error ??
                resetSecurity.error
              )?.message
            }
          </div>
        )}
        <section className="user-edit-dialog__scope">
          <h4>Screen scope</h4>
          <ScreenScopeEditor
            userId={user.id}
            userRole={role}
            csrf={csrf}
            disabled={role === "owner"}
          />
        </section>
        <footer className="user-edit-dialog__actions">
          {user.active ? (
            <button
              type="button"
              className="button button--danger-quiet"
              disabled={isSelf || deactivate.isPending}
              onClick={() => {
                if (confirm(`Deactivate ${user.name}?`)) deactivate.mutate();
              }}
            >
              <UserRoundX size={15} />
              {deactivate.isPending ? "Deactivating…" : "Deactivate"}
            </button>
          ) : (
            <button
              type="button"
              className="button button--danger-quiet"
              disabled={isSelf || permanentlyDelete.isPending}
              onClick={() => {
                if (
                  confirm(
                    `Permanently delete ${user.name}? This removes their login, preferences, and security credentials. This cannot be undone.`,
                  )
                )
                  permanentlyDelete.mutate();
              }}
            >
              <Trash2 size={15} />
              {permanentlyDelete.isPending ? "Deleting…" : "Delete permanently"}
            </button>
          )}
          <span />
          <button
            type="button"
            className="button button--quiet"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={
              update.isPending ||
              name.trim().length < 2 ||
              username.trim().length < 3 ||
              (password.length > 0 && password.length < 12)
            }
          >
            <Save size={15} /> {update.isPending ? "Saving…" : "Save changes"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
