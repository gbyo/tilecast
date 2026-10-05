import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider";
import type { User } from "../api/types";
import { Avatar, AvatarFallback } from "../components/ui/avatar";

// Section and role structures hold translation keys, never rendered text.
// Labels are resolved with t() at render so the page follows language changes.
const roleKeys = {
  owner: "roles.owner",
  administrator: "roles.administrator",
  editor: "roles.editor",
  contributor: "roles.contributor",
  viewer: "roles.viewer",
} as const satisfies Record<User["role"], string>;

const SECTIONS = [
  {
    id: "preferences",
    path: "/account/preferences",
    titleKey: "myAccount.sections.preferences.title",
    descriptionKey: "myAccount.sections.preferences.description",
  },
  {
    id: "security",
    path: "/account/security",
    titleKey: "myAccount.sections.security.title",
    descriptionKey: "myAccount.sections.security.description",
  },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * Shared chrome for account-owned pages. Preferences and sign-in security are
 * real routes so history, deep links, native navigation, and page lifecycle
 * agree about which destination is open.
 */
export function MyAccountPage() {
  const { t } = useTranslation(["account", "common"]);
  const { status } = useAuth();
  const location = useLocation();
  const user = status?.user;
  const active: SectionId = location.pathname.endsWith("/security")
    ? "security"
    : "preferences";
  const activeSection =
    SECTIONS.find((section) => section.id === active) ?? SECTIONS[0];

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-[900px] gap-6">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3 sm:items-end">
        <div className="grid min-w-0 gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("myAccount.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("myAccount.subtitle")}
          </p>
        </div>
        {user && <SignedInAs user={user} />}
      </header>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav
          aria-label={t("myAccount.navLabel")}
          className="grid min-w-0 grid-cols-2 gap-1 rounded-lg bg-muted p-1 lg:sticky lg:top-6 lg:flex lg:flex-col lg:self-start lg:bg-transparent lg:p-0"
        >
          {SECTIONS.map((section) => (
            <NavLink
              key={section.id}
              to={section.path}
              end
              className={({ isActive }) =>
                `min-w-0 rounded-md px-3 py-2 text-center text-sm leading-snug outline-hidden transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 lg:text-left ${
                  isActive
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`
              }
            >
              <span className="block break-words">{t(section.titleKey)}</span>
            </NavLink>
          ))}
        </nav>

        <main className="min-w-0">
          <section
            className="grid min-w-0 gap-4"
            aria-labelledby={`account-${activeSection.id}-title`}
          >
            <header className="grid min-w-0 gap-1">
              <h2
                id={`account-${activeSection.id}-title`}
                className="text-base font-semibold"
              >
                {t(activeSection.titleKey)}
              </h2>
              <p className="max-w-[74ch] text-sm text-muted-foreground">
                {t(activeSection.descriptionKey)}
              </p>
            </header>
            <div className="grid min-w-0 content-start gap-4">
              <Outlet />
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

/**
 * Old Account links used hash anchors because both sections lived in one
 * document. Keep those bookmarks working while replacing the history entry
 * with the corresponding real route.
 */
export function AccountIndexRedirect() {
  const location = useLocation();
  return (
    <Navigate
      to={
        location.hash === "#security"
          ? "/account/security"
          : "/account/preferences"
      }
      replace
    />
  );
}

/** Which account is being edited, stated once beside the Account heading. */
function SignedInAs({ user }: { user: User }) {
  const { t } = useTranslation(["account", "common"]);
  return (
    <p className="m-0 flex max-w-full min-w-0 items-center gap-3">
      <Avatar className="size-9 shrink-0" aria-hidden="true">
        <AvatarFallback>
          {user.name.trim().slice(0, 1).toUpperCase() || "?"}
        </AvatarFallback>
      </Avatar>
      <span className="grid min-w-0 max-w-full gap-px">
        <span className="sr-only">{t("myAccount.signedInAs")} </span>
        <strong className="truncate text-sm font-semibold">{user.name}</strong>
        <small className="truncate text-xs text-muted-foreground">
          {user.username} · {t(roleKeys[user.role])}
        </small>
      </span>
    </p>
  );
}
