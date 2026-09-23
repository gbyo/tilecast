import { useAuth } from "../auth/AuthProvider";
import { PreferencesPage } from "./PreferencesPage";
import { SecurityPage } from "./SecurityPage";
import type { User } from "../api/types";

const roleLabels: Record<User["role"], string> = {
  owner: "Owner",
  administrator: "Administrator",
  editor: "Editor",
  contributor: "Contributor",
  viewer: "Viewer",
};

/**
 * Two groups of account-owned settings in one column.
 *
 * The section ids are load-bearing: `/preferences` and `/security` redirect to
 * `/account#preferences` and `/account#security`.
 *
 * Each group is a heading over panels rather than a card wrapping panels. The
 * page previously boxed both groups, which put the security panels a card deep
 * and left the two columns at wildly different heights — preferences is a fixed
 * short list, while security grows a QR code and a password prompt mid-flow.
 */
export function MyAccountPage() {
  const { status } = useAuth();
  const user = status?.user;

  return (
    <div className="grid max-w-[900px] gap-8 max-sm:gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold tracking-tight">My Account</h1>
          <p className="text-sm text-muted-foreground">
            Settings that belong to you rather than to the organization.
          </p>
        </div>
        {user && <SignedInAs user={user} />}
      </header>

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
            Appearance and workflow settings, stored with your account rather
            than this browser.
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
          <h2 id="account-security-title" className="text-base font-semibold">
            Sign-in security
          </h2>
          <p className="mt-0 max-w-[74ch] text-sm text-muted-foreground">
            Whether a second factor is required is an organization setting. What
            you use to satisfy it is your choice.
          </p>
        </div>
        <SecurityPage />
      </section>
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
      <span
        className="grid size-9 flex-none place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
        aria-hidden="true"
      >
        {user.name.trim().slice(0, 1).toUpperCase() || "?"}
      </span>
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
