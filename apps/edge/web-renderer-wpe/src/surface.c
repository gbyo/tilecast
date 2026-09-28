/*
 * One remote surface: an off-screen WebView, its data profile and its frame
 * export. Policy is threat review §9-§12; everything a page could use to
 * reach outside its view is refused here.
 */
#include "helper.h"
#include "policy.h"

#include <string.h>
#include <sys/random.h>

#define SCRIPT_WORLD "tilecast-helper"
#define YOUTUBE_POLL_MS 500

struct _TcSurface {
  TcWeb *web;
  char id[49];
  char capability[TC_RW_CAPABILITY_HEX + 1];
  TcRwContentKind kind;
  char *url;
  GPtrArray *hosts;
  guint scroll_x;
  guint scroll_y;
  guint width;
  guint height;
  gboolean visible;
  gboolean muted;
  gboolean youtube_ended;
  gboolean loaded_once;
  gboolean failed;
  char youtube_state[24];
  WebKitNetworkSession *private_session; /* owned: cookie policy "disabled" */
  WebKitWebView *view;
  WPEToplevel *toplevel;
  TcFrames *frames;
  GCancellable *cancellable;
  guint youtube_poll;
  guint blocked_source;
};

static void
event (TcSurface *surface, TcRwEventKind kind, const char *code)
{
  tc_control_event (surface->web, surface->id, kind, code);
}

static void fail (TcSurface *surface, TcRwEventKind kind, const char *code);
static void youtube_command (TcSurface *surface);

/* After the `created` reply, which the caller sends synchronously. */
static gboolean
report_blocked (gpointer data)
{
  TcSurface *surface = data;
  surface->blocked_source = 0;
  fail (surface, TC_RW_EVENT_NAVIGATION_BLOCKED, "blocked_navigation");
  return G_SOURCE_REMOVE;
}

/* A surface fails once; later signals of a failed view say nothing new. */
static void
fail (TcSurface *surface, TcRwEventKind kind, const char *code)
{
  if (surface->failed)
    return;
  surface->failed = TRUE;
  webkit_web_view_set_is_muted (surface->view, TRUE);
  event (surface, kind, code);
}

static gboolean
random_capability (char out[TC_RW_CAPABILITY_HEX + 1])
{
  guint8 bytes[32];
  gsize filled = 0;
  while (filled < sizeof bytes) {
    ssize_t got = getrandom (bytes + filled, sizeof bytes - filled, 0);
    if (got <= 0)
      return FALSE;
    filled += (gsize) got;
  }
  static const char hex[] = "0123456789abcdef";
  for (guint i = 0; i < sizeof bytes; i++) {
    out[i * 2] = hex[bytes[i] >> 4];
    out[i * 2 + 1] = hex[bytes[i] & 15];
  }
  out[TC_RW_CAPABILITY_HEX] = '\0';
  return TRUE;
}

/* ------------------------------------------------------------ policy */

static gboolean
main_frame_allowed (TcSurface *surface, const char *uri)
{
  if (surface->kind == TC_RW_CONTENT_YOUTUBE)
    return g_strcmp0 (uri, TC_YOUTUBE_BASE_URI) == 0;
  return tc_policy_main_frame (uri, surface->url, surface->hosts) == TC_NAV_ALLOW;
}

static gboolean
on_decide_policy (WebKitWebView *view, WebKitPolicyDecision *decision, WebKitPolicyDecisionType type, gpointer data)
{
  (void) view;
  TcSurface *surface = data;
  if (type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
    webkit_policy_decision_ignore (decision);
    return TRUE;
  }
  if (type == WEBKIT_POLICY_DECISION_TYPE_RESPONSE) {
    WebKitResponsePolicyDecision *response = WEBKIT_RESPONSE_POLICY_DECISION (decision);
    gboolean main_frame = webkit_response_policy_decision_is_main_frame_main_resource (response);
    if (!webkit_response_policy_decision_is_mime_type_supported (response)) {
      /* Never a download. */
      webkit_policy_decision_ignore (decision);
      if (main_frame)
        fail (surface, TC_RW_EVENT_FAILED, "unsupported_content");
      return TRUE;
    }
    WebKitURIResponse *uri_response = webkit_response_policy_decision_get_response (response);
    if (main_frame && !main_frame_allowed (surface, webkit_uri_response_get_uri (uri_response))) {
      webkit_policy_decision_ignore (decision);
      fail (surface, TC_RW_EVENT_NAVIGATION_BLOCKED, "blocked_navigation");
      return TRUE;
    }
    guint status = webkit_uri_response_get_status_code (uri_response);
    if (main_frame && surface->kind == TC_RW_CONTENT_PAGE && status >= 400) {
      webkit_policy_decision_ignore (decision);
      fail (surface, TC_RW_EVENT_FAILED, "http_error");
      return TRUE;
    }
    webkit_policy_decision_use (decision);
    return TRUE;
  }
  /* WebKit 2.54 does not say whether a navigation action targets the main
   * frame, so this decision refuses local and custom schemes in every frame.
   * The allowlist is enforced for the main frame by on_uri_changed (each
   * provisional URL and redirect hop) and by the main-frame response check
   * above, before the document commits. */
  WebKitNavigationAction *action =
    webkit_navigation_policy_decision_get_navigation_action (WEBKIT_NAVIGATION_POLICY_DECISION (decision));
  const char *uri = webkit_uri_request_get_uri (webkit_navigation_action_get_request (action));
  gboolean allowed = surface->kind == TC_RW_CONTENT_YOUTUBE
                       ? (g_strcmp0 (uri, TC_YOUTUBE_BASE_URI) == 0 || tc_youtube_subframe_allowed (uri))
                       : tc_policy_any_frame (uri) == TC_NAV_ALLOW;
  if (allowed) {
    webkit_policy_decision_use (decision);
    return TRUE;
  }
  webkit_policy_decision_ignore (decision);
  g_autofree char *host = tc_policy_log_host (uri);
  g_message ("surface %s: refused a navigation to a local or custom scheme (host %s)", surface->id, host);
  return TRUE;
}

/* The main frame's provisional or committed URL changed: a navigation or a
 * redirect hop. Anything outside the policy stops the load. */
static void
on_uri_changed (WebKitWebView *view, GParamSpec *pspec, gpointer data)
{
  (void) pspec;
  TcSurface *surface = data;
  const char *uri = webkit_web_view_get_uri (view);
  /* WebKit clears the URI when a provisional load fails; that is not a
   * navigation. */
  if (uri == NULL || *uri == '\0' || surface->failed || main_frame_allowed (surface, uri))
    return;
  g_autofree char *host = tc_policy_log_host (uri);
  const char *scheme = g_uri_peek_scheme (uri);
  g_message ("surface %s: refused a main-frame navigation to %s host %s", surface->id, scheme ? scheme : "-", host);
  webkit_web_view_stop_loading (view);
  fail (surface, TC_RW_EVENT_NAVIGATION_BLOCKED, "blocked_navigation");
}

static gboolean
on_permission_request (WebKitWebView *view, WebKitPermissionRequest *request, gpointer data)
{
  (void) view;
  (void) data;
  webkit_permission_request_deny (request);
  return TRUE;
}

static gboolean
on_file_chooser (WebKitWebView *view, WebKitFileChooserRequest *request, gpointer data)
{
  (void) view;
  (void) data;
  webkit_file_chooser_request_cancel (request);
  return TRUE;
}

static gboolean
on_script_dialog (WebKitWebView *view, WebKitScriptDialog *dialog, gpointer data)
{
  (void) view;
  (void) data;
  /* Handled synchronously without an answer: alert returns, confirm is
   * false, prompt is null, before-unload stays on the page.
   * webkit_script_dialog_close() is only for dialogs kept with
   * webkit_script_dialog_ref(). */
  (void) dialog;
  return TRUE;
}

static gboolean
on_authenticate (WebKitWebView *view, WebKitAuthenticationRequest *request, gpointer data)
{
  (void) view;
  (void) data;
  webkit_authentication_request_cancel (request);
  return TRUE;
}

static gboolean
on_tls_errors (WebKitWebView *view, char *uri, GTlsCertificate *certificate, GTlsCertificateFlags errors,
               gpointer data)
{
  (void) view;
  (void) uri;
  (void) certificate;
  (void) errors;
  fail (data, TC_RW_EVENT_FAILED, "tls_failure");
  return TRUE;
}

static const char *
load_error_code (GError *error)
{
  if (g_error_matches (error, WEBKIT_NETWORK_ERROR, WEBKIT_NETWORK_ERROR_CANCELLED)
      || g_error_matches (error, WEBKIT_POLICY_ERROR, WEBKIT_POLICY_ERROR_FRAME_LOAD_INTERRUPTED_BY_POLICY_CHANGE))
    return NULL;
  GNetworkMonitor *monitor = g_network_monitor_get_default ();
  if (monitor != NULL && !g_network_monitor_get_network_available (monitor))
    return "offline";
  return "load_failed";
}

static gboolean
on_load_failed (WebKitWebView *view, WebKitLoadEvent load_event, char *uri, GError *error, gpointer data)
{
  (void) view;
  (void) load_event;
  (void) uri;
  const char *code = load_error_code (error);
  g_message ("surface %s: load failed (%s %d): %s", ((TcSurface *) data)->id, g_quark_to_string (error->domain),
             error->code, code ? code : "ignored");
  if (code != NULL)
    fail (data, TC_RW_EVENT_FAILED, code);
  return TRUE;
}

static void
on_process_terminated (WebKitWebView *view, WebKitWebProcessTerminationReason reason, gpointer data)
{
  (void) view;
  TcSurface *surface = data;
  g_message ("surface %s: web process terminated (reason %d)", surface->id, (int) reason);
  fail (surface, TC_RW_EVENT_FAILED, "renderer_crash");
}

static void
apply_scroll (TcSurface *surface)
{
  if (surface->scroll_x == 0 && surface->scroll_y == 0)
    return;
  static const char body[] = "window.scrollTo(x, y);";
  GVariantBuilder arguments;
  g_variant_builder_init (&arguments, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add (&arguments, "{sv}", "x", g_variant_new_uint32 (surface->scroll_x));
  g_variant_builder_add (&arguments, "{sv}", "y", g_variant_new_uint32 (surface->scroll_y));
  webkit_web_view_call_async_javascript_function (surface->view, body, -1, g_variant_builder_end (&arguments),
                                                  SCRIPT_WORLD, NULL, surface->cancellable, NULL, NULL);
}

static void
on_load_changed (WebKitWebView *view, WebKitLoadEvent load_event, gpointer data)
{
  (void) view;
  TcSurface *surface = data;
  if (load_event != WEBKIT_LOAD_FINISHED || surface->failed)
    return;
  if (surface->kind == TC_RW_CONTENT_PAGE) {
    apply_scroll (surface);
    event (surface, TC_RW_EVENT_LOADED, NULL);
  } else {
    /* The wrapper document replaced about:blank; give it the current
     * visibility. It reports "loaded" itself when the player is ready. */
    youtube_command (surface);
  }
  surface->loaded_once = TRUE;
}

/* ------------------------------------------------------------ YouTube */

static void
youtube_command (TcSurface *surface)
{
  /* The wrapper watches this attribute; the command is a fixed token. */
  static const char body[] =
    "document.documentElement.setAttribute('data-tc-command', play ? 'play' : 'pause'); return true;";
  GVariantBuilder arguments;
  g_variant_builder_init (&arguments, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add (&arguments, "{sv}", "play", g_variant_new_boolean (surface->visible));
  webkit_web_view_call_async_javascript_function (surface->view, body, -1, g_variant_builder_end (&arguments),
                                                  SCRIPT_WORLD, NULL, surface->cancellable, NULL, NULL);
}

static void
on_youtube_state (GObject *source, GAsyncResult *result, gpointer data)
{
  g_autoptr (GError) error = NULL;
  g_autoptr (JSCValue) value =
    webkit_web_view_call_async_javascript_function_finish (WEBKIT_WEB_VIEW (source), result, &error);
  if (value == NULL || !jsc_value_is_string (value))
    return; /* cancelled, or the wrapper is not there yet */
  TcSurface *surface = data;
  g_autofree char *state = jsc_value_to_string (value);
  if (state == NULL || strlen (state) >= sizeof surface->youtube_state || strcmp (state, surface->youtube_state) == 0)
    return;
  g_strlcpy (surface->youtube_state, state, sizeof surface->youtube_state);
  if (strcmp (state, "ready") == 0 || strcmp (state, "playing") == 0) {
    if (!surface->youtube_ended && strcmp (state, "ready") == 0)
      event (surface, TC_RW_EVENT_LOADED, NULL);
    surface->youtube_ended = FALSE;
  } else if (strcmp (state, "ended") == 0) {
    surface->youtube_ended = TRUE;
    event (surface, TC_RW_EVENT_MEDIA_ENDED, NULL);
  } else if (g_str_has_prefix (state, "error:")) {
    g_message ("surface %s: YouTube player error %s", surface->id, state + 6);
    fail (surface, TC_RW_EVENT_FAILED, "youtube_error");
  }
}

static gboolean
poll_youtube (gpointer data)
{
  TcSurface *surface = data;
  static const char body[] = "var s = document.documentElement.getAttribute('data-tc-state');"
                             "return typeof s === 'string' && /^(loading|ready|playing|paused|buffering|ended|"
                             "error:[0-9]{1,4})$/.test(s) ? s : '';";
  webkit_web_view_call_async_javascript_function (surface->view, body, -1, NULL, SCRIPT_WORLD, NULL,
                                                  surface->cancellable, on_youtube_state, surface);
  return G_SOURCE_CONTINUE;
}

/* ------------------------------------------------------------ frames */

static void
on_first_frame (gpointer data)
{
  event (data, TC_RW_EVENT_STREAM_READY, NULL);
}

static void
on_buffer_rendered (WPEView *view, WPEBuffer *buffer, gpointer data)
{
  (void) view;
  TcSurface *surface = data;
  if (surface->frames == NULL)
    return;
  tc_frames_push (surface->frames, buffer);
  if (tc_frames_failed (surface->frames))
    fail (surface, TC_RW_EVENT_FAILED, "stream_failed");
}

/* ------------------------------------------------------------ lifecycle */

static WebKitSettings *
settings_for (const TcRwCreate *create)
{
  gboolean youtube = create->kind == TC_RW_CONTENT_YOUTUBE;
  WebKitSettings *settings = webkit_settings_new ();
  webkit_settings_set_enable_javascript (settings, youtube || create->javascript);
  webkit_settings_set_enable_html5_local_storage (settings, youtube || create->dom_storage);
  webkit_settings_set_enable_html5_database (settings, youtube || create->dom_storage);
  webkit_settings_set_enable_developer_extras (settings, FALSE);
  webkit_settings_set_enable_media_stream (settings, FALSE);
  webkit_settings_set_enable_webrtc (settings, FALSE);
  webkit_settings_set_enable_encrypted_media (settings, FALSE);
  webkit_settings_set_javascript_can_open_windows_automatically (settings, FALSE);
  webkit_settings_set_javascript_can_access_clipboard (settings, FALSE);
  webkit_settings_set_allow_file_access_from_file_urls (settings, FALSE);
  webkit_settings_set_allow_universal_access_from_file_urls (settings, FALSE);
  webkit_settings_set_media_playback_requires_user_gesture (settings, FALSE);
  webkit_settings_set_enable_write_console_messages_to_stdout (settings, FALSE);
  if (!youtube && create->user_agent != NULL && create->user_agent[0] != '\0')
    webkit_settings_set_user_agent (settings, create->user_agent);
  return settings;
}

static void
set_background (WebKitWebView *view, const char *color)
{
  WebKitColor rgba = { 0, 0, 0, 1 };
  if (color != NULL && color[0] == '#') {
    guint r, g, b, a = 255;
    if (sscanf (color + 1, "%2x%2x%2x", &r, &g, &b) == 3) {
      if (strlen (color) == 9)
        sscanf (color + 7, "%2x", &a);
      rgba = (WebKitColor) { r / 255.0, g / 255.0, b / 255.0, a / 255.0 };
    }
  }
  webkit_web_view_set_background_color (view, &rgba);
}

TcSurface *
tc_surface_create (TcWeb *web, TcRwCreate *create, const char **code)
{
  TcSurface *surface = g_new0 (TcSurface, 1);
  surface->web = web;
  g_strlcpy (surface->id, create->surface_id, sizeof surface->id);
  surface->kind = create->kind;
  surface->width = create->width;
  surface->height = create->height;
  surface->visible = create->visible;
  surface->muted = TRUE;
  surface->scroll_x = create->scroll_x;
  surface->scroll_y = create->scroll_y;
  surface->cancellable = g_cancellable_new ();
  if (create->kind == TC_RW_CONTENT_PAGE) {
    surface->url = g_steal_pointer (&create->url);
    surface->hosts = g_steal_pointer (&create->allowed_hosts);
  }
  if (!random_capability (surface->capability)) {
    *code = "unavailable";
    tc_surface_destroy (surface);
    return NULL;
  }
  g_autofree char *socket_name = g_strdup_printf ("%s.sock", surface->capability);
  g_autofree char *socket_path = g_build_filename (web->frames_dir, socket_name, NULL);
  g_autoptr (GError) error = NULL;
  surface->frames = tc_frames_new (socket_path, web->egl_display, on_first_frame, surface, &error);
  if (surface->frames == NULL) {
    g_warning ("surface %s: frame export unavailable: %s", surface->id, error->message);
    *code = "unavailable";
    tc_surface_destroy (surface);
    return NULL;
  }

  gboolean owned = FALSE;
  TcRwCookiePolicy policy = create->kind == TC_RW_CONTENT_YOUTUBE ? TC_RW_COOKIES_FIRST_PARTY : create->cookies;
  WebKitNetworkSession *session = tc_profiles_session (web, policy, &owned);
  if (owned)
    surface->private_session = session;
  g_autoptr (WebKitSettings) settings = settings_for (create);
  /* A fresh content manager: no script message handler, no user script. */
  g_autoptr (WebKitUserContentManager) content = webkit_user_content_manager_new ();
  surface->view = g_object_new (WEBKIT_TYPE_WEB_VIEW, "display", web->display, "web-context", web->context,
                                "network-session", session, "settings", settings, "user-content-manager", content,
                                NULL);
  /* WebKitWebView is not floating in WPE: g_object_new's reference is ours. */
  webkit_web_view_set_is_muted (surface->view, TRUE);
  set_background (surface->view, create->kind == TC_RW_CONTENT_YOUTUBE ? "#000000" : create->background);
  if (create->kind == TC_RW_CONTENT_PAGE && create->zoom_percent != 100)
    webkit_web_view_set_zoom_level (surface->view, create->zoom_percent / 100.0);
  g_signal_connect (surface->view, "decide-policy", G_CALLBACK (on_decide_policy), surface);
  g_signal_connect (surface->view, "permission-request", G_CALLBACK (on_permission_request), surface);
  g_signal_connect (surface->view, "run-file-chooser", G_CALLBACK (on_file_chooser), surface);
  g_signal_connect (surface->view, "script-dialog", G_CALLBACK (on_script_dialog), surface);
  g_signal_connect (surface->view, "authenticate", G_CALLBACK (on_authenticate), surface);
  g_signal_connect (surface->view, "load-failed-with-tls-errors", G_CALLBACK (on_tls_errors), surface);
  g_signal_connect (surface->view, "load-failed", G_CALLBACK (on_load_failed), surface);
  g_signal_connect (surface->view, "load-changed", G_CALLBACK (on_load_changed), surface);
  g_signal_connect (surface->view, "web-process-terminated", G_CALLBACK (on_process_terminated), surface);
  g_signal_connect (surface->view, "notify::uri", G_CALLBACK (on_uri_changed), surface);

  WPEView *wpe_view = webkit_web_view_get_wpe_view (surface->view);
  surface->toplevel = wpe_view_get_toplevel (wpe_view);
  if (surface->toplevel == NULL) {
    surface->toplevel = wpe_display_create_toplevel (web->display, 1);
    wpe_view_set_toplevel (wpe_view, surface->toplevel);
  } else {
    g_object_ref (surface->toplevel);
  }
  wpe_toplevel_resize (surface->toplevel, (int) surface->width, (int) surface->height);
  g_signal_connect (wpe_view, "buffer-rendered", G_CALLBACK (on_buffer_rendered), surface);

  if (create->kind == TC_RW_CONTENT_YOUTUBE) {
    g_autofree char *html = tc_youtube_wrapper (create);
    webkit_web_view_load_html (surface->view, html, TC_YOUTUBE_BASE_URI);
    surface->youtube_poll = g_timeout_add (YOUTUBE_POLL_MS, poll_youtube, surface);
    if (surface->visible)
      youtube_command (surface);
  } else if (tc_policy_main_frame (surface->url, surface->url, surface->hosts) != TC_NAV_ALLOW) {
    /* The configured URL itself is outside the allowlist. The surface exists
     * so the renderer gets a typed event, not a missing reply. */
    surface->blocked_source = g_idle_add (report_blocked, surface);
  } else {
    webkit_web_view_load_uri (surface->view, surface->url);
  }
  return surface;
}

void
tc_surface_resize (TcSurface *surface, guint width, guint height)
{
  surface->width = width;
  surface->height = height;
  wpe_toplevel_resize (surface->toplevel, (int) width, (int) height);
}

void
tc_surface_set_visible (TcSurface *surface, gboolean visible)
{
  surface->visible = visible;
  if (surface->kind == TC_RW_CONTENT_YOUTUBE)
    youtube_command (surface);
}

void
tc_surface_set_muted (TcSurface *surface, gboolean muted)
{
  surface->muted = muted || surface->failed;
  webkit_web_view_set_is_muted (surface->view, surface->muted);
}

void
tc_surface_reload (TcSurface *surface)
{
  if (surface->failed)
    return;
  if (surface->kind == TC_RW_CONTENT_YOUTUBE)
    return; /* the wrapper keeps the player; a reload would restart it */
  webkit_web_view_reload (surface->view);
}

const char *
tc_surface_capability (TcSurface *surface)
{
  return surface->capability;
}

guint64
tc_surface_pixels (TcSurface *surface)
{
  return (guint64) surface->width * surface->height;
}

WebKitNetworkSession *
tc_surface_private_session (TcSurface *surface)
{
  return surface->private_session;
}

void
tc_surface_destroy (TcSurface *surface)
{
  if (surface == NULL)
    return;
  if (surface->youtube_poll != 0)
    g_source_remove (surface->youtube_poll);
  if (surface->blocked_source != 0)
    g_source_remove (surface->blocked_source);
  if (surface->cancellable != NULL)
    g_cancellable_cancel (surface->cancellable);
  /* Silence first: a hidden or stale surface is never audible. */
  if (surface->view != NULL) {
    webkit_web_view_set_is_muted (surface->view, TRUE);
    g_signal_handlers_disconnect_by_data (surface->view, surface);
    g_signal_handlers_disconnect_by_data (webkit_web_view_get_wpe_view (surface->view), surface);
  }
  /* The socket goes first, so the capability names nothing from here on. */
  tc_frames_free (surface->frames);
  g_clear_object (&surface->view);
  g_clear_object (&surface->toplevel);
  g_clear_object (&surface->private_session);
  g_clear_object (&surface->cancellable);
  g_clear_pointer (&surface->hosts, g_ptr_array_unref);
  g_free (surface->url);
  g_free (surface);
}
