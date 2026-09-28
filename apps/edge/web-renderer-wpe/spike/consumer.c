/*
 * M11 Phase 0 spike: the trusted side. A headless WPE view loads a page that
 * shows tcweb://cap/<id> streams in <video> elements (the runtime's normal
 * DOM composition). It prints page console output and, at exit, writes its
 * own composited output as a PPM so the result can be inspected.
 *
 *   consumer --url URL --frames-dir DIR --plugin-dir DIR --out PPM [--exit-after N]
 */
#include <gst/gst.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <wpe/headless/wpe-headless.h>
#include <wpe/webkit.h>

static WPEBuffer *last;
static guint64 frames;
static char *out_path;

static void
on_buffer_rendered (WPEView *view, WPEBuffer *buffer, gpointer data)
{
  frames++;
  g_set_object (&last, buffer);
}

static void
write_ppm (void)
{
  if (last == NULL || !WPE_IS_BUFFER_SHM (last)) {
    g_message ("consumer: no SHM frame to write");
    return;
  }
  GBytes *bytes = wpe_buffer_shm_get_data (WPE_BUFFER_SHM (last));
  const guint8 *p = g_bytes_get_data (bytes, NULL);
  int w = wpe_buffer_get_width (last), h = wpe_buffer_get_height (last);
  guint stride = wpe_buffer_shm_get_stride (WPE_BUFFER_SHM (last));
  FILE *f = fopen (out_path, "wb");
  fprintf (f, "P6\n%d %d\n255\n", w, h);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      const guint8 *px = p + (gsize) y * stride + (gsize) x * 4;
      fputc (px[2], f);
      fputc (px[1], f);
      fputc (px[0], f);
    }
  fclose (f);
  g_message ("consumer: wrote %dx%d to %s", w, h, out_path);
}

static gboolean
on_terminated (WebKitWebView *v, WebKitWebProcessTerminationReason reason, gpointer d)
{
  g_message ("consumer: TRUSTED WEB PROCESS TERMINATED (%d)", reason);
  return FALSE;
}

static gboolean
quit (gpointer loop)
{
  write_ppm ();
  struct rusage usage;
  getrusage (RUSAGE_SELF, &usage);
  g_message ("consumer: composited frames=%" G_GUINT64_FORMAT " ui maxrss=%ldKiB", frames, usage.ru_maxrss);
  g_main_loop_quit (loop);
  return G_SOURCE_REMOVE;
}

int
main (int argc, char **argv)
{
  g_autofree char *url = NULL, *frames_dir = NULL, *plugin_dir = NULL;
  int exit_after = 10;
  GOptionEntry entries[] = {
    { "url", 0, 0, G_OPTION_ARG_STRING, &url, "URL", NULL },
    { "frames-dir", 0, 0, G_OPTION_ARG_FILENAME, &frames_dir, "", NULL },
    { "plugin-dir", 0, 0, G_OPTION_ARG_FILENAME, &plugin_dir, "", NULL },
    { "out", 0, 0, G_OPTION_ARG_FILENAME, &out_path, "", NULL },
    { "exit-after", 0, 0, G_OPTION_ARG_INT, &exit_after, "", NULL },
    { NULL },
  };
  g_autoptr (GOptionContext) options = g_option_context_new (NULL);
  g_option_context_add_main_entries (options, entries, NULL);
  if (!g_option_context_parse (options, &argc, &argv, NULL) || url == NULL)
    return 2;
  g_setenv ("WEBKIT_GST_ALLOWED_URI_PROTOCOLS", "tcweb", TRUE);
  g_setenv ("TILECAST_WEB_FRAMES_DIR", frames_dir, TRUE);
  g_setenv ("GST_PLUGIN_PATH", plugin_dir, TRUE);

  WPEDisplay *display = wpe_display_headless_new ();
  wpe_display_connect (display, NULL);
  WebKitWebContext *context = webkit_web_context_new ();
  webkit_web_context_add_path_to_sandbox (context, plugin_dir, TRUE);
  webkit_web_context_add_path_to_sandbox (context, frames_dir, TRUE);
  WebKitSettings *settings = webkit_settings_new ();
  webkit_settings_set_media_playback_requires_user_gesture (settings, FALSE);
  webkit_settings_set_enable_write_console_messages_to_stdout (settings, TRUE);
  WebKitWebView *view = g_object_new (WEBKIT_TYPE_WEB_VIEW, "display", display, "web-context", context, "settings",
                                      settings, NULL);
  g_object_ref_sink (view);
  WPEView *wpe_view = webkit_web_view_get_wpe_view (view);
  WPEToplevel *toplevel = wpe_view_get_toplevel (wpe_view);
  if (toplevel == NULL) {
    toplevel = wpe_display_create_toplevel (display, 1);
    wpe_view_set_toplevel (wpe_view, toplevel);
    g_object_unref (toplevel);
  }
  wpe_toplevel_resize (toplevel, 1280, 720);
  g_signal_connect (wpe_view, "buffer-rendered", G_CALLBACK (on_buffer_rendered), NULL);
  g_signal_connect (view, "web-process-terminated", G_CALLBACK (on_terminated), NULL);
  webkit_web_view_load_uri (view, url);
  GMainLoop *loop = g_main_loop_new (NULL, FALSE);
  g_timeout_add_seconds (exit_after, quit, loop);
  g_main_loop_run (loop);
  return 0;
}
