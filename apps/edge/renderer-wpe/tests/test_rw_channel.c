/* Regression tests for the trusted renderer's bounded async helper channel.
 *
 * A helper that connects but stops reading must never block the renderer's
 * main loop: the queue fills, the write deadline fires, and the channel
 * reports a disconnect while unrelated main-loop activity continues.
 * A helper that floods inbound frames must trip the trusted-side budget.
 *
 * GLib-only (no WebKit): runs under ctest in the WPE CI image.
 */
#include "rw-channel.h"

#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

typedef struct {
  int peer;
  guint disconnects;
  char last_reason[128];
  guint ticks;
  GMainLoop *loop;
} Fixture;

static void
on_disconnect (TcRwChannel *channel, const char *reason, gpointer user_data)
{
  Fixture *fixture = user_data;
  (void) channel;
  fixture->disconnects++;
  g_strlcpy (fixture->last_reason, reason, sizeof fixture->last_reason);
  if (fixture->loop != NULL)
    g_main_loop_quit (fixture->loop);
}

static GSocketConnection *
wrap_fd (int fd)
{
  GError *error = NULL;
  GSocket *socket = g_socket_new_from_fd (fd, &error);
  g_assert_no_error (error);
  GSocketConnection *connection =
    g_socket_connection_factory_create_connection (socket);
  g_object_unref (socket);
  return connection;
}

/* One connected channel plus the peer fd the test reads (or ignores). */
static TcRwChannel *
connected (Fixture *fixture, guint max_queued, guint timeout_ms, int *peer_out)
{
  int pair[2];
  g_assert_cmpint (socketpair (AF_UNIX, SOCK_STREAM, 0, pair), ==, 0);
  /* Small kernel buffers so backpressure tests fill them quickly. */
  int small = 4096;
  setsockopt (pair[0], SOL_SOCKET, SO_SNDBUF, &small, sizeof small);
  setsockopt (pair[1], SOL_SOCKET, SO_RCVBUF, &small, sizeof small);
  GSocketConnection *connection = wrap_fd (pair[0]);
  TcRwChannel *channel =
    tc_rw_channel_new_full (max_queued, timeout_ms, on_disconnect, fixture);
  tc_rw_channel_attach (channel, connection);
  g_object_unref (connection);
  fixture->peer = pair[1];
  if (peer_out != NULL)
    *peer_out = pair[1];
  return channel;
}

static void
read_exact (int fd, guint8 *buffer, gsize length)
{
  gsize got = 0;
  while (got < length) {
    ssize_t n = recv (fd, buffer + got, length - got, 0);
    g_assert_cmpint (n, >, 0);
    got += (gsize) n;
  }
}

static char *
read_frame (int fd)
{
  guint8 header[4];
  read_exact (fd, header, 4);
  guint32 length =
    ((guint32) header[0] << 24) | ((guint32) header[1] << 16)
    | ((guint32) header[2] << 8) | (guint32) header[3];
  guint8 *payload = g_malloc (length + 1);
  read_exact (fd, payload, length);
  payload[length] = '\0';
  return (char *) payload;
}

static void
drain (TcRwChannel *channel)
{
  gint64 deadline = g_get_monotonic_time () + 5 * G_USEC_PER_SEC;
  while (tc_rw_channel_queued (channel) > 0) {
    g_assert_cmpint (g_get_monotonic_time (), <, deadline);
    g_main_context_iteration (NULL, TRUE);
  }
}

static void
test_detached_and_oversize (void)
{
  Fixture fixture = { .peer = -1 };
  TcRwChannel *channel = tc_rw_channel_new (on_disconnect, &fixture);
  g_assert_false (tc_rw_channel_send (channel, TC_RW_FRAME_HELLO, NULL, "{\"a\":1}"));
  g_assert_cmpuint (tc_rw_channel_queued (channel), ==, 0);

  int peer = -1;
  TcRwChannel *live = connected (&fixture, 0, 0, &peer);
  g_assert_false (tc_rw_channel_send (live, TC_RW_FRAME_CREATE, "s", ""));
  g_assert_false (tc_rw_channel_send (live, TC_RW_FRAME_CREATE, "s", NULL));
  char *huge = g_malloc (65 * 1024);
  memset (huge, 'x', 65 * 1024 - 1);
  huge[65 * 1024 - 1] = '\0';
  g_assert_false (tc_rw_channel_send (live, TC_RW_FRAME_CREATE, "s", huge));
  g_free (huge);
  g_assert_cmpuint (fixture.disconnects, ==, 0);

  close (peer);
  tc_rw_channel_free (live);
  tc_rw_channel_free (channel);
}

static void
test_bound (void)
{
  Fixture fixture = { .peer = -1 };
  int peer = -1;
  TcRwChannel *channel = connected (&fixture, 4, 0, &peer);
  for (int i = 0; i < 4; i++) {
    char *json = g_strdup_printf ("{\"n\":%d}", i);
    char id[16];
    g_snprintf (id, sizeof id, "surface-%d", i);
    g_assert_true (tc_rw_channel_send (channel, TC_RW_FRAME_CREATE, id, json));
    g_free (json);
  }
  g_assert_cmpuint (tc_rw_channel_queued (channel), ==, 4);
  g_assert_false (tc_rw_channel_send (channel, TC_RW_FRAME_CREATE, "surface-4", "{}"));
  g_assert_cmpuint (tc_rw_channel_queued (channel), ==, 4);
  g_assert_cmpuint (fixture.disconnects, ==, 0);
  close (peer);
  tc_rw_channel_free (channel);
}

static void
test_ordering_and_coalescing (void)
{
  Fixture fixture = { .peer = -1 };
  int peer = -1;
  TcRwChannel *channel = connected (&fixture, 0, 0, &peer);
  /* No main-loop iterations yet, so the head stays queued and in flight. */
  g_assert_true (tc_rw_channel_send (channel, TC_RW_FRAME_RESIZE, "s1", "{\"w\":1}"));
  g_assert_true (tc_rw_channel_send (channel, TC_RW_FRAME_RESIZE, "s1", "{\"w\":2}"));
  g_assert_true (tc_rw_channel_send (channel, TC_RW_FRAME_RESIZE, "s1", "{\"w\":3}"));
  /* The head is mid-write and untouchable; the two tail updates collapse. */
  g_assert_cmpuint (tc_rw_channel_queued (channel), ==, 2);
  /* Lifecycle frames never coalesce, and other surfaces are unaffected. */
  g_assert_true (tc_rw_channel_send (channel, TC_RW_FRAME_DESTROY, "s1", "{\"d\":1}"));
  g_assert_true (tc_rw_channel_send (channel, TC_RW_FRAME_RESIZE, "s2", "{\"w\":9}"));
  g_assert_cmpuint (tc_rw_channel_queued (channel), ==, 4);

  drain (channel);
  g_assert_cmpstr (read_frame (peer), ==, "{\"w\":1}");
  g_assert_cmpstr (read_frame (peer), ==, "{\"w\":3}");
  g_assert_cmpstr (read_frame (peer), ==, "{\"d\":1}");
  g_assert_cmpstr (read_frame (peer), ==, "{\"w\":9}");
  g_assert_cmpuint (fixture.disconnects, ==, 0);
  close (peer);
  tc_rw_channel_free (channel);
}

static void
test_flood_budget (void)
{
  Fixture fixture = { .peer = -1 };
  TcRwChannel *channel = tc_rw_channel_new (on_disconnect, &fixture);
  gint64 now = 1 * G_USEC_PER_SEC;
  for (guint i = 0; i < TC_RW_MAX_INCOMING_PER_SEC; i++)
    g_assert_true (tc_rw_channel_note_incoming (channel, now));
  g_assert_false (tc_rw_channel_note_incoming (channel, now));
  /* A new window forgives: bursts are fine, sustained floods are not. */
  g_assert_true (tc_rw_channel_note_incoming (channel, now + 2 * G_USEC_PER_SEC));
  tc_rw_channel_free (channel);
}

static gboolean
tick (gpointer user_data)
{
  Fixture *fixture = user_data;
  fixture->ticks++;
  return G_SOURCE_CONTINUE;
}

static gboolean
quit_loop (gpointer user_data)
{
  g_main_loop_quit ((GMainLoop *) user_data);
  return G_SOURCE_REMOVE;
}

/* A helper that connects but never reads: the main loop must stay
 * responsive, unrelated work must continue, and the channel must report a
 * disconnect instead of blocking. */
static void
test_non_reading_helper (void)
{
  Fixture fixture = { .peer = -1, .disconnects = 0, .ticks = 0 };
  int peer = -1;
  TcRwChannel *channel = connected (&fixture, 8, 200, &peer);
  /* Shrink the kernel buffers so the test fills them quickly. */
  int small = 4096;
  setsockopt (peer, SOL_SOCKET, SO_RCVBUF, &small, sizeof small);

  char *big = g_malloc (60 * 1024 + 1);
  memset (big, 'y', 60 * 1024);
  big[60 * 1024] = '\0';
  g_assert_true (tc_rw_channel_send (channel, TC_RW_FRAME_CREATE, "s1", big));
  g_free (big);
  /* Fill the bounded queue behind the stuck head frame. */
  guint accepted = 1;
  for (guint i = 0; i < 32; i++) {
    char id[16];
    g_snprintf (id, sizeof id, "s%d", i + 2);
    if (!tc_rw_channel_send (channel, TC_RW_FRAME_CREATE, id, "{\"n\":1}"))
      break;
    accepted++;
  }
  g_assert_cmpuint (accepted, ==, 8);
  g_assert_cmpuint (tc_rw_channel_queued (channel), ==, 8);
  /* One more send after a full queue still fails instead of growing. */
  g_assert_false (tc_rw_channel_send (channel, TC_RW_FRAME_CREATE, "overflow", "{}"));

  GMainLoop *loop = g_main_loop_new (NULL, FALSE);
  fixture.loop = loop;
  guint tick_source = g_timeout_add (20, tick, &fixture);
  g_timeout_add (5000, quit_loop, loop);
  gint64 start = g_get_monotonic_time ();
  g_main_loop_run (loop);
  gint64 elapsed = g_get_monotonic_time () - start;
  g_source_remove (tick_source);
  fixture.loop = NULL;
  g_main_loop_unref (loop);

  /* The write deadline fired promptly (not the 5 s guard): the stuck
   * helper degrades the channel instead of blocking the loop. */
  g_assert_cmpuint (fixture.disconnects, ==, 1);
  g_assert_cmpint (elapsed, <, 2500 * 1000);
  /* Unrelated main-loop activity continued while the helper was stuck. */
  g_assert_cmpuint (fixture.ticks, >, 5);
  g_assert_cmpuint (tc_rw_channel_queued (channel), ==, 0);
  close (peer);
  tc_rw_channel_free (channel);
}

/* Detach between the write and its completion, then reuse the channel: the
 * stale completion must not disconnect the new connection or corrupt it. */
static void
test_stale_completion (void)
{
  Fixture fixture = { .peer = -1, .disconnects = 0 };
  int peer = -1;
  TcRwChannel *channel = connected (&fixture, 0, 0, &peer);
  g_assert_true (tc_rw_channel_send (channel, TC_RW_FRAME_CREATE, "s1", "{\"n\":1}"));
  tc_rw_channel_detach (channel);
  g_assert_cmpuint (tc_rw_channel_queued (channel), ==, 0);

  int pair[2];
  g_assert_cmpint (socketpair (AF_UNIX, SOCK_STREAM, 0, pair), ==, 0);
  GSocketConnection *second = wrap_fd (pair[0]);
  tc_rw_channel_attach (channel, second);
  g_object_unref (second);
  g_assert_true (tc_rw_channel_send (channel, TC_RW_FRAME_RELOAD, "s1", "{\"r\":1}"));
  drain (channel);
  g_assert_cmpstr (read_frame (pair[1]), ==, "{\"r\":1}");
  g_assert_cmpuint (fixture.disconnects, ==, 0);

  close (peer);
  close (pair[1]);
  tc_rw_channel_free (channel);
}

/* Free a channel with a write still outstanding, then create a new one: the
 * abandoned completion must not drive the new channel even if the allocator
 * reuses the same address (every channel takes a fresh identity). */
static void
test_abandoned_write_after_free (void)
{
  Fixture fixture = { .peer = -1, .disconnects = 0 };
  int peer = -1;
  TcRwChannel *dead = connected (&fixture, 0, 0, &peer);
  g_assert_true (tc_rw_channel_send (dead, TC_RW_FRAME_CREATE, "s1", "{\"n\":1}"));
  close (peer);
  tc_rw_channel_free (dead);

  int fresh_peer = -1;
  TcRwChannel *channel = connected (&fixture, 0, 0, &fresh_peer);
  g_assert_true (tc_rw_channel_send (channel, TC_RW_FRAME_CREATE, "s1", "{\"n\":2}"));
  drain (channel);
  g_assert_cmpstr (read_frame (fresh_peer), ==, "{\"n\":2}");
  g_assert_cmpuint (fixture.disconnects, ==, 0);
  close (fresh_peer);
  tc_rw_channel_free (channel);
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/rw-channel/detached-and-oversize", test_detached_and_oversize);
  g_test_add_func ("/rw-channel/bound", test_bound);
  g_test_add_func ("/rw-channel/ordering-and-coalescing", test_ordering_and_coalescing);
  g_test_add_func ("/rw-channel/flood-budget", test_flood_budget);
  g_test_add_func ("/rw-channel/non-reading-helper", test_non_reading_helper);
  g_test_add_func ("/rw-channel/stale-completion", test_stale_completion);
  g_test_add_func ("/rw-channel/abandoned-write-after-free", test_abandoned_write_after_free);
  return g_test_run ();
}
