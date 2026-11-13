#include "present-relay.h"

#include "media-client.h"
#include "validate.h"

#include <gio/gio.h>
#include <glib/gstdio.h>
#include <gst/gst.h>
#include <string.h>

#define RECHECK_SECONDS 1
/* Grant checks in a row that get no answer from tilecastd before the relay
 * stops. An explicit denial stops it at once; a timeout or a reset does not
 * say that the grant ended. */
#define MAX_CHECK_ERRORS 5
#define START_TIMEOUT (2 * GST_SECOND)
#define VIDEO_CAPS \
  "application/x-rtp,media=(string)video,clock-rate=(int)90000,encoding-name=(string)H264,payload=(int)96"
#define AUDIO_CAPS                                                                                                    \
  "application/x-rtp,media=(string)audio,clock-rate=(int)44100,encoding-name=(string)L16,encoding-params=(string)2," \
  "channels=(int)2,payload=(int)96"

struct _TcPresentRelay {
  char *dir;
  char *media_socket;
  GCancellable *cancellable; /* cancelled when the relay is freed */
  char id[65];               /* the requested or running source ID; "" for none */
  guint64 generation;        /* bumps on every request */
  gboolean pending;
  TcPresentRelayReady ready;
  gpointer ready_data;
  GstElement *pipeline;
  gboolean audio;
  guint bus_watch;
  guint recheck_source;
  gboolean rechecking;
  gboolean was_running; /* a pipeline ran since the last time the relay settled */
  guint check_errors;   /* grant checks in a row without an answer */
  gboolean failed;      /* the relay for the current source did not start, or stopped for a fault */
  TcPresentRelayStopped stopped;
  gpointer stopped_data;
};

typedef enum { CHECK_START, CHECK_AGAIN } CheckPurpose;

/* What a grant check found out. Only GRANT_DENIED is an answer that the
 * grant is gone; GRANT_ERROR is a failure to ask. */
typedef enum { GRANT_OK, GRANT_DENIED, GRANT_ERROR } GrantAnswer;

typedef struct {
  TcPresentRelay *relay; /* valid only while the task's cancellable is not cancelled */
  CheckPurpose purpose;
  guint64 generation;
  char id[65];
  char *media_socket;
  gboolean audio;
  GrantAnswer answer;
} Check;

static void
check_free (Check *check)
{
  g_free (check->media_socket);
  g_free (check);
}

static char *
socket_path (TcPresentRelay *relay, const char *id, const char *stream)
{
  g_autofree char *name = g_strdup_printf ("%s-%s.sock", id, stream);
  return g_build_filename (relay->dir, name, NULL);
}

static void
remove_sockets (TcPresentRelay *relay, const char *id)
{
  g_autofree char *video = socket_path (relay, id, "video");
  g_autofree char *audio = socket_path (relay, id, "audio");
  g_unlink (video);
  g_unlink (audio);
}

static void
stop_pipeline (TcPresentRelay *relay, const char *reason)
{
  g_clear_handle_id (&relay->recheck_source, g_source_remove);
  g_clear_handle_id (&relay->bus_watch, g_source_remove);
  if (relay->pipeline != NULL) {
    gst_element_set_state (relay->pipeline, GST_STATE_NULL);
    g_clear_object (&relay->pipeline);
    if (reason != NULL)
      g_message ("present-relay: stopped (%s)", reason);
  }
  if (relay->id[0] != '\0')
    remove_sockets (relay, relay->id);
}

/* Tells the host once when a relay that ran is gone for good. A pipeline that
 * stops while a grant check for the next source waits is not that yet. */
static void
settle (TcPresentRelay *relay)
{
  if (!relay->was_running || relay->pipeline != NULL || relay->pending)
    return;
  relay->was_running = FALSE;
  if (relay->stopped != NULL)
    relay->stopped (relay->stopped_data);
}

static gboolean
add_stream (TcPresentRelay *relay, guint port, const char *caps_text, const char *stream)
{
  GstElement *udp = gst_element_factory_make ("udpsrc", NULL);
  GstElement *sink = gst_element_factory_make ("unixfdsink", NULL);
  if (udp == NULL || sink == NULL) {
    g_clear_object (&udp);
    g_clear_object (&sink);
    return FALSE;
  }
  g_autoptr (GstCaps) caps = gst_caps_from_string (caps_text);
  g_autofree char *path = socket_path (relay, relay->id, stream);
  g_unlink (path);
  /* No port sharing: if another socket holds the port, the relay fails
   * instead of splitting the stream with it. */
  g_object_set (udp, "address", "127.0.0.1", "port", (gint) port, "reuse", FALSE, "caps", caps, NULL);
  /* Forward each packet at once; the web process's jitter buffer times it. */
  g_object_set (sink, "socket-path", path, "sync", FALSE, "async", FALSE, NULL);
  gst_bin_add_many (GST_BIN (relay->pipeline), udp, sink, NULL);
  return gst_element_link (udp, sink);
}

static gboolean
on_bus (GstBus *bus, GstMessage *message, gpointer data)
{
  (void) bus;
  TcPresentRelay *relay = data;
  if (GST_MESSAGE_TYPE (message) == GST_MESSAGE_ERROR) {
    g_autoptr (GError) error = NULL;
    gst_message_parse_error (message, &error, NULL);
    g_warning ("present-relay: %s", error != NULL ? error->message : "pipeline error");
    relay->bus_watch = 0;
    relay->failed = TRUE;
    stop_pipeline (relay, "relay_failed");
    settle (relay);
    return G_SOURCE_REMOVE;
  }
  return G_SOURCE_CONTINUE;
}

static void check_grant (TcPresentRelay *relay, CheckPurpose purpose);

static gboolean
on_recheck (gpointer data)
{
  TcPresentRelay *relay = data;
  if (!relay->rechecking)
    check_grant (relay, CHECK_AGAIN);
  return G_SOURCE_CONTINUE;
}

static gboolean
start_pipeline (TcPresentRelay *relay, gboolean audio)
{
  relay->pipeline = gst_pipeline_new ("tcpresent-relay");
  relay->audio = audio;
  if (!add_stream (relay, TC_PRESENT_VIDEO_PORT, VIDEO_CAPS, "video")
      || (audio && !add_stream (relay, TC_PRESENT_AUDIO_PORT, AUDIO_CAPS, "audio"))) {
    g_warning ("present-relay: udpsrc or unixfdsink is unavailable");
    stop_pipeline (relay, NULL);
    return FALSE;
  }
  g_autoptr (GstBus) bus = gst_element_get_bus (relay->pipeline);
  relay->bus_watch = gst_bus_add_watch (bus, on_bus, relay);
  if (gst_element_set_state (relay->pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE
      || gst_element_get_state (relay->pipeline, NULL, NULL, START_TIMEOUT) == GST_STATE_CHANGE_FAILURE) {
    g_warning ("present-relay: cannot start; a forwarded port may be in use");
    stop_pipeline (relay, NULL);
    return FALSE;
  }
  g_autofree char *video = socket_path (relay, relay->id, "video");
  if (!g_file_test (video, G_FILE_TEST_EXISTS)) {
    g_warning ("present-relay: the relay socket was not created");
    stop_pipeline (relay, NULL);
    return FALSE;
  }
  relay->recheck_source = g_timeout_add_seconds (RECHECK_SECONDS, on_recheck, relay);
  relay->was_running = TRUE;
  relay->check_errors = 0;
  g_message ("present-relay: relaying (audio %s)", audio ? "on" : "off");
  return TRUE;
}

static void
check_in_thread (GTask *task, gpointer source, gpointer task_data, GCancellable *cancellable)
{
  (void) source;
  (void) cancellable;
  Check *check = task_data;
  g_autoptr (GError) error = NULL;
  if (tc_media_present (check->media_socket, check->id, &check->audio, &error))
    check->answer = GRANT_OK;
  else if (g_error_matches (error, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED))
    check->answer = GRANT_DENIED;
  else
    check->answer = GRANT_ERROR;
  g_task_return_boolean (task, TRUE);
}

static void
on_checked (GObject *source, GAsyncResult *result, gpointer data)
{
  (void) source;
  (void) data;
  GTask *task = G_TASK (result);
  if (g_cancellable_is_cancelled (g_task_get_cancellable (task)))
    return;
  Check *check = g_task_get_task_data (task);
  TcPresentRelay *relay = check->relay;
  g_task_propagate_boolean (task, NULL);
  if (check->generation != relay->generation)
    return; /* a later request replaced this one */
  if (check->purpose == CHECK_AGAIN) {
    relay->rechecking = FALSE;
    if (relay->pipeline == NULL)
      return;
    if (check->answer == GRANT_ERROR) {
      /* tilecastd did not answer: a timeout, a reset, a restart in progress.
       * That does not say that the grant ended, so the stream keeps running,
       * and the check repeats on the next tick. A daemon that stays silent
       * stops the relay after MAX_CHECK_ERRORS checks. */
      if (++relay->check_errors < MAX_CHECK_ERRORS)
        return;
      g_warning ("present-relay: tilecastd gave no answer to %u grant checks in a row", MAX_CHECK_ERRORS);
      relay->failed = TRUE;
      stop_pipeline (relay, "grant_unreachable");
      settle (relay);
      return;
    }
    relay->check_errors = 0;
    if (check->answer == GRANT_DENIED || check->audio != relay->audio) {
      stop_pipeline (relay, "grant_ended");
      settle (relay);
    }
    return;
  }
  relay->pending = FALSE;
  gboolean ok = check->answer == GRANT_OK && start_pipeline (relay, check->audio);
  if (check->answer == GRANT_DENIED)
    g_message ("present-relay: the present grant was denied");
  else if (check->answer == GRANT_ERROR)
    g_message ("present-relay: could not ask tilecastd for the present grant");
  if (!ok) {
    relay->failed = TRUE;
    relay->id[0] = '\0';
    settle (relay);
  }
  TcPresentRelayReady ready = relay->ready;
  gpointer ready_data = relay->ready_data;
  relay->ready = NULL;
  relay->ready_data = NULL;
  if (ready != NULL)
    ready (ok, ready_data);
}

static void
check_grant (TcPresentRelay *relay, CheckPurpose purpose)
{
  Check *check = g_new0 (Check, 1);
  check->relay = relay;
  check->purpose = purpose;
  check->generation = relay->generation;
  memcpy (check->id, relay->id, sizeof check->id);
  check->media_socket = g_strdup (relay->media_socket);
  if (purpose == CHECK_AGAIN)
    relay->rechecking = TRUE;
  g_autoptr (GTask) task = g_task_new (NULL, relay->cancellable, on_checked, NULL);
  g_task_set_task_data (task, check, (GDestroyNotify) check_free);
  g_task_run_in_thread (task, check_in_thread);
}

TcPresentRelay *
tc_present_relay_new (const char *dir, const char *media_socket)
{
  TcPresentRelay *relay = g_new0 (TcPresentRelay, 1);
  relay->dir = g_strdup (dir);
  relay->media_socket = g_strdup (media_socket);
  relay->cancellable = g_cancellable_new ();
  return relay;
}

void
tc_present_relay_on_stopped (TcPresentRelay *relay, TcPresentRelayStopped stopped, gpointer data)
{
  relay->stopped = stopped;
  relay->stopped_data = data;
}

void
tc_present_relay_free (TcPresentRelay *relay)
{
  if (relay == NULL)
    return;
  g_cancellable_cancel (relay->cancellable);
  stop_pipeline (relay, NULL);
  g_object_unref (relay->cancellable);
  g_free (relay->dir);
  g_free (relay->media_socket);
  g_free (relay);
}

void
tc_present_relay_set (TcPresentRelay *relay, const char *source_id, TcPresentRelayReady ready, gpointer data)
{
  if (source_id != NULL && !tc_is_sha256_hex (source_id))
    source_id = NULL;
  if (source_id != NULL && strcmp (source_id, relay->id) == 0 && (relay->pipeline != NULL || relay->pending)) {
    if (relay->pending) {
      relay->ready = ready;
      relay->ready_data = data;
    } else if (ready != NULL) {
      ready (TRUE, data);
    }
    return;
  }
  relay->generation++;
  relay->rechecking = FALSE;
  relay->failed = FALSE;
  relay->check_errors = 0;
  stop_pipeline (relay, source_id == NULL ? "presentation_ended" : "source_changed");
  relay->id[0] = '\0';
  relay->pending = FALSE;
  relay->ready = NULL;
  relay->ready_data = NULL;
  if (source_id == NULL) {
    settle (relay);
    if (ready != NULL)
      ready (TRUE, data);
    return;
  }
  static gsize gst_ready = 0;
  static gboolean gst_usable = FALSE;
  if (g_once_init_enter (&gst_ready)) {
    gst_usable = gst_init_check (NULL, NULL, NULL);
    g_once_init_leave (&gst_ready, 1);
  }
  if (!gst_usable || relay->dir == NULL || relay->media_socket == NULL) {
    settle (relay);
    if (ready != NULL)
      ready (FALSE, data);
    return;
  }
  memcpy (relay->id, source_id, sizeof relay->id);
  relay->pending = TRUE;
  relay->ready = ready;
  relay->ready_data = data;
  check_grant (relay, CHECK_START);
}

gboolean
tc_present_relay_pending (TcPresentRelay *relay)
{
  return relay != NULL && relay->pending;
}

gboolean
tc_present_relay_failed (TcPresentRelay *relay)
{
  return relay != NULL && relay->failed;
}

gboolean
tc_present_relay_active (TcPresentRelay *relay)
{
  return relay != NULL && (relay->pending || relay->pipeline != NULL);
}

static const char *const REQUIRED_ELEMENTS[] = {
  "udpsrc", "unixfdsink", "unixfdsrc", "rtpjitterbuffer", "rtph264depay", "h264parse", "rtpL16depay", NULL,
};

gboolean
tc_present_relay_probe (const char **decoder, gboolean *hardware)
{
  static gsize probed = 0;
  static const char *found = NULL;
  static gboolean found_hardware = FALSE;
  if (g_once_init_enter (&probed)) {
    gboolean usable = gst_init_check (NULL, NULL, NULL);
    for (guint i = 0; usable && REQUIRED_ELEMENTS[i] != NULL; i++) {
      g_autoptr (GstElementFactory) factory = gst_element_factory_find (REQUIRED_ELEMENTS[i]);
      usable = factory != NULL;
    }
    if (usable) {
      GList *decoders = gst_element_factory_list_get_elements (
        GST_ELEMENT_FACTORY_TYPE_DECODER | GST_ELEMENT_FACTORY_TYPE_MEDIA_VIDEO, GST_RANK_MARGINAL);
      g_autoptr (GstCaps) h264 = gst_caps_from_string ("video/x-h264");
      GList *able = gst_element_factory_list_filter (decoders, h264, GST_PAD_SINK, FALSE);
      able = g_list_sort (able, gst_plugin_feature_rank_compare_func);
      if (able != NULL) {
        GstElementFactory *best = able->data;
        found = g_intern_string (gst_plugin_feature_get_name (GST_PLUGIN_FEATURE (best)));
        const char *klass = gst_element_factory_get_metadata (best, GST_ELEMENT_METADATA_KLASS);
        found_hardware = klass != NULL && strstr (klass, "Hardware") != NULL;
      }
      gst_plugin_feature_list_free (able);
      gst_plugin_feature_list_free (decoders);
    }
    g_once_init_leave (&probed, 1);
  }
  if (decoder != NULL)
    *decoder = found;
  if (hardware != NULL)
    *hardware = found_hardware;
  return found != NULL;
}
