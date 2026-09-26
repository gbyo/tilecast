/*
 * IPC transport: AF_UNIX stream, u32 big-endian length + UTF-8 JSON object
 * (edge_protocol::ipc). Frames are written synchronously; they are small and
 * the daemon reads continuously. Reads are asynchronous on the main loop.
 *
 * On disconnect the renderer keeps showing what it has and reconnects with a
 * bounded backoff. After reconnecting it says hello again; tilecastd sends
 * renderer.configure and, after renderer.ready, the current activation.
 */
#include "host.h"

#include <gio/gunixsocketaddress.h>
#include <string.h>

static void read_header (TcHost *host);

static void
schedule_reconnect (TcHost *host)
{
  if (host->reconnect_source != 0)
    return;
  guint delay = host->reconnect_delay_ms == 0 ? 250 : host->reconnect_delay_ms;
  host->reconnect_delay_ms = MIN (delay * 2, 5000);
  host->reconnect_source = g_timeout_add_once (delay, (GSourceOnceFunc) tc_ipc_start, host);
}

static void
disconnect (TcHost *host, const char *reason)
{
  if (host->connection == NULL)
    return;
  g_message ("ipc: disconnected (%s)", reason);
  g_cancellable_cancel (host->io_cancellable);
  g_clear_object (&host->io_cancellable);
  g_io_stream_close (G_IO_STREAM (host->connection), NULL, NULL);
  g_clear_object (&host->connection);
  /* host->payload is freed by the read callback, which always runs (with
   * G_IO_ERROR_CANCELLED) after cancellation. */
  host->welcomed = FALSE;
  /* Pending page requests will never be answered by this session. */
  GHashTableIter iter;
  gpointer key, value;
  g_hash_table_iter_init (&iter, host->pending_replies);
  while (g_hash_table_iter_next (&iter, &key, &value)) {
    webkit_script_message_reply_return_error_message (value, "tilecastd is not reachable");
    g_hash_table_iter_remove (&iter);
  }
}

static gboolean
write_frame (TcHost *host, JsonNode *root)
{
  if (host->connection == NULL)
    return FALSE;
  gsize length = 0;
  g_autofree char *payload = json_to_string (root, FALSE);
  length = strlen (payload);
  if (length == 0 || length > TC_MAX_FRAME_BYTES) {
    g_warning ("ipc: refusing to send a frame of %" G_GSIZE_FORMAT " bytes", length);
    return FALSE;
  }
  guchar header[4] = { (guchar) (length >> 24), (guchar) (length >> 16), (guchar) (length >> 8), (guchar) length };
  GOutputStream *out = g_io_stream_get_output_stream (G_IO_STREAM (host->connection));
  g_autoptr (GError) error = NULL;
  if (!g_output_stream_write_all (out, header, 4, NULL, NULL, &error)
      || !g_output_stream_write_all (out, payload, length, NULL, NULL, &error)
      || !g_output_stream_flush (out, NULL, &error)) {
    disconnect (host, error ? error->message : "write failed");
    schedule_reconnect (host);
    return FALSE;
  }
  return TRUE;
}

gboolean
tc_ipc_send_event (TcHost *host, const char *name, JsonNode *data)
{
  if (!host->welcomed) {
    json_node_unref (data);
    return FALSE;
  }
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "type");
  json_builder_add_string_value (builder, "event");
  json_builder_set_member_name (builder, "seq");
  json_builder_add_int_value (builder, (gint64) host->next_outbound_seq);
  json_builder_set_member_name (builder, "event");
  json_builder_add_string_value (builder, name);
  json_builder_set_member_name (builder, "data");
  json_builder_add_value (builder, data);
  json_builder_end_object (builder);
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  if (!write_frame (host, root))
    return FALSE;
  host->next_outbound_seq++;
  return TRUE;
}

gboolean
tc_ipc_send_request (TcHost *host, const char *method, JsonNode *params, char **out_id)
{
  if (!host->welcomed) {
    json_node_unref (params);
    return FALSE;
  }
  /* Request IDs are protocol tokens: lowercase letter first. */
  g_autofree char *id = g_strdup_printf ("r%" G_GUINT64_FORMAT, ++host->next_request_id);
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "type");
  json_builder_add_string_value (builder, "request");
  json_builder_set_member_name (builder, "id");
  json_builder_add_string_value (builder, id);
  json_builder_set_member_name (builder, "method");
  json_builder_add_string_value (builder, method);
  json_builder_set_member_name (builder, "params");
  json_builder_add_value (builder, params);
  json_builder_end_object (builder);
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  if (!write_frame (host, root))
    return FALSE;
  if (out_id != NULL)
    *out_id = g_steal_pointer (&id);
  return TRUE;
}

static void
send_hello (TcHost *host)
{
  static const char *const features[] = { NULL };
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "type");
  json_builder_add_string_value (builder, "hello");
  json_builder_set_member_name (builder, "minProtocolVersion");
  json_builder_add_int_value (builder, TC_IPC_PROTOCOL_VERSION);
  json_builder_set_member_name (builder, "maxProtocolVersion");
  json_builder_add_int_value (builder, TC_IPC_PROTOCOL_VERSION);
  json_builder_set_member_name (builder, "role");
  json_builder_add_string_value (builder, "renderer");
  json_builder_set_member_name (builder, "client");
  json_builder_add_string_value (builder, "tilecast-renderer-wpe");
  json_builder_set_member_name (builder, "clientVersion");
  json_builder_add_string_value (builder, TC_RENDERER_VERSION);
  json_builder_set_member_name (builder, "features");
  json_builder_begin_array (builder);
  for (guint i = 0; features[i] != NULL; i++)
    json_builder_add_string_value (builder, features[i]);
  json_builder_end_array (builder);
  json_builder_end_object (builder);
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  write_frame (host, root);
}

static void
handle_payload (TcHost *host)
{
  g_autoptr (JsonParser) parser = json_parser_new_immutable ();
  g_autoptr (GError) error = NULL;
  if (!g_utf8_validate ((const char *) host->payload, (gssize) host->payload_length, NULL)
      || !json_parser_load_from_data (parser, (const char *) host->payload, (gssize) host->payload_length, &error)) {
    disconnect (host, "malformed frame");
    schedule_reconnect (host);
    return;
  }
  JsonNode *root = json_parser_get_root (parser);
  if (root == NULL || !JSON_NODE_HOLDS_OBJECT (root)) {
    disconnect (host, "frame is not an object");
    schedule_reconnect (host);
    return;
  }
  JsonObject *frame = json_node_get_object (root);
  const char *type = json_object_get_string_member_with_default (frame, "type", "");
  if (!host->welcomed) {
    if (g_strcmp0 (type, "welcome") == 0) {
      host->welcomed = TRUE;
      host->reconnect_delay_ms = 0;
      host->next_outbound_seq = 1;
      host->expected_inbound_seq = 1;
      g_message ("ipc: session %s opened", json_object_get_string_member_with_default (frame, "sessionId", "?"));
      if (host->runtime_ready)
        tc_protocol_send_ready (host);
      return;
    }
    if (g_strcmp0 (type, "rejected") == 0) {
      g_warning ("ipc: tilecastd rejected the session: %s (%s)",
                 json_object_get_string_member_with_default (frame, "message", ""),
                 json_object_get_string_member_with_default (frame, "code", ""));
    }
    disconnect (host, "handshake failed");
    schedule_reconnect (host);
    return;
  }
  if (g_strcmp0 (type, "goodbye") == 0) {
    disconnect (host, json_object_get_string_member_with_default (frame, "reason", "goodbye"));
    schedule_reconnect (host);
    return;
  }
  if (g_strcmp0 (type, "event") == 0) {
    gint64 seq = json_object_get_int_member_with_default (frame, "seq", -1);
    if (seq != (gint64) host->expected_inbound_seq) {
      disconnect (host, "event sequence violation");
      schedule_reconnect (host);
      return;
    }
    host->expected_inbound_seq++;
  }
  tc_protocol_handle_frame (host, frame);
}

static void
on_payload (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TcHost *host = user_data;
  gsize read = 0;
  g_autoptr (GError) error = NULL;
  gboolean ok = g_input_stream_read_all_finish (G_INPUT_STREAM (source), result, &read, &error);
  if (!ok) {
    g_clear_pointer (&host->payload, g_free);
    if (!g_error_matches (error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
      disconnect (host, error->message);
      schedule_reconnect (host);
    }
    return;
  }
  if (read != host->payload_length) {
    g_clear_pointer (&host->payload, g_free);
    disconnect (host, "connection closed");
    schedule_reconnect (host);
    return;
  }
  handle_payload (host);
  g_clear_pointer (&host->payload, g_free);
  if (host->connection != NULL)
    read_header (host);
}

static void
on_header (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TcHost *host = user_data;
  gsize read = 0;
  g_autoptr (GError) error = NULL;
  if (!g_input_stream_read_all_finish (G_INPUT_STREAM (source), result, &read, &error)) {
    if (!g_error_matches (error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
      disconnect (host, error->message);
      schedule_reconnect (host);
    }
    return;
  }
  if (read != 4) {
    disconnect (host, "connection closed");
    schedule_reconnect (host);
    return;
  }
  guint32 length = ((guint32) host->header[0] << 24) | ((guint32) host->header[1] << 16)
                   | ((guint32) host->header[2] << 8) | (guint32) host->header[3];
  if (length == 0 || length > TC_MAX_FRAME_BYTES) {
    /* Validated before allocating: an oversized length never buffers. */
    disconnect (host, "invalid frame length");
    schedule_reconnect (host);
    return;
  }
  host->payload_length = length;
  host->payload = g_malloc (length);
  GInputStream *in = g_io_stream_get_input_stream (G_IO_STREAM (host->connection));
  g_input_stream_read_all_async (in, host->payload, length, G_PRIORITY_DEFAULT, host->io_cancellable, on_payload, host);
}

static void
read_header (TcHost *host)
{
  GInputStream *in = g_io_stream_get_input_stream (G_IO_STREAM (host->connection));
  g_input_stream_read_all_async (in, host->header, 4, G_PRIORITY_DEFAULT, host->io_cancellable, on_header, host);
}

static void
on_connected (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TcHost *host = user_data;
  g_autoptr (GError) error = NULL;
  GSocketConnection *connection = g_socket_client_connect_finish (G_SOCKET_CLIENT (source), result, &error);
  g_object_unref (source);
  if (connection == NULL) {
    g_debug ("ipc: connect failed: %s", error->message);
    schedule_reconnect (host);
    return;
  }
  host->connection = connection;
  host->io_cancellable = g_cancellable_new ();
  send_hello (host);
  if (host->connection != NULL)
    read_header (host);
}

void
tc_ipc_start (TcHost *host)
{
  host->reconnect_source = 0;
  if (host->connection != NULL)
    return;
  GSocketClient *client = g_socket_client_new ();
  g_autoptr (GSocketAddress) address = g_unix_socket_address_new (host->socket_path);
  g_socket_client_connect_async (client, G_SOCKET_CONNECTABLE (address), NULL, on_connected, host);
}

void
tc_ipc_stop (TcHost *host, const char *reason)
{
  if (host->reconnect_source != 0) {
    g_source_remove (host->reconnect_source);
    host->reconnect_source = 0;
  }
  if (host->connection != NULL && host->welcomed) {
    g_autoptr (JsonBuilder) builder = json_builder_new ();
    json_builder_begin_object (builder);
    json_builder_set_member_name (builder, "type");
    json_builder_add_string_value (builder, "goodbye");
    json_builder_set_member_name (builder, "reason");
    json_builder_add_string_value (builder, reason);
    json_builder_end_object (builder);
    g_autoptr (JsonNode) root = json_builder_get_root (builder);
    write_frame (host, root);
  }
  disconnect (host, reason);
}
