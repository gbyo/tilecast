import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActionMenu, MenuItem } from "@react-spectrum/s2/ActionMenu";
import { Button } from "@react-spectrum/s2/Button";
import { ButtonGroup } from "@react-spectrum/s2/ButtonGroup";
import { Checkbox } from "@react-spectrum/s2/Checkbox";
import { Cell, Column, Row, TableBody, TableHeader, TableView } from "@react-spectrum/s2/TableView";
import { Content, Footer } from "@react-spectrum/s2/Dialog";
import { Dialog, DialogContainer } from "@react-spectrum/s2/Dialog";
import { Form } from "@react-spectrum/s2/Form";
import { Heading } from "@react-spectrum/s2/Heading";
import { IllustratedMessage } from "@react-spectrum/s2/IllustratedMessage";
import { InlineAlert } from "@react-spectrum/s2/InlineAlert";
import { Picker, PickerItem } from "@react-spectrum/s2/Picker";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import { Text } from "@react-spectrum/s2/Text";
import { TextField } from "@react-spectrum/s2/TextField";
import { SearchField } from "@react-spectrum/s2/SearchField";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import AddIcon from "@react-spectrum/s2/icons/Add";
import { api } from "../api/client";
import type { User } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";
import { ScreenScopeEditor } from "./ScreenScopeEditor";

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

const roleLabels: Record<UserRole, string> = {
  owner: "Owner",
  administrator: "Administrator",
  editor: "Editor",
  contributor: "Contributor",
  viewer: "Viewer",
};

const roleDescriptions: Record<UserRole, string> = {
  owner: "Everything, including backups and integration tokens.",
  administrator: "Everything except Owner-only system operations.",
  editor: "Creates content, publishes it, and manages screens and playback.",
  contributor:
    "Creates and edits content, but cannot publish a Layout, delete anything, or put content on a screen.",
  viewer: "Reads only.",
};

const tableStyles = style({ height: 560, minHeight: 320, width: "full" });
const pageHeaderStyles = style({
  display: "flex",
  alignItems: "start",
  justifyContent: "space-between",
  gap: 16,
  marginBottom: 24,
});
const filterStyles = style({ display: "flex", gap: 12, marginBottom: 16 });
const securityStyles = style({
  display: "flex",
  alignItems: "start",
  justifyContent: "space-between",
  gap: 16,
  paddingY: 16,
  borderTopWidth: 1,
  borderBottomWidth: 1,
  borderColor: "gray-200",
});

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatLastLogin(value: string | null | undefined) {
  if (!value) return "Never signed in";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

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
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ManagedUser>();
  const [search, setSearch] = useState("");
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
      setCreating(false);
      await client.invalidateQueries({ queryKey: ["users"] });
    },
  });

  if (!canManage) {
    return (
      <InlineAlert variant="negative" fillStyle="subtleFill">
        <Heading level={2}>User management is restricted</Heading>
        <Text>Owner or Administrator access is required to manage Studio users.</Text>
      </InlineAlert>
    );
  }

  const allowedRoles: UserRole[] = isOwner
    ? ["owner", "administrator", "editor", "contributor", "viewer"]
    : ["editor", "contributor", "viewer"];
  const visibleUsers = (users.data?.items ?? []).filter((user) => {
    const needle = search.trim().toLocaleLowerCase();
    return (
      !needle ||
      user.name.toLocaleLowerCase().includes(needle) ||
      user.username.toLocaleLowerCase().includes(needle) ||
      roleLabels[user.role].toLocaleLowerCase().includes(needle)
    );
  });

  return (
    <section className="user-management">
      <header className={pageHeaderStyles}>
        <div>
          <Heading level={1}>Users</Heading>
          <Text>Manage Studio access, roles, and two-step verification.</Text>
        </div>
        <Button variant="accent" onPress={() => setCreating(true)}>
          <AddIcon aria-hidden="true" /> Add user
        </Button>
      </header>

      <div className={filterStyles}>
        <SearchField
          aria-label="Search users"
          placeholder="Search users"
          value={search}
          onChange={setSearch}
        />
      </div>

      {users.error && (
        <InlineAlert variant="negative" fillStyle="subtleFill">
          <Heading level={2}>Users could not be loaded</Heading>
          <Text>{errorMessage(users.error, "Please try again.")}</Text>
        </InlineAlert>
      )}

      <TableView
        aria-label="Studio users"
        density={document.documentElement.dataset.density === "compact" ? "compact" : "regular"}
        styles={tableStyles}
        loadingState={users.isLoading ? "loading" : undefined}
      >
        <TableHeader>
          <Column isRowHeader>Name</Column>
          <Column>Username</Column>
          <Column>Role</Column>
          <Column>Account</Column>
          <Column>Two-step verification</Column>
          <Column>Last signed in</Column>
          <Column>Actions</Column>
        </TableHeader>
        <TableBody
          items={visibleUsers}
          renderEmptyState={() => (
            <IllustratedMessage>
              <Heading level={2}>
                {search ? "No matching users" : "No users found"}
              </Heading>
              <Text>
                {search
                  ? "Adjust your search to find a Studio account."
                  : "Create an account to give another person access to Studio."}
              </Text>
              {!search && (
                <Button variant="accent" onPress={() => setCreating(true)}>
                  Add user
                </Button>
              )}
            </IllustratedMessage>
          )}
        >
          {(user) => {
            const canEdit =
              currentUser?.role === "owner" ||
              (currentUser?.role === "administrator" &&
                ["editor", "contributor", "viewer"].includes(user.role));
            return (
              <Row id={user.id}>
                <Cell>
                  <Text>{user.name}</Text>
                </Cell>
                <Cell>{user.username}</Cell>
                <Cell>
                  <StatusLight variant={user.role === "owner" ? "notice" : "informative"}>
                    {roleLabels[user.role]}
                  </StatusLight>
                </Cell>
                <Cell>
                  <StatusLight variant={user.active ? "positive" : "negative"}>
                    {user.active ? "Active" : "Inactive"}
                  </StatusLight>
                </Cell>
                <Cell>
                  <StatusLight
                    variant={
                      user.mfaEnrolled
                        ? "positive"
                        : user.mfaRequired
                          ? "negative"
                          : "informative"
                    }
                  >
                    {user.mfaEnrolled
                      ? "Enrolled"
                      : user.mfaRequired
                        ? "Required, not enrolled"
                        : "Not enabled"}
                  </StatusLight>
                </Cell>
                <Cell>{formatLastLogin(user.lastLoginAt)}</Cell>
                <Cell>
                  <ActionMenu
                    aria-label={`Actions for ${user.name}`}
                    onAction={() => setEditing(user)}
                  >
                    <MenuItem id="edit" isDisabled={!canEdit}>Edit account</MenuItem>
                  </ActionMenu>
                </Cell>
              </Row>
            );
          }}
        </TableBody>
      </TableView>

      {creating && (
        <DialogContainer
          onDismiss={() => {
            setCreating(false);
            create.reset();
          }}
        >
          <Dialog aria-label="Add a user" size="S" isDismissible>
            <Heading slot="title">Add a user</Heading>
            <Content>
              <Form
                onSubmit={(event) => {
                  event.preventDefault();
                  create.mutate({
                    name: name.trim(),
                    username: username.trim(),
                    password,
                    role,
                  });
                }}
                validationBehavior="aria"
              >
                <TextField
                  label="Name"
                  autoFocus
                  value={name}
                  onChange={setName}
                  isRequired
                  minLength={2}
                />
                <TextField
                  label="Username"
                  value={username}
                  onChange={setUsername}
                  autoComplete="username"
                  isRequired
                  minLength={3}
                />
                <TextField
                  label="Temporary password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  autoComplete="new-password"
                  description="Passwords must contain at least 12 characters."
                  isRequired
                  minLength={12}
                />
                <Picker
                  label="Role"
                  selectedKey={role}
                  onSelectionChange={(key) => setRole(key as UserRole)}
                >
                  {allowedRoles.map((value) => (
                    <PickerItem key={value} id={value}>
                      {roleLabels[value]}
                    </PickerItem>
                  ))}
                </Picker>
                <Text>{roleDescriptions[role]}</Text>
                {create.error && (
                  <InlineAlert variant="negative" fillStyle="subtleFill">
                    <Heading level={2}>User could not be added</Heading>
                    <Text>{errorMessage(create.error, "Please try again.")}</Text>
                  </InlineAlert>
                )}
                <Footer>
                  <ButtonGroup>
                    <Button
                      variant="secondary"
                      onPress={() => {
                        setCreating(false);
                        create.reset();
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      variant="accent"
                      isPending={create.isPending}
                      isDisabled={
                        create.isPending ||
                        name.trim().length < 2 ||
                        username.trim().length < 3 ||
                        password.length < 12
                      }
                    >
                      Add user
                    </Button>
                  </ButtonGroup>
                </Footer>
              </Form>
            </Content>
          </Dialog>
        </DialogContainer>
      )}

      {editing && currentUser && (
        <UserEditorDialog
          key={editing.id}
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
  const { confirm } = useSpectrumDialogs();
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
  const mutationError =
    update.error ??
    deactivate.error ??
    permanentlyDelete.error ??
    resetSecurity.error;

  return (
    <DialogContainer onDismiss={onClose}>
      <Dialog aria-label={`Edit ${user.name}`} size="L" isDismissible>
        <Heading slot="title">Edit {user.name}</Heading>
        <Content>
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate();
            }}
            validationBehavior="aria"
          >
            <TextField
              label="Name"
              autoFocus
              value={name}
              onChange={setName}
              isRequired
              minLength={2}
            />
            <TextField
              label="Username"
              value={username}
              onChange={setUsername}
              autoComplete="username"
              isRequired
              minLength={3}
            />
            <Picker
              label="Role"
              selectedKey={role}
              onSelectionChange={(key) => setRole(key as UserRole)}
            >
              {allowedRoles.map((value) => (
                <PickerItem key={value} id={value}>
                  {roleLabels[value]}
                </PickerItem>
              ))}
            </Picker>
            <Text>{roleDescriptions[role]}</Text>
            <TextField
              label="New password"
              type="password"
              value={password}
              placeholder="Leave unchanged"
              autoComplete="new-password"
              description="Leave blank to keep the current password. New passwords need at least 12 characters."
              onChange={setPassword}
              minLength={password ? 12 : undefined}
            />
            <Checkbox
              isSelected={active}
              isDisabled={isSelf}
              onChange={setActive}
            >
              Account active
            </Checkbox>
            <section className={securityStyles} aria-labelledby="user-security-title">
              <div>
                <Heading id="user-security-title" level={3}>
                  Two-step verification
                </Heading>
                <Text>
                  {user.mfaEnrolled
                    ? "This account has an authenticator app or a passkey enrolled."
                    : "This account has no second factor enrolled."}
                </Text>
              </div>
              <Button
                variant="negative"
                isDisabled={!user.mfaEnrolled || resetSecurity.isPending}
                isPending={resetSecurity.isPending}
                onPress={async () => {
                  if (
                    await confirm({
                      title: `Reset two-step verification for ${user.name}?`,
                      description:
                        "This clears every authenticator, passkey, and recovery code. The user will be signed out everywhere and must enroll again.",
                      confirmLabel: "Reset security",
                      tone: "negative",
                    })
                  ) {
                    resetSecurity.mutate();
                  }
                }}
              >
                Reset security
              </Button>
            </section>
            <section aria-labelledby="screen-scope-title">
              <Heading id="screen-scope-title" level={3}>Screen scope</Heading>
              <ScreenScopeEditor
                userId={user.id}
                userRole={role}
                csrf={csrf}
                disabled={role === "owner"}
              />
            </section>
            {mutationError && (
              <InlineAlert variant="negative" fillStyle="subtleFill">
                <Heading level={2}>Account update could not be completed</Heading>
                <Text>{errorMessage(mutationError, "Please try again.")}</Text>
              </InlineAlert>
            )}
            <Footer>
              <ButtonGroup>
                {user.active ? (
                  <Button
                    variant="negative"
                    isDisabled={isSelf || deactivate.isPending}
                    isPending={deactivate.isPending}
                    onPress={async () => {
                      if (
                        await confirm({
                          title: `Deactivate ${user.name}?`,
                          description:
                            "This prevents the account from signing in. You can reactivate it later.",
                          confirmLabel: "Deactivate",
                          tone: "negative",
                        })
                      ) {
                        deactivate.mutate();
                      }
                    }}
                  >
                    Deactivate
                  </Button>
                ) : (
                  <Button
                    variant="negative"
                    isDisabled={isSelf || permanentlyDelete.isPending}
                    isPending={permanentlyDelete.isPending}
                    onPress={async () => {
                      if (
                        await confirm({
                          title: `Permanently delete ${user.name}?`,
                          description:
                            "This removes the login, preferences, and security credentials. This cannot be undone.",
                          confirmLabel: "Delete permanently",
                          tone: "negative",
                        })
                      ) {
                        permanentlyDelete.mutate();
                      }
                    }}
                  >
                    Delete permanently
                  </Button>
                )}
                <Button variant="secondary" onPress={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="accent"
                  isDisabled={
                    update.isPending ||
                    name.trim().length < 2 ||
                    username.trim().length < 3 ||
                    (password.length > 0 && password.length < 12)
                  }
                  isPending={update.isPending}
                >
                  Save changes
                </Button>
              </ButtonGroup>
            </Footer>
          </Form>
        </Content>
      </Dialog>
    </DialogContainer>
  );
}
