#include "host.h"
#include "validate.h"

#include <execinfo.h>
#include <glib-unix.h>
#include <signal.h>
#include <unistd.h>
#include <wpe/drm/wpe-drm.h>
#include <wpe/headless/wpe-headless.h>
#include <wpe/wayland/wpe-wayland.h>

static gboolean
on_terminate (gpointer user_data)
{
  TcHost *host = user_data;
  g_message ("renderer: stopping");
  tc_ipc_stop (host, "renderer_stopping");
  g_main_loop_quit (host->loop);
  return G_SOURCE_REMOVE;
}

static gboolean
on_exit_timer (gpointer user_data)
{
  TcHost *host = user_data;
  g_message ("renderer: --exit-after elapsed");
  tc_ipc_stop (host, "renderer_stopping");
  g_main_loop_quit (host->loop);
  return G_SOURCE_REMOVE;
}

static gboolean
on_health (gpointer user_data)
{
  TcHost *host = user_data;
  gboolean responsive = webkit_web_view_get_is_web_process_responsive (host->view);
  tc_protocol_send_health (host, responsive ? "healthy" : "failing", responsive ? NULL : "web_process_unresponsive");
  return G_SOURCE_CONTINUE;
}

/* --crash-backtrace (development and CI): a fatal signal writes the
 * renderer's stack to stderr before the default action (the exit systemd
 * sees). Only async-signal-safe calls run in the handler. */
static void
on_fatal_signal (int signal_number)
{
  static const char banner[] = "renderer: fatal signal; backtrace follows\n";
  void *frames[64];
  if (write (STDERR_FILENO, banner, sizeof banner - 1) < 0) {
    /* Nothing else can be done inside a signal handler. */
  }
  backtrace_symbols_fd (frames, backtrace (frames, G_N_ELEMENTS (frames)), STDERR_FILENO);
  signal (signal_number, SIG_DFL);
  raise (signal_number);
}

static void
install_crash_backtrace (void)
{
  /* backtrace() loads its unwinder on first use; do that now, not in the
   * handler. */
  void *frames[1];
  backtrace (frames, 1);
  signal (SIGSEGV, on_fatal_signal);
  signal (SIGBUS, on_fatal_signal);
  signal (SIGABRT, on_fatal_signal);
  signal (SIGILL, on_fatal_signal);
  signal (SIGFPE, on_fatal_signal);
}

static WPEDisplay *
create_display (TcPlatform platform)
{
  switch (platform) {
  case TC_PLATFORM_DRM:
    return wpe_display_drm_new ();
  case TC_PLATFORM_WAYLAND:
    return wpe_display_wayland_new ();
  case TC_PLATFORM_HEADLESS:
  default:
    return wpe_display_headless_new ();
  }
}

int
main (int argc, char **argv)
{
  g_autofree char *platform = NULL;
  g_autofree char *socket_path = NULL;
  g_autofree char *runtime_dir = NULL;
  g_autofree char *size = NULL;
  g_autofree char *media_socket = NULL;
  g_autofree char *gst_plugin_dir = NULL;
  gboolean console = FALSE;
  gboolean probe_drm = FALSE;
  gboolean crash_backtrace = FALSE;
  int exit_after = 0;
  GOptionEntry entries[] = {
    { "platform", 0, 0, G_OPTION_ARG_STRING, &platform, "drm, wayland or headless", "NAME" },
    { "socket", 0, 0, G_OPTION_ARG_FILENAME, &socket_path, "tilecastd socket", "PATH" },
    { "runtime-dir", 0, 0, G_OPTION_ARG_FILENAME, &runtime_dir, "Trusted web runtime directory", "PATH" },
    { "media-socket", 0, 0, G_OPTION_ARG_FILENAME, &media_socket, "tilecastd media capability socket", "PATH" },
    { "gst-plugin-dir", 0, 0, G_OPTION_ARG_FILENAME, &gst_plugin_dir, "Directory holding the tcmedia GStreamer plugin", "PATH" },
    { "headless-size", 0, 0, G_OPTION_ARG_STRING, &size, "Headless view size (default 1920x1080)", "WxH" },
    { "console", 0, 0, G_OPTION_ARG_NONE, &console, "Write page console messages to stderr (development)", NULL },
    { "exit-after", 0, 0, G_OPTION_ARG_INT, &exit_after, "Exit after N seconds (CI)", "N" },
    { "probe-drm", 0, 0, G_OPTION_ARG_NONE, &probe_drm, "Print the DRM/KMS outputs as JSON and exit (read-only)", NULL },
    { "crash-backtrace", 0, 0, G_OPTION_ARG_NONE, &crash_backtrace, "Print a backtrace on a fatal signal (development)", NULL },
    { NULL },
  };
  g_autoptr (GOptionContext) options = g_option_context_new ("- Tilecast WPE renderer");
  g_option_context_add_main_entries (options, entries, NULL);
  g_autoptr (GError) error = NULL;
  if (!g_option_context_parse (options, &argc, &argv, &error)) {
    g_printerr ("tilecast-renderer-wpe: %s\n", error->message);
    return 2;
  }
  if (probe_drm)
    return tc_drm_probe ("/dev/dri");
  if (crash_backtrace)
    install_crash_backtrace ();

  TcHost host = { 0 };
  host.headless_width = 1920;
  host.headless_height = 1080;
  if (platform == NULL || g_strcmp0 (platform, "drm") == 0)
    host.platform = TC_PLATFORM_DRM;
  else if (g_strcmp0 (platform, "wayland") == 0)
    host.platform = TC_PLATFORM_WAYLAND;
  else if (g_strcmp0 (platform, "headless") == 0)
    host.platform = TC_PLATFORM_HEADLESS;
  else {
    g_printerr ("tilecast-renderer-wpe: unknown platform %s\n", platform);
    return 2;
  }
  if (size != NULL && sscanf (size, "%dx%d", &host.headless_width, &host.headless_height) != 2) {
    g_printerr ("tilecast-renderer-wpe: --headless-size must be WxH\n");
    return 2;
  }
  host.socket_path = g_strdup (socket_path ? socket_path : "/run/tilecast-edge/edge.sock");
  host.runtime_dir = g_strdup (runtime_dir ? runtime_dir : "/opt/tilecast-edge/current/share/tilecast/renderer-web");
  host.media_socket = g_strdup (media_socket ? media_socket : "/run/tilecast-edge/media.sock");
  host.gst_plugin_dir = g_strdup (gst_plugin_dir ? gst_plugin_dir : "/opt/tilecast-edge/current/lib/gstreamer-1.0");
  if (!tc_is_clean_absolute_path (host.socket_path) || !tc_is_clean_absolute_path (host.runtime_dir)
      || !tc_is_clean_absolute_path (host.media_socket) || !tc_is_clean_absolute_path (host.gst_plugin_dir)) {
    g_printerr ("tilecast-renderer-wpe: path options must be clean absolute paths\n");
    return 2;
  }
  host.console_to_stderr = console;
  host.exit_after_seconds = exit_after > 0 ? (guint) exit_after : 0;
  host.content = g_ptr_array_new_with_free_func (tc_content_ref_free);
  host.plugin_content = g_ptr_array_new_with_free_func (tc_content_ref_free);
  host.media_aliases = g_hash_table_new_full (g_str_hash, g_str_equal, g_free, g_free);
  host.pending_replies = g_hash_table_new_full (g_str_hash, g_str_equal, g_free,
                                                (GDestroyNotify) webkit_script_message_reply_unref);
  host.current_generation = -1;
  host.loop = g_main_loop_new (NULL, FALSE);

  /* Media playback. Web processes inherit this environment:
   *   - WebKit's GStreamer backend loads media only from allowlisted URI
   *     protocols; the renderer plays CAS objects only, so the allowlist is
   *     exactly tcmedia;
   *   - tcmediasrc (gst-tcmedia.c) serves opaque tcmedia URLs through the
   *     daemon's bounded media socket. */
  g_setenv ("WEBKIT_GST_ALLOWED_URI_PROTOCOLS", "tcmedia", TRUE);
  g_setenv ("TILECAST_MEDIA_SOCKET", host.media_socket, TRUE);
  const char *existing = g_getenv ("GST_PLUGIN_PATH");
  g_autofree char *plugin_path =
    existing && *existing ? g_strjoin (":", host.gst_plugin_dir, existing, NULL) : g_strdup (host.gst_plugin_dir);
  g_setenv ("GST_PLUGIN_PATH", plugin_path, TRUE);

  host.display = create_display (host.platform);
  if (!wpe_display_connect (host.display, &error)) {
    g_printerr ("tilecast-renderer-wpe: cannot open %s display: %s\n", platform ? platform : "drm", error->message);
    return 4;
  }
  wpe_display_set_primary (host.display);
  if (!tc_view_create (&host, &error)) {
    g_printerr ("tilecast-renderer-wpe: cannot create the web view: %s\n", error->message);
    return 4;
  }

  tc_ipc_start (&host);
  host.health_source = g_timeout_add_seconds (60, on_health, &host);
  g_unix_signal_add (SIGTERM, on_terminate, &host);
  g_unix_signal_add (SIGINT, on_terminate, &host);
  if (host.exit_after_seconds > 0)
    g_timeout_add_seconds (host.exit_after_seconds, on_exit_timer, &host);

  g_main_loop_run (host.loop);

  g_clear_object (&host.view);
  g_clear_object (&host.network_session);
  g_clear_object (&host.web_context);
  g_clear_object (&host.display);
  g_main_loop_unref (host.loop);
  g_hash_table_unref (host.pending_replies);
  g_ptr_array_unref (host.content);
  g_ptr_array_unref (host.plugin_content);
  g_hash_table_unref (host.media_aliases);
  return host.exit_code;
}
