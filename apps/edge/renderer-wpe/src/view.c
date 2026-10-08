/*
 * The web view and the native/JS bridge.
 *
 * Security model (docs/tilecast-edge.md §10.2–10.3, §17):
 *   - The view loads only tilecast://runtime/index.html, the shared Tilecast
 *     Player Runtime (packages/player-runtime) that Electron also hosts. Every other
 *     navigation, new window and permission request is refused.
 *   - The bridge script is injected only into the top frame of pages under
 *     tilecast://runtime/. Remote content never gets the bridge, and
 *     in this renderer version no remote content is loaded at all.
 *   - Page → host messages are a closed set of types. The host copies known,
 *     bounded fields into IPC events; it never forwards page objects as-is.
 *   - Host → page calls pass data as GVariant arguments to a fixed function
 *     body; nothing is concatenated into JavaScript source.
 */
#include "host.h"
#include "validate.h"
#include "remote-web.h"

#include <glib/gstdio.h>
#include <string.h>

#define RUNTIME_URI "tilecast://runtime/index.html"
#define MAX_TEXT 240

static void
deliver_done (GObject *source, GAsyncResult *result, gpointer user_data)
{
  (void) user_data;
  g_autoptr (GError) error = NULL;
  g_autoptr (JSCValue) value =
    webkit_web_view_call_async_javascript_function_finish (WEBKIT_WEB_VIEW (source), result, &error);
  if (error != NULL)
    g_warning ("view: runtime delivery failed: %s", error->message);
}

void
tc_view_deliver (TcHost *host, const char *name, const char *json)
{
  static const char body[] =
    "return globalThis.__tilecastHost ? globalThis.__tilecastHost.receive(name, json) : false;";
  GVariantBuilder builder;
  g_variant_builder_init (&builder, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add (&builder, "{sv}", "name", g_variant_new_string (name));
  g_variant_builder_add (&builder, "{sv}", "json", g_variant_new_string (json));
  webkit_web_view_call_async_javascript_function (host->view, body, -1, g_variant_builder_end (&builder), NULL,
                                                  NULL, NULL, deliver_done, host);
}

void
tc_view_reply_json (TcHost *host, WebKitScriptMessageReply *reply, const char *json)
{
  JSCContext *context = g_object_get_data (G_OBJECT (host->view), "tc-js-context");
  if (context == NULL) {
    webkit_script_message_reply_return_error_message (reply, "runtime context unavailable");
    return;
  }
  g_autoptr (JSCValue) value = jsc_value_new_from_json (context, json);
  webkit_script_message_reply_return_value (reply, value);
}

void
tc_view_reload_runtime (TcHost *host)
{
  /* The document that owned the remote web surfaces is going away. */
  tc_remote_web_reset (host);
  host->runtime_ready = FALSE;
  g_clear_pointer (&host->runtime_support, json_node_unref);
  webkit_web_view_load_uri (host->view, RUNTIME_URI);
}

void
tc_view_resolve_reply (TcHost *host, const char *request_id, const char *result_json, const char *error_message)
{
  WebKitScriptMessageReply *reply = g_hash_table_lookup (host->pending_replies, request_id);
  if (reply == NULL)
    return;
  if (result_json != NULL) {
    JSCContext *context = g_object_get_data (G_OBJECT (host->view), "tc-js-context");
    if (context != NULL) {
      g_autoptr (JSCValue) value = jsc_value_new_from_json (context, result_json);
      webkit_script_message_reply_return_value (reply, value);
    } else {
      webkit_script_message_reply_return_error_message (reply, "runtime context unavailable");
    }
  } else {
    webkit_script_message_reply_return_error_message (reply, error_message ? error_message : "error");
  }
  g_hash_table_remove (host->pending_replies, request_id);
}

/* Copies a bounded string member into the builder, or fails. */
static gboolean
copy_string (JsonBuilder *builder, JsonObject *source, const char *member, gboolean required, gsize max)
{
  const char *value = json_object_get_string_member_with_default (source, member, NULL);
  if (value == NULL)
    return !required;
  if (strlen (value) > max * 4 || !g_utf8_validate (value, -1, NULL) || g_utf8_strlen (value, -1) > (glong) max)
    return FALSE;
  json_builder_set_member_name (builder, member);
  json_builder_add_string_value (builder, value);
  return TRUE;
}

/* Adds {"activation": {"activationId", "generation"}} from the page message. */
static gboolean
copy_activation (JsonBuilder *builder, JsonObject *message)
{
  JsonObject *activation = json_object_get_object_member (message, "activation");
  if (activation == NULL)
    return FALSE;
  const char *id = json_object_get_string_member_with_default (activation, "activationId", NULL);
  gint64 generation = json_object_get_int_member_with_default (activation, "generation", -1);
  if (id == NULL || strlen (id) != 36 || generation < 0)
    return FALSE;
  json_builder_set_member_name (builder, "activation");
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "activationId");
  json_builder_add_string_value (builder, id);
  json_builder_set_member_name (builder, "generation");
  json_builder_add_int_value (builder, generation);
  json_builder_end_object (builder);
  return TRUE;
}

static const char *const EVIDENCE_KINDS[] = {
  "item_started", "item_transition", "video_progress", "image_shown", "widget_shown", "widget_empty",
  "widget_alive", "layout_shown", "layout_alive", "layout_zone_rendered", "website_loaded", "website_alive",
  "frame_changed", "surface_shown", NULL,
};

static gboolean
is_evidence_kind (const char *kind)
{
  for (guint i = 0; EVIDENCE_KINDS[i] != NULL; i++) {
    if (g_strcmp0 (kind, EVIDENCE_KINDS[i]) == 0)
      return TRUE;
  }
  return FALSE;
}

static void
forward_page_message (TcHost *host, JsonObject *message)
{
  const char *type = json_object_get_string_member_with_default (message, "type", "");
  if (g_strcmp0 (type, "runtime.ready") == 0) {
    host->runtime_ready = FALSE;
    g_clear_pointer (&host->runtime_support, json_node_unref);
    JsonNode *support = json_object_get_member (message, "support");
    if (support != NULL && !JSON_NODE_HOLDS_NULL (support)) {
      if (!tc_runtime_support_valid (support))
        return;
      host->runtime_support = json_node_copy (support);
    }
    host->runtime_ready = TRUE;
    tc_protocol_send_ready (host);
    if (host->current_plugins_json != NULL)
      tc_view_deliver (host, "plugin.state", host->current_plugins_json);
    if (host->current_activation_json != NULL)
      tc_view_deliver (host, "presentation.activate", host->current_activation_json);
    return;
  }

  if (g_str_has_prefix (type, "remote_web.")) {
    if (g_strcmp0 (type, "remote_web.recovered") == 0)
      g_message ("view: a remote web surface recovered");
    else
      tc_remote_web_page_message (host, type, message);
    return;
  }

  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  const char *event = NULL;
  gboolean ok = copy_activation (builder, message);
  if (g_strcmp0 (type, "presentation.accepted") == 0) {
    event = "presentation.accepted";
  } else if (g_strcmp0 (type, "presentation.rejected") == 0) {
    event = "presentation.rejected";
    ok = ok && copy_string (builder, message, "code", TRUE, 64) && copy_string (builder, message, "message", TRUE, MAX_TEXT);
  } else if (g_strcmp0 (type, "renderer.progress") == 0) {
    event = "renderer.progress";
    const char *kind = json_object_get_string_member_with_default (message, "kind", NULL);
    ok = ok && is_evidence_kind (kind) && copy_string (builder, message, "itemId", FALSE, 160)
         && copy_string (builder, message, "zoneId", FALSE, 160);
    if (ok) {
      json_builder_set_member_name (builder, "kind");
      json_builder_add_string_value (builder, kind);
    }
  } else if (g_strcmp0 (type, "renderer.item_error") == 0) {
    event = "renderer.item_error";
    ok = ok && copy_string (builder, message, "itemId", FALSE, 160) && copy_string (builder, message, "code", TRUE, 64)
         && copy_string (builder, message, "message", TRUE, MAX_TEXT);
  } else {
    ok = FALSE;
  }
  json_builder_end_object (builder);
  if (!ok || event == NULL) {
    g_warning ("view: dropping unrecognized page message");
    return;
  }
  tc_ipc_send_event (host, event, json_builder_get_root (builder));
}

static JsonObject *
parse_message (JSCValue *value, JsonParser *parser)
{
  if (!jsc_value_is_object (value))
    return NULL;
  g_autofree char *json = jsc_value_to_json (value, 0);
  if (json == NULL || strlen (json) > 64 * 1024 || !json_parser_load_from_data (parser, json, -1, NULL))
    return NULL;
  JsonNode *root = json_parser_get_root (parser);
  return root && JSON_NODE_HOLDS_OBJECT (root) ? json_node_get_object (root) : NULL;
}

static void
on_script_message (WebKitUserContentManager *manager, JSCValue *value, gpointer user_data)
{
  (void) manager;
  TcHost *host = user_data;
  g_autoptr (JsonParser) parser = json_parser_new_immutable ();
  JsonObject *message = parse_message (value, parser);
  if (message != NULL)
    forward_page_message (host, message);
}

static gboolean
on_script_request (WebKitUserContentManager *manager, JSCValue *value, WebKitScriptMessageReply *reply,
                   gpointer user_data)
{
  (void) manager;
  TcHost *host = user_data;
  g_autoptr (JsonParser) parser = json_parser_new_immutable ();
  JsonObject *message = parse_message (value, parser);
  const char *type = message ? json_object_get_string_member_with_default (message, "type", "") : "";
  g_object_set_data_full (G_OBJECT (host->view), "tc-js-context", g_object_ref (jsc_value_get_context (value)),
                          g_object_unref);
  if (g_strcmp0 (type, "remote_web.create") == 0) {
    tc_remote_web_create (host, message, reply);
    return TRUE;
  }
  /* A fixed set of requests, each with a fixed parameter shape. */
  gboolean setup = g_strcmp0 (type, "setup.submit_server_url") == 0;
  gboolean discovery = g_strcmp0 (type, "discovery.list") == 0;
  if (!setup && !discovery) {
    webkit_script_message_reply_return_error_message (reply, "unsupported request");
    return TRUE;
  }
  g_autoptr (JsonBuilder) params = json_builder_new ();
  json_builder_begin_object (params);
  gboolean ok = setup ? copy_string (params, message, "url", TRUE, 512) : TRUE;
  json_builder_end_object (params);
  g_autofree char *id = NULL;
  if (!ok || !tc_ipc_send_request (host, type, json_builder_get_root (params), &id)) {
    webkit_script_message_reply_return_error_message (reply, ok ? "tilecastd is not reachable" : "invalid address");
    return TRUE;
  }
  g_object_set_data_full (G_OBJECT (host->view), "tc-js-context", g_object_ref (jsc_value_get_context (value)),
                          g_object_unref);
  g_hash_table_insert (host->pending_replies, g_steal_pointer (&id), webkit_script_message_reply_ref (reply));
  return TRUE;
}

static gboolean
on_decide_policy (WebKitWebView *view, WebKitPolicyDecision *decision, WebKitPolicyDecisionType type, gpointer data)
{
  (void) view;
  (void) data;
  if (type == WEBKIT_POLICY_DECISION_TYPE_RESPONSE)
    return FALSE;
  WebKitNavigationAction *action =
    webkit_navigation_policy_decision_get_navigation_action (WEBKIT_NAVIGATION_POLICY_DECISION (decision));
  const char *uri = webkit_uri_request_get_uri (webkit_navigation_action_get_request (action));
  if (type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION && g_str_has_prefix (uri, "tilecast://runtime/")) {
    webkit_policy_decision_use (decision);
  } else {
    g_warning ("view: refused navigation away from the trusted runtime");
    webkit_policy_decision_ignore (decision);
  }
  return TRUE;
}

static gboolean
on_permission_request (WebKitWebView *view, WebKitPermissionRequest *request, gpointer data)
{
  (void) view;
  (void) data;
  /* Microphone, camera, geolocation, notifications: never granted. */
  webkit_permission_request_deny (request);
  return TRUE;
}

static void
on_web_process_terminated (WebKitWebView *view, WebKitWebProcessTerminationReason reason, gpointer user_data)
{
  (void) view;
  TcHost *host = user_data;
  host->web_process_terminations++;
  g_warning ("view: web process terminated (reason %d); reloading the runtime", (int) reason);
  tc_remote_web_reset (host);
  tc_protocol_send_health (host, "degraded", "web_process_terminated");
  tc_view_reload_runtime (host);
}

static gboolean
on_load_failed (WebKitWebView *view, WebKitLoadEvent event, char *uri, GError *error, gpointer user_data)
{
  (void) view;
  (void) event;
  (void) uri;
  (void) user_data;
  g_warning ("view: runtime load failed: %s", error->message);
  return FALSE;
}

static char *
read_bridge_script (TcHost *host, GError **error)
{
  g_autofree char *path = g_build_filename (host->runtime_dir, "tilecast-bridge.js", NULL);
  char *contents = NULL;
  if (!g_file_get_contents (path, &contents, NULL, error))
    return NULL;
  return contents;
}

/* How long a release renderer waits for the media socket before it builds the
 * web context. The release self-test starts the renderer before its host
 * binds the socket, and the self-test renderer is not restarted. Development
 * and CI builds do not sandbox and do not wait. */
#ifdef TILECAST_ALLOW_UNSANDBOXED_WEBKIT
#define MEDIA_SOCKET_WAIT_MS 0
#else
#define MEDIA_SOCKET_WAIT_MS 30000
#endif

/* WebKit refuses to add a path to the sandbox that does not exist yet
 * ("must be created before adding it to the sandbox"), and the renderer can
 * start before the daemon has bound its media socket (the release self-test
 * starts the renderer first). Wait for it, bounded. */
static gboolean
wait_for_path (const char *path, guint timeout_ms)
{
  for (guint waited = 0; waited < timeout_ms; waited += 100) {
    if (g_file_test (path, G_FILE_TEST_EXISTS))
      return TRUE;
    g_usleep (100 * 1000);
  }
  return g_file_test (path, G_FILE_TEST_EXISTS);
}

static gboolean
media_socket_identity (const char *path, guint64 *dev, guint64 *ino)
{
  GStatBuf st;
  if (g_stat (path, &st) != 0)
    return FALSE;
  *dev = (guint64) st.st_dev;
  *ino = (guint64) st.st_ino;
  return TRUE;
}

gboolean
tc_view_media_socket_stale (TcHost *host)
{
  guint64 dev = 0, ino = 0;
  if (!media_socket_identity (host->media_socket, &dev, &ino))
    return FALSE;
  return !host->media_identity_known || dev != host->media_dev || ino != host->media_ino;
}

gboolean
tc_view_create (TcHost *host, GError **error)
{
  g_autofree char *bridge = read_bridge_script (host, error);
  if (bridge == NULL)
    return FALSE;

  host->web_context = webkit_web_context_new ();
  /* The web-process sandbox sees the media plugin; media bytes are provided
   * by tilecastd over its capability socket. */
  webkit_web_context_add_path_to_sandbox (host->web_context, host->gst_plugin_dir, TRUE);
  if (!wait_for_path (host->media_socket, MEDIA_SOCKET_WAIT_MS))
    g_warning ("view: %s does not exist yet; video needs the renderer restarted once the daemon is up",
               host->media_socket);
  host->media_identity_known = media_socket_identity (host->media_socket, &host->media_dev, &host->media_ino);
  webkit_web_context_add_path_to_sandbox (host->web_context, host->media_socket, TRUE);
  /* tcwebsrc connects to the helper's frame sockets from the web process.
   * The directory is the helper's; the renderer unit's supplementary
   * group tilecast-web is what lets it connect. */
  /* The directory must exist when the web process starts and keep its
   * inode across helper restarts: tmpfiles.d creates it and the helper unit
   * preserves it (RuntimeDirectoryPreserve=yes). */
  if (g_file_test (host->web_frames_dir, G_FILE_TEST_IS_DIR))
    webkit_web_context_add_path_to_sandbox (host->web_context, host->web_frames_dir, TRUE);
  host->network_session = webkit_network_session_new_ephemeral ();
  tc_schemes_register (host);

  WebKitSettings *settings = webkit_settings_new ();
  webkit_settings_set_enable_developer_extras (settings, FALSE);
  webkit_settings_set_enable_media_stream (settings, FALSE);
  webkit_settings_set_media_playback_requires_user_gesture (settings, FALSE);
  webkit_settings_set_enable_write_console_messages_to_stdout (settings, host->console_to_stderr);
  webkit_settings_set_javascript_can_open_windows_automatically (settings, FALSE);

  WebKitUserContentManager *manager = webkit_user_content_manager_new ();
  static const char *const allow[] = { "tilecast://runtime/*", NULL };
  g_autoptr (WebKitUserScript) script = webkit_user_script_new (
    bridge, WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, allow, NULL);
  webkit_user_content_manager_add_script (manager, script);
  g_signal_connect (manager, "script-message-received::tilecast", G_CALLBACK (on_script_message), host);
  g_signal_connect (manager, "script-message-with-reply-received::tilecastRequest", G_CALLBACK (on_script_request),
                    host);
  webkit_user_content_manager_register_script_message_handler (manager, "tilecast", NULL);
  webkit_user_content_manager_register_script_message_handler_with_reply (manager, "tilecastRequest", NULL);

  host->view = g_object_new (WEBKIT_TYPE_WEB_VIEW, "display", host->display, "web-context", host->web_context,
                             "network-session", host->network_session, "settings", settings,
                             "user-content-manager", manager, NULL);
  g_object_unref (settings);
  g_object_unref (manager);
  g_object_ref_sink (host->view);

  WebKitColor black = { 0, 0, 0, 1 };
  webkit_web_view_set_background_color (host->view, &black);
  g_signal_connect (host->view, "decide-policy", G_CALLBACK (on_decide_policy), host);
  g_signal_connect (host->view, "permission-request", G_CALLBACK (on_permission_request), host);
  g_signal_connect (host->view, "web-process-terminated", G_CALLBACK (on_web_process_terminated), host);
  g_signal_connect (host->view, "load-failed", G_CALLBACK (on_load_failed), host);

  WPEView *wpe_view = webkit_web_view_get_wpe_view (host->view);
  WPEToplevel *toplevel = wpe_view_get_toplevel (wpe_view);
  if (toplevel == NULL) {
    toplevel = wpe_display_create_toplevel (host->display, 1);
    wpe_view_set_toplevel (wpe_view, toplevel);
    g_object_unref (toplevel);
  }
  if (host->platform == TC_PLATFORM_HEADLESS)
    wpe_toplevel_resize (toplevel, host->headless_width, host->headless_height);
  else
    wpe_toplevel_fullscreen (toplevel);
  wpe_toplevel_set_title (toplevel, "Tilecast");

  webkit_web_view_load_uri (host->view, RUNTIME_URI);
  return TRUE;
}
