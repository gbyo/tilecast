/*
 * tilecast-runtime-conformance: runs one Player Runtime conformance fixture
 * under WPE WebKit (WPEPlatform, headless) and records the results.
 *
 * Test-only; never installed. It loads the same runtime artifact the product
 * serves, from the same trusted origin (tilecast://runtime/index.html), with
 * the product's runtime path validation and media source, and injects the
 * shared conformance fixture host instead of the product bridge. The Electron
 * runner (apps/player-linux/conformance) does the same under Chromium, and
 * packages/player-runtime/conformance/compare.mjs compares the two.
 *
 *   tilecast-runtime-conformance --runtime-dir DIR --host-script FILE
 *     --fixture FILE --cas-root DIR --out DIR [--size WxH] [--timeout S]
 *
 * Screenshots are written as <out>/<checkpoint>.raw plus a .json sidecar
 * (width, height, stride, format); the results as <out>/result.json.
 */
#include "validate.h"

#include <errno.h>
#include <fcntl.h>
#include <gio/gunixinputstream.h>
#include <json-glib/json-glib.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <wpe/headless/wpe-headless.h>
#include <wpe/webkit.h>

typedef struct {
  char *runtime_dir;
  char *cas_root;
  char *out_dir;
  GMainLoop *loop;
  WebKitWebView *view;
  int exit_code;
} Runner;

static void
finish_request (WebKitURISchemeRequest *request, const char *path, const char *content_type)
{
  int fd = open (path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat info;
  if (fd < 0 || fstat (fd, &info) != 0 || !S_ISREG (info.st_mode)) {
    if (fd >= 0)
      close (fd);
    g_autoptr (GError) error = g_error_new (G_IO_ERROR, G_IO_ERROR_NOT_FOUND, "not found");
    webkit_uri_scheme_request_finish_error (request, error);
    return;
  }
  g_autoptr (GInputStream) stream = g_unix_input_stream_new (fd, TRUE);
  webkit_uri_scheme_request_finish (request, stream, info.st_size, content_type);
}

static void
handle_runtime (WebKitURISchemeRequest *request, gpointer user_data)
{
  Runner *runner = user_data;
  const char *path = webkit_uri_scheme_request_get_path (request);
  const char *type = tc_runtime_content_type (path);
  if (!tc_runtime_path_is_allowed (path) || type == NULL) {
    g_autoptr (GError) error = g_error_new (G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "not a runtime file");
    webkit_uri_scheme_request_finish_error (request, error);
    return;
  }
  g_autofree char *file = g_build_filename (runner->runtime_dir, path + 1, NULL);
  finish_request (request, file, type);
}

static void
handle_media (WebKitURISchemeRequest *request, gpointer user_data)
{
  Runner *runner = user_data;
  const char *uri = webkit_uri_scheme_request_get_uri (request);
  const char *prefix = "tcmedia://sha256/";
  const char *hex = g_str_has_prefix (uri, prefix) ? uri + strlen (prefix) : NULL;
  if (!tc_is_sha256_hex (hex)) {
    g_autoptr (GError) error = g_error_new (G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "not a media object");
    webkit_uri_scheme_request_finish_error (request, error);
    return;
  }
  char shard[3] = { hex[0], hex[1], '\0' };
  g_autofree char *file = g_build_filename (runner->cas_root, "sha256", shard, hex, NULL);
  finish_request (request, file, "image/png");
}

static gboolean
write_file (const char *dir, const char *name, const char *suffix, const void *data, gsize length)
{
  g_autofree char *file_name = g_strconcat (name, suffix, NULL);
  g_autofree char *path = g_build_filename (dir, file_name, NULL);
  g_autoptr (GError) error = NULL;
  if (!g_file_set_contents (path, data, (gssize) length, &error)) {
    g_printerr ("conformance: %s\n", error->message);
    return FALSE;
  }
  return TRUE;
}

static gboolean
checkpoint_name_is_safe (const char *name)
{
  if (name == NULL || name[0] == '\0' || strlen (name) > 64)
    return FALSE;
  for (const char *p = name; *p; p++) {
    if (!(g_ascii_isalnum (*p) || *p == '-' || *p == '_'))
      return FALSE;
  }
  return TRUE;
}

typedef struct {
  Runner *runner;
  char *name;
  WebKitScriptMessageReply *reply;
} SnapshotJob;

static void
snapshot_done (GObject *source, GAsyncResult *result, gpointer user_data)
{
  SnapshotJob *job = user_data;
  g_autoptr (GError) error = NULL;
  g_autoptr (WebKitImage) image = webkit_web_view_get_snapshot_finish (WEBKIT_WEB_VIEW (source), result, &error);
  if (image == NULL) {
    webkit_script_message_reply_return_error_message (job->reply, error ? error->message : "snapshot failed");
  } else {
    GBytes *bytes = webkit_image_as_bytes (image); /* transfer none */
    gsize length = 0;
    const void *data = g_bytes_get_data (bytes, &length);
    g_autofree char *meta = g_strdup_printf (
      "{\"width\":%d,\"height\":%d,\"stride\":%u,\"format\":\"webkit-image\"}\n", webkit_image_get_width (image),
      webkit_image_get_height (image), webkit_image_get_stride (image));
    gboolean ok = write_file (job->runner->out_dir, job->name, ".raw", data, length)
                  && write_file (job->runner->out_dir, job->name, ".json", meta, strlen (meta));
    if (ok) {
      g_autoptr (JSCContext) context = jsc_context_new ();
      g_autoptr (JSCValue) value = jsc_value_new_null (context);
      webkit_script_message_reply_return_value (job->reply, value);
    } else {
      webkit_script_message_reply_return_error_message (job->reply, "could not write the snapshot");
    }
  }
  webkit_script_message_reply_unref (job->reply);
  g_free (job->name);
  g_free (job);
}

static gboolean
on_snapshot (WebKitUserContentManager *manager, JSCValue *value, WebKitScriptMessageReply *reply, gpointer user_data)
{
  Runner *runner = user_data;
  g_autofree char *name = jsc_value_is_string (value) ? jsc_value_to_string (value) : NULL;
  if (!checkpoint_name_is_safe (name)) {
    webkit_script_message_reply_return_error_message (reply, "invalid checkpoint name");
    return TRUE;
  }
  SnapshotJob *job = g_new0 (SnapshotJob, 1);
  job->runner = runner;
  job->name = g_steal_pointer (&name);
  job->reply = webkit_script_message_reply_ref (reply);
  webkit_web_view_get_snapshot (runner->view, WEBKIT_SNAPSHOT_REGION_VISIBLE, WEBKIT_SNAPSHOT_OPTIONS_NONE, NULL,
                                snapshot_done, job);
  return TRUE;
}

static void
on_finish (WebKitUserContentManager *manager, JSCValue *value, gpointer user_data)
{
  Runner *runner = user_data;
  g_autofree char *json = jsc_value_is_string (value) ? jsc_value_to_string (value) : NULL;
  if (json == NULL || !write_file (runner->out_dir, "result", ".json", json, strlen (json)))
    runner->exit_code = 1;
  g_main_loop_quit (runner->loop);
}

static gboolean
on_timeout (gpointer user_data)
{
  Runner *runner = user_data;
  g_printerr ("conformance: timed out\n");
  runner->exit_code = 2;
  g_main_loop_quit (runner->loop);
  return G_SOURCE_REMOVE;
}

static gboolean
on_decide_policy (WebKitWebView *view, WebKitPolicyDecision *decision, WebKitPolicyDecisionType type, gpointer data)
{
  if (type == WEBKIT_POLICY_DECISION_TYPE_RESPONSE)
    return FALSE;
  WebKitNavigationAction *action =
    webkit_navigation_policy_decision_get_navigation_action (WEBKIT_NAVIGATION_POLICY_DECISION (decision));
  const char *uri = webkit_uri_request_get_uri (webkit_navigation_action_get_request (action));
  if (type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION && g_str_has_prefix (uri, "tilecast://runtime/"))
    webkit_policy_decision_use (decision);
  else
    webkit_policy_decision_ignore (decision);
  return TRUE;
}

int
main (int argc, char **argv)
{
  g_autofree char *runtime_dir = NULL, *host_script = NULL, *fixture = NULL, *cas_root = NULL, *out_dir = NULL,
                  *size = NULL;
  int timeout = 180;
  GOptionEntry entries[] = {
    { "runtime-dir", 0, 0, G_OPTION_ARG_FILENAME, &runtime_dir, "Built runtime directory", "DIR" },
    { "host-script", 0, 0, G_OPTION_ARG_FILENAME, &host_script, "Conformance fixture host script", "FILE" },
    { "fixture", 0, 0, G_OPTION_ARG_FILENAME, &fixture, "Fixture JSON", "FILE" },
    { "cas-root", 0, 0, G_OPTION_ARG_FILENAME, &cas_root, "Fixture media store", "DIR" },
    { "out", 0, 0, G_OPTION_ARG_FILENAME, &out_dir, "Output directory", "DIR" },
    { "size", 0, 0, G_OPTION_ARG_STRING, &size, "View size (default 1280x720)", "WxH" },
    { "timeout", 0, 0, G_OPTION_ARG_INT, &timeout, "Seconds before giving up", "S" },
    { NULL },
  };
  g_autoptr (GOptionContext) options = g_option_context_new ("- run a Player Runtime conformance fixture");
  g_option_context_add_main_entries (options, entries, NULL);
  g_autoptr (GError) error = NULL;
  if (!g_option_context_parse (options, &argc, &argv, &error) || !runtime_dir || !host_script || !fixture
      || !cas_root || !out_dir) {
    g_printerr ("conformance: %s\n", error ? error->message : "missing required options");
    return 64;
  }
  int width = 1280, height = 720;
  if (size != NULL && sscanf (size, "%dx%d", &width, &height) != 2) {
    g_printerr ("conformance: invalid --size\n");
    return 64;
  }

  g_autofree char *host_source = NULL;
  g_autoptr (JsonParser) parser = json_parser_new ();
  if (!g_file_get_contents (host_script, &host_source, NULL, &error) || !json_parser_load_from_file (parser, fixture, &error)) {
    g_printerr ("conformance: %s\n", error->message);
    return 66;
  }
  /* The fixture is re-serialized by json-glib, never pasted as text. */
  g_autofree char *fixture_json = json_to_string (json_parser_get_root (parser), FALSE);
  g_autofree char *runner_source = g_strdup_printf (
    "globalThis.__tilecastConformanceRunner = Object.freeze({"
    "  fixture: %s,"
    "  snapshot: (name) => webkit.messageHandlers.conformanceSnapshot.postMessage(name).then(() => undefined),"
    "  finish: (result) => webkit.messageHandlers.conformanceFinish.postMessage(JSON.stringify(result)),"
    "});",
    fixture_json);

  Runner runner = { .runtime_dir = runtime_dir, .cas_root = cas_root, .out_dir = out_dir };
  runner.loop = g_main_loop_new (NULL, FALSE);
  g_mkdir_with_parents (out_dir, 0755);

  /* The product's media environment (see src/main.c): video plays through
   * tcmediasrc from the fixture store only. GST_PLUGIN_PATH is the caller's. */
  g_setenv ("WEBKIT_GST_ALLOWED_URI_PROTOCOLS", "tcmedia", TRUE);
  g_setenv ("TILECAST_CAS_ROOT", cas_root, TRUE);

  WPEDisplay *display = wpe_display_headless_new ();
  if (!wpe_display_connect (display, &error)) {
    g_printerr ("conformance: display: %s\n", error->message);
    return 70;
  }
  wpe_display_set_primary (display);
  WebKitWebContext *web_context = webkit_web_context_new ();
  webkit_web_context_add_path_to_sandbox (web_context, cas_root, TRUE);
  WebKitSecurityManager *security = webkit_web_context_get_security_manager (web_context);
  webkit_security_manager_register_uri_scheme_as_secure (security, "tilecast");
  webkit_security_manager_register_uri_scheme_as_secure (security, "tcmedia");
  webkit_security_manager_register_uri_scheme_as_cors_enabled (security, "tcmedia");
  webkit_web_context_register_uri_scheme (web_context, "tilecast", handle_runtime, &runner, NULL);
  webkit_web_context_register_uri_scheme (web_context, "tcmedia", handle_media, &runner, NULL);

  WebKitSettings *settings = webkit_settings_new ();
  webkit_settings_set_enable_media_stream (settings, FALSE);
  webkit_settings_set_media_playback_requires_user_gesture (settings, FALSE);
  webkit_settings_set_enable_write_console_messages_to_stdout (settings, TRUE);

  WebKitUserContentManager *manager = webkit_user_content_manager_new ();
  static const char *const allow[] = { "tilecast://runtime/*", NULL };
  g_autoptr (WebKitUserScript) runner_script = webkit_user_script_new (
    runner_source, WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, allow, NULL);
  g_autoptr (WebKitUserScript) host = webkit_user_script_new (
    host_source, WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, allow, NULL);
  webkit_user_content_manager_add_script (manager, runner_script);
  webkit_user_content_manager_add_script (manager, host);
  g_signal_connect (manager, "script-message-with-reply-received::conformanceSnapshot", G_CALLBACK (on_snapshot),
                    &runner);
  g_signal_connect (manager, "script-message-received::conformanceFinish", G_CALLBACK (on_finish), &runner);
  webkit_user_content_manager_register_script_message_handler_with_reply (manager, "conformanceSnapshot", NULL);
  webkit_user_content_manager_register_script_message_handler (manager, "conformanceFinish", NULL);

  runner.view = g_object_new (WEBKIT_TYPE_WEB_VIEW, "display", display, "web-context", web_context, "settings",
                              settings, "user-content-manager", manager, NULL);
  g_object_ref_sink (runner.view);
  WebKitColor black = { 0, 0, 0, 1 };
  webkit_web_view_set_background_color (runner.view, &black);
  g_signal_connect (runner.view, "decide-policy", G_CALLBACK (on_decide_policy), NULL);

  WPEView *wpe_view = webkit_web_view_get_wpe_view (runner.view);
  WPEToplevel *toplevel = wpe_view_get_toplevel (wpe_view);
  if (toplevel == NULL) {
    toplevel = wpe_display_create_toplevel (display, 1);
    wpe_view_set_toplevel (wpe_view, toplevel);
    g_object_unref (toplevel);
  }
  wpe_toplevel_resize (toplevel, width, height);

  g_timeout_add_seconds ((guint) timeout, on_timeout, &runner);
  webkit_web_view_load_uri (runner.view, "tilecast://runtime/index.html");
  g_main_loop_run (runner.loop);
  return runner.exit_code;
}
