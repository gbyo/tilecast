/*
 * Stage 4 latency spike: the WebKit side. A headless WPE view shows one
 * <video src="tcpresent://cap/<id>"> over the whole view, as the Runtime
 * external-presentation view will. On every composited buffer it reads the
 * center pixel and prints the wall-clock time of each black/white change:
 *
 *   glass white <unix microseconds>
 *   glass black <unix microseconds>
 *
 * The composited buffer is the closest point to the glass that a headless
 * platform has. Page console output goes to stdout. The stream takes the
 * shipped path: this process runs the renderer's relay (present-relay.c),
 * which asks the grant on --media-socket and relays the loopback RTP into the
 * web process, sandboxed or not.
 *
 *   consumer --plugin-dir DIR --media-socket PATH [--muted] [--seconds N]
 */
#include "present-relay.h"

#include <glib/gstdio.h>
#include <gst/gst.h>
#include <stdio.h>
#include <string.h>
#include <wpe/headless/wpe-headless.h>
#include <wpe/webkit.h>

static int last_phase = -1;
static guint64 frames;

static int
center_luma (WPEBuffer *buffer)
{
  g_autoptr (GError) error = NULL;
  GBytes *bytes = NULL;
  g_autoptr (GBytes) imported = NULL;
  guint stride;
  if (WPE_IS_BUFFER_SHM (buffer)) {
    bytes = wpe_buffer_shm_get_data (WPE_BUFFER_SHM (buffer));
    stride = wpe_buffer_shm_get_stride (WPE_BUFFER_SHM (buffer));
  } else {
    imported = wpe_buffer_import_to_pixels (buffer, &error);
    if (imported == NULL)
      return -1;
    bytes = imported;
    stride = (guint) wpe_buffer_get_width (buffer) * 4;
  }
  gsize size = 0;
  const guint8 *pixels = g_bytes_get_data (bytes, &size);
  int x = wpe_buffer_get_width (buffer) / 2, y = wpe_buffer_get_height (buffer) / 2;
  gsize offset = (gsize) y * stride + (gsize) x * 4;
  if (offset + 4 > size)
    return -1;
  return (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
}

static void
on_buffer_rendered (WPEView *view, WPEBuffer *buffer, gpointer data)
{
  (void) view;
  (void) data;
  gint64 now = g_get_real_time ();
  frames++;
  int luma = center_luma (buffer);
  int phase = luma > 200 ? 1 : luma >= 0 && luma < 50 ? 0 : -1;
  if (phase >= 0 && phase != last_phase) {
    printf ("glass %s %" G_GINT64_FORMAT "\n", phase ? "white" : "black", now);
    fflush (stdout);
    last_phase = phase;
  }
}

typedef struct {
  WebKitWebView *view;
  char *html;
} Page;

static void
on_relay (gboolean ok, gpointer data)
{
  Page *page = data;
  printf ("relay %s\n", ok ? "ready" : "failed");
  webkit_web_view_load_html (page->view, page->html, "http://127.0.0.1/");
}

static gboolean
quit (gpointer loop)
{
  printf ("composited frames %" G_GUINT64_FORMAT "\n", frames);
  g_main_loop_quit (loop);
  return G_SOURCE_REMOVE;
}

int
main (int argc, char **argv)
{
  g_autofree char *plugin_dir = NULL, *media_socket = NULL;
  gboolean muted = FALSE;
  int seconds = 60;
  GOptionEntry entries[] = {
    { "plugin-dir", 0, 0, G_OPTION_ARG_FILENAME, &plugin_dir, "", NULL },
    { "media-socket", 0, 0, G_OPTION_ARG_FILENAME, &media_socket, "", NULL },
    { "muted", 0, 0, G_OPTION_ARG_NONE, &muted, "", NULL },
    { "seconds", 0, 0, G_OPTION_ARG_INT, &seconds, "", NULL },
    { NULL },
  };
  g_autoptr (GOptionContext) options = g_option_context_new (NULL);
  g_option_context_add_main_entries (options, entries, NULL);
  if (!g_option_context_parse (options, &argc, &argv, NULL) || plugin_dir == NULL || media_socket == NULL)
    return 2;
  g_setenv ("WEBKIT_GST_ALLOWED_URI_PROTOCOLS", "tcpresent", TRUE);
  g_setenv ("GST_PLUGIN_PATH", plugin_dir, TRUE);
  g_autofree char *present_dir = g_dir_make_tmp ("tilecast-present-XXXXXX", NULL);
  g_setenv ("TILECAST_PRESENT_DIR", present_dir, TRUE);
  TcPresentRelay *relay = tc_present_relay_new (present_dir, media_socket);

  WPEDisplay *display = wpe_display_headless_new ();
  wpe_display_connect (display, NULL);
  WebKitWebContext *context = webkit_web_context_new ();
  webkit_web_context_add_path_to_sandbox (context, plugin_dir, TRUE);
  webkit_web_context_add_path_to_sandbox (context, present_dir, TRUE);
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
  g_autofree char *html = g_strdup_printf (
    "<!doctype html><body style='margin:0;background:#808080;overflow:hidden'>"
    "<video id=v autoplay %s style='position:fixed;inset:0;width:100vw;height:100vh;object-fit:fill'"
    " src='tcpresent://cap/%s'></video><script>"
    "var v=document.getElementById('v');"
    "['loadedmetadata','playing','waiting','stalled','error','ended'].forEach(function(e){"
    "v.addEventListener(e,function(){console.log('video '+e+' state='+v.readyState+' size='+v.videoWidth+'x'"
    "+v.videoHeight+(v.error?' error='+v.error.code+':'+v.error.message:''))})});"
    "setInterval(function(){console.log('video stats audioBytes='+v.webkitAudioDecodedByteCount+' videoBytes='"
    "+v.webkitVideoDecodedByteCount+' audioTracks='+(v.audioTracks?v.audioTracks.length:'n/a')+' videoTracks='"
    "+(v.videoTracks?v.videoTracks.length:'n/a')+' t='+v.currentTime.toFixed(2))},5000);"
    "</script>",
    muted ? "muted" : "", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  Page page = { view, html };
  tc_present_relay_set (relay, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", on_relay, &page);
  GMainLoop *loop = g_main_loop_new (NULL, FALSE);
  g_timeout_add_seconds (seconds, quit, loop);
  g_main_loop_run (loop);
  tc_present_relay_free (relay);
  g_rmdir (present_dir);
  return 0;
}
