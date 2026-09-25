/*
 * preview.request: a bounded JPEG of what the view shows, for the Studio
 * live preview (M8).
 *
 * The daemon decides when a preview may be taken; it never asks during a
 * protected state (setup, pairing, safe mode), and this code never runs on
 * its own. The renderer takes one snapshot of the visible view, scales it to
 * fit the requested bounds with GStreamer (appsrc ! videoconvert !
 * videoscale ! jpegenc ! appsink, the GStreamer the renderer already uses)
 * and answers renderer.preview. A JPEG over the byte bound is encoded again
 * at a lower quality; if it still does not fit, the answer is
 * "unavailable", never a truncated image.
 */
#include "host.h"

#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <string.h>

#define TC_PREVIEW_MAX_WIDTH 3840
#define TC_PREVIEW_MAX_HEIGHT 2160
#define TC_PREVIEW_MAX_BYTES (2 * 1024 * 1024)

typedef struct {
  TcHost *host;
  char *request_id;
  guint max_width;
  guint max_height;
  guint max_bytes;
} PreviewRequest;

static void
request_free (PreviewRequest *request)
{
  g_free (request->request_id);
  g_free (request);
}

static void
send_result (TcHost *host, const char *request_id, const char *jpeg_base64, guint width, guint height,
             const char *unavailable_code)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "requestId");
  json_builder_add_string_value (builder, request_id);
  json_builder_set_member_name (builder, "result");
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "outcome");
  if (unavailable_code != NULL) {
    json_builder_add_string_value (builder, "unavailable");
    json_builder_set_member_name (builder, "code");
    json_builder_add_string_value (builder, unavailable_code);
  } else {
    json_builder_add_string_value (builder, "captured");
    json_builder_set_member_name (builder, "jpegBase64");
    json_builder_add_string_value (builder, jpeg_base64);
    json_builder_set_member_name (builder, "width");
    json_builder_add_int_value (builder, width);
    json_builder_set_member_name (builder, "height");
    json_builder_add_int_value (builder, height);
  }
  json_builder_end_object (builder);
  json_builder_end_object (builder);
  tc_ipc_send_event (host, "renderer.preview", json_builder_get_root (builder));
}

/* Fits (width, height) inside the bounds, keeping the aspect ratio and even
 * dimensions for the encoder. */
static void
fit (guint width, guint height, guint max_width, guint max_height, guint *out_width, guint *out_height)
{
  double scale = MIN (1.0, MIN ((double) max_width / width, (double) max_height / height));
  *out_width = MAX (2, ((guint) (width * scale)) & ~1u);
  *out_height = MAX (2, ((guint) (height * scale)) & ~1u);
}

/* Encodes one BGRx frame to JPEG at `quality`, scaled to out_width x
 * out_height. Returns NULL on any pipeline failure. */
static GBytes *
encode (GBytes *pixels, guint width, guint height, guint stride, guint out_width, guint out_height, int quality)
{
  g_autoptr (GError) error = NULL;
  g_autofree char *description = g_strdup_printf (
    "appsrc name=src ! videoconvert ! videoscale ! video/x-raw,width=%u,height=%u ! jpegenc quality=%d ! "
    "appsink name=sink sync=false",
    out_width, out_height, quality);
  GstElement *pipeline = gst_parse_launch (description, &error);
  if (pipeline == NULL) {
    g_bytes_unref (pixels);
    return NULL;
  }
  GstElement *source = gst_bin_get_by_name (GST_BIN (pipeline), "src");
  GstElement *sink = gst_bin_get_by_name (GST_BIN (pipeline), "sink");
  g_autoptr (GstCaps) caps = gst_caps_new_simple ("video/x-raw", "format", G_TYPE_STRING, "BGRx", "width", G_TYPE_INT,
                                                  (int) width, "height", G_TYPE_INT, (int) height, "framerate",
                                                  GST_TYPE_FRACTION, 0, 1, NULL);
  g_object_set (source, "caps", caps, "format", GST_FORMAT_TIME, NULL);
  GBytes *result = NULL;
  gboolean pushed = FALSE;
  if (gst_element_set_state (pipeline, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE) {
    /* GStreamer expects tightly packed rows for these caps. */
    GBytes *packed = pixels;
    if (stride != width * 4) {
      const guint8 *rows = g_bytes_get_data (pixels, NULL);
      guint8 *tight = g_malloc ((gsize) width * 4 * height);
      for (guint y = 0; y < height; y++)
        memcpy (tight + (gsize) y * width * 4, rows + (gsize) y * stride, (gsize) width * 4);
      packed = g_bytes_new_take (tight, (gsize) width * 4 * height);
      g_bytes_unref (pixels);
    }
    GstBuffer *buffer = gst_buffer_new_wrapped_bytes (packed);
    g_bytes_unref (packed);
    pushed = TRUE;
    gst_app_src_push_buffer (GST_APP_SRC (source), buffer);
    gst_app_src_end_of_stream (GST_APP_SRC (source));
    GstSample *sample = gst_app_sink_try_pull_sample (GST_APP_SINK (sink), 5 * GST_SECOND);
    if (sample != NULL) {
      GstBuffer *encoded = gst_sample_get_buffer (sample);
      GstMapInfo map;
      if (encoded != NULL && gst_buffer_map (encoded, &map, GST_MAP_READ)) {
        result = g_bytes_new (map.data, map.size);
        gst_buffer_unmap (encoded, &map);
      }
      gst_sample_unref (sample);
    }
  }
  if (!pushed)
    g_bytes_unref (pixels);
  gst_element_set_state (pipeline, GST_STATE_NULL);
  gst_object_unref (source);
  gst_object_unref (sink);
  gst_object_unref (pipeline);
  return result;
}

static void
on_snapshot (GObject *object, GAsyncResult *result, gpointer user_data)
{
  PreviewRequest *request = user_data;
  g_autoptr (GError) error = NULL;
  g_autoptr (WebKitImage) image = webkit_web_view_get_snapshot_finish (WEBKIT_WEB_VIEW (object), result, &error);
  if (image == NULL) {
    g_message ("preview: snapshot failed: %s", error ? error->message : "unknown");
    send_result (request->host, request->request_id, NULL, 0, 0, "snapshot_failed");
    request_free (request);
    return;
  }
  guint width = (guint) webkit_image_get_width (image);
  guint height = (guint) webkit_image_get_height (image);
  guint stride = webkit_image_get_stride (image);
  g_autoptr (GBytes) pixels = webkit_image_as_bytes (image);
  if (width == 0 || height == 0 || stride < width * 4 || g_bytes_get_size (pixels) < (gsize) stride * height) {
    send_result (request->host, request->request_id, NULL, 0, 0, "snapshot_invalid");
    request_free (request);
    return;
  }
  guint out_width, out_height;
  fit (width, height, request->max_width, request->max_height, &out_width, &out_height);
  static const int qualities[] = { 80, 60, 40 };
  for (guint i = 0; i < G_N_ELEMENTS (qualities); i++) {
    g_autoptr (GBytes) jpeg = encode (g_bytes_ref (pixels), width, height, stride, out_width, out_height, qualities[i]);
    if (jpeg == NULL) {
      send_result (request->host, request->request_id, NULL, 0, 0, "encode_failed");
      request_free (request);
      return;
    }
    if (g_bytes_get_size (jpeg) <= request->max_bytes) {
      gsize size = 0;
      const guchar *data = g_bytes_get_data (jpeg, &size);
      g_autofree char *base64 = g_base64_encode (data, size);
      send_result (request->host, request->request_id, base64, out_width, out_height, NULL);
      request_free (request);
      return;
    }
  }
  send_result (request->host, request->request_id, NULL, 0, 0, "preview_too_large");
  request_free (request);
}

void
tc_preview_capture (TcHost *host, JsonObject *data)
{
  const char *request_id = json_object_get_string_member_with_default (data, "requestId", NULL);
  if (request_id == NULL || strlen (request_id) != 36)
    return;
  gint64 max_width = json_object_get_int_member_with_default (data, "maxWidth", 0);
  gint64 max_height = json_object_get_int_member_with_default (data, "maxHeight", 0);
  gint64 max_bytes = json_object_get_int_member_with_default (data, "maxBytes", 0);
  if (max_width < 16 || max_width > TC_PREVIEW_MAX_WIDTH || max_height < 16 || max_height > TC_PREVIEW_MAX_HEIGHT
      || max_bytes < 1024 || max_bytes > TC_PREVIEW_MAX_BYTES) {
    send_result (host, request_id, NULL, 0, 0, "preview_request_invalid");
    return;
  }
  if (host->view == NULL) {
    send_result (host, request_id, NULL, 0, 0, "renderer_not_ready");
    return;
  }
  PreviewRequest *request = g_new0 (PreviewRequest, 1);
  request->host = host;
  request->request_id = g_strdup (request_id);
  request->max_width = (guint) max_width;
  request->max_height = (guint) max_height;
  request->max_bytes = (guint) max_bytes;
  webkit_web_view_get_snapshot (host->view, WEBKIT_SNAPSHOT_REGION_VISIBLE, WEBKIT_SNAPSHOT_OPTIONS_NONE, NULL,
                                on_snapshot, request);
}
