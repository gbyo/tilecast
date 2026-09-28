#include "helper.h"

#include <errno.h>
#include <glib-unix.h>
#include <glib/gstdio.h>
#include <gst/gst.h>
#include <pwd.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <wpe/headless/wpe-headless.h>

static gboolean
on_terminate (gpointer data)
{
  TcWeb *web = data;
  g_message ("web renderer: stopping");
  g_main_loop_quit (web->loop);
  return G_SOURCE_REMOVE;
}

static gboolean
clean_absolute (const char *path)
{
  if (path == NULL || path[0] != '/')
    return FALSE;
  g_auto (GStrv) parts = g_strsplit (path + 1, "/", -1);
  for (guint i = 0; parts[i] != NULL; i++) {
    if (parts[i][0] == '\0' || strcmp (parts[i], ".") == 0 || strcmp (parts[i], "..") == 0)
      return FALSE;
  }
  return TRUE;
}

/* The frame directory belongs to this process: it starts empty, so no socket
 * from an earlier run (and no capability) survives a restart. */
static gboolean
prepare_frames_dir (const char *dir, GError **error)
{
  if (g_mkdir_with_parents (dir, 0750) != 0 || chmod (dir, 0750) != 0) {
    g_set_error (error, G_IO_ERROR, g_io_error_from_errno (errno), "frame directory: %s", g_strerror (errno));
    return FALSE;
  }
  g_autoptr (GDir) listing = g_dir_open (dir, 0, error);
  if (listing == NULL)
    return FALSE;
  const char *name;
  while ((name = g_dir_read_name (listing)) != NULL) {
    if (g_str_has_suffix (name, ".sock")) {
      g_autofree char *path = g_build_filename (dir, name, NULL);
      g_unlink (path);
    }
  }
  return TRUE;
}

int
main (int argc, char **argv)
{
  g_autofree char *control = NULL, *frames = NULL, *data = NULL, *cache = NULL, *client_user = NULL;
  int client_uid = -1;
  int exit_after = 0;
  GOptionEntry entries[] = {
    { "control-socket", 0, 0, G_OPTION_ARG_FILENAME, &control, "Control socket (default /run/tilecast-web/control.sock)",
      "PATH" },
    { "frames-dir", 0, 0, G_OPTION_ARG_FILENAME, &frames, "Frame socket directory (default /run/tilecast-web/frames)",
      "PATH" },
    { "data-dir", 0, 0, G_OPTION_ARG_FILENAME, &data, "Persistent website data (default /var/lib/tilecast-web)",
      "PATH" },
    { "cache-dir", 0, 0, G_OPTION_ARG_FILENAME, &cache, "Website cache (default /var/cache/tilecast-web)", "PATH" },
    { "client-user", 0, 0, G_OPTION_ARG_STRING, &client_user, "The renderer's account (default tilecast)", "NAME" },
    { "client-uid", 0, 0, G_OPTION_ARG_INT, &client_uid, "The renderer's UID (tests)", "UID" },
    { "exit-after", 0, 0, G_OPTION_ARG_INT, &exit_after, "Exit after N seconds (CI)", "N" },
    { NULL },
  };
  g_autoptr (GOptionContext) options = g_option_context_new ("- Tilecast remote web renderer");
  g_option_context_add_main_entries (options, entries, NULL);
  g_autoptr (GError) error = NULL;
  if (!g_option_context_parse (options, &argc, &argv, &error)) {
    g_printerr ("tilecast-web-renderer-wpe: %s\n", error->message);
    return 2;
  }
  TcWeb web = { 0 };
  web.control_path = g_strdup (control ? control : "/run/tilecast-web/control.sock");
  web.frames_dir = g_strdup (frames ? frames : "/run/tilecast-web/frames");
  web.data_dir = g_strdup (data ? data : "/var/lib/tilecast-web");
  web.cache_dir = g_strdup (cache ? cache : "/var/cache/tilecast-web");
  if (!clean_absolute (web.control_path) || !clean_absolute (web.frames_dir) || !clean_absolute (web.data_dir)
      || !clean_absolute (web.cache_dir)) {
    g_printerr ("tilecast-web-renderer-wpe: path options must be clean absolute paths\n");
    return 2;
  }
  if (client_uid >= 0) {
    web.client_uid = (uid_t) client_uid;
  } else {
    struct passwd *account = getpwnam (client_user ? client_user : "tilecast");
    if (account == NULL) {
      g_printerr ("tilecast-web-renderer-wpe: unknown client account\n");
      return 2;
    }
    web.client_uid = account->pw_uid;
  }
  /* sun_path holds 108 bytes including the NUL; a frame socket is
   * <dir>/<64 hex>.sock. unixfdsink does not report a failed bind. */
  if (strlen (web.frames_dir) + 1 + TC_RW_CAPABILITY_HEX + strlen (".sock") >= 108 || strlen (web.control_path) >= 108) {
    g_printerr ("tilecast-web-renderer-wpe: socket paths must be shorter than 108 bytes\n");
    return 2;
  }
  if (geteuid () == 0) {
    g_printerr ("tilecast-web-renderer-wpe: refusing to run as root\n");
    return 2;
  }
  umask (0077);
  gst_init (NULL, NULL);
  if (!prepare_frames_dir (web.frames_dir, &error)) {
    g_printerr ("tilecast-web-renderer-wpe: %s\n", error->message);
    return 4;
  }

  web.display = wpe_display_headless_new ();
  if (!wpe_display_connect (web.display, &error)) {
    g_printerr ("tilecast-web-renderer-wpe: cannot open the headless display: %s\n", error->message);
    return 4;
  }
  WPEDRMDevice *device = wpe_display_get_drm_device (web.display);
  web.accelerated = device != NULL && wpe_drm_device_get_render_node (device) != NULL;
  g_autoptr (GError) egl_error = NULL;
  web.egl_display = wpe_display_get_egl_display (web.display, &egl_error);
  if (web.egl_display == NULL)
    g_message ("web renderer: no EGL display (%s); DMA-BUF frames cannot be exported",
               egl_error ? egl_error->message : "unknown");
  web.context = webkit_web_context_new ();
  web.surfaces = g_hash_table_new_full (g_str_hash, g_str_equal, g_free, (GDestroyNotify) tc_surface_destroy);
  web.deferred_events = g_hash_table_new_full (g_str_hash, g_str_equal, g_free, g_free);
  web.loop = g_main_loop_new (NULL, FALSE);
  if (!tc_control_start (&web, &error)) {
    g_printerr ("tilecast-web-renderer-wpe: %s\n", error->message);
    return 4;
  }
  g_message ("web renderer: ready (WPE WebKit %u.%u.%u, %s)", webkit_get_major_version (), webkit_get_minor_version (),
             webkit_get_micro_version (), web.accelerated ? "GPU" : "software");
  g_unix_signal_add (SIGTERM, on_terminate, &web);
  g_unix_signal_add (SIGINT, on_terminate, &web);
  if (exit_after > 0)
    g_timeout_add_seconds ((guint) exit_after, on_terminate, &web);
  g_main_loop_run (web.loop);

  tc_control_stop (&web);
  g_hash_table_unref (web.surfaces);
  g_hash_table_unref (web.deferred_events);
  g_clear_object (&web.first_party);
  g_clear_object (&web.all);
  g_clear_object (&web.context);
  g_clear_object (&web.display);
  g_main_loop_unref (web.loop);
  return 0;
}
