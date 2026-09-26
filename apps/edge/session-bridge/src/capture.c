/*
 * Noise Meter capture: `pipewiresrc ! audioconvert ! level ! fakesink`.
 *
 * GStreamer's `level` element measures; this file only converts its
 * per-channel `rms` (dB) into one linear value and sends it. Samples stay
 * in the pipeline and end in fakesink. The pipeline exists only while
 * tilecastd asks for capture; asking to stop sets it to NULL, which closes
 * the PipeWire stream and releases the microphone.
 *
 * A failed pipeline is retried every TB_RETRY_MS while capture is wanted.
 * A pipeline that plays but produces no level message within
 * TB_SILENCE_TIMEOUT_US (no source linked, a stalled device) counts as a
 * failure too.
 *
 * pipewiresrc can block in a state change (for example while it waits for a
 * source that does not exist), so every state change runs on a worker
 * thread and the main loop, which also serves tilecastd, never waits for
 * PipeWire. At most one such worker runs at a time; a new pipeline waits
 * until the previous one is gone.
 */
#include "bridge.h"

#include <string.h>

#define TB_LEVEL_INTERVAL_NS (60 * GST_MSECOND)
#define TB_RETRY_MS 5000
#define TB_SILENCE_TIMEOUT_US (4 * G_USEC_PER_SEC)

static void start_pipeline (TbBridge *bridge);

static void
set_state (TbBridge *bridge, TbCaptureState state)
{
  if (bridge->capture_state == state)
    return;
  g_message ("capture: %s -> %s", tb_capture_state_name (bridge->capture_state), tb_capture_state_name (state));
  bridge->capture_state = state;
  tb_capture_send_state (bridge);
}

void
tb_capture_send_state (TbBridge *bridge)
{
  /* A reading only travels with a level message; a state change carries none. */
  if (bridge->capture_state != TB_CAPTURE_CAPTURING)
    tb_ipc_send_event (bridge, "audio.level", tb_level_data (bridge->capture_state, 0.0));
}

static void
release_in_thread (GTask *task, gpointer source_object, gpointer task_data, GCancellable *cancellable)
{
  GstElement *pipeline = task_data;
  gst_element_set_state (pipeline, GST_STATE_NULL);
  g_task_return_boolean (task, TRUE);
}

static void
on_released (GObject *source, GAsyncResult *result, gpointer data)
{
  TbBridge *bridge = data;
  bridge->capture_workers--;
}

static void
teardown (TbBridge *bridge)
{
  if (bridge->capture_watchdog_source != 0) {
    g_source_remove (bridge->capture_watchdog_source);
    bridge->capture_watchdog_source = 0;
  }
  if (bridge->pipeline != NULL) {
    GstBus *bus = gst_element_get_bus (bridge->pipeline);
    gst_bus_remove_watch (bus);
    gst_object_unref (bus);
    /* Stopping closes the PipeWire stream; the worker owns the pipeline. */
    GstElement *pipeline = g_steal_pointer (&bridge->pipeline);
    bridge->capture_workers++;
    g_autoptr (GTask) task = g_task_new (NULL, NULL, on_released, bridge);
    g_task_set_task_data (task, pipeline, gst_object_unref);
    g_task_run_in_thread (task, release_in_thread);
  }
}

static void
play_in_thread (GTask *task, gpointer source_object, gpointer task_data, GCancellable *cancellable)
{
  GstStateChangeReturn result = gst_element_set_state (GST_ELEMENT (task_data), GST_STATE_PLAYING);
  g_task_return_int (task, result);
}

static void failed (TbBridge *bridge, TbCaptureState reason);

static void
on_played (GObject *source, GAsyncResult *result, gpointer data)
{
  TbBridge *bridge = data;
  bridge->capture_workers--;
  GstElement *pipeline = g_task_get_task_data (G_TASK (result));
  gssize state = g_task_propagate_int (G_TASK (result), NULL);
  /* Only the current pipeline; a replaced one is already being released. */
  if (pipeline == bridge->pipeline && state == GST_STATE_CHANGE_FAILURE)
    failed (bridge, TB_CAPTURE_FAILED);
}

static void
retry_now (gpointer data)
{
  TbBridge *bridge = data;
  bridge->capture_retry_source = 0;
  if (bridge->capture_wanted && bridge->pipeline == NULL)
    start_pipeline (bridge);
}

/* Records why capture stopped and tries again later while it is wanted. */
static void
failed (TbBridge *bridge, TbCaptureState reason)
{
  teardown (bridge);
  set_state (bridge, reason);
  if (bridge->capture_wanted && bridge->capture_retry_source == 0) {
    bridge->capture_retry_source = g_timeout_add_once (TB_RETRY_MS, retry_now, bridge);
    if (reason == TB_CAPTURE_FAILED)
      set_state (bridge, TB_CAPTURE_RECOVERING);
  }
}

static TbCaptureState
classify_error (const GError *error)
{
  if (error->domain == GST_RESOURCE_ERROR) {
    switch (error->code) {
    case GST_RESOURCE_ERROR_NOT_AUTHORIZED:
      return TB_CAPTURE_PERMISSION_DENIED;
    case GST_RESOURCE_ERROR_NOT_FOUND:
      return TB_CAPTURE_NO_MICROPHONE;
    default:
      break;
    }
  }
  /* pipewiresrc reports a session it cannot reach as a failed open. */
  if (error->message != NULL && strstr (error->message, "connect") != NULL)
    return TB_CAPTURE_PIPEWIRE_UNAVAILABLE;
  return TB_CAPTURE_FAILED;
}

static void
on_level (TbBridge *bridge, const GstStructure *structure)
{
  const GValue *value = gst_structure_get_value (structure, "rms");
  if (value == NULL)
    return;
  double decibels[8];
  guint channels = 0;
  G_GNUC_BEGIN_IGNORE_DEPRECATIONS
  if (G_VALUE_HOLDS (value, G_TYPE_VALUE_ARRAY)) {
    GValueArray *array = g_value_get_boxed (value);
    for (guint i = 0; array != NULL && i < array->n_values && channels < G_N_ELEMENTS (decibels); i++)
      decibels[channels++] = g_value_get_double (g_value_array_get_nth (array, i));
  }
  G_GNUC_END_IGNORE_DEPRECATIONS
  double rms = 0.0;
  if (!tb_rms_from_decibels (decibels, channels, &rms))
    return;
  bridge->last_level_at = g_get_monotonic_time ();
  set_state (bridge, TB_CAPTURE_CAPTURING);
  tb_ipc_send_event (bridge, "audio.level", tb_level_data (TB_CAPTURE_CAPTURING, rms));
}

static gboolean
on_bus (GstBus *bus, GstMessage *message, gpointer data)
{
  (void) bus;
  TbBridge *bridge = data;
  switch (GST_MESSAGE_TYPE (message)) {
  case GST_MESSAGE_ELEMENT: {
    const GstStructure *structure = gst_message_get_structure (message);
    if (structure != NULL && gst_structure_has_name (structure, "level"))
      on_level (bridge, structure);
    break;
  }
  case GST_MESSAGE_ERROR: {
    g_autoptr (GError) error = NULL;
    gst_message_parse_error (message, &error, NULL);
    g_warning ("capture: %s", error->message);
    failed (bridge, classify_error (error));
    return G_SOURCE_REMOVE;
  }
  case GST_MESSAGE_EOS:
    failed (bridge, TB_CAPTURE_FAILED);
    return G_SOURCE_REMOVE;
  default:
    break;
  }
  return G_SOURCE_CONTINUE;
}

static gboolean
watchdog (gpointer data)
{
  TbBridge *bridge = data;
  if (g_get_monotonic_time () - bridge->last_level_at < TB_SILENCE_TIMEOUT_US)
    return G_SOURCE_CONTINUE;
  bridge->capture_watchdog_source = 0;
  g_warning ("capture: no level measurement for %d s", (int) (TB_SILENCE_TIMEOUT_US / G_USEC_PER_SEC));
  /* With no source to link to, PipeWire leaves the stream waiting. */
  failed (bridge, bridge->inventory.pipewire && bridge->inventory.sources == 0 ? TB_CAPTURE_NO_MICROPHONE
                                                                                : TB_CAPTURE_FAILED);
  return G_SOURCE_REMOVE;
}

static void
start_pipeline (TbBridge *bridge)
{
  GstElementFactory *source_factory = gst_element_factory_find ("pipewiresrc");
  if (source_factory == NULL) {
    failed (bridge, TB_CAPTURE_PIPEWIRE_UNAVAILABLE);
    return;
  }
  gst_object_unref (source_factory);
  if (!bridge->inventory.pipewire) {
    /* WirePlumber could not reach the session's PipeWire. */
    failed (bridge, TB_CAPTURE_PIPEWIRE_UNAVAILABLE);
    return;
  }
  if (bridge->inventory.sources == 0) {
    /* No Audio/Source node: a stream would only wait for one. */
    failed (bridge, TB_CAPTURE_NO_MICROPHONE);
    return;
  }
  if (bridge->capture_workers > 0) {
    /* The previous pipeline is still starting or stopping. */
    failed (bridge, TB_CAPTURE_STARTING);
    return;
  }
  set_state (bridge, TB_CAPTURE_STARTING);
  GstElement *pipeline = gst_pipeline_new ("noise-meter");
  GstElement *source = gst_element_factory_make ("pipewiresrc", "source");
  GstElement *convert = gst_element_factory_make ("audioconvert", "convert");
  GstElement *level = gst_element_factory_make ("level", "level");
  GstElement *sink = gst_element_factory_make ("fakesink", "sink");
  if (source == NULL || convert == NULL || level == NULL || sink == NULL) {
    g_clear_object (&source);
    g_clear_object (&convert);
    g_clear_object (&level);
    g_clear_object (&sink);
    gst_object_unref (pipeline);
    failed (bridge, TB_CAPTURE_PIPEWIRE_UNAVAILABLE);
    return;
  }
  g_object_set (source, "client-name", "tilecast-session-bridge", NULL);
  g_object_set (level, "interval", (guint64) TB_LEVEL_INTERVAL_NS, "post-messages", TRUE, NULL);
  g_object_set (sink, "sync", FALSE, "async", FALSE, NULL);
  gst_bin_add_many (GST_BIN (pipeline), source, convert, level, sink, NULL);
  if (!gst_element_link_many (source, convert, level, sink, NULL)) {
    gst_object_unref (pipeline);
    failed (bridge, TB_CAPTURE_FAILED);
    return;
  }
  bridge->pipeline = pipeline;
  GstBus *bus = gst_element_get_bus (pipeline);
  gst_bus_add_watch (bus, on_bus, bridge);
  gst_object_unref (bus);
  bridge->capture_workers++;
  g_autoptr (GTask) task = g_task_new (NULL, NULL, on_played, bridge);
  g_task_set_task_data (task, gst_object_ref (pipeline), gst_object_unref);
  g_task_run_in_thread (task, play_in_thread);
  bridge->last_level_at = g_get_monotonic_time ();
  bridge->capture_watchdog_source = g_timeout_add_seconds (1, watchdog, bridge);
}

void
tb_capture_set_wanted (TbBridge *bridge, gboolean wanted)
{
  if (bridge->capture_wanted == wanted)
    return;
  bridge->capture_wanted = wanted;
  if (wanted)
    start_pipeline (bridge);
  else
    tb_capture_stop (bridge);
}

void
tb_capture_stop (TbBridge *bridge)
{
  bridge->capture_wanted = FALSE;
  if (bridge->capture_retry_source != 0) {
    g_source_remove (bridge->capture_retry_source);
    bridge->capture_retry_source = 0;
  }
  teardown (bridge);
  set_state (bridge, TB_CAPTURE_IDLE);
}
