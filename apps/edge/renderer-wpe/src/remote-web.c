#include "remote-web.h"

#include "rw-protocol.h"
#include "validate.h"

#include <gio/gunixsocketaddress.h>
#include <math.h>
#include <string.h>

#define CREATE_TIMEOUT_MS 10000
#define CLEAR_TIMEOUT_MS 30000

typedef struct {
  TcHost *host;
  char id[49];
  WebKitScriptMessageReply *reply; /* pending create; NULL once answered */
  guint timeout;
} Surface;

typedef struct {
  TcHost *host;
  char request_id[49];
  char *command_id;
  guint timeout;
} Clear;

static void read_header (TcHost *host);
static void connect_helper (TcHost *host);
static void disconnect (TcHost *host, const char *reason);

/* ------------------------------------------------------------ bookkeeping */

static void
answer_create (Surface *surface, const char *capability, const char *code)
{
  if (surface->reply == NULL)
    return;
  if (surface->timeout != 0) {
    g_source_remove (surface->timeout);
    surface->timeout = 0;
  }
  g_autofree char *json = NULL;
  if (capability != NULL)
    json = g_strdup_printf ("{\"ok\":true,\"uri\":\"tcweb://cap/%s\"}", capability);
  else
    json = g_strdup_printf ("{\"ok\":false,\"code\":\"%s\"}", code);
  tc_view_reply_json (surface->host, surface->reply, json);
  webkit_script_message_reply_unref (surface->reply);
  surface->reply = NULL;
}

static void
surface_free (gpointer data)
{
  Surface *surface = data;
  answer_create (surface, NULL, "unavailable");
  g_free (surface);
}

static void
clear_free (gpointer data)
{
  Clear *clear = data;
  if (clear->timeout != 0)
    g_source_remove (clear->timeout);
  g_free (clear->command_id);
  g_free (clear);
}

static void
ensure_tables (TcHost *host)
{
  if (host->rw_surfaces == NULL)
    host->rw_surfaces = g_hash_table_new_full (g_str_hash, g_str_equal, NULL, surface_free);
  if (host->rw_clears == NULL)
    host->rw_clears = g_hash_table_new_full (g_str_hash, g_str_equal, NULL, clear_free);
}

static void
send_command_result (TcHost *host, const char *command_id, gboolean success, const char *code)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "commandId");
  json_builder_add_string_value (builder, command_id);
  json_builder_set_member_name (builder, "success");
  json_builder_add_boolean_value (builder, success);
  json_builder_set_member_name (builder, "code");
  json_builder_add_string_value (builder, code);
  json_builder_end_object (builder);
  tc_ipc_send_event (host, "renderer.command_result", json_builder_get_root (builder));
}

/* ------------------------------------------------------------ to the page */

static void
deliver_event (TcHost *host, const char *surface_id, const char *kind, const char *code)
{
  if (!host->runtime_ready)
    return;
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "surfaceId");
  if (surface_id != NULL)
    json_builder_add_string_value (builder, surface_id);
  else
    json_builder_add_null_value (builder);
  json_builder_set_member_name (builder, "kind");
  json_builder_add_string_value (builder, kind);
  if (code != NULL) {
    json_builder_set_member_name (builder, "code");
    json_builder_add_string_value (builder, code);
  }
  json_builder_end_object (builder);
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  g_autofree char *json = json_to_string (root, FALSE);
  tc_view_deliver (host, "remote-web.event", json);
}

/* ------------------------------------------------------------ transport */

/* The helper is untrusted: writes are queued on the bounded async channel
 * and never block the main loop. FALSE means the queue is full (or the
 * helper is gone); every caller then disconnects into the recovery path. */
static gboolean
send_frame (TcHost *host, TcRwFrameKind kind, const char *surface_id, const char *json)
{
  if (host->rw_channel == NULL)
    return FALSE;
  return tc_rw_channel_send (host->rw_channel, kind, surface_id, json);
}

static gboolean
send_node (TcHost *host, TcRwFrameKind kind, const char *surface_id, JsonNode *node)
{
  g_autofree char *json = json_to_string (node, FALSE);
  return send_frame (host, kind, surface_id, json);
}

static void
channel_disconnected (TcRwChannel *channel, const char *reason, gpointer user_data)
{
  (void) channel;
  TcHost *host = user_data;
  disconnect (host, reason);
}

static void
schedule_reconnect (TcHost *host)
{
  if (host->rw_reconnect_source != 0 || host->rw_stopping)
    return;
  guint delay = host->rw_reconnect_delay_ms == 0 ? 500 : host->rw_reconnect_delay_ms;
  host->rw_reconnect_delay_ms = MIN (delay * 2, 5000);
  host->rw_reconnect_source = g_timeout_add_once (delay, (GSourceOnceFunc) connect_helper, host);
}

/* The helper went away: every surface it had is gone, and so is every
 * capability it issued (threat review §15). */
static void
disconnect (TcHost *host, const char *reason)
{
  if (host->rw_connection == NULL)
    return;
  gboolean was_welcomed = host->rw_welcomed;
  g_message ("remote-web: helper disconnected (%s)", reason);
  /* Drop queued outbound frames and invalidate in-flight async writes first,
   * so their completions go stale instead of touching a new connection. */
  tc_rw_channel_detach (host->rw_channel);
  g_cancellable_cancel (host->rw_io);
  g_clear_object (&host->rw_io);
  g_io_stream_close (G_IO_STREAM (host->rw_connection), NULL, NULL);
  g_clear_object (&host->rw_connection);
  host->rw_welcomed = FALSE;
  host->rw_reason = "remote_web_helper_restarting";
  ensure_tables (host);
  gboolean had_surfaces = g_hash_table_size (host->rw_surfaces) > 0;
  g_hash_table_remove_all (host->rw_surfaces);
  GHashTableIter iter;
  gpointer value;
  g_hash_table_iter_init (&iter, host->rw_clears);
  while (g_hash_table_iter_next (&iter, NULL, &value)) {
    Clear *clear = value;
    send_command_result (host, clear->command_id, FALSE, "remote_web_helper_restarted");
    g_hash_table_iter_remove (&iter);
  }
  if (was_welcomed) {
    deliver_event (host, NULL, "process-terminated", "helper_terminated");
    if (had_surfaces || host->welcomed)
      tc_protocol_send_health (host, "degraded", "remote_web_helper_restarting");
  }
  schedule_reconnect (host);
}

static void
handle_message (TcHost *host, JsonObject *object)
{
  TcRwMessage message;
  const char *reason = NULL;
  if (!tc_rw_parse_message (object, &message, &reason)) {
    disconnect (host, "protocol violation");
    return;
  }
  if (!host->rw_welcomed) {
    if (message.type != TC_RW_MSG_WELCOME || message.version != TC_RW_PROTOCOL_VERSION) {
      disconnect (host, "handshake failed");
      return;
    }
    gboolean first = !host->rw_ever_welcomed;
    host->rw_welcomed = TRUE;
    host->rw_ever_welcomed = TRUE;
    host->rw_accelerated = message.accelerated;
    host->rw_reason = NULL;
    host->rw_reconnect_delay_ms = 0;
    g_message ("remote-web: helper ready (%s frames)", message.accelerated ? "GPU" : "software");
    if (first) {
      /* The first welcome adds remote web to what this renderer can show. */
      if (host->runtime_ready)
        tc_protocol_send_ready (host);
    } else {
      deliver_event (host, NULL, "recovered", NULL);
      tc_protocol_send_health (host, "healthy", NULL);
    }
    return;
  }
  ensure_tables (host);
  switch (message.type) {
  case TC_RW_MSG_CREATED:
  case TC_RW_MSG_REJECTED: {
    Surface *surface = g_hash_table_lookup (host->rw_surfaces, message.surface_id);
    if (surface == NULL || surface->reply == NULL) {
      disconnect (host, "reply for no request");
      return;
    }
    if (message.type == TC_RW_MSG_CREATED) {
      answer_create (surface, message.capability, NULL);
    } else {
      answer_create (surface, NULL, message.code);
      g_hash_table_remove (host->rw_surfaces, message.surface_id);
    }
    return;
  }
  case TC_RW_MSG_EVENT:
    /* Events for a surface the runtime already destroyed are dropped. */
    if (g_hash_table_contains (host->rw_surfaces, message.surface_id))
      deliver_event (host, message.surface_id, tc_rw_event_kind_name (message.event),
                     message.code[0] != '\0' ? message.code : NULL);
    return;
  case TC_RW_MSG_CLEARED: {
    Clear *clear = g_hash_table_lookup (host->rw_clears, message.request_id);
    if (clear == NULL)
      return;
    send_command_result (host, clear->command_id, message.ok,
                         message.ok ? "website_data_cleared" : "website_data_clear_failed");
    g_hash_table_remove (host->rw_clears, message.request_id);
    return;
  }
  case TC_RW_MSG_WELCOME:
  case TC_RW_MSG_INVALID:
  default:
    disconnect (host, "unexpected message");
    return;
  }
}

static void
on_payload (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TcHost *host = user_data;
  gsize read = 0;
  g_autoptr (GError) error = NULL;
  gboolean ok = g_input_stream_read_all_finish (G_INPUT_STREAM (source), result, &read, &error);
  if (!ok || read != host->rw_payload_length) {
    g_clear_pointer (&host->rw_payload, g_free);
    if (error == NULL || !g_error_matches (error, G_IO_ERROR, G_IO_ERROR_CANCELLED))
      disconnect (host, error ? error->message : "connection closed");
    return;
  }
  g_autoptr (JsonParser) parser = json_parser_new_immutable ();
  gboolean parsed = g_utf8_validate ((const char *) host->rw_payload, (gssize) host->rw_payload_length, NULL)
                    && json_parser_load_from_data (parser, (const char *) host->rw_payload,
                                                   (gssize) host->rw_payload_length, NULL)
                    && JSON_NODE_HOLDS_OBJECT (json_parser_get_root (parser));
  g_clear_pointer (&host->rw_payload, g_free);
  if (!parsed) {
    disconnect (host, "malformed frame");
    return;
  }
  /* Trusted-side inbound budget: the helper-side EVENT_BUDGET is not a
   * security boundary against a compromised helper, so sustained floods of
   * otherwise-valid frames disconnect here instead of monopolizing the loop. */
  if (!tc_rw_channel_note_incoming (host->rw_channel, g_get_monotonic_time ())) {
    disconnect (host, "event flood");
    return;
  }
  handle_message (host, json_node_get_object (json_parser_get_root (parser)));
  if (host->rw_connection != NULL)
    read_header (host);
}

static void
on_header (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TcHost *host = user_data;
  gsize read = 0;
  g_autoptr (GError) error = NULL;
  if (!g_input_stream_read_all_finish (G_INPUT_STREAM (source), result, &read, &error) || read != 4) {
    if (error == NULL || !g_error_matches (error, G_IO_ERROR, G_IO_ERROR_CANCELLED))
      disconnect (host, error ? error->message : "connection closed");
    return;
  }
  guint32 length = ((guint32) host->rw_header[0] << 24) | ((guint32) host->rw_header[1] << 16)
                   | ((guint32) host->rw_header[2] << 8) | (guint32) host->rw_header[3];
  if (length == 0 || length > TC_RW_MAX_FRAME) {
    disconnect (host, "invalid frame length");
    return;
  }
  host->rw_payload_length = length;
  host->rw_payload = g_malloc (length);
  GInputStream *in = g_io_stream_get_input_stream (G_IO_STREAM (host->rw_connection));
  g_input_stream_read_all_async (in, host->rw_payload, length, G_PRIORITY_DEFAULT, host->rw_io, on_payload, host);
}

static void
read_header (TcHost *host)
{
  GInputStream *in = g_io_stream_get_input_stream (G_IO_STREAM (host->rw_connection));
  g_input_stream_read_all_async (in, host->rw_header, 4, G_PRIORITY_DEFAULT, host->rw_io, on_header, host);
}

static void
on_connected (GObject *source, GAsyncResult *result, gpointer user_data)
{
  TcHost *host = user_data;
  g_autoptr (GError) error = NULL;
  GSocketConnection *connection = g_socket_client_connect_finish (G_SOCKET_CLIENT (source), result, &error);
  g_object_unref (source);
  if (connection == NULL) {
    g_debug ("remote-web: helper not reachable: %s", error->message);
    if (!host->rw_ever_welcomed)
      host->rw_reason = "remote_web_helper_unavailable";
    schedule_reconnect (host);
    return;
  }
  host->rw_connection = connection;
  host->rw_io = g_cancellable_new ();
  tc_rw_channel_attach (host->rw_channel, connection);
  /* Queued, never blocking: an empty queue cannot be full. */
  if (!send_frame (host, TC_RW_FRAME_HELLO, NULL, "{\"type\":\"hello\",\"version\":1}")) {
    disconnect (host, "hello failed");
    return;
  }
  read_header (host);
}

static void
connect_helper (TcHost *host)
{
  host->rw_reconnect_source = 0;
  if (host->rw_connection != NULL || host->rw_stopping)
    return;
  GSocketClient *client = g_socket_client_new ();
  g_autoptr (GSocketAddress) address = g_unix_socket_address_new (host->web_control_socket);
  g_socket_client_connect_async (client, G_SOCKET_CONNECTABLE (address), NULL, on_connected, host);
}

void
tc_remote_web_start (TcHost *host)
{
  ensure_tables (host);
  if (host->rw_channel == NULL)
    host->rw_channel = tc_rw_channel_new (channel_disconnected, host);
  host->rw_reason = "remote_web_helper_unavailable";
  connect_helper (host);
}

void
tc_remote_web_stop (TcHost *host)
{
  host->rw_stopping = TRUE;
  if (host->rw_reconnect_source != 0) {
    g_source_remove (host->rw_reconnect_source);
    host->rw_reconnect_source = 0;
  }
  disconnect (host, "renderer stopping");
  /* Detach first so late completions go stale; a dispatched GIO write can
   * still complete afterwards, but its ticket validates against the
   * channel's identity record — which outlives the channel — and returns
   * without touching freed state. */
  tc_rw_channel_free (host->rw_channel);
  host->rw_channel = NULL;
  g_clear_pointer (&host->rw_surfaces, g_hash_table_unref);
  g_clear_pointer (&host->rw_clears, g_hash_table_unref);
}

gboolean
tc_remote_web_available (TcHost *host)
{
  return host->rw_ever_welcomed;
}

gboolean
tc_remote_web_accelerated (TcHost *host)
{
  return host->rw_accelerated;
}

const char *
tc_remote_web_reason (TcHost *host)
{
  return host->rw_welcomed ? NULL : host->rw_reason;
}

/* ------------------------------------------------------------ from the page */

static gboolean
on_create_timeout (gpointer data)
{
  Surface *surface = data;
  surface->timeout = 0;
  answer_create (surface, NULL, "unavailable");
  return G_SOURCE_REMOVE;
}

static guint
device_pixels (JsonObject *viewport, const char *member)
{
  double css = json_object_get_double_member_with_default (viewport, member, 0);
  double scale = json_object_get_double_member_with_default (viewport, "deviceScale", 1);
  if (!isfinite (css) || !isfinite (scale) || scale < 1 || scale > 4)
    return 0;
  double pixels = round (css * scale);
  return pixels < 1 || pixels > 100000 ? 0 : (guint) pixels;
}

void
tc_remote_web_create (TcHost *host, JsonObject *message, WebKitScriptMessageReply *reply)
{
  ensure_tables (host);
  JsonObject *spec = json_object_get_object_member (message, "spec");
  JsonObject *viewport = spec ? json_object_get_object_member (spec, "viewport") : NULL;
  JsonNode *content = spec ? json_object_get_member (spec, "content") : NULL;
  const char *surface_id = spec ? json_object_get_string_member_with_default (spec, "surfaceId", NULL) : NULL;
  const char *code = NULL;
  g_autoptr (JsonNode) request = NULL;
  if (!host->rw_welcomed) {
    code = "unavailable";
  } else if (viewport == NULL || content == NULL || !JSON_NODE_HOLDS_OBJECT (content) || !tc_rw_is_surface_id (surface_id)
             || g_hash_table_contains (host->rw_surfaces, surface_id)) {
    code = "invalid_request";
  } else if (g_hash_table_size (host->rw_surfaces) >= TC_RW_MAX_SURFACES) {
    code = "limit_exceeded";
  } else {
    /* Rebuild the helper frame from typed parts only; the parser then
     * refuses any member the protocol does not define. */
    g_autoptr (JsonBuilder) builder = json_builder_new ();
    json_builder_begin_object (builder);
    json_builder_set_member_name (builder, "type");
    json_builder_add_string_value (builder, "create");
    json_builder_set_member_name (builder, "surfaceId");
    json_builder_add_string_value (builder, surface_id);
    json_builder_set_member_name (builder, "width");
    json_builder_add_int_value (builder, device_pixels (viewport, "width"));
    json_builder_set_member_name (builder, "height");
    json_builder_add_int_value (builder, device_pixels (viewport, "height"));
    json_builder_set_member_name (builder, "muted");
    json_builder_add_boolean_value (builder, json_object_get_boolean_member_with_default (spec, "muted", TRUE));
    json_builder_set_member_name (builder, "visible");
    json_builder_add_boolean_value (builder, json_object_get_boolean_member_with_default (spec, "visible", FALSE));
    json_builder_set_member_name (builder, "content");
    json_builder_add_value (builder, json_node_copy (content));
    json_builder_end_object (builder);
    request = json_builder_get_root (builder);
    TcRwRequest parsed;
    const char *reason = NULL;
    if (!tc_rw_parse_request (json_node_get_object (request), &parsed, &reason)) {
      code = "invalid_request";
    } else {
      tc_rw_create_clear (&parsed.create);
    }
  }
  if (code != NULL) {
    g_autofree char *json = g_strdup_printf ("{\"ok\":false,\"code\":\"%s\"}", code);
    tc_view_reply_json (host, reply, json);
    return;
  }
  Surface *surface = g_new0 (Surface, 1);
  surface->host = host;
  g_strlcpy (surface->id, surface_id, sizeof surface->id);
  surface->reply = webkit_script_message_reply_ref (reply);
  surface->timeout = g_timeout_add (CREATE_TIMEOUT_MS, on_create_timeout, surface);
  g_hash_table_insert (host->rw_surfaces, surface->id, surface);
  if (!send_node (host, TC_RW_FRAME_CREATE, surface_id, request))
    disconnect (host, "backpressure");
}

void
tc_remote_web_page_message (TcHost *host, const char *type, JsonObject *message)
{
  ensure_tables (host);
  const char *surface_id = json_object_get_string_member_with_default (message, "surfaceId", NULL);
  if (!tc_rw_is_surface_id (surface_id) || !g_hash_table_contains (host->rw_surfaces, surface_id))
    return;
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "surfaceId");
  json_builder_add_string_value (builder, surface_id);
  json_builder_set_member_name (builder, "type");
  TcRwFrameKind kind = TC_RW_FRAME_DESTROY;
  if (g_strcmp0 (type, "remote_web.viewport") == 0) {
    guint width = device_pixels (message, "width");
    guint height = device_pixels (message, "height");
    if (width < TC_RW_MIN_EDGE || height < TC_RW_MIN_EDGE || width > TC_RW_MAX_EDGE || height > TC_RW_MAX_EDGE)
      return;
    kind = TC_RW_FRAME_RESIZE;
    json_builder_add_string_value (builder, "resize");
    json_builder_set_member_name (builder, "width");
    json_builder_add_int_value (builder, width);
    json_builder_set_member_name (builder, "height");
    json_builder_add_int_value (builder, height);
  } else if (g_strcmp0 (type, "remote_web.visible") == 0 || g_strcmp0 (type, "remote_web.muted") == 0) {
    gboolean visible = g_strcmp0 (type, "remote_web.visible") == 0;
    kind = visible ? TC_RW_FRAME_VISIBLE : TC_RW_FRAME_MUTE;
    json_builder_add_string_value (builder, visible ? "visible" : "mute");
    json_builder_set_member_name (builder, visible ? "visible" : "muted");
    json_builder_add_boolean_value (builder, json_object_get_boolean_member_with_default (
                                               message, visible ? "visible" : "muted", !visible));
  } else if (g_strcmp0 (type, "remote_web.reload") == 0) {
    kind = TC_RW_FRAME_RELOAD;
    json_builder_add_string_value (builder, "reload");
  } else if (g_strcmp0 (type, "remote_web.destroy") == 0) {
    kind = TC_RW_FRAME_DESTROY;
    json_builder_add_string_value (builder, "destroy");
  } else {
    return;
  }
  json_builder_end_object (builder);
  g_autoptr (JsonNode) request = json_builder_get_root (builder);
  if (g_strcmp0 (type, "remote_web.destroy") == 0)
    g_hash_table_remove (host->rw_surfaces, surface_id);
  if (host->rw_welcomed && !send_node (host, kind, surface_id, request))
    disconnect (host, "backpressure");
}

void
tc_remote_web_reset (TcHost *host)
{
  if (host->rw_surfaces == NULL)
    return;
  GHashTableIter iter;
  gpointer key;
  g_hash_table_iter_init (&iter, host->rw_surfaces);
  while (g_hash_table_iter_next (&iter, &key, NULL)) {
    if (host->rw_welcomed) {
      g_autofree char *json = g_strdup_printf ("{\"type\":\"destroy\",\"surfaceId\":\"%s\"}", (const char *) key);
      if (!send_frame (host, TC_RW_FRAME_DESTROY, key, json)) {
        g_hash_table_iter_remove (&iter);
        disconnect (host, "backpressure");
        return;
      }
    }
    g_hash_table_iter_remove (&iter);
  }
}

static gboolean
on_clear_timeout (gpointer data)
{
  Clear *clear = data;
  clear->timeout = 0;
  send_command_result (clear->host, clear->command_id, FALSE, "remote_web_timeout");
  g_hash_table_remove (clear->host->rw_clears, clear->request_id);
  return G_SOURCE_REMOVE;
}

void
tc_remote_web_clear (TcHost *host, const char *command_id)
{
  ensure_tables (host);
  if (!host->rw_welcomed) {
    send_command_result (host, command_id, FALSE, "remote_web_unavailable");
    return;
  }
  if (g_hash_table_size (host->rw_clears) >= TC_RW_MAX_IN_FLIGHT) {
    send_command_result (host, command_id, FALSE, "remote_web_busy");
    return;
  }
  Clear *clear = g_new0 (Clear, 1);
  clear->host = host;
  g_snprintf (clear->request_id, sizeof clear->request_id, "c-%" G_GUINT64_FORMAT, ++host->rw_next_clear);
  clear->command_id = g_strdup (command_id);
  clear->timeout = g_timeout_add (CLEAR_TIMEOUT_MS, on_clear_timeout, clear);
  g_hash_table_insert (host->rw_clears, clear->request_id, clear);
  g_autofree char *json = g_strdup_printf ("{\"type\":\"clear-data\",\"requestId\":\"%s\"}", clear->request_id);
  if (!send_frame (host, TC_RW_FRAME_CLEAR, NULL, json))
    disconnect (host, "backpressure");
}
