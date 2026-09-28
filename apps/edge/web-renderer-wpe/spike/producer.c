/*
 * M11 Phase 0 spike: an off-screen WPE WebView whose rendered buffers are
 * exported through GStreamer unixfdsink.
 *
 *   producer --url URL --socket PATH [--size WxH] [--exit-after N]
 *
 * Frames: WPEView::buffer-rendered (headless view). SHM buffers are copied
 * once into a memfd-backed GstShmAllocator buffer; DMA-BUF buffers are
 * wrapped (dup'd fd) without a copy. The latest frame is re-sent once a
 * second when the page is idle, so a consumer sees a live stream.
 */
#include <gst/allocators/allocators.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <gst/video/video.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>
#include <wpe/headless/wpe-headless.h>
#include <wpe/webkit.h>

static gboolean stamp;

typedef struct {
  GstElement *pipeline;
  GstElement *appsrc;
  GstAllocator *shm;
  GstAllocator *dmabuf;
  GstBuffer *last;
  int width, height;
  guint64 frames, shm_frames, dmabuf_frames, repeats;
  gint64 last_push_us;
  gint64 first_frame_us;
  gint64 start_us;
  char caps_kind[16];
} Spike;

static void
set_caps (Spike *s, WPEBuffer *buffer)
{
  g_autoptr (GstCaps) caps = NULL;
  const char *kind;
  if (WPE_IS_BUFFER_DMA_BUF (buffer)) {
    WPEBufferDMABuf *dma = WPE_BUFFER_DMA_BUF (buffer);
    guint32 fourcc = wpe_buffer_dma_buf_get_format (dma);
    guint64 modifier = wpe_buffer_dma_buf_get_modifier (dma);
    g_autofree char *drm = gst_video_dma_drm_fourcc_to_string (fourcc, modifier);
    caps = gst_caps_new_simple ("video/x-raw", "format", G_TYPE_STRING, "DMA_DRM", "drm-format", G_TYPE_STRING, drm,
                                "width", G_TYPE_INT, s->width, "height", G_TYPE_INT, s->height, "framerate",
                                GST_TYPE_FRACTION, 0, 1, NULL);
    gst_caps_set_features (caps, 0, gst_caps_features_new_single_static_str (GST_CAPS_FEATURE_MEMORY_DMABUF));
    kind = "dmabuf";
  } else {
    caps = gst_caps_new_simple ("video/x-raw", "format", G_TYPE_STRING, "BGRA", "width", G_TYPE_INT, s->width,
                                "height", G_TYPE_INT, s->height, "framerate", GST_TYPE_FRACTION, 0, 1, NULL);
    kind = "shm";
  }
  if (g_strcmp0 (kind, s->caps_kind) != 0) {
    g_strlcpy (s->caps_kind, kind, sizeof s->caps_kind);
    g_autofree char *text = gst_caps_to_string (caps);
    g_message ("producer: caps %s", text);
  }
  gst_app_src_set_caps (GST_APP_SRC (s->appsrc), caps);
}

static void
push (Spike *s, GstBuffer *buffer)
{
  s->last_push_us = g_get_monotonic_time ();
  gst_app_src_push_buffer (GST_APP_SRC (s->appsrc), buffer);
}

static void
on_buffer_rendered (WPEView *view, WPEBuffer *buffer, gpointer data)
{
  Spike *s = data;
  s->width = wpe_buffer_get_width (buffer);
  s->height = wpe_buffer_get_height (buffer);
  set_caps (s, buffer);
  GstBuffer *out = NULL;
  if (WPE_IS_BUFFER_DMA_BUF (buffer)) {
    WPEBufferDMABuf *dma = WPE_BUFFER_DMA_BUF (buffer);
    guint planes = wpe_buffer_dma_buf_get_n_planes (dma);
    out = gst_buffer_new ();
    gsize offsets[4] = { 0 };
    gint strides[4] = { 0 };
    for (guint i = 0; i < planes && i < 4; i++) {
      int fd = dup (wpe_buffer_dma_buf_get_fd (dma, i));
      gsize size = (gsize) wpe_buffer_dma_buf_get_stride (dma, i) * (gsize) s->height;
      gst_buffer_append_memory (out, gst_dmabuf_allocator_alloc (s->dmabuf, fd, size));
      offsets[i] = wpe_buffer_dma_buf_get_offset (dma, i);
      strides[i] = (gint) wpe_buffer_dma_buf_get_stride (dma, i);
    }
    gst_buffer_add_video_meta_full (out, GST_VIDEO_FRAME_FLAG_NONE, GST_VIDEO_FORMAT_DMA_DRM, s->width, s->height,
                                    planes, offsets, strides);
    s->dmabuf_frames++;
  } else {
    WPEBufferSHM *shm = WPE_BUFFER_SHM (buffer);
    GBytes *bytes = wpe_buffer_shm_get_data (shm);
    gsize size = 0;
    const guint8 *pixels = g_bytes_get_data (bytes, &size);
    guint stride = wpe_buffer_shm_get_stride (shm);
    gsize packed = (gsize) s->width * 4u * (gsize) s->height;
    GstMemory *memory = gst_allocator_alloc (s->shm, packed, NULL);
    GstMapInfo map;
    gst_memory_map (memory, &map, GST_MAP_WRITE);
    if (stride == (guint) s->width * 4u) {
      memcpy (map.data, pixels, MIN (packed, size));
    } else {
      for (int y = 0; y < s->height; y++)
        memcpy (map.data + (gsize) y * s->width * 4u, pixels + (gsize) y * stride, (gsize) s->width * 4u);
    }
    if (stamp) {
      /* Measurement only: the wall-clock microsecond of this frame in the
       * first 64 pixels, one bit per pixel, read back by latency.html. */
      guint64 now = (guint64) g_get_real_time ();
      for (int bit = 0; bit < 64; bit++)
        for (int row = 0; row < 4; row++)
          memset (map.data + (gsize) row * s->width * 4u + (gsize) bit * 16u, ((now >> (63 - bit)) & 1) ? 0xff : 0x00, 16);
    }
    gst_memory_unmap (memory, &map);
    out = gst_buffer_new ();
    gst_buffer_append_memory (out, memory);
    s->shm_frames++;
  }
  if (s->frames++ == 0) {
    s->first_frame_us = g_get_monotonic_time ();
    g_message ("producer: first frame %dx%d after %" G_GINT64_FORMAT " ms", s->width, s->height,
               (s->first_frame_us - s->start_us) / 1000);
  }
  gst_buffer_replace (&s->last, out);
  push (s, out);
}

static gboolean
on_keepalive (gpointer data)
{
  Spike *s = data;
  if (s->last != NULL && g_get_monotonic_time () - s->last_push_us > G_USEC_PER_SEC) {
    s->repeats++;
    push (s, gst_buffer_copy (s->last));
  }
  return G_SOURCE_CONTINUE;
}

static gboolean
on_report (gpointer data)
{
  Spike *s = data;
  struct rusage usage;
  getrusage (RUSAGE_SELF, &usage);
  guint clients = 0;
  GstElement *sink = gst_bin_get_by_name (GST_BIN (s->pipeline), "sink");
  g_object_get (sink, "num-clients", &clients, NULL);
  gst_object_unref (sink);
  g_message ("producer: frames=%" G_GUINT64_FORMAT " shm=%" G_GUINT64_FORMAT " dmabuf=%" G_GUINT64_FORMAT
             " repeats=%" G_GUINT64_FORMAT " clients=%u maxrss=%ldKiB utime=%ld.%03lds",
             s->frames, s->shm_frames, s->dmabuf_frames, s->repeats, clients, usage.ru_maxrss,
             (long) usage.ru_utime.tv_sec, (long) usage.ru_utime.tv_usec / 1000);
  return G_SOURCE_CONTINUE;
}

static gboolean
quit (gpointer loop)
{
  g_main_loop_quit (loop);
  return G_SOURCE_REMOVE;
}

int
main (int argc, char **argv)
{
  g_autofree char *url = NULL, *socket_path = NULL, *size = NULL;
  int exit_after = 0;
  GOptionEntry entries[] = {
    { "url", 0, 0, G_OPTION_ARG_STRING, &url, "URL", NULL },
    { "socket", 0, 0, G_OPTION_ARG_FILENAME, &socket_path, "unixfdsink socket", NULL },
    { "size", 0, 0, G_OPTION_ARG_STRING, &size, "WxH", NULL },
    { "exit-after", 0, 0, G_OPTION_ARG_INT, &exit_after, "seconds", NULL },
    { "stamp", 0, 0, G_OPTION_ARG_NONE, &stamp, "stamp frames with the wall clock (latency measurement)", NULL },
    { NULL },
  };
  g_autoptr (GOptionContext) options = g_option_context_new (NULL);
  g_option_context_add_main_entries (options, entries, NULL);
  g_option_context_add_group (options, gst_init_get_option_group ());
  if (!g_option_context_parse (options, &argc, &argv, NULL) || url == NULL || socket_path == NULL)
    return 2;
  int width = 1280, height = 720;
  if (size != NULL)
    sscanf (size, "%dx%d", &width, &height);

  Spike s = { 0 };
  s.start_us = g_get_monotonic_time ();
  s.shm = gst_shm_allocator_get ();
  s.dmabuf = gst_dmabuf_allocator_new ();
  g_autofree char *description = g_strdup_printf (
    "appsrc name=src is-live=true do-timestamp=true format=time max-buffers=2 leaky-type=downstream "
    "! queue max-size-buffers=1 leaky=downstream ! unixfdsink name=sink sync=false async=false socket-path=%s",
    socket_path);
  s.pipeline = gst_parse_launch (description, NULL);
  s.appsrc = gst_bin_get_by_name (GST_BIN (s.pipeline), "src");
  gst_element_set_state (s.pipeline, GST_STATE_PLAYING);

  WPEDisplay *display = wpe_display_headless_new ();
  wpe_display_connect (display, NULL);
  WebKitNetworkSession *session = webkit_network_session_new_ephemeral ();
  WebKitWebView *view = g_object_new (WEBKIT_TYPE_WEB_VIEW, "display", display, "network-session", session, NULL);
  g_object_ref_sink (view);
  WPEView *wpe_view = webkit_web_view_get_wpe_view (view);
  WPEToplevel *toplevel = wpe_view_get_toplevel (wpe_view);
  if (toplevel == NULL) {
    toplevel = wpe_display_create_toplevel (display, 1);
    wpe_view_set_toplevel (wpe_view, toplevel);
    g_object_unref (toplevel);
  }
  wpe_toplevel_resize (toplevel, width, height);
  g_signal_connect (wpe_view, "buffer-rendered", G_CALLBACK (on_buffer_rendered), &s);
  webkit_web_view_load_uri (view, url);

  GMainLoop *loop = g_main_loop_new (NULL, FALSE);
  g_timeout_add (250, on_keepalive, &s);
  g_timeout_add_seconds (2, on_report, &s);
  if (exit_after > 0)
    g_timeout_add_seconds (exit_after, quit, loop);
  g_main_loop_run (loop);
  on_report (&s);
  gst_element_set_state (s.pipeline, GST_STATE_NULL);
  return 0;
}
