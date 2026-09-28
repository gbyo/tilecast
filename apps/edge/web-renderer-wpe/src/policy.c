#include "policy.h"
#include "rw-protocol.h"

#include <string.h>

static GUri *
parse (const char *url)
{
  if (url == NULL || strlen (url) > TC_RW_MAX_URL * 4)
    return NULL;
  return g_uri_parse (url, G_URI_FLAGS_ENCODED | G_URI_FLAGS_PARSE_RELAXED, NULL);
}

TcNavDecision
tc_policy_main_frame (const char *target, const char *configured, GPtrArray *hosts)
{
  g_autoptr (GUri) uri = parse (target);
  g_autoptr (GUri) original = parse (configured);
  if (uri == NULL || original == NULL || hosts == NULL)
    return TC_NAV_BLOCK;
  const char *scheme = g_uri_get_scheme (uri);
  gboolean https = g_ascii_strcasecmp (scheme, "https") == 0;
  gboolean http = g_ascii_strcasecmp (scheme, "http") == 0;
  if (!https && !(http && g_ascii_strcasecmp (g_uri_get_scheme (original), "http") == 0))
    return TC_NAV_BLOCK;
  if (g_uri_get_userinfo (uri) != NULL)
    return TC_NAV_BLOCK;
  int port = g_uri_get_port (uri);
  if (port != -1 && port != (https ? 443 : 80))
    return TC_NAV_BLOCK;
  char host[TC_RW_MAX_HOST + 1];
  if (!tc_rw_normalize_host (g_uri_get_host (uri), host))
    return TC_NAV_BLOCK;
  for (guint i = 0; i < hosts->len; i++) {
    if (strcmp (host, g_ptr_array_index (hosts, i)) == 0)
      return TC_NAV_ALLOW;
  }
  return TC_NAV_BLOCK;
}

TcNavDecision
tc_policy_any_frame (const char *target)
{
  if (target == NULL)
    return TC_NAV_BLOCK;
  if (strcmp (target, "about:blank") == 0 || strcmp (target, "about:srcdoc") == 0)
    return TC_NAV_ALLOW;
  g_autoptr (GUri) uri = parse (target);
  if (uri == NULL)
    return TC_NAV_BLOCK;
  const char *scheme = g_uri_get_scheme (uri);
  static const char *const allowed[] = { "https", "http", "data", "blob", NULL };
  for (guint i = 0; allowed[i] != NULL; i++) {
    if (g_ascii_strcasecmp (scheme, allowed[i]) == 0)
      return g_uri_get_userinfo (uri) == NULL ? TC_NAV_ALLOW : TC_NAV_BLOCK;
  }
  return TC_NAV_BLOCK;
}

char *
tc_policy_log_host (const char *url)
{
  g_autoptr (GUri) uri = parse (url);
  char host[TC_RW_MAX_HOST + 1];
  if (uri == NULL || !tc_rw_normalize_host (g_uri_get_host (uri), host))
    return g_strdup ("-");
  return g_strdup (host);
}
