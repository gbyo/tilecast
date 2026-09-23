import { useAuth } from "../auth/AuthProvider";
import { PageHeader, Panel } from "../components/legacy-ui";
import { PreferencesPage } from "./PreferencesPage";
import { SecurityPage } from "./SecurityPage";
import type { User } from "../api/types";
import "./MyAccountPage.css";

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
    <div className="my-account-page">
      <PageHeader
        title="My Account"
        description="Settings that belong to you rather than to the organization."
        actions={user && <SignedInAs user={user} />}
      />

      <section
        id="preferences"
        className="my-account-group"
        aria-labelledby="account-preferences-title"
      >
        <div className="my-account-group__heading">
          <h2 id="account-preferences-title">Preferences</h2>
          <p>
            Appearance and workflow settings, stored with your account rather
            than this browser.
          </p>
        </div>
        <Panel className="my-account-preferences">
          <PreferencesPage />
        </Panel>
      </section>

      <section
        id="security"
        className="my-account-group"
        aria-labelledby="account-security-title"
      >
        <div className="my-account-group__heading">
          <h2 id="account-security-title">Sign-in security</h2>
          <p>
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
    <p className="my-account-identity">
      <span className="my-account-identity__avatar" aria-hidden="true">
        {user.name.trim().slice(0, 1).toUpperCase() || "?"}
      </span>
      <span className="my-account-identity__copy">
        <span className="visually-hidden">Signed in as </span>
        <strong>{user.name}</strong>
        <small>
          {user.username} · {roleLabels[user.role]}
        </small>
      </span>
    </p>
  );
}
