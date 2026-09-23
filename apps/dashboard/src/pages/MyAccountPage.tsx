import { useEffect } from "react";
import { useLocation } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { User } from "../api/types";
import { Avatar, AvatarFallback } from "../components/ui/avatar";
import { PreferencesPage } from "./PreferencesPage";
import { SecurityPage } from "./SecurityPage";

const roleLabels: Record<User["role"], string> = {
  owner: "Owner",
  administrator: "Administrator",
  editor: "Editor",
  contributor: "Contributor",
  viewer: "Viewer",
};

const SECTIONS = [
  {
    id: "preferences",
    title: "Preferences",
    description:
      "Appearance and workflow settings, stored with your account rather than this browser.",
  },
  {
    id: "security",
    title: "Sign-in security",
    description:
      "Whether a second factor is required is an organization setting. What you use to satisfy it is your choice.",
  },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * Two account-owned sections in a nested composition: a section nav on the
 * left, the active section on the right, stacked on narrow screens.
 *
 * The section ids are load-bearing: `/preferences` and `/security` redirect
 * to `/account#preferences` and `/account#security`, and the nav preserves
 * those deep links.
 */
export function MyAccountPage() {
  const { status } = useAuth();
  const location = useLocation();
  const user = status?.user;

  const active: SectionId =
    location.hash === "#security" ? "security" : "preferences";

  // A deep link should land on its section, including the initial load.
  useEffect(() => {
    if (!location.hash) return;
    document.querySelector(location.hash)?.scrollIntoView?.();
  }, [location.hash]);

  return (
    <div className="grid max-w-[900px] gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold tracking-tight">My Account</h1>
          <p className="text-sm text-muted-foreground">
            Settings that belong to you rather than to the organization.
          </p>
        </div>
        {user && <SignedInAs user={user} />}
      </header>

      <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav
          aria-label="Account sections"
          className="flex gap-1 overflow-x-auto lg:sticky lg:top-6 lg:flex-col lg:self-start"
        >
          {SECTIONS.map((section) => {
            const selected = section.id === active;
            return (
              <a
                key={section.id}
                href={`#${section.id}`}
                aria-current={selected ? "true" : undefined}
                className={`rounded-xl px-3 py-2 text-sm whitespace-nowrap outline-hidden transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
                  selected
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {section.title}
              </a>
            );
          })}
        </nav>

        <div className="grid content-start gap-8">
          <section
            id="preferences"
            className="grid scroll-mt-6 gap-4"
            aria-labelledby="account-preferences-title"
          >
            <div className="grid gap-1">
              <h2
                id="account-preferences-title"
                className="text-base font-semibold"
              >
                Preferences
              </h2>
              <p className="mt-0 max-w-[74ch] text-sm text-muted-foreground">
                {SECTIONS[0].description}
              </p>
            </div>
            <div className="grid content-start gap-4">
              <PreferencesPage />
            </div>
          </section>

          <section
            id="security"
            className="grid scroll-mt-6 gap-4"
            aria-labelledby="account-security-title"
          >
            <div className="grid gap-1">
              <h2
                id="account-security-title"
                className="text-base font-semibold"
              >
                Sign-in security
              </h2>
              <p className="mt-0 max-w-[74ch] text-sm text-muted-foreground">
                {SECTIONS[1].description}
              </p>
            </div>
            <SecurityPage />
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Which account is being edited, stated once. Studio supports several roles
 * with visibly different pages, so the role belongs next to the name — a
 * viewer and an owner should not have to guess why they see different things.
 */
function SignedInAs({ user }: { user: User }) {
  return (
    <p className="m-0 flex items-center gap-3">
      <Avatar className="size-9" aria-hidden="true">
        <AvatarFallback>
          {user.name.trim().slice(0, 1).toUpperCase() || "?"}
        </AvatarFallback>
      </Avatar>
      <span className="grid min-w-0 gap-px">
        <span className="sr-only">Signed in as </span>
        <strong className="text-sm font-semibold">{user.name}</strong>
        <small className="text-xs text-muted-foreground">
          {user.username} · {roleLabels[user.role]}
        </small>
      </span>
    </p>
  );
}
