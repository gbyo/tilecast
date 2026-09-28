/*
 * The control socket: one client (the trusted renderer), identified by
 * SO_PEERCRED. A new connection replaces the old one and destroys every
 * surface of the old one, so a capability never outlives the renderer
 * connection that asked for it (threat review §5, §7).
 */
#include "helper.h"

#include <errno.h>
#include <gio/gunixcredentialsmessage.h>
#include <gio/gunixsocketaddress.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define EVENT_BUDGET 32
#define SEND_TIMEOUT_SECONDS 2

static void read_header (TcWeb *web);

static void
destroy_all_surfaces (TcWeb *web)
{
  /* The table's value destructor is tc_surface_destroy. */
  g_hash_table_remove_all (web->surfaces);
}

static void
disconnect (TcWeb *web, const char *reason)
{
  if (web->client == NULL)
    return;
  g_message ("control: client disconnected (%s)", reason);
  g_cancellable_cancel (web->io);
  g_clear_object (&web->io);
  g_io_stream_close (G_IO_STREAM (web->client), NULL, NULL);
  g_clear_object (&web->client);
  web->hello_done = FALSE;
  web->clears_in_flight = 0;
  g_hash_table_remove_all (web->deferred_events);
  destroy_all_surfaces (web);
}

/* Writes all of `data`, waiting at most SEND_TIMEOUT_SECONDS in total for the
 * socket to accept it. A renderer that stops reading is disconnected; the
 * helper's main loop never blocks on it for longer. Reads are asynchronous
 * and have no timeout: an idle renderer is normal. */
static gboolean
send_all (GSocket *socket, const guchar *data, gsize length, gint64 deadline, GError **error)
{
  while (length > 0) {
    gssize sent = g_socket_send_with_blocking (socket, (const gchar *) data, length, FALSE, NULL, error);
    if (sent > 0) {
      data += sent;
      length -= (gsize) sent;
      continue;
    }
    if (sent < 0 && !g_error_matches (*error, G_IO_ERROR, G_IO_ERROR_WOULD_BLOCK))
      return FALSE;
    g_clear_error (error);
    gint64 remaining = deadline - g_get_monotonic_time ();
    if (remaining <= 0 || !g_socket_condition_timed_wait (socket, G_IO_OUT, remaining, NULL, error)) {
      if (error != NULL && *error == NULL)
        g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_TIMED_OUT, "the renderer does not read");
      return FALSE;
    }
  }
  return TRUE;
}

static gboolean
write_frame (TcWeb *web, const char *json)
{
  gsize length = strlen (json);
  if (web->client == NULL || length == 0 || length > TC_RW_MAX_FRAME)
    return FALSE;
  guchar header[4] = { (guchar) (length >> 24), (guchar) (length >> 16), (guchar) (length >> 8), (guchar) length };
  GSocket *socket = g_socket_connection_get_socket (web->client);
  gint64 deadline = g_get_monotonic_time () + SEND_TIMEOUT_SECONDS * G_USEC_PER_SEC;
  g_autoptr (GError) error = NULL;
  if (!send_all (socket, header, 4, deadline, &error)
      || !send_all (socket, (const guchar *) json, length, deadline, &error)) {
    disconnect (web, error ? error->message : "write failed");
    return FALSE;
  }
  return TRUE;
}

void
tc_control_send (TcWeb *web, const char *json)
{
  write_frame (web, json);
}

static gboolean
flush_deferred (gpointer data)
{
  TcWeb *web = data;
  web->deferred_source = 0;
  web->event_window_start = g_get_monotonic_time ();
  web->events_in_window = 0;
  GHashTableIter iter;
  gpointer value;
  g_hash_table_iter_init (&iter, web->deferred_events);
  while (g_hash_table_iter_next (&iter, NULL, &value)) {
    if (web->events_in_window >= EVENT_BUDGET)
      break;
    web->events_in_window++;
    g_autofree char *frame = g_strdup (value);
    g_hash_table_iter_remove (&iter);
    if (!write_frame (web, frame))
      return G_SOURCE_REMOVE;
  }
  if (g_hash_table_size (web->deferred_events) > 0)
    web->deferred_source = g_timeout_add_seconds (1, flush_deferred, web);
  return G_SOURCE_REMOVE;
}

void
tc_control_event (TcWeb *web, const char *surface_id, TcRwEventKind kind, const char *code)
{
  if (web->client == NULL || !web->hello_done)
    return;
  g_autofree char *frame = tc_rw_build_event (surface_id, kind, code);
  gint64 now = g_get_monotonic_time ();
  if (now - web->event_window_start >= G_USEC_PER_SEC) {
    web->event_window_start = now;
    web->events_in_window = 0;
  }
  /* Over budget: keep only the newest event of each kind for each surface,
   * sent in the next window. A page that reloads itself in a loop cannot
   * flood the renderer, and no kind replaces another. */
  g_autofree char *key = g_strdup_printf ("%s/%s", surface_id, tc_rw_event_kind_name (kind));
  if (web->events_in_window >= EVENT_BUDGET || g_hash_table_contains (web->deferred_events, key)) {
    g_hash_table_replace (web->deferred_events, g_steal_pointer (&key), g_steal_pointer (&frame));
    if (web->deferred_source == 0)
      web->deferred_source = g_timeout_add_seconds (1, flush_deferred, web);
    return;
  }
  web->events_in_window++;
  write_frame (web, frame);
}

static guint64
pixels_in_use (TcWeb *web, const char *except)
{
  guint64 total = 0;
  GHashTableIter iter;
  gpointer key, value;
  g_hash_table_iter_init (&iter, web->surfaces);
  while (g_hash_table_iter_next (&iter, &key, &value)) {
    if (except == NULL || strcmp (key, except) != 0)
      total += tc_surface_pixels (value);
  }
  return total;
}

typedef struct {
  TcWeb *web;
  GSocketConnection *client;
  char request_id[49];
} PendingClear;

static void
on_cleared (gboolean ok, gpointer user_data)
{
  PendingClear *pending = user_data;
  TcWeb *web = pending->web;
  /* Answer only the connection that asked. */
  if (web->client == pending->client) {
    if (web->clears_in_flight > 0)
      web->clears_in_flight--;
    g_autofree char *frame = tc_rw_build_cleared (pending->request_id, ok);
    tc_control_send (web, frame);
  }
  g_object_unref (pending->client);
  g_free (pending);
}

static gboolean
dispatch (TcWeb *web, JsonObject *object)
{
  TcRwRequest request;
  const char *reason = NULL;
  if (!tc_rw_parse_request (object, &request, &reason)) {
    g_warning ("control: refused a request (%s)", reason);
    return FALSE;
  }
  if (!web->hello_done && request.type != TC_RW_REQ_HELLO)
    return FALSE;
  TcSurface *surface = NULL;
  if (request.type != TC_RW_REQ_HELLO && request.type != TC_RW_REQ_CREATE && request.type != TC_RW_REQ_CLEAR_DATA) {
    surface = g_hash_table_lookup (web->surfaces, request.surface_id);
    /* A request for a surface this connection does not own is ignored: the
     * renderer may destroy a surface the helper already failed. */
    if (surface == NULL)
      return TRUE;
  }
  switch (request.type) {
  case TC_RW_REQ_HELLO: {
    if (web->hello_done || request.version != TC_RW_PROTOCOL_VERSION)
      return FALSE;
    web->hello_done = TRUE;
    g_autofree char *frame = tc_rw_build_welcome (web->accelerated);
    return write_frame (web, frame);
  }
  case TC_RW_REQ_CREATE: {
    const char *code = NULL;
    guint64 pixels = (guint64) request.create.width * request.create.height;
    if (g_hash_table_contains (web->surfaces, request.surface_id))
      code = "invalid_request";
    else if (g_hash_table_size (web->surfaces) >= TC_RW_MAX_SURFACES
             || pixels_in_use (web, NULL) + pixels > TC_RW_MAX_PIXELS)
      code = "limit_exceeded";
    if (code == NULL) {
      surface = tc_surface_create (web, &request.create, &code);
      if (surface != NULL)
        g_hash_table_insert (web->surfaces, g_strdup (request.surface_id), surface);
    }
    tc_rw_create_clear (&request.create);
    g_autofree char *frame = surface != NULL ? tc_rw_build_created (request.surface_id, tc_surface_capability (surface))
                                             : tc_rw_build_rejected (request.surface_id, code);
    return write_frame (web, frame);
  }
  case TC_RW_REQ_RESIZE:
    if (pixels_in_use (web, request.surface_id) + (guint64) request.width * request.height > TC_RW_MAX_PIXELS) {
      tc_control_event (web, request.surface_id, TC_RW_EVENT_FAILED, "limit_exceeded");
      return TRUE;
    }
    tc_surface_resize (surface, request.width, request.height);
    return TRUE;
  case TC_RW_REQ_VISIBLE:
    tc_surface_set_visible (surface, request.flag);
    return TRUE;
  case TC_RW_REQ_MUTE:
    tc_surface_set_muted (surface, request.flag);
    return TRUE;
  case TC_RW_REQ_RELOAD:
    tc_surface_reload (surface);
    return TRUE;
  case TC_RW_REQ_DESTROY:
    g_hash_table_remove (web->surfaces, request.surface_id);
    return TRUE;
  case TC_RW_REQ_CLEAR_DATA: {
    if (web->clears_in_flight >= TC_RW_MAX_IN_FLIGHT)
      return FALSE;
    web->clears_in_flight++;
    PendingClear *pending = g_new0 (PendingClear, 1);
    pending->web = web;
    pending->client = g_object_ref (web->client);
    g_strlcpy (pending->request_id, request.request_id, sizeof pending->request_id);
    tc_profiles_clear (web, on_cleared, pending);
    return TRUE;
  }
  case TC_RW_REQ_INVALID:
  default:
    return FALSE;
  }
}

static void
handle_payload (TcWeb *web)
{
  g_autoptr (JsonParser) parser = json_parser_new_immutable ();
  if (!g_utf8_validate ((const char *) web->payload, (gssize) web->payload_length, NULL)
      || !json_parser_load_from_data (parser, (const char *) web->payload, (gssize) web->payload_length, NULL)
      || !JSON_NODE_HOLDS_OBJECT (json_parser_get_root (parser))) {
    disconnect (web, "malformed frame");
    return;
  }
  if (!dispatch (web, json_node_get_object (json_parser_get_root (parser))))
    disconnect (web, "protocol violation");
}

static void
on_payload (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TcWeb *web = user_data;
  gsize read = 0;
  g_autoptr (GError) error = NULL;
  gboolean ok = g_input_stream_read_all_finish (G_INPUT_STREAM (source), result, &read, &error);
  if (!ok || read != web->payload_length) {
    g_clear_pointer (&web->payload, g_free);
    if (error == NULL || !g_error_matches (error, G_IO_ERROR, G_IO_ERROR_CANCELLED))
      disconnect (web, error ? error->message : "connection closed");
    return;
  }
  handle_payload (web);
  g_clear_pointer (&web->payload, g_free);
  if (web->client != NULL)
    read_header (web);
}

static void
on_header (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TcWeb *web = user_data;
  gsize read = 0;
  g_autoptr (GError) error = NULL;
  if (!g_input_stream_read_all_finish (G_INPUT_STREAM (source), result, &read, &error) || read != 4) {
    if (error == NULL || !g_error_matches (error, G_IO_ERROR, G_IO_ERROR_CANCELLED))
      disconnect (web, error ? error->message : "connection closed");
    return;
  }
  guint32 length = ((guint32) web->header[0] << 24) | ((guint32) web->header[1] << 16)
                   | ((guint32) web->header[2] << 8) | (guint32) web->header[3];
  if (length == 0 || length > TC_RW_MAX_FRAME) {
    /* Checked before allocation: an oversized length never buffers. */
    disconnect (web, "invalid frame length");
    return;
  }
  web->payload_length = length;
  web->payload = g_malloc (length);
  GInputStream *in = g_io_stream_get_input_stream (G_IO_STREAM (web->client));
  g_input_stream_read_all_async (in, web->payload, length, G_PRIORITY_DEFAULT, web->io, on_payload, web);
}

static void
read_header (TcWeb *web)
{
  GInputStream *in = g_io_stream_get_input_stream (G_IO_STREAM (web->client));
  g_input_stream_read_all_async (in, web->header, 4, G_PRIORITY_DEFAULT, web->io, on_header, web);
}

static gboolean
on_incoming (GSocketService *service, GSocketConnection *connection, GObject *source, gpointer user_data)
{
  (void) service;
  (void) source;
  TcWeb *web = user_data;
  GSocket *socket = g_socket_connection_get_socket (connection);
  g_autoptr (GError) error = NULL;
  g_autoptr (GCredentials) credentials = g_socket_get_credentials (socket, &error);
  uid_t uid = credentials ? g_credentials_get_unix_user (credentials, NULL) : (uid_t) -1;
  if (credentials == NULL || uid != web->client_uid) {
    g_warning ("control: refused a connection from uid %ld", (long) uid);
    g_io_stream_close (G_IO_STREAM (connection), NULL, NULL);
    return TRUE;
  }
  if (web->client != NULL)
    disconnect (web, "replaced by a new connection");
  web->client = g_object_ref (connection);
  web->io = g_cancellable_new ();
  web->event_window_start = g_get_monotonic_time ();
  web->events_in_window = 0;
  g_message ("control: client connected");
  read_header (web);
  return TRUE;
}

gboolean
tc_control_start (TcWeb *web, GError **error)
{
  if (unlink (web->control_path) != 0 && errno != ENOENT) {
    g_set_error (error, G_IO_ERROR, g_io_error_from_errno (errno), "remove stale control socket: %s",
                 g_strerror (errno));
    return FALSE;
  }
  web->service = g_socket_service_new ();
  g_autoptr (GSocketAddress) address = g_unix_socket_address_new (web->control_path);
  if (!g_socket_listener_add_address (G_SOCKET_LISTENER (web->service), address, G_SOCKET_TYPE_STREAM,
                                      G_SOCKET_PROTOCOL_DEFAULT, NULL, NULL, error))
    return FALSE;
  if (chmod (web->control_path, 0660) != 0) {
    g_set_error (error, G_IO_ERROR, g_io_error_from_errno (errno), "chmod control socket: %s", g_strerror (errno));
    return FALSE;
  }
  g_signal_connect (web->service, "incoming", G_CALLBACK (on_incoming), web);
  g_socket_service_start (web->service);
  return TRUE;
}

void
tc_control_stop (TcWeb *web)
{
  disconnect (web, "helper stopping");
  if (web->deferred_source != 0) {
    g_source_remove (web->deferred_source);
    web->deferred_source = 0;
  }
  if (web->service != NULL) {
    g_socket_service_stop (web->service);
    g_socket_listener_close (G_SOCKET_LISTENER (web->service));
    g_clear_object (&web->service);
    unlink (web->control_path);
  }
}
