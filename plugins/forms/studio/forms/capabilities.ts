import type { FormCapability } from "../types";

// expandCapabilities mirrors the server capability lattice (apps/server/internal/forms/types.go):
// manage implies everything; approve implies review; review implies view_all; view_all implies
// view_own. The dashboard expands granted capabilities the same way so it authorizes UI exactly as
// the server authorizes requests.
export function expandCapabilities(
  granted: FormCapability[] | undefined,
): Set<FormCapability> {
  const set = new Set<FormCapability>();
  for (const capability of granted ?? []) {
    set.add(capability);
    switch (capability) {
      case "manage":
        set.add("submit");
        set.add("review");
        set.add("approve");
        set.add("view_all");
        set.add("view_own");
        break;
      case "approve":
        set.add("review");
        set.add("view_all");
        set.add("view_own");
        break;
      case "review":
        set.add("view_all");
        set.add("view_own");
        break;
      case "view_all":
        set.add("view_own");
        break;
      default:
        break;
    }
  }
  return set;
}

export function hasCapability(
  granted: FormCapability[] | undefined,
  need: FormCapability,
): boolean {
  return expandCapabilities(granted).has(need);
}

// canReviewForm reports whether the caller may act on a form's responses queue (review, approve, or
// manage). Used to gate the Responses tab, the Approvals navigation item, and record review.
export function canReviewForm(granted: FormCapability[] | undefined): boolean {
  const effective = expandCapabilities(granted);
  return effective.has("review") || effective.has("manage");
}

// canViewResponses reports whether the caller may see all of a form's responses (view_all, review,
// approve, or manage).
export function canViewResponses(
  granted: FormCapability[] | undefined,
): boolean {
  return expandCapabilities(granted).has("view_all");
}

export function canSubmitToForm(
  granted: FormCapability[] | undefined,
): boolean {
  return expandCapabilities(granted).has("submit");
}

// canManageForm reports whether the caller may edit workflow, views, and access (manage).
export function canManageForm(granted: FormCapability[] | undefined): boolean {
  return expandCapabilities(granted).has("manage");
}
