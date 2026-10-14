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
import type { ReactNode } from "react";
import type { ManagedUser, Role, User } from "../api/types";
import { api } from "../api/client";
import { contentQueries } from "../data/content";
import { useCapabilities } from "../auth/capabilities";
import {
  rolesQueryKey,
  useRoleLabels,
  useRoles,
} from "../settings/access/roleNames";
import {
  ContentAccessFields,
  type ContentAccessDraft,
} from "../settings/access/ContentAccessFields";
import { ContentAccessEditor } from "../settings/access/ContentAccessEditor";
import { RoleCapabilitySummary } from "../settings/access/RoleCapabilitySummary";
import { ScreenScopeEditor } from "./ScreenScopeEditor";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import { apiErrorMessage, useFormatLocale } from "../i18n";

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

/** A role that includes Media or Widgets, for which content access matters. */
function roleUsesMedia(role?: Role) {
  return Boolean(
    role?.capabilities.some(
      (capability) =>
        capability === "media.read" || capability === "widget.read",
    ),
  );
}

export function UsersPage() {
  const { t } = useTranslation(["account", "common"]);
  const locale = useFormatLocale();
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const currentUser = auth.status?.user;
  const { can } = useCapabilities();
  const canManage = can("users.manage");
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => withUserError(listUsers(), t("users.errors.requestFailed")),
    enabled: canManage,
  });
  const roles = useRoles(canManage);
  const labels = useRoleLabels(roles.data);
  const [editing, setEditing] = useState<ManagedUser>();
  const [createOpen, setCreateOpen] = useState(false);

  if (!canManage) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("users.accessDenied")}</AlertDescription>
      </Alert>
    );
  }

  // The server decides which roles this account may hand out: only the
  // Owner assigns Owner and Administrator, and nobody grants more than they
  // hold. A row is editable when its current role is one of those.
  const assignableRoles = roles.data?.filter((role) => role.assignable) ?? [];
  const assignable = (key: string) =>
    assignableRoles.some((role) => role.key === key);

  return (
    <section className="grid content-start gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          disabled={!roles.data}
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={16} aria-hidden="true" /> {t("users.addForm.submit")}
        </Button>
      </div>

      {createOpen && roles.data && (
        <UserCreateDialog
          roles={roles.data}
          allowedRoles={assignableRoles}
          csrf={csrf}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            await client.invalidateQueries({ queryKey: ["users"] });
            await client.invalidateQueries({ queryKey: rolesQueryKey });
            setCreateOpen(false);
          }}
        />
      )}

      {users.isLoading || roles.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" /> {t("users.list.loading")}
        </p>
      ) : users.error || roles.error ? (
        <Alert variant="destructive">
          <AlertDescription role="alert">
            {apiErrorMessage(users.error ?? roles.error)}
          </AlertDescription>
        </Alert>
      ) : (
        <ItemGroup className="gap-2">
          {users.data?.items?.map((user) => {
            const canEdit = assignable(user.role);
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
                    {labels.name(user.role)} ·{" "}
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

      {editing && currentUser && roles.data && (
        <UserEditorDialog
          user={editing}
          currentUser={currentUser}
          roles={roles.data}
          allowedRoles={
            assignable(editing.role)
              ? assignableRoles
              : roles.data.filter((role) => role.key === editing.role)
          }
          csrf={csrf}
          onClose={() => setEditing(undefined)}
          onChanged={async () => {
            await client.invalidateQueries({ queryKey: ["users"] });
            await client.invalidateQueries({ queryKey: rolesQueryKey });
            setEditing(undefined);
          }}
        />
      )}
    </section>
  );
}

/**
 * The role picker: built-in roles first, then the installation's own, each
 * with what it lets someone do.
 */
function RoleSelect({
  id,
  roles,
  allowedRoles,
  value,
  onChange,
}: {
  id: string;
  roles: readonly Role[];
  allowedRoles: readonly Role[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("account");
  const labels = useRoleLabels(roles);
  const builtin = allowedRoles.filter((role) => role.builtin);
  const custom = allowedRoles.filter((role) => !role.builtin);
  return (
    <Select
      items={allowedRoles.map((role) => ({
        value: role.key,
        label: labels.name(role.key, role.name),
      }))}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger id={id}>
        <SelectValue>{labels.name(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {builtin.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t("users.roleSelect.builtin")}</SelectLabel>
            {builtin.map((role) => (
              <SelectItem key={role.key} value={role.key}>
                {labels.name(role.key, role.name)}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {custom.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t("users.roleSelect.custom")}</SelectLabel>
            {custom.map((role) => (
              <SelectItem key={role.key} value={role.key}>
                {labels.name(role.key, role.name)}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}

function UserCreateDialog({
  roles,
  allowedRoles,
  csrf,
  onClose,
  onCreated,
}: {
  roles: readonly Role[];
  allowedRoles: readonly Role[];
  csrf: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { t } = useTranslation(["account", "common"]);
  const labels = useRoleLabels(roles);
  const myAccess = useQuery({ queryKey: ["my-access"], queryFn: api.myAccess });
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>(
    allowedRoles.find((entry) => entry.key === "viewer")?.key ??
      allowedRoles[0]?.key ??
      "viewer",
  );
  const [content, setContent] = useState<ContentAccessDraft>();
  const selectedRole = roles.find((entry) => entry.key === role);
  const usesMedia = roleUsesMedia(selectedRole);
  const folders = useQuery({ ...contentQueries.folders(), enabled: usesMedia });
  const tags = useQuery({ ...contentQueries.tags(), enabled: usesMedia });
  // A new account starts with the creator's own reach: the whole library from
  // someone who has it, and nothing from someone who does not. The fields
  // below change that before the account exists.
  useEffect(() => {
    if (content || !myAccess.data) return;
    setContent({
      libraryMode: myAccess.data.content.libraryMode,
      tagMode: myAccess.data.content.tagMode,
      folderIds: [],
      tagIds: [],
    });
  }, [content, myAccess.data]);
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
            ...(content
              ? {
                  contentAccess: {
                    libraryMode: content.libraryMode,
                    tagMode: content.tagMode,
                    folderIds:
                      content.libraryMode === "restricted"
                        ? content.folderIds
                        : [],
                    tagIds:
                      content.tagMode === "restricted" ? content.tagIds : [],
                  },
                }
              : {}),
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
  const restrictedEmpty =
    usesMedia &&
    content?.libraryMode === "restricted" &&
    content.folderIds.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("users.addForm.title")}</DialogTitle>
          <DialogDescription>
            {t("users.addForm.passwordHint")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
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
          </div>
          <AccessSection
            title={t("users.access.roleTitle")}
            description={t("users.access.roleDescription")}
          >
            <Field>
              <FieldLabel htmlFor="users-add-role">
                {t("users.addForm.roleLabel")}
              </FieldLabel>
              <RoleSelect
                id="users-add-role"
                roles={roles}
                allowedRoles={allowedRoles}
                value={role}
                onChange={setRole}
              />
              <FieldDescription>{labels.description(role)}</FieldDescription>
            </Field>
          </AccessSection>
          {usesMedia && role !== "owner" && (
            <AccessSection
              title={t("users.access.contentTitle")}
              description={t("users.access.contentDescription")}
            >
              {folders.error || tags.error ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {apiErrorMessage(folders.error ?? tags.error)}
                  </AlertDescription>
                </Alert>
              ) : content && folders.data && tags.data ? (
                <ContentAccessFields
                  value={content}
                  onChange={setContent}
                  folders={folders.data}
                  tags={tags.data}
                  idPrefix="users-add-content"
                />
              ) : (
                <Spinner aria-label={t("contentAccess.loading")} />
              )}
              {restrictedEmpty && (
                <p className="text-sm text-muted-foreground" role="note">
                  {t("contentAccess.library.emptyNote")}
                </p>
              )}
            </AccessSection>
          )}
          {create.error && (
            <Alert variant="destructive">
              <AlertDescription role="alert">
                {apiErrorMessage(create.error)}
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

/** One titled part of an account's access: what, which media, which screens. */
function AccessSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 border-t border-border pt-4">
      <header className="grid gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </header>
      {children}
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

type EditorTab = "account" | "role" | "content" | "screens";

function UserEditorDialog({
  user,
  currentUser,
  roles,
  allowedRoles,
  csrf,
  onClose,
  onChanged,
}: {
  user: ManagedUser;
  currentUser: User;
  roles: readonly Role[];
  allowedRoles: readonly Role[];
  csrf: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation(["account", "common"]);
  const labels = useRoleLabels(roles);
  const [tab, setTab] = useState<EditorTab>("account");
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
  const savedRole = roles.find((entry) => entry.key === user.role);
  const chosenRole = roles.find((entry) => entry.key === role);
  const profileTab = tab === "account" || tab === "role";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
        {confirmDialog}
        <DialogHeader>
          <DialogTitle>
            {t("users.editDialog.title", { name: user.name })}
          </DialogTitle>
          <DialogDescription>
            {user.username} · {labels.name(user.role)}
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(next) => setTab(next as EditorTab)}
          className="w-full min-w-0"
        >
          <TabsList
            variant="line"
            aria-label={t("users.editDialog.tabsLabel")}
            className="min-h-10 w-full max-w-full justify-start gap-4 overflow-x-auto rounded-none border-b border-border p-0"
          >
            <TabsTrigger value="account" className="flex-none px-2">
              {t("users.editDialog.tabs.account")}
            </TabsTrigger>
            <TabsTrigger value="role" className="flex-none px-2">
              {t("users.editDialog.tabs.role")}
            </TabsTrigger>
            <TabsTrigger value="content" className="flex-none px-2">
              {t("users.editDialog.tabs.content")}
            </TabsTrigger>
            <TabsTrigger value="screens" className="flex-none px-2">
              {t("users.editDialog.tabs.screens")}
            </TabsTrigger>
          </TabsList>
          {/* Account and Role save together with the footer; content and
              screen access are separate policies with their own Save. */}
          <form
            id="users-edit-form"
            className="grid"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate();
            }}
          >
            <TabsContent
              value="account"
              keepMounted
              className="grid gap-4 pt-4"
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
            </TabsContent>
            <TabsContent value="role" keepMounted className="grid gap-4 pt-4">
              <p className="text-sm text-muted-foreground">
                {t("users.access.roleDescription")}
              </p>
              <Field>
                <FieldLabel htmlFor="users-edit-role">
                  {t("users.editDialog.roleLabel")}
                </FieldLabel>
                <RoleSelect
                  id="users-edit-role"
                  roles={roles}
                  allowedRoles={allowedRoles}
                  value={role}
                  onChange={setRole}
                />
                <FieldDescription>{labels.description(role)}</FieldDescription>
              </Field>
              <RoleCapabilitySummary
                capabilities={chosenRole?.capabilities ?? []}
              />
            </TabsContent>
          </form>
          <TabsContent value="content" className="grid gap-4 pt-4">
            <p className="text-sm text-muted-foreground">
              {t("users.access.contentDescription")}
            </p>
            {isSelf ? (
              <p className="text-sm text-muted-foreground" role="note">
                {t("users.access.selfNote")}
              </p>
            ) : (
              <ContentAccessEditor
                userId={user.id}
                csrf={csrf}
                roleUsesMedia={roleUsesMedia(savedRole)}
              />
            )}
          </TabsContent>
          <TabsContent value="screens" className="grid gap-4 pt-4">
            <p className="text-sm text-muted-foreground">
              {t("users.access.screensDescription")}
            </p>
            {isSelf ? (
              <p className="text-sm text-muted-foreground" role="note">
                {t("users.access.selfNote")}
              </p>
            ) : (
              <ScreenScopeEditor
                userId={user.id}
                userRole={user.role}
                csrf={csrf}
                disabled={user.role === "owner"}
              />
            )}
          </TabsContent>
        </Tabs>
        {(update.error ||
          deactivate.error ||
          permanentlyDelete.error ||
          resetSecurity.error) && (
          <Alert variant="destructive">
            <AlertDescription role="alert">
              {apiErrorMessage(
                update.error ??
                  deactivate.error ??
                  permanentlyDelete.error ??
                  resetSecurity.error,
              )}
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter className="flex-wrap">
          {profileTab &&
            (user.active ? (
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
            ))}
          <Button type="button" variant="ghost" onClick={onClose}>
            {profileTab
              ? t("common:actions.cancel")
              : t("common:actions.close")}
          </Button>
          {profileTab && (
            <Button
              type="submit"
              form="users-edit-form"
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
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
