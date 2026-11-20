/*
 * tilecast-wpe-compositor-lab: development and test tool, never installed in
 * an Edge release (docs/tilecast-edge-wpe-compositor-lab.md).
 *
 * Runs one deterministic synthetic scene in WPE WebKit with the same
 * WPEPlatform display, settings and view setup as tilecast-renderer-wpe, and
 * no Tilecast Server, credential, network, manifest or Player Runtime. The
 * scene paints only colors it declares and posts markers ("transition from A
 * to B starts", "settled on B") to the host. For each buffer WPE presents
 * (WPEView::buffer-rendered) the lab records its metadata and, in lab mode
 * only, imports its pixels, samples a grid and asks lab-detector.c whether
 * the frame is possible. Impossible frames are anomalies; a bounded number of
 * them are dumped as PPM with the frames around them.
 *
 * Output in --out:
 *   timeline.jsonl  header, buffer metadata, markers, clock samples, frame
 *                   verdicts and anomalies, one JSON object per line;
 *   summary.json    versions, environment, pacing, buffer formats, anomaly
 *                   counts: the file to attach to a bug;
 *   anomaly-*.ppm   optional frame dumps.
 *
 * Exit status: 0 clean, 3 anomalies found, 4 setup failure, 5 timeout.
 */
#include "buffer-timeline.h"
#include "lab-detector.h"
#include "motion-setting.h"
#include "preview-pixels.h"
#include "validate.h"
#include "visual-trace-format.h"

#include <errno.h>
#include <fcntl.h>
#include <gio/gunixinputstream.h>
#include <glib-unix.h>
#include <glib/gstdio.h>
#include <math.h>
#include <signal.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <wpe/drm/wpe-drm.h>
#include <wpe/headless/wpe-headless.h>
#include <wpe/wayland/wpe-wayland.h>
#include <wpe/webkit.h>

#define LAB_SCHEMA "tilecast-compositor-lab-v1"
#define LAB_TIMELINE_BYTES (64u * 1024u * 1024u)
#define LAB_MAX_ANOMALY_RECORDS 256
#define LAB_MAX_DUMPS 64
#define LAB_MAX_CONTEXT 8
#define LAB_CLOCK_INTERVAL_MS 500

#ifndef TC_LAB_SCENES_DIR
#define TC_LAB_SCENES_DIR ""
#endif

static const char *const SCENES[] = {
  "opacity-basic", "crossfade", "crossfade-cleanup-variants", "transform-3d", "startup-minimal", "video-crossfade", NULL,
};

typedef enum {
  INSPECT_OFF,
  INSPECT_TRANSITIONS,
  INSPECT_ALL,
} InspectMode;

typedef struct {
  guint64 seq;
  GByteArray *ppm;
} ContextFrame;

typedef struct {
  /* Options. */
  char *platform_name;
  char *scene;
  char *variant;
  int iterations;
  int width, height;
  char *out_dir;
  char *scenes_dir;
  InspectMode inspect;
  guint columns, rows;
  int max_dumps;
  int dump_scale;
  int dump_context;
  int timeout_seconds;
  char *inspector;

  /* Engine. */
  GMainLoop *loop;
  WPEDisplay *display;
  WebKitWebContext *context;
  WebKitNetworkSession *session;
  WebKitWebView *view;
  WPEView *wpe_view;
  GCancellable *cancellable;
  gint64 started_us;
  int exit_code;
  const char *result;

  /* Recording. */
  TcTraceWriter *timeline;
  TcBufferTimeline *buffers;
  TcLabDetector *detector;
  TcLabProbe probe;
  GString *line;
  GHashTable *fourccs;   /* "XR24 0x..." -> count */
  GHashTable *kinds;     /* "dmabuf" -> count */
  gint64 *presented_us;
  gsize presented;
  double *transition_intervals;
  gsize transition_count;
  gint64 last_transition_frame_us;
  double *import_us;
  gsize imports;
  guint64 import_failures;
  const char *import_problem;
  guint64 markers;
  guint64 transitions;
  int completed_iterations;
  int current_iteration;
  gboolean done;
  gboolean clock_in_flight;

  /* Anomalies. */
  guint64 anomalies;
  GHashTable *anomaly_kinds; /* name -> count */
  GPtrArray *anomaly_list;   /* JsonNode* */
  int dumps;
  int dump_after;           /* frames still to dump after an anomaly */
  int dump_group;
  ContextFrame ring[LAB_MAX_CONTEXT];
  guint ring_next;
} Lab;

static void
count (GHashTable *table, const char *key)
{
  gpointer value = g_hash_table_lookup (table, key);
  g_hash_table_insert (table, g_strdup (key), GUINT_TO_POINTER (GPOINTER_TO_UINT (value) + 1));
}

static void
write_line (Lab *lab)
{
  tc_trace_writer_line (lab->timeline, lab->line->str);
  g_string_truncate (lab->line, 0);
}

static gboolean
known_scene (const char *scene)
{
  for (guint i = 0; SCENES[i] != NULL; i++) {
    if (g_strcmp0 (scene, SCENES[i]) == 0)
      return TRUE;
  }
  return FALSE;
}

/* Scene files: lower-case names with one of a few extensions, directly in
 * the scenes directory or its media/ subdirectory. */
static gboolean
scene_path_allowed (const char *path)
{
  static GRegex *grammar;
  if (grammar == NULL)
    grammar = g_regex_new ("^/(media/)?[a-z0-9][a-z0-9-]{0,63}\\.(html|js|css|mp4|webm)$", G_REGEX_OPTIMIZE, 0, NULL);
  return path != NULL && g_regex_match (grammar, path, 0, NULL);
}

static const char *
content_type (const char *path)
{
  if (g_str_has_suffix (path, ".html"))
    return "text/html";
  if (g_str_has_suffix (path, ".js"))
    return "text/javascript";
  if (g_str_has_suffix (path, ".css"))
    return "text/css";
  if (g_str_has_suffix (path, ".mp4"))
    return "video/mp4";
  return "video/webm";
}

static void
handle_scene_request (WebKitURISchemeRequest *request, gpointer user_data)
{
  Lab *lab = user_data;
  const char *path = webkit_uri_scheme_request_get_path (request);
  g_autofree char *file = scene_path_allowed (path) ? g_build_filename (lab->scenes_dir, path + 1, NULL) : NULL;
  int fd = file ? open (file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) : -1;
  struct stat info;
  if (fd < 0 || fstat (fd, &info) != 0 || !S_ISREG (info.st_mode)) {
    if (fd >= 0)
      close (fd);
    g_autoptr (GError) error = g_error_new_literal (G_IO_ERROR, G_IO_ERROR_NOT_FOUND, "not a scene file");
    webkit_uri_scheme_request_finish_error (request, error);
    return;
  }
  g_autoptr (GInputStream) stream = g_unix_input_stream_new (fd, TRUE);
  webkit_uri_scheme_request_finish (request, stream, info.st_size, content_type (path));
}

/* ---- frame inspection -------------------------------------------------- */

static gboolean
pixel_order (WPEBuffer *buffer, TcLabChannelOrder *order, guint *declared_stride)
{
  *declared_stride = 0;
  if (WPE_IS_BUFFER_DMA_BUF (buffer)) {
    switch (wpe_buffer_dma_buf_get_format (WPE_BUFFER_DMA_BUF (buffer))) {
    case 0x34325258: /* XR24 */
    case 0x34325241: /* AR24 */
      *order = TC_LAB_ORDER_BGRX;
      return TRUE;
    case 0x34324258: /* XB24 */
    case 0x34324241: /* AB24 */
      *order = TC_LAB_ORDER_RGBX;
      return TRUE;
    default:
      return FALSE;
    }
  }
  if (WPE_IS_BUFFER_SHM (buffer) && wpe_buffer_shm_get_format (WPE_BUFFER_SHM (buffer)) == WPE_PIXEL_FORMAT_ARGB8888) {
    *order = TC_LAB_ORDER_BGRX;
    *declared_stride = wpe_buffer_shm_get_stride (WPE_BUFFER_SHM (buffer));
    return TRUE;
  }
  return FALSE;
}

static void
context_free (ContextFrame *frame)
{
  g_clear_pointer (&frame->ppm, g_byte_array_unref);
}

static void
write_dump (Lab *lab, const char *role, guint64 seq, GByteArray *ppm)
{
  g_autofree char *name = g_strdup_printf ("anomaly-%02d-%s-seq%06" G_GUINT64_FORMAT ".ppm", lab->dump_group, role, seq);
  g_autofree char *path = g_build_filename (lab->out_dir, name, NULL);
  g_autoptr (GError) error = NULL;
  if (!g_file_set_contents_full (path, (const char *) ppm->data, ppm->len, G_FILE_SET_CONTENTS_CONSISTENT, 0644,
                                 &error))
    g_warning ("lab: cannot write %s: %s", name, error->message);
}

static void
record_anomaly (Lab *lab, TcLabVerdict verdict, guint64 seq, gint64 mono, const TcLabFrameMetrics *m, gboolean dumped)
{
  const char *kind = tc_lab_verdict_name (verdict);
  lab->anomalies++;
  count (lab->anomaly_kinds, kind);
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "type");
  json_builder_add_string_value (builder, "anomaly");
  json_builder_set_member_name (builder, "kind");
  json_builder_add_string_value (builder, kind);
  json_builder_set_member_name (builder, "seq");
  json_builder_add_int_value (builder, (gint64) seq);
  json_builder_set_member_name (builder, "mono");
  json_builder_add_int_value (builder, mono);
  json_builder_set_member_name (builder, "iteration");
  json_builder_add_int_value (builder, lab->current_iteration);
  json_builder_set_member_name (builder, "point");
  json_builder_add_int_value (builder, m->point);
  json_builder_set_member_name (builder, "value");
  json_builder_add_double_value (builder, round (m->value * 1000) / 1000);
  json_builder_set_member_name (builder, "rgb");
  json_builder_begin_array (builder);
  json_builder_add_int_value (builder, m->mean.r);
  json_builder_add_int_value (builder, m->mean.g);
  json_builder_add_int_value (builder, m->mean.b);
  json_builder_end_array (builder);
  json_builder_set_member_name (builder, "dumped");
  json_builder_add_boolean_value (builder, dumped);
  json_builder_end_object (builder);
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  g_autofree char *json = json_to_string (root, FALSE);
  tc_trace_writer_line (lab->timeline, json);
  if (lab->anomaly_list->len < LAB_MAX_ANOMALY_RECORDS)
    g_ptr_array_add (lab->anomaly_list, json_node_copy (root));
  g_message ("lab: %s anomaly at frame %" G_GUINT64_FORMAT ", iteration %d", kind, seq, lab->current_iteration);
}

static void
inspect (Lab *lab, WPEBuffer *buffer, guint64 seq, gint64 mono)
{
  gboolean wanted = lab->inspect == INSPECT_ALL || tc_lab_detector_checking (lab->detector) || lab->dump_after > 0;
  if (lab->inspect == INSPECT_OFF || !wanted)
    return;
  TcLabChannelOrder order;
  guint declared_stride;
  if (!pixel_order (buffer, &order, &declared_stride)) {
    lab->import_failures++;
    lab->import_problem = "unsupported_format";
    return;
  }
  gint64 start = g_get_monotonic_time ();
  g_autoptr (GError) error = NULL;
  /* (transfer none): memory the buffer owns, valid during this handler. */
  GBytes *bytes = wpe_buffer_import_to_pixels (buffer, &error);
  gint64 elapsed = g_get_monotonic_time () - start;
  if (bytes == NULL) {
    lab->import_failures++;
    lab->import_problem = "import_failed";
    return;
  }
  gsize size = 0;
  const guint8 *pixels = g_bytes_get_data (bytes, &size);
  int width = wpe_buffer_get_width (buffer), height = wpe_buffer_get_height (buffer);
  guint stride = 0;
  if (tc_pixels_layout (width, height, size, declared_stride, &stride) != TC_PIXELS_OK) {
    lab->import_failures++;
    lab->import_problem = "bad_layout";
    return;
  }
  if (lab->imports < TC_TRACE_MAX_PACING_SAMPLES)
    lab->import_us[lab->imports++] = (double) elapsed;

  TcRgb samples[TC_LAB_MAX_POINTS];
  tc_lab_sample_grid (pixels, width, height, stride, order, &lab->probe, lab->columns, lab->rows, samples);
  TcLabFrameMetrics metrics;
  TcLabVerdict verdict = tc_lab_detector_frame (lab->detector, samples, &metrics);
  g_string_append_printf (lab->line,
                          "{\"type\":\"inspect\",\"seq\":%" G_GUINT64_FORMAT ",\"mono\":%" G_GINT64_FORMAT
                          ",\"state\":\"%s\",\"verdict\":\"%s\",\"rgb\":[%u,%u,%u],\"mixMin\":%.3f,\"mixMax\":%.3f,"
                          "\"mixMean\":%.3f,\"distance\":%.1f,\"hash\":\"%08x\",\"importUs\":%" G_GINT64_FORMAT "}",
                          seq, mono, metrics.state, tc_lab_verdict_name (verdict), metrics.mean.r, metrics.mean.g,
                          metrics.mean.b, metrics.mix_min, metrics.mix_max, metrics.mix_mean, metrics.distance,
                          metrics.hash, elapsed);
  write_line (lab);

  gboolean dumped = FALSE;
  /* Dumps cost a scaled copy of every inspected frame (the context ring), so
   * that work stops once the dump budget is spent. */
  if (lab->max_dumps > 0 && (lab->dumps < lab->max_dumps || lab->dump_after > 0)) {
    g_autoptr (GByteArray) ppm = g_byte_array_new ();
    if (tc_lab_ppm (pixels, width, height, stride, order, (guint) lab->dump_scale, ppm)) {
      if (verdict != TC_LAB_OK && lab->dumps < lab->max_dumps) {
        dumped = TRUE;
        lab->dump_group = ++lab->dumps;
        /* The frames before it, oldest first, then this one. */
        for (int i = 0; i < lab->dump_context; i++) {
          ContextFrame *frame = &lab->ring[(lab->ring_next + i) % lab->dump_context];
          if (frame->ppm != NULL)
            write_dump (lab, "before", frame->seq, frame->ppm);
        }
        write_dump (lab, "frame", seq, ppm);
        lab->dump_after = lab->dump_context;
      } else if (lab->dump_after > 0) {
        lab->dump_after--;
        write_dump (lab, "after", seq, ppm);
      }
      if (lab->dump_context > 0) {
        ContextFrame *slot = &lab->ring[lab->ring_next];
        context_free (slot);
        slot->seq = seq;
        slot->ppm = g_byte_array_ref (ppm);
        lab->ring_next = (lab->ring_next + 1) % lab->dump_context;
      }
    }
  }
  if (verdict != TC_LAB_OK)
    record_anomaly (lab, verdict, seq, mono, &metrics, dumped);
}

static void
on_buffer_rendered (WPEView *view, WPEBuffer *buffer, gpointer user_data)
{
  (void) view;
  Lab *lab = user_data;
  gint64 now = g_get_monotonic_time ();
  guint64 seq = tc_buffer_timeline_rendered (lab->buffers, buffer, now, lab->line);
  write_line (lab);
  if (lab->presented < TC_TRACE_MAX_PACING_SAMPLES)
    lab->presented_us[lab->presented++] = now;
  gboolean moving = tc_lab_detector_checking (lab->detector) && lab->last_transition_frame_us > 0;
  if (moving && lab->transition_count < TC_TRACE_MAX_PACING_SAMPLES)
    lab->transition_intervals[lab->transition_count++] = (double) (now - lab->last_transition_frame_us) / 1000.0;
  lab->last_transition_frame_us = tc_lab_detector_checking (lab->detector) ? now : 0;

  char key[48];
  if (WPE_IS_BUFFER_DMA_BUF (buffer)) {
    char fourcc[5];
    tc_trace_fourcc (wpe_buffer_dma_buf_get_format (WPE_BUFFER_DMA_BUF (buffer)), fourcc);
    g_snprintf (key, sizeof key, "%s 0x%016" G_GINT64_MODIFIER "x", fourcc,
                wpe_buffer_dma_buf_get_modifier (WPE_BUFFER_DMA_BUF (buffer)));
    count (lab->fourccs, key);
    count (lab->kinds, "dmabuf");
  } else {
    count (lab->kinds, WPE_IS_BUFFER_SHM (buffer) ? "shm" : "other");
  }
  inspect (lab, buffer, seq, now);
}

static void
on_buffer_released (WPEView *view, WPEBuffer *buffer, gpointer user_data)
{
  (void) view;
  Lab *lab = user_data;
  tc_buffer_timeline_released (lab->buffers, buffer, g_get_monotonic_time (), lab->line);
  write_line (lab);
}

static void
on_buffers_changed (WPEView *view, gpointer buffers, guint n, gpointer user_data)
{
  (void) view;
  Lab *lab = user_data;
  tc_buffer_timeline_pool (lab->buffers, buffers, n, g_get_monotonic_time (), lab->line);
  write_line (lab);
}

/* ---- page messages ----------------------------------------------------- */

static TcLabRules
parse_rules (const char *rules)
{
  TcLabRules result = 0;
  if (rules == NULL)
    return TC_LAB_RULE_REVERSAL;
  g_auto (GStrv) parts = g_strsplit (rules, ":", 8);
  for (guint i = 0; parts[i] != NULL; i++) {
    if (g_strcmp0 (parts[i], "reversal") == 0)
      result |= TC_LAB_RULE_REVERSAL;
    else if (g_strcmp0 (parts[i], "foreign") == 0)
      result |= TC_LAB_RULE_FOREIGN;
    else if (g_strcmp0 (parts[i], "uniform") == 0)
      result |= TC_LAB_RULE_UNIFORM;
  }
  return result;
}

static double
clamp_fraction (JsonObject *object, const char *member, double fallback)
{
  JsonNode *node = object ? json_object_get_member (object, member) : NULL;
  if (node == NULL || !JSON_NODE_HOLDS_VALUE (node))
    return fallback;
  double value = json_node_get_double (node);
  return isfinite (value) ? CLAMP (value, 0.0, 1.0) : fallback;
}

static void finish (Lab *lab, const char *result, int exit_code);

static void
handle_palette (Lab *lab, JsonObject *message)
{
  JsonObject *colors = json_object_get_object_member (message, "colors");
  if (colors == NULL)
    return;
  JsonObjectIter iter;
  const char *name;
  JsonNode *node;
  json_object_iter_init (&iter, colors);
  while (json_object_iter_next (&iter, &name, &node)) {
    if (!JSON_NODE_HOLDS_ARRAY (node) || json_array_get_length (json_node_get_array (node)) != 3)
      continue;
    JsonArray *rgb = json_node_get_array (node);
    TcRgb color = { (guint8) CLAMP (json_array_get_int_element (rgb, 0), 0, 255),
                    (guint8) CLAMP (json_array_get_int_element (rgb, 1), 0, 255),
                    (guint8) CLAMP (json_array_get_int_element (rgb, 2), 0, 255) };
    if (!tc_lab_detector_set_color (lab->detector, name, color))
      g_warning ("lab: palette color refused: not a token or palette full");
  }
  JsonObject *probe = json_object_get_object_member (message, "probe");
  lab->probe = (TcLabProbe) { clamp_fraction (probe, "x", 0), clamp_fraction (probe, "y", 0),
                              clamp_fraction (probe, "w", 1), clamp_fraction (probe, "h", 1) };
}

static void
handle_marker (Lab *lab, JsonObject *record)
{
  const char *ev = json_object_get_string_member_with_default (record, "ev", "");
  lab->markers++;
  int iteration = (int) json_object_get_int_member_with_default (record, "iteration", lab->current_iteration);
  lab->current_iteration = iteration;
  if (g_strcmp0 (ev, "arm") == 0) {
    tc_lab_detector_arm (lab->detector);
  } else if (g_strcmp0 (ev, "transition-start") == 0) {
    /* "path" is palette names joined by ':' (two to four); a probe given
     * with the marker (px, py, pw, ph) replaces the scene's probe. */
    const char *path = json_object_get_string_member_with_default (record, "path", NULL);
    const char *rules = json_object_get_string_member_with_default (record, "rules", NULL);
    g_auto (GStrv) names = path ? g_strsplit (path, ":", TC_LAB_MAX_PATH + 1) : NULL;
    if (names == NULL || !tc_lab_detector_transition_path (lab->detector, (const char *const *) names,
                                                           g_strv_length (names), parse_rules (rules)))
      g_warning ("lab: transition path is not two to four palette colors");
    if (json_object_has_member (record, "px"))
      lab->probe = (TcLabProbe) { clamp_fraction (record, "px", 0), clamp_fraction (record, "py", 0),
                                  clamp_fraction (record, "pw", 1), clamp_fraction (record, "ph", 1) };
    lab->transitions++;
  } else if (g_strcmp0 (ev, "settled") == 0) {
    const char *color = json_object_get_string_member_with_default (record, "color", NULL);
    if (!tc_lab_detector_settled (lab->detector, color))
      tc_lab_detector_reset (lab->detector);
  } else if (g_strcmp0 (ev, "reset") == 0) {
    tc_lab_detector_reset (lab->detector);
  } else if (g_strcmp0 (ev, "iteration-end") == 0) {
    lab->completed_iterations = MAX (lab->completed_iterations, iteration + 1);
  }
}

static void
on_lab_message (WebKitUserContentManager *manager, JSCValue *value, gpointer user_data)
{
  (void) manager;
  Lab *lab = user_data;
  if (lab->done || !jsc_value_is_object (value))
    return;
  g_autofree char *json = jsc_value_to_json (value, 0);
  g_autoptr (JsonParser) parser = json_parser_new_immutable ();
  if (json == NULL || strlen (json) > 64 * 1024 || !json_parser_load_from_data (parser, json, -1, NULL)
      || !JSON_NODE_HOLDS_OBJECT (json_parser_get_root (parser)))
    return;
  JsonObject *message = json_node_get_object (json_parser_get_root (parser));
  const char *type = json_object_get_string_member_with_default (message, "type", "");
  gint64 now = g_get_monotonic_time ();
  if (g_strcmp0 (type, "palette") == 0) {
    handle_palette (lab, message);
    g_string_append_printf (lab->line, "{\"type\":\"palette\",\"recv\":%" G_GINT64_FORMAT ",\"colors\":%u}", now,
                            json_object_get_size (json_object_get_object_member (message, "colors")));
    write_line (lab);
    return;
  }
  if (g_strcmp0 (type, "marker") == 0) {
    JsonObject *record = json_object_get_object_member (message, "record");
    g_autoptr (JsonBuilder) builder = json_builder_new ();
    json_builder_begin_object (builder);
    json_builder_set_member_name (builder, "type");
    json_builder_add_string_value (builder, "marker");
    json_builder_set_member_name (builder, "recv");
    json_builder_add_int_value (builder, now);
    json_builder_set_member_name (builder, "rec");
    if (record == NULL || !tc_trace_copy_page_record (record, builder))
      return;
    json_builder_end_object (builder);
    tc_trace_writer_builder (lab->timeline, builder);
    handle_marker (lab, record);
    return;
  }
  if (g_strcmp0 (type, "done") == 0) {
    lab->completed_iterations = MAX (lab->completed_iterations,
                                     (int) json_object_get_int_member_with_default (message, "iterations", 0));
    finish (lab, lab->anomalies ? "anomalies" : "pass", lab->anomalies ? 3 : 0);
    return;
  }
  if (g_strcmp0 (type, "error") == 0) {
    const char *code = json_object_get_string_member_with_default (message, "code", "scene_error");
    g_warning ("lab: the scene reported an error (%s)", tc_trace_token_valid (code, 48) ? code : "scene_error");
    finish (lab, "scene_error", 4);
  }
}

/* ---- clock samples ----------------------------------------------------- */

typedef struct {
  Lab *lab;
  GCancellable *cancellable;
  gint64 t0;
} ClockProbe;

static void
clock_done (GObject *source, GAsyncResult *result, gpointer user_data)
{
  ClockProbe *probe = user_data;
  gint64 t1 = g_get_monotonic_time ();
  g_autoptr (GError) error = NULL;
  g_autoptr (JSCValue) value =
    webkit_web_view_call_async_javascript_function_finish (WEBKIT_WEB_VIEW (source), result, &error);
  if (!g_cancellable_is_cancelled (probe->cancellable)) {
    Lab *lab = probe->lab;
    lab->clock_in_flight = FALSE;
    if (value != NULL && jsc_value_is_number (value)) {
      g_string_append_printf (lab->line,
                              "{\"type\":\"clock\",\"t0\":%" G_GINT64_FORMAT ",\"t1\":%" G_GINT64_FORMAT ",\"js\":%.3f}",
                              probe->t0, t1, jsc_value_to_double (value));
      write_line (lab);
    }
  }
  g_object_unref (probe->cancellable);
  g_free (probe);
}

static gboolean
on_clock_tick (gpointer user_data)
{
  Lab *lab = user_data;
  if (lab->done || lab->clock_in_flight)
    return G_SOURCE_CONTINUE;
  ClockProbe *probe = g_new0 (ClockProbe, 1);
  probe->lab = lab;
  probe->cancellable = g_object_ref (lab->cancellable);
  probe->t0 = g_get_monotonic_time ();
  lab->clock_in_flight = TRUE;
  webkit_web_view_call_async_javascript_function (lab->view, "return performance.now();", -1, NULL, NULL, NULL,
                                                  lab->cancellable, clock_done, probe);
  tc_trace_writer_flush (lab->timeline);
  return G_SOURCE_CONTINUE;
}

/* ---- summary ----------------------------------------------------------- */

static void
add_counts (JsonBuilder *builder, const char *name, GHashTable *table)
{
  json_builder_set_member_name (builder, name);
  json_builder_begin_object (builder);
  GHashTableIter iter;
  gpointer key, value;
  g_hash_table_iter_init (&iter, table);
  while (g_hash_table_iter_next (&iter, &key, &value)) {
    json_builder_set_member_name (builder, key);
    json_builder_add_int_value (builder, GPOINTER_TO_UINT (value));
  }
  json_builder_end_object (builder);
}

static void
add_string (JsonBuilder *builder, const char *name, const char *value)
{
  json_builder_set_member_name (builder, name);
  if (value)
    json_builder_add_string_value (builder, value);
  else
    json_builder_add_null_value (builder);
}

static void
add_int (JsonBuilder *builder, const char *name, gint64 value)
{
  json_builder_set_member_name (builder, name);
  json_builder_add_int_value (builder, value);
}

static double
nominal_interval_ms (Lab *lab)
{
  WPEScreen *screen = lab->wpe_view ? wpe_view_get_screen (lab->wpe_view) : NULL;
  int millihertz = screen ? wpe_screen_get_refresh_rate (screen) : 0;
  return millihertz > 0 ? 1000000.0 / millihertz : 0;
}

static void
write_summary (Lab *lab)
{
  g_autoptr (JsonBuilder) b = json_builder_new ();
  json_builder_begin_object (b);
  add_string (b, "schema", LAB_SCHEMA);
  add_string (b, "result", lab->result);
  add_string (b, "scene", lab->scene);
  add_string (b, "variant", lab->variant);
  add_int (b, "iterationsRequested", lab->iterations);
  add_int (b, "iterationsCompleted", lab->completed_iterations);
  add_int (b, "durationMs", (g_get_monotonic_time () - lab->started_us) / 1000);
  add_string (b, "platform", lab->platform_name);
  g_autofree char *webkit = g_strdup_printf ("%u.%u.%u", webkit_get_major_version (), webkit_get_minor_version (),
                                             webkit_get_micro_version ());
  add_string (b, "webkit", webkit);
  json_builder_set_member_name (b, "env");
  tc_trace_env_to_json (b);
  WPEScreen *screen = lab->wpe_view ? wpe_view_get_screen (lab->wpe_view) : NULL;
  json_builder_set_member_name (b, "screen");
  if (screen) {
    json_builder_begin_object (b);
    add_int (b, "width", wpe_screen_get_width (screen));
    add_int (b, "height", wpe_screen_get_height (screen));
    add_int (b, "refreshMilliHz", wpe_screen_get_refresh_rate (screen));
    json_builder_end_object (b);
  } else {
    json_builder_add_null_value (b);
  }
  add_string (b, "inspect", lab->inspect == INSPECT_OFF ? "off" : lab->inspect == INSPECT_ALL ? "all" : "transitions");
  g_autofree char *grid = g_strdup_printf ("%ux%u", lab->columns, lab->rows);
  add_string (b, "grid", grid);
  json_builder_set_member_name (b, "buffers");
  json_builder_begin_object (b);
  add_int (b, "distinct", tc_buffer_timeline_distinct_buffers (lab->buffers));
  add_int (b, "distinctMemory", tc_buffer_timeline_distinct_memory (lab->buffers));
  add_counts (b, "kinds", lab->kinds);
  add_counts (b, "formats", lab->fourccs);
  json_builder_end_object (b);
  TcPacing pacing;
  double nominal = nominal_interval_ms (lab);
  tc_pacing_compute (lab->presented_us, lab->presented, nominal, &pacing);
  json_builder_set_member_name (b, "pacing");
  tc_pacing_to_json (&pacing, b);
  tc_pacing_compute_intervals (lab->transition_intervals, lab->transition_count, nominal, &pacing);
  json_builder_set_member_name (b, "pacingDuringTransitions");
  tc_pacing_to_json (&pacing, b);
  /* What inspection cost: imports run on the main thread at presentation
   * time, so they are part of what the lab measures. */
  tc_pacing_compute_intervals (lab->import_us, lab->imports, 0, &pacing);
  json_builder_set_member_name (b, "import");
  json_builder_begin_object (b);
  add_int (b, "count", (gint64) lab->imports);
  add_int (b, "failures", (gint64) lab->import_failures);
  add_string (b, "problem", lab->import_problem);
  json_builder_set_member_name (b, "medianUs");
  json_builder_add_double_value (b, pacing.median_ms);
  json_builder_set_member_name (b, "p95Us");
  json_builder_add_double_value (b, pacing.p95_ms);
  json_builder_set_member_name (b, "maxUs");
  json_builder_add_double_value (b, pacing.max_ms);
  json_builder_end_object (b);
  add_int (b, "markers", (gint64) lab->markers);
  add_int (b, "transitions", (gint64) lab->transitions);
  json_builder_set_member_name (b, "anomalies");
  json_builder_begin_object (b);
  add_int (b, "total", (gint64) lab->anomalies);
  add_counts (b, "byKind", lab->anomaly_kinds);
  add_int (b, "dumps", lab->dumps);
  json_builder_set_member_name (b, "first");
  json_builder_begin_array (b);
  for (guint i = 0; i < lab->anomaly_list->len; i++)
    json_builder_add_value (b, json_node_copy (g_ptr_array_index (lab->anomaly_list, i)));
  json_builder_end_array (b);
  json_builder_end_object (b);
  add_int (b, "timelineLines", (gint64) tc_trace_writer_lines (lab->timeline));
  add_int (b, "timelineDropped", (gint64) tc_trace_writer_dropped (lab->timeline));
  json_builder_end_object (b);

  g_autoptr (JsonNode) root = json_builder_get_root (b);
  g_autoptr (JsonGenerator) generator = json_generator_new ();
  json_generator_set_pretty (generator, TRUE);
  json_generator_set_root (generator, root);
  g_autofree char *path = g_build_filename (lab->out_dir, "summary.json", NULL);
  g_autoptr (GError) error = NULL;
  if (!json_generator_to_file (generator, path, &error))
    g_warning ("lab: cannot write summary.json: %s", error->message);
}

static void
finish (Lab *lab, const char *result, int exit_code)
{
  if (lab->done)
    return;
  lab->done = TRUE;
  lab->result = result;
  lab->exit_code = exit_code;
  g_cancellable_cancel (lab->cancellable);
  write_summary (lab);
  g_string_append_printf (lab->line, "{\"type\":\"end\",\"result\":\"%s\",\"mono\":%" G_GINT64_FORMAT "}", result,
                          g_get_monotonic_time ());
  tc_trace_writer_close (lab->timeline, lab->line->str);
  lab->timeline = NULL;
  g_message ("lab: %s: %s, %" G_GUINT64_FORMAT " anomalies, %zu frames; results in %s", lab->scene, result,
             lab->anomalies, lab->presented, lab->out_dir);
  g_main_loop_quit (lab->loop);
}

static gboolean
on_timeout (gpointer user_data)
{
  Lab *lab = user_data;
  finish (lab, "timeout", 5);
  return G_SOURCE_REMOVE;
}

static gboolean
on_signal (gpointer user_data)
{
  Lab *lab = user_data;
  finish (lab, "interrupted", 4);
  return G_SOURCE_REMOVE;
}

static void
on_web_process_terminated (WebKitWebView *view, WebKitWebProcessTerminationReason reason, gpointer user_data)
{
  (void) view;
  Lab *lab = user_data;
  g_warning ("lab: web process terminated (reason %d)", (int) reason);
  finish (lab, "web_process_terminated", 4);
}

/* ---- setup ------------------------------------------------------------- */

static void
enforce_webkit_sandbox (void)
{
#ifndef TILECAST_ALLOW_UNSANDBOXED_WEBKIT
  if (g_getenv ("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS") != NULL) {
    g_unsetenv ("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS");
    g_printerr ("tilecast-wpe-compositor-lab: ignoring WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS; WebKit's sandbox stays on\n");
  }
#endif
}

/* --inspector accepts a loopback address only: whoever reaches the port
 * controls the page. Reach it from another machine through an SSH tunnel. */
static gboolean
inspector_address_valid (const char *address)
{
  if (address == NULL)
    return FALSE;
  const char *colon = strrchr (address, ':');
  if (colon == NULL)
    return FALSE;
  g_autofree char *host = g_strndup (address, colon - address);
  if (g_strcmp0 (host, "127.0.0.1") != 0 && g_strcmp0 (host, "[::1]") != 0)
    return FALSE;
  char *end = NULL;
  long port = strtol (colon + 1, &end, 10);
  return end != NULL && *end == '\0' && port >= 1024 && port <= 65535;
}

static WPEDisplay *
create_display (const char *platform)
{
  if (g_strcmp0 (platform, "drm") == 0)
    return wpe_display_drm_new ();
  if (g_strcmp0 (platform, "wayland") == 0)
    return wpe_display_wayland_new ();
  return wpe_display_headless_new ();
}

static gboolean
create_view (Lab *lab, GError **error)
{
  lab->display = create_display (lab->platform_name);
  if (!wpe_display_connect (lab->display, error))
    return FALSE;
  wpe_display_set_primary (lab->display);
  /* As tilecast-renderer-wpe: no-preference, so scenes animate. */
  gboolean reduced_motion = tc_reduced_motion_for_no_preference (
    webkit_get_major_version (), webkit_get_minor_version (), webkit_get_micro_version ());
  g_autoptr (GError) settings_error = NULL;
  if (!wpe_settings_set_boolean (wpe_display_get_settings (lab->display), WPE_SETTING_REDUCED_MOTION, reduced_motion,
                                 WPE_SETTINGS_SOURCE_APPLICATION, &settings_error))
    g_warning ("lab: cannot set the motion preference: %s", settings_error->message);

  lab->context = webkit_web_context_new ();
  lab->session = webkit_network_session_new_ephemeral ();
  webkit_web_context_register_uri_scheme (lab->context, "tclab", handle_scene_request, lab, NULL);
  WebKitSecurityManager *security = webkit_web_context_get_security_manager (lab->context);
  webkit_security_manager_register_uri_scheme_as_secure (security, "tclab");
  webkit_security_manager_register_uri_scheme_as_cors_enabled (security, "tclab");

  WebKitSettings *settings = webkit_settings_new ();
  webkit_settings_set_enable_developer_extras (settings, lab->inspector != NULL);
  webkit_settings_set_enable_media_stream (settings, FALSE);
  webkit_settings_set_media_playback_requires_user_gesture (settings, FALSE);
  webkit_settings_set_enable_write_console_messages_to_stdout (settings, TRUE);
  webkit_settings_set_javascript_can_open_windows_automatically (settings, FALSE);

  WebKitUserContentManager *manager = webkit_user_content_manager_new ();
  g_signal_connect (manager, "script-message-received::tclab", G_CALLBACK (on_lab_message), lab);
  webkit_user_content_manager_register_script_message_handler (manager, "tclab", NULL);

  lab->view = g_object_new (WEBKIT_TYPE_WEB_VIEW, "display", lab->display, "web-context", lab->context,
                            "network-session", lab->session, "settings", settings, "user-content-manager", manager,
                            NULL);
  g_object_unref (settings);
  g_object_unref (manager);
  g_object_ref_sink (lab->view);
  WebKitColor black = { 0, 0, 0, 1 };
  webkit_web_view_set_background_color (lab->view, &black);
  g_signal_connect (lab->view, "web-process-terminated", G_CALLBACK (on_web_process_terminated), lab);

  lab->wpe_view = webkit_web_view_get_wpe_view (lab->view);
  g_signal_connect (lab->wpe_view, "buffer-rendered", G_CALLBACK (on_buffer_rendered), lab);
  g_signal_connect (lab->wpe_view, "buffer-released", G_CALLBACK (on_buffer_released), lab);
  g_signal_connect (lab->wpe_view, "buffers-changed", G_CALLBACK (on_buffers_changed), lab);
  WPEToplevel *toplevel = wpe_view_get_toplevel (lab->wpe_view);
  if (toplevel == NULL) {
    toplevel = wpe_display_create_toplevel (lab->display, 1);
    wpe_view_set_toplevel (lab->wpe_view, toplevel);
    g_object_unref (toplevel);
  }
  if (g_strcmp0 (lab->platform_name, "drm") == 0)
    wpe_toplevel_fullscreen (toplevel);
  else
    wpe_toplevel_resize (toplevel, lab->width, lab->height);
  wpe_toplevel_set_title (toplevel, "Tilecast compositor lab");
  return TRUE;
}

static void
write_header (Lab *lab)
{
  g_autoptr (JsonBuilder) b = json_builder_new ();
  json_builder_begin_object (b);
  add_string (b, "type", "header");
  add_string (b, "schema", LAB_SCHEMA);
  add_string (b, "traceSchema", TC_TRACE_SCHEMA);
  add_string (b, "source", "tilecast-wpe-compositor-lab");
  add_string (b, "clock", "CLOCK_MONOTONIC microseconds; scene t is performance.now() ms");
  add_int (b, "startMono", lab->started_us);
  add_string (b, "scene", lab->scene);
  add_string (b, "variant", lab->variant);
  add_int (b, "iterations", lab->iterations);
  add_string (b, "platform", lab->platform_name);
  g_autofree char *webkit = g_strdup_printf ("%u.%u.%u", webkit_get_major_version (), webkit_get_minor_version (),
                                             webkit_get_micro_version ());
  add_string (b, "webkit", webkit);
  json_builder_set_member_name (b, "env");
  tc_trace_env_to_json (b);
  json_builder_end_object (b);
  tc_trace_writer_builder (lab->timeline, b);
}

int
main (int argc, char **argv)
{
  enforce_webkit_sandbox ();
  Lab lab = { 0 };
  g_autofree char *size = NULL;
  g_autofree char *inspect = NULL;
  g_autofree char *grid = NULL;
  lab.iterations = 20;
  lab.max_dumps = 6;
  lab.dump_scale = 4;
  lab.dump_context = 2;
  lab.timeout_seconds = 900;
  GOptionEntry entries[] = {
    { "platform", 0, 0, G_OPTION_ARG_STRING, &lab.platform_name, "drm, wayland or headless (default headless)", "NAME" },
    { "scene", 0, 0, G_OPTION_ARG_STRING, &lab.scene, "Scene name (see --help-scenes in the docs)", "NAME" },
    { "variant", 0, 0, G_OPTION_ARG_STRING, &lab.variant, "Scene variant", "NAME" },
    { "iterations", 0, 0, G_OPTION_ARG_INT, &lab.iterations, "Repetitions of the scene (1-10000, default 20)", "N" },
    { "size", 0, 0, G_OPTION_ARG_STRING, &size, "View size on wayland and headless (default 1920x1080)", "WxH" },
    { "out", 0, 0, G_OPTION_ARG_FILENAME, &lab.out_dir, "Output directory", "DIR" },
    { "scenes-dir", 0, 0, G_OPTION_ARG_FILENAME, &lab.scenes_dir, "Scene files", "DIR" },
    { "inspect", 0, 0, G_OPTION_ARG_STRING, &inspect, "off, transitions (default) or all", "MODE" },
    { "grid", 0, 0, G_OPTION_ARG_STRING, &grid, "Sample grid inside the scene's probe (default 8x5)", "CxR" },
    { "dump-anomalies", 0, 0, G_OPTION_ARG_INT, &lab.max_dumps, "Anomalies to dump as PPM (0-64, default 6)", "N" },
    { "dump-scale", 0, 0, G_OPTION_ARG_INT, &lab.dump_scale, "Downscale of dumped frames (1-16, default 4)", "N" },
    { "dump-context", 0, 0, G_OPTION_ARG_INT, &lab.dump_context, "Frames before and after each dump (0-8, default 2)",
      "N" },
    { "timeout", 0, 0, G_OPTION_ARG_INT, &lab.timeout_seconds, "Give up after N seconds (default 900)", "N" },
    { "inspector", 0, 0, G_OPTION_ARG_STRING, &lab.inspector,
      "Development only: serve Web Inspector on a loopback address (127.0.0.1:PORT)", "ADDR" },
    { NULL },
  };
  g_autoptr (GOptionContext) options = g_option_context_new ("- Tilecast WPE compositor lab (development only)");
  g_option_context_add_main_entries (options, entries, NULL);
  g_autoptr (GError) error = NULL;
  if (!g_option_context_parse (options, &argc, &argv, &error)) {
    g_printerr ("tilecast-wpe-compositor-lab: %s\n", error->message);
    return 4;
  }
  if (lab.platform_name == NULL)
    lab.platform_name = g_strdup ("headless");
  if (g_strcmp0 (lab.platform_name, "drm") != 0 && g_strcmp0 (lab.platform_name, "wayland") != 0
      && g_strcmp0 (lab.platform_name, "headless") != 0) {
    g_printerr ("tilecast-wpe-compositor-lab: --platform must be drm, wayland or headless\n");
    return 4;
  }
  if (!known_scene (lab.scene)) {
    g_printerr ("tilecast-wpe-compositor-lab: --scene must be one of:");
    for (guint i = 0; SCENES[i] != NULL; i++)
      g_printerr (" %s", SCENES[i]);
    g_printerr ("\n");
    return 4;
  }
  if (lab.variant != NULL && !tc_trace_token_valid (lab.variant, 48)) {
    g_printerr ("tilecast-wpe-compositor-lab: --variant must be a short name\n");
    return 4;
  }
  lab.width = 1920;
  lab.height = 1080;
  if (size != NULL && (sscanf (size, "%dx%d", &lab.width, &lab.height) != 2 || lab.width < 64 || lab.height < 64
                       || lab.width > 7680 || lab.height > 4320)) {
    g_printerr ("tilecast-wpe-compositor-lab: --size must be WxH between 64x64 and 7680x4320\n");
    return 4;
  }
  lab.columns = 8;
  lab.rows = 5;
  if (grid != NULL && (sscanf (grid, "%ux%u", &lab.columns, &lab.rows) != 2 || lab.columns == 0 || lab.rows == 0
                       || lab.columns * lab.rows > TC_LAB_MAX_POINTS)) {
    g_printerr ("tilecast-wpe-compositor-lab: --grid must be CxR with at most %d points\n", TC_LAB_MAX_POINTS);
    return 4;
  }
  lab.inspect = inspect == NULL || g_strcmp0 (inspect, "transitions") == 0 ? INSPECT_TRANSITIONS
                : g_strcmp0 (inspect, "all") == 0                         ? INSPECT_ALL
                : g_strcmp0 (inspect, "off") == 0                         ? INSPECT_OFF
                                                                          : (InspectMode) -1;
  if ((int) lab.inspect < 0 || lab.iterations < 1 || lab.iterations > 10000 || lab.max_dumps < 0
      || lab.max_dumps > LAB_MAX_DUMPS || lab.dump_scale < 1 || lab.dump_scale > 16 || lab.dump_context < 0
      || lab.dump_context > LAB_MAX_CONTEXT || lab.timeout_seconds < 10 || lab.timeout_seconds > 86400) {
    g_printerr ("tilecast-wpe-compositor-lab: an option is out of range (see --help)\n");
    return 4;
  }
  if (lab.out_dir == NULL || !tc_is_clean_absolute_path (lab.out_dir)) {
    g_printerr ("tilecast-wpe-compositor-lab: --out must be a clean absolute path\n");
    return 4;
  }
  if (lab.scenes_dir == NULL) {
    g_autofree char *exe = g_file_read_link ("/proc/self/exe", NULL);
    g_autofree char *dir = exe ? g_path_get_dirname (exe) : NULL;
    g_autofree char *beside = dir ? g_build_filename (dir, "..", "share", "tilecast-wpe-lab", "scenes", NULL) : NULL;
    g_autofree char *canonical = beside ? g_canonicalize_filename (beside, NULL) : NULL;
    lab.scenes_dir = g_strdup (canonical && g_file_test (canonical, G_FILE_TEST_IS_DIR) ? canonical : TC_LAB_SCENES_DIR);
  }
  if (!tc_is_clean_absolute_path (lab.scenes_dir) || !g_file_test (lab.scenes_dir, G_FILE_TEST_IS_DIR)) {
    g_printerr ("tilecast-wpe-compositor-lab: scene directory not found; pass --scenes-dir\n");
    return 4;
  }
  if (lab.inspector != NULL) {
    if (!inspector_address_valid (lab.inspector)) {
      g_printerr ("tilecast-wpe-compositor-lab: --inspector takes 127.0.0.1:PORT or [::1]:PORT (1024-65535)\n");
      return 4;
    }
    g_setenv ("WEBKIT_INSPECTOR_HTTP_SERVER", lab.inspector, TRUE);
    g_printerr ("tilecast-wpe-compositor-lab: Web Inspector on http://%s (loopback only; development use)\n",
                lab.inspector);
  }
  if (g_mkdir_with_parents (lab.out_dir, 0755) != 0) {
    g_printerr ("tilecast-wpe-compositor-lab: cannot create %s: %s\n", lab.out_dir, g_strerror (errno));
    return 4;
  }

  lab.started_us = g_get_monotonic_time ();
  lab.timeline = tc_trace_writer_open (lab.out_dir, "timeline.jsonl", LAB_TIMELINE_BYTES, &error);
  if (lab.timeline == NULL) {
    g_printerr ("tilecast-wpe-compositor-lab: %s\n", error->message);
    return 4;
  }
  lab.buffers = tc_buffer_timeline_new ();
  lab.detector = tc_lab_detector_new (lab.columns, lab.rows);
  lab.probe = (TcLabProbe) { 0, 0, 1, 1 };
  lab.line = g_string_sized_new (512);
  lab.fourccs = g_hash_table_new_full (g_str_hash, g_str_equal, g_free, NULL);
  lab.kinds = g_hash_table_new_full (g_str_hash, g_str_equal, g_free, NULL);
  lab.anomaly_kinds = g_hash_table_new_full (g_str_hash, g_str_equal, g_free, NULL);
  lab.anomaly_list = g_ptr_array_new_with_free_func ((GDestroyNotify) json_node_unref);
  lab.presented_us = g_new (gint64, TC_TRACE_MAX_PACING_SAMPLES);
  lab.transition_intervals = g_new (double, TC_TRACE_MAX_PACING_SAMPLES);
  lab.import_us = g_new (double, TC_TRACE_MAX_PACING_SAMPLES);
  lab.cancellable = g_cancellable_new ();
  lab.loop = g_main_loop_new (NULL, FALSE);
  write_header (&lab);

  if (!create_view (&lab, &error)) {
    g_printerr ("tilecast-wpe-compositor-lab: cannot open the %s display: %s\n", lab.platform_name, error->message);
    finish (&lab, "display_unavailable", 4);
    return lab.exit_code;
  }
  g_autofree char *uri = g_strdup_printf ("tclab://scene/%s.html?iterations=%d%s%s", lab.scene, lab.iterations,
                                          lab.variant ? "&variant=" : "", lab.variant ? lab.variant : "");
  webkit_web_view_load_uri (lab.view, uri);
  g_timeout_add (LAB_CLOCK_INTERVAL_MS, on_clock_tick, &lab);
  g_timeout_add_seconds ((guint) lab.timeout_seconds, on_timeout, &lab);
  g_unix_signal_add (SIGINT, on_signal, &lab);
  g_unix_signal_add (SIGTERM, on_signal, &lab);
  g_main_loop_run (lab.loop);

  for (int i = 0; i < LAB_MAX_CONTEXT; i++)
    context_free (&lab.ring[i]);
  g_clear_object (&lab.view);
  g_clear_object (&lab.session);
  g_clear_object (&lab.context);
  g_clear_object (&lab.display);
  tc_buffer_timeline_free (lab.buffers);
  tc_lab_detector_free (lab.detector);
  g_string_free (lab.line, TRUE);
  g_hash_table_unref (lab.fourccs);
  g_hash_table_unref (lab.kinds);
  g_hash_table_unref (lab.anomaly_kinds);
  g_ptr_array_unref (lab.anomaly_list);
  g_free (lab.presented_us);
  g_free (lab.transition_intervals);
  g_free (lab.import_us);
  g_object_unref (lab.cancellable);
  g_main_loop_unref (lab.loop);
  return lab.exit_code;
}
