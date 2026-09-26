#include "media-client.h"

#include <glib/gstdio.h>
#include <string.h>

#define CAPABILITY "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

typedef struct {
  GSocketListener *listener;
  const char *expected_request;
  const char *response;
  const char *bytes;
  gsize byte_count;
} FixtureServer;

static gboolean
read_exact (GInputStream *input, void *bytes, gsize count)
{
  gsize received = 0;
  g_autoptr (GError) error = NULL;
  gboolean ok = g_input_stream_read_all (input, bytes, count, &received, NULL, &error);
  g_assert_no_error (error);
  g_assert_true (ok);
  g_assert_cmpuint (received, ==, count);
  return TRUE;
}

static gpointer
serve_fixture (gpointer data)
{
  FixtureServer *server = data;
  g_autoptr (GError) error = NULL;
  g_autoptr (GSocketConnection) connection = g_socket_listener_accept (server->listener, NULL, NULL, &error);
  g_assert_no_error (error);
  g_assert_nonnull (connection);
  GInputStream *input = g_io_stream_get_input_stream (G_IO_STREAM (connection));
  guint8 header[4];
  read_exact (input, header, sizeof header);
  guint32 length = ((guint32) header[0] << 24) | ((guint32) header[1] << 16) | ((guint32) header[2] << 8) | header[3];
  g_assert_cmpuint (length, <, 512);
  char request[512];
  read_exact (input, request, length);
  request[length] = '\0';
  g_assert_cmpstr (request, ==, server->expected_request);

  length = (guint32) strlen (server->response);
  guint8 reply_header[4] = { length >> 24, length >> 16, length >> 8, length };
  GOutputStream *output = g_io_stream_get_output_stream (G_IO_STREAM (connection));
  g_assert_true (g_output_stream_write_all (output, reply_header, sizeof reply_header, NULL, NULL, &error));
  g_assert_no_error (error);
  g_assert_true (g_output_stream_write_all (output, server->response, length, NULL, NULL, &error));
  g_assert_no_error (error);
  if (server->byte_count != 0) {
    g_assert_true (g_output_stream_write_all (output, server->bytes, server->byte_count, NULL, NULL, &error));
    g_assert_no_error (error);
  }
  return NULL;
}

static char *
fixture (const char *name)
{
  g_autofree char *path = g_build_filename (TC_MEDIA_FIXTURE_DIR, name, NULL);
  char *contents = NULL;
  g_assert_true (g_file_get_contents (path, &contents, NULL, NULL));
  g_strchomp (contents);
  return contents;
}

static void
run_case (const char *request_name, const char *response_name, const char *bytes, gsize byte_count,
          gboolean is_head, gboolean expect_ok)
{
  g_autofree char *dir = g_dir_make_tmp ("tilecast-media-client-XXXXXX", NULL);
  g_assert_nonnull (dir);
  g_autofree char *path = g_build_filename (dir, "media.sock", NULL);
  g_autoptr (GSocketListener) listener = g_socket_listener_new ();
  g_autoptr (GSocketAddress) address = g_unix_socket_address_new (path);
  g_assert_true (g_socket_listener_add_address (listener, address, G_SOCKET_TYPE_STREAM, G_SOCKET_PROTOCOL_DEFAULT,
                                                 NULL, NULL, NULL));
  g_autofree char *request = fixture (request_name);
  g_autofree char *response = fixture (response_name);
  FixtureServer server = { listener, request, response, bytes, byte_count };
  GThread *thread = g_thread_new ("media-fixture", serve_fixture, &server);
  g_autoptr (GError) error = NULL;
  gboolean ok;
  if (is_head) {
    guint64 size = 0;
    g_autofree char *mime = NULL;
    ok = tc_media_head (path, CAPABILITY, &size, &mime, &error);
    if (expect_ok) {
      g_assert_cmpuint (size, ==, 5);
      g_assert_cmpstr (mime, ==, "image/png");
    }
  } else {
    char buffer[3] = { 0 };
    ok = tc_media_read (path, CAPABILITY, 2, buffer, sizeof buffer, &error);
    if (expect_ok)
      g_assert_cmpmem (buffer, sizeof buffer, "cde", 3);
  }
  g_assert_cmpint (ok, ==, expect_ok);
  if (expect_ok)
    g_assert_no_error (error);
  else
    g_assert_error (error, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED);
  g_thread_join (thread);
  g_socket_listener_close (listener);
  g_assert_cmpint (g_unlink (path), ==, 0);
  g_assert_cmpint (g_rmdir (dir), ==, 0);
}

static void
test_head (void)
{
  run_case ("head-request.json", "head-response.json", NULL, 0, TRUE, TRUE);
}

static void
test_read (void)
{
  run_case ("read-request.json", "read-response.json", "cde", 3, FALSE, TRUE);
}

static void
test_denied (void)
{
  run_case ("head-request.json", "denied-response.json", NULL, 0, TRUE, FALSE);
}

static void
test_invalid_capability (void)
{
  g_autoptr (GError) error = NULL;
  guint64 size;
  char *mime = NULL;
  g_assert_false (tc_media_head ("/nonexistent/media.sock", "tcmedia://sha256/" CAPABILITY, &size, &mime, &error));
  g_assert_error (error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT);
  g_assert_null (mime);
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/media/head", test_head);
  g_test_add_func ("/media/read", test_read);
  g_test_add_func ("/media/denied", test_denied);
  g_test_add_func ("/media/invalid-capability", test_invalid_capability);
  return g_test_run ();
}
