/*
 * Watch Live H.264: one persistent GStreamer encoder of the presented WPE
 * buffer, controlled by tilecastd.
 *
 * tilecastd sends live_encoder.start only while Studio holds an H.264
 * lease and the screen is not protected, and live_encoder.stop the moment
 * that ends; this code never starts an encoder on its own. While a stream
 * runs:
 *
 *   - a main-loop timer at the profile's frame rate takes the buffer the
 *     view last presented (the same source as the preview, so hardware
 *     video layers are included). When nothing new was presented, the last
 *     copy is pushed again without another copy;
 *   - at most TC_LIVE_MAX_IN_FLIGHT raw frames wait for the encoder. When
 *     the encoder is busy, or the last copy took too much of the main loop,
 *     the frame is dropped before encoding and counted, never queued;
 *   - conversion, scaling and encoding run on GStreamer's streaming threads:
 *     appsrc ! videoconvert ! videoscale ! <encoder> ! h264parse ! appsink;
 *   - h264parse (config-interval=-1) writes SPS and PPS before every IDR,
 *     and the encoder makes an IDR about once a second, so a decoder can
 *     start at any keyframe. live_encoder.keyframe asks for one sooner;
 *   - each access unit leaves as renderer.live_chunk (base64), at most
 *     TC_LIVE_MAX_ACCESS_UNIT bytes. A larger one is dropped and an IDR is
 *     requested.
 *
 * Encoder probe. Before advertising anything, the renderer instantiates
 * each candidate and encodes real frames at the profile size, then checks
 * that the first output is a Constrained Baseline keyframe with SPS, PPS and
 * an IDR slice. Order: vah264lpenc, vah264enc, openh264enc. A VA-API
 * encoder that passes at 1280x720 advertises h264-720p15 and below; a
 * software encoder starts at h264-540p15. Nothing passes: no H.264 profile,
 * and Watch Live stays on MJPEG. The probe runs once per renderer process on
 * a worker thread.
 *
 * A stream failure is reported as renderer.live_encoder "failed" and never
 * affects playback. No frame, chunk or pixel is logged or stored.
 */
#include "host.h"
#include "validate.h"

#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <gst/video/video.h>
#include <string.h>

#define TC_LIVE_MAX_ACCESS_UNIT (512 * 1024)
#define TC_LIVE_MAX_IN_FLIGHT 2
#define TC_LIVE_PROBE_TIMEOUT_US (6 * G_USEC_PER_SEC)
/* A copy that took more than this share of the frame interval skips the
 * next frame, so the main loop never spends more than about a quarter of
 * its time on Watch Live. */
#define TC_LIVE_MAIN_LOOP_SHARE 4

typedef struct {
  const char *element;
  gboolean hardware;
  const char *raw_format;
} Candidate;

static const Candidate candidates[] = {
  { "vah264lpenc", TRUE, "NV12" },
  { "vah264enc", TRUE, "NV12" },
  { "openh264enc", FALSE, "I420" },
};

/* --- Probe result (written once by the worker, read on the main loop) --- */

static struct {
  gboolean done;
  const Candidate *candidate;
  gboolean supports_720p;
} probe;

static TcHost *probe_host;

/* --- The running stream (main thread) ------------------------------------ */

typedef struct {
  TcHost *host;
  char stream_id[37];
  guint generation;
  GstElement *pipeline;
  GstElement *source;
  GstElement *encoder;
  GstElement *sink;
  guint timer;
  guint fps;
  guint width;
  guint height;
  guint64 frame;
  gint in_flight; /* atomic */
  guint dropped;
  guint skip;
  guint64 copied_generation;
  GBytes *last_pixels;
  TcPixelFormat last_format;
  guint last_width;
  guint last_height;
  gint64 last_capture_us;
  /* Main thread: when the last access unit was delivered. */
  gint64 last_output_us;
  /* Push times of frames in the encoder, by PTS index (a small ring). */
  gint64 pushed_at[8];
} Stream;

static Stream *active;
static guint next_generation;

typedef struct {
  TcHost *host;
  guint generation;
  char stream_id[37];
  char *data_base64;
  guint64 timestamp_us;
  guint width;
  guint height;
  gboolean keyframe;
  guint capture_us;
  guint encode_us;
  guint dropped;
  gboolean failed;
  gboolean oversized;
} Delivery;

static void send_state (TcHost *host, const char *stream_id, const char *state, const char *code,
                        const char *encoder);

static gboolean
gstreamer_ready (void)
{
  static gsize once = 0;
  static gboolean usable = FALSE;
  if (g_once_init_enter (&once)) {
    usable = gst_init_check (NULL, NULL, NULL);
    g_once_init_leave (&once, 1);
  }
  return usable;
}

/* Encoder properties for low latency, no B-frames, about one IDR a second,
 * and bitrate control. Only properties the element has are set. */
static void
configure_encoder (GstElement *encoder, guint fps, guint bitrate)
{
  GObjectClass *klass = G_OBJECT_GET_CLASS (encoder);
  const char *name = GST_OBJECT_NAME (gst_element_get_factory (encoder));
  if (g_str_has_prefix (name, "va")) {
    if (g_object_class_find_property (klass, "b-frames"))
      g_object_set (encoder, "b-frames", 0, NULL);
    if (g_object_class_find_property (klass, "key-int-max"))
      g_object_set (encoder, "key-int-max", fps, NULL);
    if (g_object_class_find_property (klass, "bitrate"))
      g_object_set (encoder, "bitrate", MAX (1u, bitrate / 1000), NULL);
    if (g_object_class_find_property (klass, "rate-control"))
      gst_util_set_object_arg (G_OBJECT (encoder), "rate-control", "cbr");
    if (g_object_class_find_property (klass, "target-usage"))
      g_object_set (encoder, "target-usage", 7, NULL);
    if (g_object_class_find_property (klass, "ref-frames"))
      g_object_set (encoder, "ref-frames", 1, NULL);
  } else {
    if (g_object_class_find_property (klass, "gop-size"))
      g_object_set (encoder, "gop-size", fps, NULL);
    if (g_object_class_find_property (klass, "bitrate"))
      g_object_set (encoder, "bitrate", bitrate, NULL);
    if (g_object_class_find_property (klass, "rate-control"))
      gst_util_set_object_arg (G_OBJECT (encoder), "rate-control", "bitrate");
    if (g_object_class_find_property (klass, "usage-type"))
      gst_util_set_object_arg (G_OBJECT (encoder), "usage-type", "screen");
    if (g_object_class_find_property (klass, "complexity"))
      gst_util_set_object_arg (G_OBJECT (encoder), "complexity", "low");
    if (g_object_class_find_property (klass, "multi-thread"))
      g_object_set (encoder, "multi-thread", 2, NULL);
  }
}

/* appsrc ! videoconvert ! videoscale ! raw caps ! encoder ! baseline caps
 * ! h264parse ! byte-stream AU caps ! appsink. Returns a NULL-state
 * pipeline, or NULL. */
static GstElement *
build_pipeline (const Candidate *candidate, GstElement *input, guint width, guint height, guint fps,
                guint bitrate, GstElement **encoder_out, GstElement **sink_out)
{
  GstElement *pipeline = gst_pipeline_new (NULL);
  GstElement *convert = gst_element_factory_make ("videoconvert", NULL);
  GstElement *scale = gst_element_factory_make ("videoscale", NULL);
  GstElement *raw = gst_element_factory_make ("capsfilter", NULL);
  GstElement *encoder = gst_element_factory_make (candidate->element, NULL);
  GstElement *profile = gst_element_factory_make ("capsfilter", NULL);
  GstElement *parse = gst_element_factory_make ("h264parse", NULL);
  GstElement *stream = gst_element_factory_make ("capsfilter", NULL);
  GstElement *sink = gst_element_factory_make ("appsink", NULL);
  if (pipeline == NULL || input == NULL || convert == NULL || scale == NULL || raw == NULL || encoder == NULL
      || profile == NULL || parse == NULL || stream == NULL || sink == NULL) {
    GstElement *all[] = { pipeline, input, convert, scale, raw, encoder, profile, parse, stream, sink };
    for (guint i = 0; i < G_N_ELEMENTS (all); i++)
      if (all[i] != NULL)
        gst_object_unref (gst_object_ref_sink (all[i]));
    return NULL;
  }
  g_autoptr (GstCaps) raw_caps =
    gst_caps_new_simple ("video/x-raw", "format", G_TYPE_STRING, candidate->raw_format, "width", G_TYPE_INT,
                         (int) width, "height", G_TYPE_INT, (int) height, "framerate", GST_TYPE_FRACTION, (int) fps,
                         1, "pixel-aspect-ratio", GST_TYPE_FRACTION, 1, 1, NULL);
  g_autoptr (GstCaps) profile_caps =
    gst_caps_new_simple ("video/x-h264", "profile", G_TYPE_STRING, "constrained-baseline", NULL);
  g_autoptr (GstCaps) stream_caps = gst_caps_new_simple ("video/x-h264", "stream-format", G_TYPE_STRING,
                                                         "byte-stream", "alignment", G_TYPE_STRING, "au", NULL);
  g_object_set (raw, "caps", raw_caps, NULL);
  g_object_set (profile, "caps", profile_caps, NULL);
  g_object_set (stream, "caps", stream_caps, NULL);
  g_object_set (parse, "config-interval", -1, NULL);
  g_object_set (sink, "sync", FALSE, "max-buffers", 8, "drop", FALSE, NULL);
  configure_encoder (encoder, fps, bitrate);
  gst_bin_add_many (GST_BIN (pipeline), input, convert, scale, raw, encoder, profile, parse, stream, sink, NULL);
  if (!gst_element_link_many (input, convert, scale, raw, encoder, profile, parse, stream, sink, NULL)) {
    gst_object_unref (pipeline);
    return NULL;
  }
  *encoder_out = encoder;
  *sink_out = sink;
  return pipeline;
}

/* NAL unit types of an Annex B access unit, in order, as a bit set of
 * "seen SPS", "seen PPS", "IDR after both". */
static gboolean
is_restartable_keyframe (const guint8 *data, gsize size)
{
  gboolean sps = FALSE, pps = FALSE;
  for (gsize i = 0; i + 3 < size; i++) {
    if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1) {
      guint type = data[i + 3] & 0x1f;
      if (type == 7)
        sps = TRUE;
      else if (type == 8)
        pps = TRUE;
      else if (type == 5)
        return sps && pps;
      i += 2;
    }
  }
  return FALSE;
}

/* One probe at one size: real frames through the real pipeline. */
static gboolean
probe_candidate (const Candidate *candidate, guint width, guint height, guint fps)
{
  GstElement *source = gst_element_factory_make ("videotestsrc", NULL);
  if (source == NULL)
    return FALSE;
  g_object_set (source, "num-buffers", 4, NULL);
  gst_util_set_object_arg (G_OBJECT (source), "pattern", "ball");
  GstElement *encoder = NULL, *sink = NULL;
  GstElement *pipeline = build_pipeline (candidate, source, width, height, fps, 900000, &encoder, &sink);
  if (pipeline == NULL)
    return FALSE;
  gboolean ok = FALSE;
  if (gst_element_set_state (pipeline, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE) {
    GstSample *sample = gst_app_sink_try_pull_sample (GST_APP_SINK (sink), TC_LIVE_PROBE_TIMEOUT_US * GST_USECOND);
    if (sample != NULL) {
      GstBuffer *buffer = gst_sample_get_buffer (sample);
      GstMapInfo map;
      if (buffer != NULL && !GST_BUFFER_FLAG_IS_SET (buffer, GST_BUFFER_FLAG_DELTA_UNIT)
          && gst_buffer_map (buffer, &map, GST_MAP_READ)) {
        ok = map.size <= TC_LIVE_MAX_ACCESS_UNIT && is_restartable_keyframe (map.data, map.size);
        gst_buffer_unmap (buffer, &map);
      }
      gst_sample_unref (sample);
    }
  }
  gst_element_set_state (pipeline, GST_STATE_NULL);
  gst_object_unref (pipeline);
  return ok;
}

static void
send_capabilities (TcHost *host)
{
  if (!probe.done || !host->welcomed)
    return;
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "profiles");
  json_builder_begin_array (builder);
  if (probe.candidate != NULL) {
    if (probe.supports_720p)
      json_builder_add_string_value (builder, "h264-720p15");
    json_builder_add_string_value (builder, "h264-540p15");
    json_builder_add_string_value (builder, "h264-540p10");
  }
  json_builder_end_array (builder);
  if (probe.candidate != NULL) {
    json_builder_set_member_name (builder, "encoder");
    json_builder_add_string_value (builder, probe.candidate->element);
  }
  json_builder_set_member_name (builder, "hardware");
  json_builder_add_boolean_value (builder, probe.candidate != NULL && probe.candidate->hardware);
  json_builder_end_object (builder);
  tc_ipc_send_event (host, "renderer.live_capabilities", json_builder_get_root (builder));
}

static void
probe_in_thread (GTask *task, gpointer source_object, gpointer task_data, GCancellable *cancellable)
{
  (void) source_object;
  (void) task_data;
  (void) cancellable;
  if (gstreamer_ready ()) {
    for (guint i = 0; i < G_N_ELEMENTS (candidates) && probe.candidate == NULL; i++) {
      const Candidate *candidate = &candidates[i];
      g_autoptr (GstElementFactory) factory = gst_element_factory_find (candidate->element);
      if (factory == NULL)
        continue;
      /* Hardware encoders must prove 720p; software starts at 540p. */
      if (candidate->hardware && probe_candidate (candidate, 1280, 720, 15)) {
        probe.candidate = candidate;
        probe.supports_720p = TRUE;
      } else if (probe_candidate (candidate, 960, 540, 15)) {
        probe.candidate = candidate;
      } else {
        g_message ("live-encoder: %s is installed but did not produce a Constrained Baseline stream",
                   candidate->element);
      }
    }
  }
  g_task_return_boolean (task, TRUE);
}

static void
on_probed (GObject *source, GAsyncResult *result, gpointer user_data)
{
  (void) source;
  (void) result;
  (void) user_data;
  probe.done = TRUE;
  if (probe.candidate != NULL)
    g_message ("live-encoder: H.264 Watch Live uses %s (%s, up to %s)", probe.candidate->element,
               probe.candidate->hardware ? "hardware" : "software", probe.supports_720p ? "720p15" : "540p15");
  else
    g_message ("live-encoder: no working H.264 encoder; Watch Live uses MJPEG");
  if (probe_host != NULL)
    send_capabilities (probe_host);
}

void
tc_live_encoder_init (TcHost *host)
{
  probe_host = host;
  g_autoptr (GTask) task = g_task_new (NULL, NULL, on_probed, NULL);
  g_task_run_in_thread (task, probe_in_thread);
}

void
tc_live_encoder_welcomed (TcHost *host)
{
  /* A new daemon session knows nothing: stop any stream of the old one and
   * repeat the probe result. */
  tc_live_encoder_stop_all (host);
  send_capabilities (host);
}

/* --- Streaming ------------------------------------------------------------ */

static void
send_state (TcHost *host, const char *stream_id, const char *state, const char *code, const char *encoder)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "streamId");
  json_builder_add_string_value (builder, stream_id);
  json_builder_set_member_name (builder, "state");
  json_builder_add_string_value (builder, state);
  json_builder_set_member_name (builder, "code");
  json_builder_add_string_value (builder, code);
  if (encoder != NULL) {
    json_builder_set_member_name (builder, "encoder");
    json_builder_add_string_value (builder, encoder);
  }
  json_builder_end_object (builder);
  tc_ipc_send_event (host, "renderer.live_encoder", json_builder_get_root (builder));
}

static void
delivery_free (Delivery *delivery)
{
  g_free (delivery->data_base64);
  g_free (delivery);
}

/* Main thread: hand one access unit to tilecastd if its stream still runs. */
static gboolean
deliver (gpointer user_data)
{
  Delivery *delivery = user_data;
  Stream *stream = active;
  if (stream == NULL || stream->generation != delivery->generation)
    return G_SOURCE_REMOVE;
  stream->last_output_us = g_get_monotonic_time ();
  if (delivery->failed) {
    send_state (delivery->host, delivery->stream_id, "failed", "encoder_error", NULL);
    tc_live_encoder_stop_all (delivery->host);
    return G_SOURCE_REMOVE;
  }
  if (delivery->oversized) {
    gst_element_send_event (stream->sink, gst_video_event_new_upstream_force_key_unit (GST_CLOCK_TIME_NONE, TRUE, 0));
    return G_SOURCE_REMOVE;
  }
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "streamId");
  json_builder_add_string_value (builder, delivery->stream_id);
  json_builder_set_member_name (builder, "timestampMicros");
  json_builder_add_int_value (builder, (gint64) delivery->timestamp_us);
  json_builder_set_member_name (builder, "width");
  json_builder_add_int_value (builder, delivery->width);
  json_builder_set_member_name (builder, "height");
  json_builder_add_int_value (builder, delivery->height);
  json_builder_set_member_name (builder, "keyframe");
  json_builder_add_boolean_value (builder, delivery->keyframe);
  json_builder_set_member_name (builder, "dataBase64");
  json_builder_add_string_value (builder, delivery->data_base64);
  json_builder_set_member_name (builder, "captureMicros");
  json_builder_add_int_value (builder, delivery->capture_us);
  json_builder_set_member_name (builder, "encodeMicros");
  json_builder_add_int_value (builder, delivery->encode_us);
  json_builder_set_member_name (builder, "droppedFrames");
  json_builder_add_int_value (builder, stream->dropped);
  json_builder_end_object (builder);
  stream->dropped = 0;
  tc_ipc_send_event (delivery->host, "renderer.live_chunk", json_builder_get_root (builder));
  return G_SOURCE_REMOVE;
}

/* Streaming thread: one encoded access unit. The stream outlives this
 * callback: stop sets the pipeline to NULL, which joins streaming threads
 * before the stream is freed. */
static GstFlowReturn
on_new_sample (GstAppSink *sink, gpointer user_data)
{
  Stream *stream = user_data;
  GstSample *sample = gst_app_sink_pull_sample (sink);
  if (sample == NULL)
    return GST_FLOW_EOS;
  g_atomic_int_add (&stream->in_flight, -1);
  if (g_atomic_int_get (&stream->in_flight) < 0)
    g_atomic_int_set (&stream->in_flight, 0);
  Delivery *delivery = g_new0 (Delivery, 1);
  delivery->host = stream->host;
  delivery->generation = stream->generation;
  memcpy (delivery->stream_id, stream->stream_id, sizeof delivery->stream_id);
  GstBuffer *buffer = gst_sample_get_buffer (sample);
  GstCaps *caps = gst_sample_get_caps (sample);
  GstStructure *structure = caps != NULL ? gst_caps_get_structure (caps, 0) : NULL;
  int width = 0, height = 0;
  if (structure != NULL) {
    gst_structure_get_int (structure, "width", &width);
    gst_structure_get_int (structure, "height", &height);
  }
  GstMapInfo map;
  if (buffer == NULL || width <= 0 || height <= 0 || !gst_buffer_map (buffer, &map, GST_MAP_READ)) {
    delivery->failed = TRUE;
  } else {
    if (map.size > TC_LIVE_MAX_ACCESS_UNIT) {
      delivery->oversized = TRUE;
    } else {
      delivery->data_base64 = g_base64_encode (map.data, map.size);
      delivery->keyframe = !GST_BUFFER_FLAG_IS_SET (buffer, GST_BUFFER_FLAG_DELTA_UNIT);
      delivery->width = (guint) width;
      delivery->height = (guint) height;
      GstClockTime pts = GST_BUFFER_PTS (buffer);
      delivery->timestamp_us = GST_CLOCK_TIME_IS_VALID (pts) ? pts / GST_USECOND : 0;
      guint64 index = GST_CLOCK_TIME_IS_VALID (pts) && stream->fps > 0 ? pts * stream->fps / GST_SECOND : 0;
      gint64 pushed = stream->pushed_at[index % G_N_ELEMENTS (stream->pushed_at)];
      gint64 now = g_get_monotonic_time ();
      delivery->encode_us = pushed > 0 && now > pushed ? (guint) MIN (now - pushed, G_MAXUINT) : 0;
      delivery->capture_us = (guint) MIN (stream->last_capture_us, G_MAXUINT);
    }
    gst_buffer_unmap (buffer, &map);
  }
  gst_sample_unref (sample);
  g_idle_add_full (G_PRIORITY_DEFAULT_IDLE, deliver, delivery, (GDestroyNotify) delivery_free);
  return GST_FLOW_OK;
}

/* Main thread, at the profile frame rate. */
static gboolean
on_tick (gpointer user_data)
{
  Stream *stream = user_data;
  if (stream->skip > 0) {
    stream->skip--;
    stream->dropped++;
    return G_SOURCE_CONTINUE;
  }
  /* An encoder may consume a frame without output; a second of silence
   * means nothing is really in flight. */
  if (g_atomic_int_get (&stream->in_flight) >= TC_LIVE_MAX_IN_FLIGHT
      && g_get_monotonic_time () - stream->last_output_us > G_USEC_PER_SEC)
    g_atomic_int_set (&stream->in_flight, 0);
  if (g_atomic_int_get (&stream->in_flight) >= TC_LIVE_MAX_IN_FLIGHT) {
    /* The encoder is behind: drop this raw frame instead of queueing it. */
    stream->dropped++;
    return G_SOURCE_CONTINUE;
  }
  guint64 generation = tc_preview_presented_generation (stream->host);
  if (stream->last_pixels == NULL || generation != stream->copied_generation) {
    TcPixelFormat format;
    guint width = 0, height = 0;
    gint64 elapsed = 0;
    GBytes *pixels = tc_preview_copy_presented (stream->host, &format, &width, &height, &elapsed);
    stream->last_capture_us = elapsed;
    if (pixels == NULL) {
      stream->dropped++;
      return G_SOURCE_CONTINUE;
    }
    g_clear_pointer (&stream->last_pixels, g_bytes_unref);
    stream->last_pixels = pixels;
    stream->last_format = format;
    stream->last_width = width;
    stream->last_height = height;
    stream->copied_generation = generation;
    gint64 interval = G_USEC_PER_SEC / MAX (1u, stream->fps);
    if (elapsed * TC_LIVE_MAIN_LOOP_SHARE > interval)
      stream->skip = (guint) MIN (elapsed * TC_LIVE_MAIN_LOOP_SHARE / interval, 4);
  } else {
    stream->last_capture_us = 0;
  }
  g_autoptr (GstCaps) caps = gst_caps_new_simple (
    "video/x-raw", "format", G_TYPE_STRING, tc_pixel_format_gst_name (stream->last_format), "width", G_TYPE_INT,
    (int) stream->last_width, "height", G_TYPE_INT, (int) stream->last_height, "framerate", GST_TYPE_FRACTION,
    (int) stream->fps, 1, "pixel-aspect-ratio", GST_TYPE_FRACTION, 1, 1, NULL);
  GstBuffer *buffer = gst_buffer_new_wrapped_bytes (stream->last_pixels);
  GST_BUFFER_PTS (buffer) = gst_util_uint64_scale (stream->frame, GST_SECOND, stream->fps);
  GST_BUFFER_DURATION (buffer) = gst_util_uint64_scale (1, GST_SECOND, stream->fps);
  stream->pushed_at[stream->frame % G_N_ELEMENTS (stream->pushed_at)] = g_get_monotonic_time ();
  stream->frame++;
  GstSample *sample = gst_sample_new (buffer, caps, NULL, NULL);
  gst_buffer_unref (buffer);
  g_atomic_int_inc (&stream->in_flight);
  if (gst_app_src_push_sample (GST_APP_SRC (stream->source), sample) != GST_FLOW_OK)
    g_atomic_int_add (&stream->in_flight, -1);
  gst_sample_unref (sample);
  return G_SOURCE_CONTINUE;
}

static gboolean
on_bus_message (GstBus *bus, GstMessage *message, gpointer user_data)
{
  (void) bus;
  guint generation = GPOINTER_TO_UINT (user_data);
  Stream *stream = active;
  if (stream == NULL || stream->generation != generation)
    return G_SOURCE_REMOVE;
  if (GST_MESSAGE_TYPE (message) == GST_MESSAGE_ERROR) {
    g_autoptr (GError) error = NULL;
    gst_message_parse_error (message, &error, NULL);
    g_message ("live-encoder: encoder failed: %s", error ? error->message : "unknown");
    TcHost *host = stream->host;
    char id[37];
    memcpy (id, stream->stream_id, sizeof id);
    tc_live_encoder_stop_all (host);
    send_state (host, id, "failed", "encoder_error", NULL);
    return G_SOURCE_REMOVE;
  }
  return G_SOURCE_CONTINUE;
}

void
tc_live_encoder_stop_all (TcHost *host)
{
  (void) host;
  Stream *stream = active;
  if (stream == NULL)
    return;
  active = NULL;
  if (stream->timer != 0)
    g_source_remove (stream->timer);
  /* NULL joins the streaming threads; queued deliveries see a new
   * generation (or none) and drop themselves. */
  gst_element_set_state (stream->pipeline, GST_STATE_NULL);
  GstBus *bus = gst_element_get_bus (stream->pipeline);
  gst_bus_remove_watch (bus);
  gst_object_unref (bus);
  gst_object_unref (stream->pipeline);
  g_clear_pointer (&stream->last_pixels, g_bytes_unref);
  g_free (stream);
}

static void
start (TcHost *host, JsonObject *data)
{
  const char *stream_id = json_object_get_string_member_with_default (data, "streamId", NULL);
  if (!tc_is_canonical_uuid (stream_id))
    return;
  /* A new start replaces the running stream. */
  tc_live_encoder_stop_all (host);
  gint64 max_width = json_object_get_int_member_with_default (data, "maxWidth", 0);
  gint64 max_height = json_object_get_int_member_with_default (data, "maxHeight", 0);
  gint64 fps = json_object_get_int_member_with_default (data, "fps", 0);
  gint64 bitrate = json_object_get_int_member_with_default (data, "bitrate", 0);
  const char *profile = json_object_get_string_member_with_default (data, "profile", "");
  gboolean allowed = probe.candidate != NULL
                     && (g_strcmp0 (profile, "h264-540p15") == 0 || g_strcmp0 (profile, "h264-540p10") == 0
                         || (g_strcmp0 (profile, "h264-720p15") == 0 && probe.supports_720p));
  if (!allowed || max_width < 16 || max_width > 1280 || max_height < 16 || max_height > 720 || fps < 1 || fps > 30
      || bitrate < 100000 || bitrate > 8000000) {
    send_state (host, stream_id, "failed", "start_invalid", NULL);
    return;
  }
  if (host->view == NULL || !gstreamer_ready ()) {
    send_state (host, stream_id, "failed", "renderer_not_ready", NULL);
    return;
  }
  /* The output size follows the presented buffer's aspect ratio, inside the
   * profile bounds, even for 4:2:0. Without a presented buffer yet, the
   * profile bounds are used. */
  TcPixelFormat format = TC_PIXEL_FORMAT_BGRX;
  guint source_width = (guint) max_width, source_height = (guint) max_height;
  gint64 elapsed = 0;
  g_autoptr (GBytes) first = tc_preview_copy_presented (host, &format, &source_width, &source_height, &elapsed);
  double scale = MIN (1.0, MIN ((double) max_width / source_width, (double) max_height / source_height));
  guint width = MAX (16u, ((guint) (source_width * scale)) & ~1u);
  guint height = MAX (16u, ((guint) (source_height * scale)) & ~1u);

  Stream *stream = g_new0 (Stream, 1);
  stream->host = host;
  memcpy (stream->stream_id, stream_id, sizeof stream->stream_id);
  stream->generation = ++next_generation;
  stream->fps = (guint) fps;
  stream->width = width;
  stream->height = height;
  GstElement *source = gst_element_factory_make ("appsrc", NULL);
  if (source != NULL) {
    g_object_set (source, "is-live", TRUE, "format", GST_FORMAT_TIME, "block", FALSE, "max-buffers",
                  (guint64) TC_LIVE_MAX_IN_FLIGHT + 1, NULL);
    if (g_object_class_find_property (G_OBJECT_GET_CLASS (source), "leaky-type"))
      gst_util_set_object_arg (G_OBJECT (source), "leaky-type", "downstream");
  }
  stream->pipeline =
    build_pipeline (probe.candidate, source, width, height, stream->fps, (guint) bitrate, &stream->encoder, &stream->sink);
  if (stream->pipeline == NULL) {
    g_free (stream);
    send_state (host, stream_id, "failed", "pipeline_failed", NULL);
    return;
  }
  stream->source = source;
  GstAppSinkCallbacks callbacks = { 0 };
  callbacks.new_sample = on_new_sample;
  gst_app_sink_set_callbacks (GST_APP_SINK (stream->sink), &callbacks, stream, NULL);
  GstBus *bus = gst_element_get_bus (stream->pipeline);
  gst_bus_add_watch (bus, on_bus_message, GUINT_TO_POINTER (stream->generation));
  gst_object_unref (bus);
  active = stream;
  if (gst_element_set_state (stream->pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
    tc_live_encoder_stop_all (host);
    send_state (host, stream_id, "failed", "pipeline_failed", NULL);
    return;
  }
  stream->last_output_us = g_get_monotonic_time ();
  stream->timer = g_timeout_add_full (G_PRIORITY_DEFAULT, MAX (1u, 1000u / stream->fps), on_tick, stream, NULL);
  send_state (host, stream_id, "started", "ok", probe.candidate->element);
}

void
tc_live_encoder_handle (TcHost *host, const char *name, JsonObject *data)
{
  if (g_strcmp0 (name, "live_encoder.start") == 0) {
    start (host, data);
    return;
  }
  const char *stream_id = json_object_get_string_member_with_default (data, "streamId", NULL);
  if (active == NULL || g_strcmp0 (stream_id, active->stream_id) != 0)
    return;
  if (g_strcmp0 (name, "live_encoder.stop") == 0)
    tc_live_encoder_stop_all (host);
  else if (g_strcmp0 (name, "live_encoder.keyframe") == 0)
    gst_element_send_event (active->sink, gst_video_event_new_upstream_force_key_unit (GST_CLOCK_TIME_NONE, TRUE, 0));
}
