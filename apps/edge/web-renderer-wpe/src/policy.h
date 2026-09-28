/*
 * Navigation policy for remote pages (threat review §9). Pure functions,
 * unit tested in tests/test_policy.c. The rules follow the Android player's
 * WebsiteNavigationPolicy so both players refuse the same navigations.
 */
#pragma once

#include <glib.h>

G_BEGIN_DECLS

typedef enum {
  TC_NAV_ALLOW,
  /* A network URL outside the allowlist, or with a refused scheme, port or
   * user information: reported as blocked_navigation. */
  TC_NAV_BLOCK,
} TcNavDecision;

/*
 * A main-frame navigation or redirect to `target`, for a surface whose
 * configured URL is `configured` and whose allowlist is `hosts` (normalized
 * with tc_rw_normalize_host). https is always a candidate; http only when
 * the configured URL is http. Only the scheme's default port. The host must
 * equal one allowlist entry.
 */
TcNavDecision tc_policy_main_frame (const char *target, const char *configured, GPtrArray *hosts);

/*
 * A navigation action in any frame. WebKit 2.54 does not say which frame an
 * action targets, so this is the rule every frame can follow: network URLs
 * (the page's own security rules apply to subframes) and the documents pages
 * build frames from (about:blank, about:srcdoc, data:, blob:). Every local or
 * custom scheme is refused: file:, tilecast:, tcmedia:, tcweb:, javascript:
 * navigations and anything unknown. The main frame is also checked with
 * tc_policy_main_frame before it commits.
 */
TcNavDecision tc_policy_any_frame (const char *target);

/* The host of `url` for a log line, never its path or query. Returns a new
 * string ("-" when there is no host). */
char *tc_policy_log_host (const char *url);

G_END_DECLS
