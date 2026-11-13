/*
 * The AirPlay relay (src/present-relay.c) with a fake tilecastd media
 * socket, real loopback UDP on the fixed ports, and unixfdsrc on the far
 * side as the web process's tcpresent source uses it. Needs UDP ports 42000
 * and 42002 on 127.0.0.1 to be free.
 */
#include "media-client.h"
#include "present-relay.h"

#include <gio/gio.h>
#include <glib/gstdio.h>
#include <gst/app/gstappsink.h>
#include <gst/gst.h>
#include <string.h>

#define SOURCE "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

typedef enum { GRANT_AUDIO, GRANT_VIDEO, GRANT_DENIED } GrantMode;

typedef struct {
  GSocketListener *listener;
  gint mode;     /* atomic GrantMode */
  gint requests; /* atomic */
  gint stop;     /* atomic */
} FakeDaemon;

static char *
fixture (const char *name)
{
  g_autofree char *path = g_build_filename (TC_MEDIA_FIXTURE_DIR, name, NULL);
  char *contents = NULL;
  g_assert_true (g_file_get_contents (path, &contents, NULL, NULL));
  g_strchomp (contents);
  return contents;
}

static gpointer
serve (gpointer data)
{
  FakeDaemon *daemon = data;
  g_autofree char *expected = fixture ("present-request.json");
  g_autofree char *audio = fixture ("present-response.json");
  g_autofree char *video = fixture ("present-video-response.json");
  g_autofree char *denied = fixture ("denied-response.json");
  while (!g_atomic_int_get (&daemon->stop)) {
    g_autoptr (GSocketConnection) connection = g_socket_listener_accept (daemon->listener, NULL, NULL, NULL);
    if (connection == NULL || g_atomic_int_get (&daemon->stop))
      break;
    GInputStream *input = g_io_stream_get_input_stream (G_IO_STREAM (connection));
    guint8 header[4];
    gsize got = 0;
    if (!g_input_stream_read_all (input, header, 4, &got, NULL, NULL) || got != 4)
      continue;
    guint32 length = ((guint32) header[0] << 24) | ((guint32) header[1] << 16) | ((guint32) header[2] << 8) | header[3];
    g_assert_cmpuint (length, <, 512);
    char request[512];
    g_assert_true (g_input_stream_read_all (input, request, length, &got, NULL, NULL) && got == length);
    request[length] = '\0';
    g_assert_cmpstr (request, ==, expected);
    g_atomic_int_inc (&daemon->requests);
    GrantMode mode = g_atomic_int_get (&daemon->mode);
    const char *reply = mode == GRANT_AUDIO ? audio : mode == GRANT_VIDEO ? video : denied;
    guint32 size = (guint32) strlen (reply);
    guint8 reply_header[4] = { size >> 24, size >> 16, size >> 8, size };
    GOutputStream *output = g_io_stream_get_output_stream (G_IO_STREAM (connection));
    g_output_stream_write_all (output, reply_header, 4, NULL, NULL, NULL);
    g_output_stream_write_all (output, reply, size, NULL, NULL, NULL);
  }
  return NULL;
}

typedef struct {
  gboolean called;
  gboolean ok;
} Ready;

static void
on_ready (gboolean ok, gpointer data)
{
  Ready *ready = data;
  ready->called = TRUE;
  ready->ok = ok;
}

static gboolean
wait_for (gboolean (*predicate) (gpointer), gpointer data, guint timeout_ms)
{
  gint64 deadline = g_get_monotonic_time () + (gint64) timeout_ms * 1000;
  while (!predicate (data) && g_get_monotonic_time () < deadline)
    g_main_context_iteration (NULL, FALSE), g_usleep (5000);
  return predicate (data);
}

static void
on_stopped (gpointer data)
{
  ++*(guint *) data;
}

static gboolean
ready_called (gpointer data)
{
  return ((Ready *) data)->called;
}

static gboolean
relay_stopped (gpointer data)
{
  return !tc_present_relay_active (data);
}

static char *
relay_socket (const char *dir, const char *stream)
{
  g_autofree char *name = g_strdup_printf ("%s-%s.sock", SOURCE, stream);
  return g_build_filename (dir, name, NULL);
}

/* Sends one datagram to 127.0.0.1:`port` until unixfdsrc on `path` delivers
 * the same bytes. The first packets can arrive before the reader connects. */
static void
assert_relays (const char *path, guint port)
{
  g_autofree char *description = g_strdup_printf ("unixfdsrc socket-path=%s ! appsink name=sink sync=false", path);
  GstElement *pipeline = gst_parse_launch (description, NULL);
  g_assert_nonnull (pipeline);
  GstElement *sink = gst_bin_get_by_name (GST_BIN (pipeline), "sink");
  g_assert_cmpint (gst_element_set_state (pipeline, GST_STATE_PLAYING), !=, GST_STATE_CHANGE_FAILURE);
  g_autoptr (GSocket) udp = g_socket_new (G_SOCKET_FAMILY_IPV4, G_SOCKET_TYPE_DATAGRAM, G_SOCKET_PROTOCOL_UDP, NULL);
  g_autoptr (GInetAddress) loopback = g_inet_address_new_loopback (G_SOCKET_FAMILY_IPV4);
  g_autoptr (GSocketAddress) target = g_inet_socket_address_new (loopback, (guint16) port);
  static const guint8 packet[] = { 0x80, 0x60, 0x00, 0x01, 0, 0, 0, 1, 0x5a, 0x5a, 0, 1, 0x65, 0x88, 0x84, 0x21 };
  GstSample *sample = NULL;
  for (int attempt = 0; attempt < 100 && sample == NULL; attempt++) {
    g_socket_send_to (udp, target, (const char *) packet, sizeof packet, NULL, NULL);
    sample = gst_app_sink_try_pull_sample (GST_APP_SINK (sink), 50 * GST_MSECOND);
    g_main_context_iteration (NULL, FALSE);
  }
  g_assert_nonnull (sample);
  GstMapInfo map;
  GstBuffer *buffer = gst_sample_get_buffer (sample);
  g_assert_true (gst_buffer_map (buffer, &map, GST_MAP_READ));
  g_assert_cmpmem (map.data, map.size, packet, sizeof packet);
  gst_buffer_unmap (buffer, &map);
  gst_sample_unref (sample);
  gst_element_set_state (pipeline, GST_STATE_NULL);
  gst_object_unref (sink);
  gst_object_unref (pipeline);
}

typedef struct {
  char *dir;
  char *media;
  FakeDaemon daemon;
  GThread *thread;
  TcPresentRelay *relay;
} Fixture;

static void
fixture_set_up (Fixture *f, gconstpointer data)
{
  (void) data;
  f->dir = g_dir_make_tmp ("tilecast-present-XXXXXX", NULL);
  f->media = g_build_filename (f->dir, "media.sock", NULL);
  f->daemon.listener = g_socket_listener_new ();
  g_autoptr (GSocketAddress) address = g_unix_socket_address_new (f->media);
  g_assert_true (g_socket_listener_add_address (f->daemon.listener, address, G_SOCKET_TYPE_STREAM,
                                                 G_SOCKET_PROTOCOL_DEFAULT, NULL, NULL, NULL));
  f->thread = g_thread_new ("fake-daemon", serve, &f->daemon);
  f->relay = tc_present_relay_new (f->dir, f->media);
}

static void
fixture_tear_down (Fixture *f, gconstpointer data)
{
  (void) data;
  tc_present_relay_free (f->relay);
  g_atomic_int_set (&f->daemon.stop, TRUE);
  g_autoptr (GSocketClient) client = g_socket_client_new ();
  g_autoptr (GSocketAddress) address = g_unix_socket_address_new (f->media);
  g_autoptr (GSocketConnection) wake = g_socket_client_connect (client, G_SOCKET_CONNECTABLE (address), NULL, NULL);
  g_thread_join (f->thread);
  g_socket_listener_close (f->daemon.listener);
  g_object_unref (f->daemon.listener);
  g_unlink (f->media);
  g_assert_cmpint (g_rmdir (f->dir), ==, 0); /* the relay left no socket behind */
  g_free (f->media);
  g_free (f->dir);
}

static void
test_relays_granted_streams_until_revoked (Fixture *f, gconstpointer data)
{
  (void) data;
  guint stopped = 0;
  tc_present_relay_on_stopped (f->relay, on_stopped, &stopped);
  Ready ready = { 0 };
  tc_present_relay_set (f->relay, SOURCE, on_ready, &ready);
  g_assert_true (tc_present_relay_pending (f->relay));
  g_assert_true (tc_present_relay_active (f->relay));
  g_assert_true (wait_for (ready_called, &ready, 5000));
  g_assert_true (ready.ok);
  g_assert_false (tc_present_relay_pending (f->relay));
  g_autofree char *video = relay_socket (f->dir, "video");
  g_autofree char *audio = relay_socket (f->dir, "audio");
  g_assert_true (g_file_test (video, G_FILE_TEST_EXISTS));
  g_assert_true (g_file_test (audio, G_FILE_TEST_EXISTS));
  assert_relays (video, TC_PRESENT_VIDEO_PORT);
  assert_relays (audio, TC_PRESENT_AUDIO_PORT);

  /* The same ID again changes nothing and answers at once. */
  Ready again = { 0 };
  tc_present_relay_set (f->relay, SOURCE, on_ready, &again);
  g_assert_true (again.called && again.ok);

  /* The daemon revokes the grant: the next check stops the relay. */
  g_atomic_int_set (&f->daemon.mode, GRANT_DENIED);
  g_assert_true (wait_for (relay_stopped, f->relay, 4000));
  g_assert_false (g_file_test (video, G_FILE_TEST_EXISTS));
  g_assert_false (g_file_test (audio, G_FILE_TEST_EXISTS));
  /* The host is told once that the relay is gone, so it can drop the last
   * presented buffer. */
  g_assert_cmpuint (stopped, ==, 1);
}

static void
test_video_only_and_stop (Fixture *f, gconstpointer data)
{
  (void) data;
  g_atomic_int_set (&f->daemon.mode, GRANT_VIDEO);
  Ready ready = { 0 };
  tc_present_relay_set (f->relay, SOURCE, on_ready, &ready);
  g_assert_true (wait_for (ready_called, &ready, 5000) && ready.ok);
  g_autofree char *video = relay_socket (f->dir, "video");
  g_autofree char *audio = relay_socket (f->dir, "audio");
  g_assert_true (g_file_test (video, G_FILE_TEST_EXISTS));
  g_assert_false (g_file_test (audio, G_FILE_TEST_EXISTS));
  assert_relays (video, TC_PRESENT_VIDEO_PORT);
  guint told = 0;
  tc_present_relay_on_stopped (f->relay, on_stopped, &told);
  Ready stopped = { 0 };
  tc_present_relay_set (f->relay, NULL, on_ready, &stopped);
  g_assert_true (stopped.called && stopped.ok);
  g_assert_false (tc_present_relay_active (f->relay));
  g_assert_false (g_file_test (video, G_FILE_TEST_EXISTS));
  g_assert_cmpuint (told, ==, 1);
}

/* A stop while the grant check waits: the answer that comes later starts
 * nothing and delivers nothing, and the host has nothing to drop. */
static void
test_stop_while_pending (Fixture *f, gconstpointer data)
{
  (void) data;
  guint told = 0;
  tc_present_relay_on_stopped (f->relay, on_stopped, &told);
  Ready first = { 0 };
  tc_present_relay_set (f->relay, SOURCE, on_ready, &first);
  g_assert_true (tc_present_relay_pending (f->relay));
  Ready stopped = { 0 };
  tc_present_relay_set (f->relay, NULL, on_ready, &stopped);
  g_assert_true (stopped.called && stopped.ok);
  g_assert_false (tc_present_relay_active (f->relay));
  /* Let the daemon's answer arrive. */
  gint64 deadline = g_get_monotonic_time () + 500 * 1000;
  while (g_get_monotonic_time () < deadline)
    g_main_context_iteration (NULL, FALSE), g_usleep (5000);
  g_assert_false (first.called);
  g_assert_false (tc_present_relay_active (f->relay));
  g_autofree char *video = relay_socket (f->dir, "video");
  g_assert_false (g_file_test (video, G_FILE_TEST_EXISTS));
  g_assert_cmpuint (told, ==, 0);
}

static void
test_refusals (Fixture *f, gconstpointer data)
{
  (void) data;
  /* A denied grant starts nothing. */
  g_atomic_int_set (&f->daemon.mode, GRANT_DENIED);
  Ready denied = { 0 };
  tc_present_relay_set (f->relay, SOURCE, on_ready, &denied);
  g_assert_true (wait_for (ready_called, &denied, 5000));
  g_assert_false (denied.ok);
  g_assert_false (tc_present_relay_active (f->relay));
  g_autofree char *video = relay_socket (f->dir, "video");
  g_assert_false (g_file_test (video, G_FILE_TEST_EXISTS));

  /* Another socket on the fixed port: the relay fails, it does not share. */
  g_atomic_int_set (&f->daemon.mode, GRANT_AUDIO);
  g_autoptr (GSocket) holder = g_socket_new (G_SOCKET_FAMILY_IPV4, G_SOCKET_TYPE_DATAGRAM, G_SOCKET_PROTOCOL_UDP, NULL);
  g_autoptr (GInetAddress) loopback = g_inet_address_new_loopback (G_SOCKET_FAMILY_IPV4);
  g_autoptr (GSocketAddress) port = g_inet_socket_address_new (loopback, TC_PRESENT_VIDEO_PORT);
  g_assert_true (g_socket_bind (holder, port, FALSE, NULL));
  Ready busy = { 0 };
  g_test_expect_message (NULL, G_LOG_LEVEL_WARNING, "*a forwarded port may be in use*");
  tc_present_relay_set (f->relay, SOURCE, on_ready, &busy);
  g_assert_true (wait_for (ready_called, &busy, 5000));
  g_test_assert_expected_messages ();
  g_assert_false (busy.ok);
  g_assert_false (tc_present_relay_active (f->relay));
  g_socket_close (holder, NULL);

  /* Anything but 64 lowercase hex is no source at all. */
  int before = g_atomic_int_get (&f->daemon.requests);
  for (guint i = 0; i < 3; i++) {
    static const char *const bad[] = { "../media", "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
                                       SOURCE "/x" };
    Ready none = { 0 };
    tc_present_relay_set (f->relay, bad[i], on_ready, &none);
    g_assert_true (none.called && none.ok);
    g_assert_false (tc_present_relay_active (f->relay));
  }
  g_assert_cmpint (g_atomic_int_get (&f->daemon.requests), ==, before);
}

static void
test_probe (void)
{
  const char *decoder = NULL;
  gboolean hardware = TRUE;
  g_assert_true (tc_present_relay_probe (&decoder, &hardware));
  g_assert_nonnull (decoder);
  g_test_message ("selected H.264 decoder: %s (hardware %d)", decoder, hardware);
}

int
main (int argc, char **argv)
{
  gst_init (&argc, &argv);
  g_test_init (&argc, &argv, NULL);
  g_test_add ("/present-relay/granted-until-revoked", Fixture, NULL, fixture_set_up,
              test_relays_granted_streams_until_revoked, fixture_tear_down);
  g_test_add ("/present-relay/video-only-and-stop", Fixture, NULL, fixture_set_up, test_video_only_and_stop,
              fixture_tear_down);
  g_test_add ("/present-relay/stop-while-pending", Fixture, NULL, fixture_set_up, test_stop_while_pending,
              fixture_tear_down);
  g_test_add ("/present-relay/refusals", Fixture, NULL, fixture_set_up, test_refusals, fixture_tear_down);
  g_test_add_func ("/present-relay/probe", test_probe);
  return g_test_run ();
}
