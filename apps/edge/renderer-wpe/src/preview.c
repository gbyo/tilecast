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
 *
 * A preview must never disturb playback, so:
 *   - one capture at a time; a request while one is running is answered
 *     "preview_busy";
 *   - the whole capture has a deadline. A snapshot WebKit does not deliver
 *     in time is answered "snapshot_timeout", and the late snapshot, if it
 *     ever arrives, is dropped;
 *   - encoding runs on a worker thread, never on the main loop that serves
 *     IPC and the web view.
 */
#include "host.h"

#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <string.h>

#define TC_PREVIEW_MAX_WIDTH 3840
#define TC_PREVIEW_MAX_HEIGHT 2160
#define TC_PREVIEW_MAX_BYTES (2 * 1024 * 1024)

/* The whole capture: snapshot, encoding and every quality retry. It stays
 * below the daemon's 10 s wait (tilecastd/src/preview.rs). */
#define TC_PREVIEW_DEADLINE_US (8 * G_USEC_PER_SEC)
#define TC_PREVIEW_SNAPSHOT_TIMEOUT_MS 4000
#define TC_PREVIEW_PULL_TIMEOUT_US (3 * G_USEC_PER_SEC)

typedef struct {
  TcHost *host;
  char *request_id;
  guint max_width;
  guint max_height;
  guint max_bytes;
  gint64 deadline;
  guint timeout_source;
  /* The daemon already has its answer (a timeout); later results are dropped. */
  gboolean answered;

  /* Encoder input, set on the main thread before the worker starts. */
  GBytes *pixels;
  guint width;
  guint height;
  guint stride;
  guint out_width;
  guint out_height;
  /* Encoder output, read on the main thread after the worker finished. */
  char *jpeg_base64;
  const char *unavailable_code;
} PreviewRequest;

/* The capture WebKit or the encoder still owns; NULL when idle. */
static PreviewRequest *in_flight;

static void
request_free (PreviewRequest *request)
{
  if (request->timeout_source != 0)
    g_source_remove (request->timeout_source);
  g_clear_pointer (&request->pixels, g_bytes_unref);
  g_free (request->jpeg_base64);
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
  if (unavailable_code != NULL)
    g_message ("preview: unavailable (%s)", unavailable_code);
  else
    g_message ("preview: captured %ux%u", width, height);
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
 * out_height, by `deadline` (monotonic). Returns NULL on any pipeline
 * failure or when the deadline passes. Runs on the worker thread. */
static GBytes *
encode (GBytes *pixels, guint width, guint height, guint stride, guint out_width, guint out_height, int quality,
        gint64 deadline)
{
  gint64 remaining = deadline - g_get_monotonic_time ();
  if (remaining <= 0)
    return NULL;
  g_autoptr (GError) error = NULL;
  g_autofree char *description = g_strdup_printf (
    "appsrc name=src ! videoconvert ! videoscale ! video/x-raw,width=%u,height=%u ! jpegenc quality=%d ! "
    "appsink name=sink sync=false",
    out_width, out_height, quality);
  GstElement *pipeline = gst_parse_launch (description, &error);
  if (pipeline == NULL)
    return NULL;
  GstElement *source = gst_bin_get_by_name (GST_BIN (pipeline), "src");
  GstElement *sink = gst_bin_get_by_name (GST_BIN (pipeline), "sink");
  g_autoptr (GstCaps) caps = gst_caps_new_simple ("video/x-raw", "format", G_TYPE_STRING, "BGRx", "width", G_TYPE_INT,
                                                  (int) width, "height", G_TYPE_INT, (int) height, "framerate",
                                                  GST_TYPE_FRACTION, 0, 1, NULL);
  g_object_set (source, "caps", caps, "format", GST_FORMAT_TIME, NULL);
  GBytes *result = NULL;
  if (gst_element_set_state (pipeline, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE) {
    /* GStreamer expects tightly packed rows for these caps. */
    GBytes *packed;
    if (stride == width * 4) {
      packed = g_bytes_ref (pixels);
    } else {
      const guint8 *rows = g_bytes_get_data (pixels, NULL);
      guint8 *tight = g_malloc ((gsize) width * 4 * height);
      for (guint y = 0; y < height; y++)
        memcpy (tight + (gsize) y * width * 4, rows + (gsize) y * stride, (gsize) width * 4);
      packed = g_bytes_new_take (tight, (gsize) width * 4 * height);
    }
    /* The buffer takes its own reference to the bytes. */
    GstBuffer *buffer = gst_buffer_new_wrapped_bytes (packed);
    g_bytes_unref (packed);
    gst_app_src_push_buffer (GST_APP_SRC (source), buffer);
    gst_app_src_end_of_stream (GST_APP_SRC (source));
    GstClockTime wait = (GstClockTime) MIN (remaining, TC_PREVIEW_PULL_TIMEOUT_US) * GST_USECOND;
    GstSample *sample = gst_app_sink_try_pull_sample (GST_APP_SINK (sink), wait);
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
  gst_element_set_state (pipeline, GST_STATE_NULL);
  gst_object_unref (source);
  gst_object_unref (sink);
  gst_object_unref (pipeline);
  return result;
}

/* The worker thread: every quality until one fits the byte bound. */
static void
encode_in_thread (GTask *task, gpointer source_object, gpointer task_data, GCancellable *cancellable)
{
  PreviewRequest *request = task_data;
  static const int qualities[] = { 80, 60, 40 };
  for (guint i = 0; i < G_N_ELEMENTS (qualities); i++) {
    g_autoptr (GBytes) jpeg = encode (request->pixels, request->width, request->height, request->stride,
                                      request->out_width, request->out_height, qualities[i], request->deadline);
    if (jpeg == NULL) {
      request->unavailable_code = g_get_monotonic_time () >= request->deadline ? "encode_timeout" : "encode_failed";
      break;
    }
    if (g_bytes_get_size (jpeg) <= request->max_bytes) {
      gsize size = 0;
      const guchar *data = g_bytes_get_data (jpeg, &size);
      request->jpeg_base64 = g_base64_encode (data, size);
      break;
    }
  }
  if (request->jpeg_base64 == NULL && request->unavailable_code == NULL)
    request->unavailable_code = "preview_too_large";
  g_task_return_boolean (task, TRUE);
}

/* Answers the daemon unless a timeout already did. */
static void
answer (PreviewRequest *request, const char *jpeg_base64, const char *unavailable_code)
{
  if (request->answered)
    return;
  request->answered = TRUE;
  send_result (request->host, request->request_id, jpeg_base64, request->out_width, request->out_height,
               unavailable_code);
}

/* The capture is over: the next request may start. */
static void
finish (PreviewRequest *request)
{
  g_assert (in_flight == request);
  in_flight = NULL;
  request_free (request);
}

static void
on_encoded (GObject *source, GAsyncResult *result, gpointer user_data)
{
  PreviewRequest *request = user_data;
  answer (request, request->jpeg_base64, request->unavailable_code);
  finish (request);
}

static gboolean
on_snapshot_timeout (gpointer user_data)
{
  PreviewRequest *request = user_data;
  request->timeout_source = 0;
  g_message ("preview: WebKit did not deliver the snapshot within %d ms", TC_PREVIEW_SNAPSHOT_TIMEOUT_MS);
  answer (request, NULL, "snapshot_timeout");
  return G_SOURCE_REMOVE;
}

static void
on_snapshot (GObject *object, GAsyncResult *result, gpointer user_data)
{
  PreviewRequest *request = user_data;
  if (request->timeout_source != 0) {
    g_source_remove (request->timeout_source);
    request->timeout_source = 0;
  }
  g_autoptr (GError) error = NULL;
  g_autoptr (WebKitImage) image = webkit_web_view_get_snapshot_finish (WEBKIT_WEB_VIEW (object), result, &error);
  if (image == NULL) {
    g_message ("preview: snapshot failed: %s", error ? error->message : "unknown");
    answer (request, NULL, "snapshot_failed");
    finish (request);
    return;
  }
  if (request->answered) {
    /* The snapshot came after the timeout answer: nobody waits for it. */
    finish (request);
    return;
  }
  guint width = (guint) webkit_image_get_width (image);
  guint height = (guint) webkit_image_get_height (image);
  guint stride = webkit_image_get_stride (image);
  /* (transfer none): the image owns these bytes; keep our own reference. */
  GBytes *pixels = webkit_image_as_bytes (image);
  if (pixels == NULL || width == 0 || height == 0 || stride < width * 4
      || g_bytes_get_size (pixels) < (gsize) stride * height) {
    answer (request, NULL, "snapshot_invalid");
    finish (request);
    return;
  }
  request->pixels = g_bytes_ref (pixels);
  request->width = width;
  request->height = height;
  request->stride = stride;
  fit (width, height, request->max_width, request->max_height, &request->out_width, &request->out_height);
  g_autoptr (GTask) task = g_task_new (NULL, NULL, on_encoded, request);
  g_task_set_task_data (task, request, NULL);
  g_task_run_in_thread (task, encode_in_thread);
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
  if (in_flight != NULL) {
    send_result (host, request_id, NULL, 0, 0, "preview_busy");
    return;
  }
  PreviewRequest *request = g_new0 (PreviewRequest, 1);
  request->host = host;
  request->request_id = g_strdup (request_id);
  request->max_width = (guint) max_width;
  request->max_height = (guint) max_height;
  request->max_bytes = (guint) max_bytes;
  request->deadline = g_get_monotonic_time () + TC_PREVIEW_DEADLINE_US;
  in_flight = request;
  g_message ("preview: snapshot requested");
  request->timeout_source = g_timeout_add (TC_PREVIEW_SNAPSHOT_TIMEOUT_MS, on_snapshot_timeout, request);
  webkit_web_view_get_snapshot (host->view, WEBKIT_SNAPSHOT_REGION_VISIBLE, WEBKIT_SNAPSHOT_OPTIONS_NONE, NULL,
                                on_snapshot, request);
}
