/*
 * The Edge IPC client: AF_UNIX stream, u32 big-endian length + one UTF-8
 * JSON object (edge_protocol::ipc), the same framing as the renderer.
 *
 * The bridge reconnects with a bounded backoff while tilecastd restarts.
 * When the socket file is gone for TB_SOCKET_GONE_EXIT_US (Edge was stopped
 * or rolled back), the bridge exits 0; tilecast-session-bridge.path starts
 * it again when the socket returns.
 */
#include "bridge.h"

#include <gio/gunixsocketaddress.h>
#include <string.h>

#define TB_SOCKET_GONE_EXIT_US (30 * G_USEC_PER_SEC)

static void read_header (TbBridge *bridge);

static void
schedule_reconnect (TbBridge *bridge)
{
  if (bridge->reconnect_source != 0)
    return;
  if (!g_file_test (bridge->socket_path, G_FILE_TEST_EXISTS)) {
    gint64 now = g_get_monotonic_time ();
    if (bridge->socket_missing_since == 0)
      bridge->socket_missing_since = now;
    else if (now - bridge->socket_missing_since > TB_SOCKET_GONE_EXIT_US) {
      g_message ("ipc: %s is gone; exiting until Edge runs again", bridge->socket_path);
      g_main_loop_quit (bridge->loop);
      return;
    }
  } else {
    bridge->socket_missing_since = 0;
  }
  guint delay = bridge->reconnect_delay_ms == 0 ? 250 : bridge->reconnect_delay_ms;
  bridge->reconnect_delay_ms = MIN (delay * 2, 5000);
  bridge->reconnect_source = g_timeout_add_once (delay, (GSourceOnceFunc) tb_ipc_start, bridge);
}

static void
disconnect (TbBridge *bridge, const char *reason)
{
  if (bridge->connection == NULL)
    return;
  g_message ("ipc: disconnected (%s)", reason);
  g_cancellable_cancel (bridge->io_cancellable);
  g_clear_object (&bridge->io_cancellable);
  g_io_stream_close (G_IO_STREAM (bridge->connection), NULL, NULL);
  g_clear_object (&bridge->connection);
  bridge->welcomed = FALSE;
  /* Without tilecastd nobody asked for the microphone. */
  tb_capture_set_wanted (bridge, FALSE);
}

static void
fail (TbBridge *bridge, const char *reason)
{
  disconnect (bridge, reason);
  schedule_reconnect (bridge);
}

static gboolean
write_frame (TbBridge *bridge, JsonNode *root)
{
  if (bridge->connection == NULL)
    return FALSE;
  g_autofree char *payload = json_to_string (root, FALSE);
  gsize length = strlen (payload);
  if (length == 0 || length > TB_MAX_OUTBOUND_FRAME_BYTES) {
    g_warning ("ipc: refusing to send a frame of %" G_GSIZE_FORMAT " bytes", length);
    return FALSE;
  }
  guchar header[4] = { (guchar) (length >> 24), (guchar) (length >> 16), (guchar) (length >> 8), (guchar) length };
  GOutputStream *out = g_io_stream_get_output_stream (G_IO_STREAM (bridge->connection));
  g_autoptr (GError) error = NULL;
  if (!g_output_stream_write_all (out, header, 4, NULL, NULL, &error)
      || !g_output_stream_write_all (out, payload, length, NULL, NULL, &error)
      || !g_output_stream_flush (out, NULL, &error)) {
    fail (bridge, error ? error->message : "write failed");
    return FALSE;
  }
  return TRUE;
}

gboolean
tb_ipc_send_event (TbBridge *bridge, const char *name, JsonNode *data)
{
  if (!bridge->welcomed) {
    json_node_unref (data);
    return FALSE;
  }
  g_autoptr (JsonNode) frame = tb_event_frame (bridge->next_outbound_seq, name, data);
  if (!write_frame (bridge, frame))
    return FALSE;
  bridge->next_outbound_seq++;
  return TRUE;
}

void
tb_ipc_announce (TbBridge *bridge)
{
  tb_inventory_send (bridge);
  tb_capture_send_state (bridge);
}

static void
handle_event (TbBridge *bridge, JsonObject *frame)
{
  const char *name = json_object_get_string_member_with_default (frame, "event", "");
  if (g_strcmp0 (name, "capture.set") != 0) {
    fail (bridge, "unexpected event");
    return;
  }
  gboolean enabled = FALSE;
  if (!tb_parse_capture_set (json_object_get_member (frame, "data"), &enabled)) {
    fail (bridge, "malformed capture.set");
    return;
  }
  tb_capture_set_wanted (bridge, enabled);
}

static void
handle_payload (TbBridge *bridge)
{
  g_autoptr (JsonParser) parser = json_parser_new_immutable ();
  if (!g_utf8_validate ((const char *) bridge->payload, (gssize) bridge->payload_length, NULL)
      || !json_parser_load_from_data (parser, (const char *) bridge->payload, (gssize) bridge->payload_length, NULL)) {
    fail (bridge, "malformed frame");
    return;
  }
  JsonNode *root = json_parser_get_root (parser);
  if (root == NULL || !JSON_NODE_HOLDS_OBJECT (root)) {
    fail (bridge, "frame is not an object");
    return;
  }
  JsonObject *frame = json_node_get_object (root);
  const char *type = json_object_get_string_member_with_default (frame, "type", "");
  if (!bridge->welcomed) {
    if (g_strcmp0 (type, "welcome") == 0
        && g_strcmp0 (json_object_get_string_member_with_default (frame, "role", ""), "session_bridge") == 0) {
      bridge->welcomed = TRUE;
      bridge->reconnect_delay_ms = 0;
      bridge->next_outbound_seq = 1;
      bridge->expected_inbound_seq = 1;
      g_message ("ipc: session %s opened", json_object_get_string_member_with_default (frame, "sessionId", "?"));
      tb_ipc_announce (bridge);
      return;
    }
    if (g_strcmp0 (type, "rejected") == 0)
      g_warning ("ipc: tilecastd rejected the session: %s",
                 json_object_get_string_member_with_default (frame, "code", ""));
    fail (bridge, "handshake failed");
    return;
  }
  if (g_strcmp0 (type, "goodbye") == 0) {
    fail (bridge, json_object_get_string_member_with_default (frame, "reason", "goodbye"));
    return;
  }
  if (g_strcmp0 (type, "event") != 0) {
    /* The bridge sends no requests, so no response can be for it. */
    fail (bridge, "unexpected frame");
    return;
  }
  if (json_object_get_int_member_with_default (frame, "seq", -1) != (gint64) bridge->expected_inbound_seq) {
    fail (bridge, "event sequence violation");
    return;
  }
  bridge->expected_inbound_seq++;
  handle_event (bridge, frame);
}

static void
on_payload (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TbBridge *bridge = user_data;
  gsize read = 0;
  g_autoptr (GError) error = NULL;
  gboolean ok = g_input_stream_read_all_finish (G_INPUT_STREAM (source), result, &read, &error);
  if (!ok || read != bridge->payload_length) {
    g_clear_pointer (&bridge->payload, g_free);
    if (ok || !g_error_matches (error, G_IO_ERROR, G_IO_ERROR_CANCELLED))
      fail (bridge, ok ? "connection closed" : error->message);
    return;
  }
  handle_payload (bridge);
  g_clear_pointer (&bridge->payload, g_free);
  if (bridge->connection != NULL)
    read_header (bridge);
}

static void
on_header (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TbBridge *bridge = user_data;
  gsize read = 0;
  g_autoptr (GError) error = NULL;
  if (!g_input_stream_read_all_finish (G_INPUT_STREAM (source), result, &read, &error)) {
    if (!g_error_matches (error, G_IO_ERROR, G_IO_ERROR_CANCELLED))
      fail (bridge, error->message);
    return;
  }
  if (read != 4) {
    fail (bridge, "connection closed");
    return;
  }
  guint32 length = ((guint32) bridge->header[0] << 24) | ((guint32) bridge->header[1] << 16)
                   | ((guint32) bridge->header[2] << 8) | (guint32) bridge->header[3];
  if (length == 0 || length > TB_MAX_INBOUND_FRAME_BYTES) {
    /* Checked before allocating. */
    fail (bridge, "invalid frame length");
    return;
  }
  bridge->payload_length = length;
  bridge->payload = g_malloc (length);
  GInputStream *in = g_io_stream_get_input_stream (G_IO_STREAM (bridge->connection));
  g_input_stream_read_all_async (in, bridge->payload, length, G_PRIORITY_DEFAULT, bridge->io_cancellable, on_payload,
                                 bridge);
}

static void
read_header (TbBridge *bridge)
{
  GInputStream *in = g_io_stream_get_input_stream (G_IO_STREAM (bridge->connection));
  g_input_stream_read_all_async (in, bridge->header, 4, G_PRIORITY_DEFAULT, bridge->io_cancellable, on_header, bridge);
}

static void
on_connected (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TbBridge *bridge = user_data;
  g_autoptr (GError) error = NULL;
  GSocketConnection *connection = g_socket_client_connect_finish (G_SOCKET_CLIENT (source), result, &error);
  g_object_unref (source);
  if (connection == NULL) {
    g_debug ("ipc: connect failed: %s", error->message);
    schedule_reconnect (bridge);
    return;
  }
  bridge->socket_missing_since = 0;
  bridge->connection = connection;
  bridge->io_cancellable = g_cancellable_new ();
  g_autoptr (JsonNode) hello = tb_hello_frame (TB_VERSION);
  if (write_frame (bridge, hello))
    read_header (bridge);
}

void
tb_ipc_start (TbBridge *bridge)
{
  bridge->reconnect_source = 0;
  if (bridge->connection != NULL)
    return;
  GSocketClient *client = g_socket_client_new ();
  g_autoptr (GSocketAddress) address = g_unix_socket_address_new (bridge->socket_path);
  g_socket_client_connect_async (client, G_SOCKET_CONNECTABLE (address), NULL, on_connected, bridge);
}

void
tb_ipc_stop (TbBridge *bridge, const char *reason)
{
  if (bridge->reconnect_source != 0) {
    g_source_remove (bridge->reconnect_source);
    bridge->reconnect_source = 0;
  }
  if (bridge->connection != NULL && bridge->welcomed) {
    g_autoptr (JsonBuilder) builder = json_builder_new ();
    json_builder_begin_object (builder);
    json_builder_set_member_name (builder, "type");
    json_builder_add_string_value (builder, "goodbye");
    json_builder_set_member_name (builder, "reason");
    json_builder_add_string_value (builder, reason);
    json_builder_end_object (builder);
    g_autoptr (JsonNode) root = json_builder_get_root (builder);
    write_frame (bridge, root);
  }
  disconnect (bridge, reason);
}
