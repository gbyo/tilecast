#include "visual-trace.h"

#include "buffer-timeline.h"
#include "host.h"
#include "visual-trace-format.h"

#include <string.h>

/* Clock samples: one now and then once a second. Each is one short
 * JavaScript call in the page world, only while the trace runs. */
#define CLOCK_SAMPLE_INTERVAL_MS 1000

struct _TcVisualTrace {
  TcHost *host;
  WPEView *view; /* weak */
  gulong rendered_handler;
  gulong released_handler;
  gulong buffers_handler;
  TcTraceWriter *writer;
  TcBufferTimeline *timeline;
  GCancellable *cancellable;
  gint64 started_us;
  guint seconds;
  gboolean deep;
  gboolean finished;
  guint window_source;
  guint clock_source;
  gboolean clock_in_flight;
  guint64 rendered;
  guint64 released;
  guint64 runtime_batches;
  guint64 runtime_records;
  guint64 runtime_refused;
  guint64 clock_samples;
  gint64 *presented_us;
  gsize presented_count;
  GString *line;
};

static void
write_line (TcVisualTrace *trace)
{
  tc_trace_writer_line (trace->writer, trace->line->str);
  g_string_truncate (trace->line, 0);
}

static void
on_buffer_rendered (WPEView *view, WPEBuffer *buffer, gpointer user_data)
{
  (void) view;
  TcVisualTrace *trace = user_data;
  gint64 now = g_get_monotonic_time ();
  trace->rendered++;
  if (trace->presented_count < TC_TRACE_MAX_PACING_SAMPLES)
    trace->presented_us[trace->presented_count++] = now;
  tc_buffer_timeline_rendered (trace->timeline, buffer, now, trace->line);
  write_line (trace);
}

static void
on_buffer_released (WPEView *view, WPEBuffer *buffer, gpointer user_data)
{
  (void) view;
  TcVisualTrace *trace = user_data;
  trace->released++;
  tc_buffer_timeline_released (trace->timeline, buffer, g_get_monotonic_time (), trace->line);
  write_line (trace);
}

static void
on_buffers_changed (WPEView *view, gpointer buffers, guint n_buffers, gpointer user_data)
{
  (void) view;
  TcVisualTrace *trace = user_data;
  tc_buffer_timeline_pool (trace->timeline, buffers, n_buffers, g_get_monotonic_time (), trace->line);
  write_line (trace);
}

typedef struct {
  TcVisualTrace *trace;
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
    TcVisualTrace *trace = probe->trace;
    trace->clock_in_flight = FALSE;
    if (value != NULL && jsc_value_is_number (value)) {
      trace->clock_samples++;
      g_string_append_printf (trace->line,
                              "{\"type\":\"clock\",\"t0\":%" G_GINT64_FORMAT ",\"t1\":%" G_GINT64_FORMAT ",\"js\":%.3f}",
                              probe->t0, t1, jsc_value_to_double (value));
      write_line (trace);
    }
  }
  g_object_unref (probe->cancellable);
  g_free (probe);
}

static void
sample_clock (TcVisualTrace *trace)
{
  if (trace->finished || trace->clock_in_flight || trace->host->view == NULL)
    return;
  ClockProbe *probe = g_new0 (ClockProbe, 1);
  probe->trace = trace;
  probe->cancellable = g_object_ref (trace->cancellable);
  trace->clock_in_flight = TRUE;
  probe->t0 = g_get_monotonic_time ();
  webkit_web_view_call_async_javascript_function (trace->host->view, "return performance.now();", -1, NULL, NULL,
                                                  NULL, trace->cancellable, clock_done, probe);
}

static gboolean
on_clock_tick (gpointer user_data)
{
  TcVisualTrace *trace = user_data;
  sample_clock (trace);
  tc_trace_writer_flush (trace->writer);
  return G_SOURCE_CONTINUE;
}

static void
disconnect_view (TcVisualTrace *trace)
{
  if (trace->view == NULL)
    return;
  g_signal_handler_disconnect (trace->view, trace->rendered_handler);
  g_signal_handler_disconnect (trace->view, trace->released_handler);
  g_signal_handler_disconnect (trace->view, trace->buffers_handler);
  g_object_remove_weak_pointer (G_OBJECT (trace->view), (gpointer *) &trace->view);
  trace->view = NULL;
}

static void
finish (TcVisualTrace *trace, const char *ended_by)
{
  if (trace->finished)
    return;
  trace->finished = TRUE;
  g_cancellable_cancel (trace->cancellable);
  g_clear_handle_id (&trace->window_source, g_source_remove);
  g_clear_handle_id (&trace->clock_source, g_source_remove);
  disconnect_view (trace);

  TcPacing pacing;
  tc_pacing_compute (trace->presented_us, trace->presented_count, 0, &pacing);
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "type");
  json_builder_add_string_value (builder, "summary");
  json_builder_set_member_name (builder, "schema");
  json_builder_add_string_value (builder, TC_TRACE_SCHEMA);
  json_builder_set_member_name (builder, "endedBy");
  json_builder_add_string_value (builder, ended_by);
  json_builder_set_member_name (builder, "durationMs");
  json_builder_add_int_value (builder, (g_get_monotonic_time () - trace->started_us) / 1000);
  json_builder_set_member_name (builder, "framesRendered");
  json_builder_add_int_value (builder, (gint64) trace->rendered);
  json_builder_set_member_name (builder, "framesReleased");
  json_builder_add_int_value (builder, (gint64) trace->released);
  json_builder_set_member_name (builder, "distinctBuffers");
  json_builder_add_int_value (builder, tc_buffer_timeline_distinct_buffers (trace->timeline));
  json_builder_set_member_name (builder, "distinctMemory");
  json_builder_add_int_value (builder, tc_buffer_timeline_distinct_memory (trace->timeline));
  json_builder_set_member_name (builder, "runtimeBatches");
  json_builder_add_int_value (builder, (gint64) trace->runtime_batches);
  json_builder_set_member_name (builder, "runtimeRecords");
  json_builder_add_int_value (builder, (gint64) trace->runtime_records);
  json_builder_set_member_name (builder, "runtimeRefused");
  json_builder_add_int_value (builder, (gint64) trace->runtime_refused);
  json_builder_set_member_name (builder, "clockSamples");
  json_builder_add_int_value (builder, (gint64) trace->clock_samples);
  json_builder_set_member_name (builder, "lines");
  json_builder_add_int_value (builder, (gint64) tc_trace_writer_lines (trace->writer));
  json_builder_set_member_name (builder, "droppedLines");
  json_builder_add_int_value (builder, (gint64) tc_trace_writer_dropped (trace->writer));
  json_builder_set_member_name (builder, "pacing");
  tc_pacing_to_json (&pacing, builder);
  json_builder_end_object (builder);
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  g_autofree char *summary = json_to_string (root, FALSE);
  g_message ("visual-trace: finished (%s): %" G_GUINT64_FORMAT " frames, %" G_GUINT64_FORMAT
             " runtime records, %" G_GUINT64_FORMAT " lines dropped; %s",
             ended_by, trace->rendered, trace->runtime_records, tc_trace_writer_dropped (trace->writer),
             tc_trace_writer_path (trace->writer));
  tc_trace_writer_close (trace->writer, summary);
  trace->writer = NULL;
}

static gboolean
on_window_end (gpointer user_data)
{
  TcVisualTrace *trace = user_data;
  trace->window_source = 0;
  finish (trace, "window");
  return G_SOURCE_REMOVE;
}

static void
write_header (TcVisualTrace *trace, WPEView *view)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "type");
  json_builder_add_string_value (builder, "header");
  json_builder_set_member_name (builder, "schema");
  json_builder_add_string_value (builder, TC_TRACE_SCHEMA);
  json_builder_set_member_name (builder, "source");
  json_builder_add_string_value (builder, "tilecast-renderer-wpe");
  json_builder_set_member_name (builder, "rendererVersion");
  json_builder_add_string_value (builder, TC_RENDERER_VERSION);
  json_builder_set_member_name (builder, "clock");
  json_builder_add_string_value (builder, "CLOCK_MONOTONIC microseconds; runtime t is performance.now() ms");
  json_builder_set_member_name (builder, "startMono");
  json_builder_add_int_value (builder, trace->started_us);
  g_autofree char *webkit = g_strdup_printf ("%u.%u.%u", webkit_get_major_version (), webkit_get_minor_version (),
                                             webkit_get_micro_version ());
  json_builder_set_member_name (builder, "webkit");
  json_builder_add_string_value (builder, webkit);
  json_builder_set_member_name (builder, "platform");
  json_builder_add_string_value (builder, trace->host->platform == TC_PLATFORM_DRM       ? "drm"
                                          : trace->host->platform == TC_PLATFORM_WAYLAND ? "wayland"
                                                                                          : "headless");
  json_builder_set_member_name (builder, "deep");
  json_builder_add_boolean_value (builder, trace->deep);
  json_builder_set_member_name (builder, "windowSeconds");
  json_builder_add_int_value (builder, trace->seconds);
  json_builder_set_member_name (builder, "env");
  tc_trace_env_to_json (builder);
  WPEScreen *screen = wpe_view_get_screen (view);
  json_builder_set_member_name (builder, "screen");
  if (screen != NULL) {
    json_builder_begin_object (builder);
    json_builder_set_member_name (builder, "width");
    json_builder_add_int_value (builder, wpe_screen_get_width (screen));
    json_builder_set_member_name (builder, "height");
    json_builder_add_int_value (builder, wpe_screen_get_height (screen));
    json_builder_set_member_name (builder, "scale");
    json_builder_add_double_value (builder, wpe_screen_get_scale (screen));
    json_builder_set_member_name (builder, "refreshMilliHz");
    json_builder_add_int_value (builder, wpe_screen_get_refresh_rate (screen));
    json_builder_end_object (builder);
  } else {
    json_builder_add_null_value (builder);
  }
  json_builder_end_object (builder);
  tc_trace_writer_builder (trace->writer, builder);
}

TcVisualTrace *
tc_visual_trace_start (TcHost *host, WPEView *view, const char *dir, guint seconds, gboolean deep)
{
  g_autoptr (GError) error = NULL;
  TcTraceWriter *writer = tc_trace_writer_open (dir, TC_VISUAL_TRACE_FILE, TC_TRACE_MAX_FILE_BYTES, &error);
  if (writer == NULL) {
    g_warning ("visual-trace: not started: %s", error->message);
    return NULL;
  }
  TcVisualTrace *trace = g_new0 (TcVisualTrace, 1);
  trace->host = host;
  trace->writer = writer;
  trace->timeline = tc_buffer_timeline_new ();
  trace->cancellable = g_cancellable_new ();
  trace->started_us = g_get_monotonic_time ();
  trace->seconds = seconds;
  trace->deep = deep;
  trace->presented_us = g_new (gint64, TC_TRACE_MAX_PACING_SAMPLES);
  trace->line = g_string_sized_new (512);
  trace->view = view;
  g_object_add_weak_pointer (G_OBJECT (view), (gpointer *) &trace->view);
  write_header (trace, view);
  trace->rendered_handler = g_signal_connect (view, "buffer-rendered", G_CALLBACK (on_buffer_rendered), trace);
  trace->released_handler = g_signal_connect (view, "buffer-released", G_CALLBACK (on_buffer_released), trace);
  trace->buffers_handler = g_signal_connect (view, "buffers-changed", G_CALLBACK (on_buffers_changed), trace);
  trace->window_source = g_timeout_add_seconds (seconds, on_window_end, trace);
  trace->clock_source = g_timeout_add (CLOCK_SAMPLE_INTERVAL_MS, on_clock_tick, trace);
  g_message ("visual-trace: recording %s%u s to %s", deep ? "a deep trace for " : "", seconds,
             tc_trace_writer_path (writer));
  return trace;
}

void
tc_visual_trace_page_message (TcVisualTrace *trace, JsonObject *message)
{
  if (trace == NULL || trace->finished)
    return;
  guint refused = 0;
  guint written = tc_trace_write_page_batch (trace->writer, message, g_get_monotonic_time (), &refused);
  trace->runtime_batches++;
  trace->runtime_records += written;
  trace->runtime_refused += refused;
}

void
tc_visual_trace_document_ready (TcVisualTrace *trace)
{
  if (trace != NULL)
    sample_clock (trace);
}

void
tc_visual_trace_stop (TcVisualTrace *trace)
{
  if (trace == NULL)
    return;
  finish (trace, "shutdown");
  tc_buffer_timeline_free (trace->timeline);
  g_object_unref (trace->cancellable);
  g_free (trace->presented_us);
  g_string_free (trace->line, TRUE);
  g_free (trace);
}
