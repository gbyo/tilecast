/*
 * Remote website data profiles (threat review §8). One network session per
 * cookie policy, configured once at creation and never changed, so two live
 * surfaces with different policies cannot affect each other.
 */
#include "helper.h"

static void
on_download_started (WebKitNetworkSession *session, WebKitDownload *download, gpointer data)
{
  (void) session;
  (void) data;
  webkit_download_cancel (download);
}

void
tc_profiles_configure (WebKitNetworkSession *session, TcRwCookiePolicy policy)
{
  /* ITP classifies domains and blocks their third-party cookies even under
   * ACCEPT_ALWAYS; the author's cookie policy must mean what it says. */
  webkit_network_session_set_itp_enabled (session, FALSE);
  webkit_network_session_set_tls_errors_policy (session, WEBKIT_TLS_ERRORS_POLICY_FAIL);
  WebKitCookieManager *cookies = webkit_network_session_get_cookie_manager (session);
  switch (policy) {
  case TC_RW_COOKIES_DISABLED:
    webkit_cookie_manager_set_accept_policy (cookies, WEBKIT_COOKIE_POLICY_ACCEPT_NEVER);
    break;
  case TC_RW_COOKIES_FIRST_PARTY:
    webkit_cookie_manager_set_accept_policy (cookies, WEBKIT_COOKIE_POLICY_ACCEPT_NO_THIRD_PARTY);
    break;
  case TC_RW_COOKIES_ALL:
  default:
    webkit_cookie_manager_set_accept_policy (cookies, WEBKIT_COOKIE_POLICY_ACCEPT_ALWAYS);
    break;
  }
  g_signal_connect (session, "download-started", G_CALLBACK (on_download_started), NULL);
}

static WebKitNetworkSession *
persistent (TcWeb *web, const char *name, TcRwCookiePolicy policy)
{
  g_autofree char *data = g_build_filename (web->data_dir, "profiles", name, NULL);
  g_autofree char *cache = g_build_filename (web->cache_dir, name, NULL);
  g_mkdir_with_parents (data, 0700);
  g_mkdir_with_parents (cache, 0700);
  WebKitNetworkSession *session = webkit_network_session_new (data, cache);
  tc_profiles_configure (session, policy);
  g_autofree char *cookies = g_build_filename (data, "cookies.sqlite", NULL);
  webkit_cookie_manager_set_persistent_storage (webkit_network_session_get_cookie_manager (session), cookies,
                                                WEBKIT_COOKIE_PERSISTENT_STORAGE_SQLITE);
  return session;
}

WebKitNetworkSession *
tc_profiles_session (TcWeb *web, TcRwCookiePolicy policy, gboolean *owned)
{
  *owned = FALSE;
  switch (policy) {
  case TC_RW_COOKIES_DISABLED: {
    WebKitNetworkSession *session = webkit_network_session_new_ephemeral ();
    tc_profiles_configure (session, policy);
    *owned = TRUE;
    return session;
  }
  case TC_RW_COOKIES_FIRST_PARTY:
    if (web->first_party == NULL)
      web->first_party = persistent (web, "first-party", policy);
    return web->first_party;
  case TC_RW_COOKIES_ALL:
  default:
    if (web->all == NULL)
      web->all = persistent (web, "all", policy);
    return web->all;
  }
}

typedef struct {
  guint pending;
  gboolean ok;
  TcClearDone done;
  gpointer user_data;
} Clear;

static void
clear_finished (Clear *clear)
{
  if (--clear->pending > 0)
    return;
  clear->done (clear->ok, clear->user_data);
  g_free (clear);
}

static void
on_manager_cleared (GObject *source, GAsyncResult *result, gpointer data)
{
  Clear *clear = data;
  g_autoptr (GError) error = NULL;
  if (!webkit_website_data_manager_clear_finish (WEBKIT_WEBSITE_DATA_MANAGER (source), result, &error)) {
    g_warning ("profiles: clearing website data failed: %s", error->message);
    clear->ok = FALSE;
  }
  clear_finished (clear);
}

static void
clear_session (Clear *clear, WebKitNetworkSession *session)
{
  if (session == NULL)
    return;
  clear->pending++;
  webkit_website_data_manager_clear (webkit_network_session_get_website_data_manager (session),
                                     WEBKIT_WEBSITE_DATA_ALL, 0, NULL, on_manager_cleared, clear);
}

void
tc_profiles_clear (TcWeb *web, TcClearDone done, gpointer user_data)
{
  Clear *clear = g_new0 (Clear, 1);
  clear->ok = TRUE;
  clear->done = done;
  clear->user_data = user_data;
  /* Held until every manager answered, so the answer comes once. The
   * persistent profiles are created if needed: data on disk from an earlier
   * run is cleared too. */
  clear->pending = 1;
  gboolean owned = FALSE;
  clear_session (clear, tc_profiles_session (web, TC_RW_COOKIES_FIRST_PARTY, &owned));
  clear_session (clear, tc_profiles_session (web, TC_RW_COOKIES_ALL, &owned));
  GHashTableIter iter;
  gpointer value;
  g_hash_table_iter_init (&iter, web->surfaces);
  while (g_hash_table_iter_next (&iter, NULL, &value))
    clear_session (clear, tc_surface_private_session (value));
  clear_finished (clear);
}
