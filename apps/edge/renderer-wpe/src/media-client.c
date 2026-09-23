#include "media-client.h"
#include "validate.h"

#include <json-glib/json-glib.h>
#include <string.h>

#define TC_MEDIA_MAX_FRAME 512u

static gboolean
read_all (GInputStream *stream, void *buffer, gsize length, GError **error)
{
  gsize received = 0;
  if (!g_input_stream_read_all (stream, buffer, length, &received, NULL, error))
    return FALSE;
  if (received != length) {
    g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_PARTIAL_INPUT, "short media response");
    return FALSE;
  }
  return TRUE;
}

static gboolean
exchange (const char *socket_path, const char *request, GSocketConnection **connection, JsonParser **parser, GError **error)
{
  if (!tc_is_clean_absolute_path (socket_path) || strlen (request) > TC_MEDIA_MAX_FRAME) {
    g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT, "invalid media request");
    return FALSE;
  }
  g_autoptr (GSocketClient) client = g_socket_client_new ();
  g_socket_client_set_timeout (client, 5);
  g_autoptr (GSocketAddress) address = g_unix_socket_address_new (socket_path);
  g_autoptr (GSocketConnection) connected =
    g_socket_client_connect (client, G_SOCKET_CONNECTABLE (address), NULL, error);
  if (connected == NULL)
    return FALSE;

  guint32 request_size = (guint32) strlen (request);
  guint8 header[4] = { request_size >> 24, request_size >> 16, request_size >> 8, request_size };
  GOutputStream *output = g_io_stream_get_output_stream (G_IO_STREAM (connected));
  if (!g_output_stream_write_all (output, header, sizeof header, NULL, NULL, error)
      || !g_output_stream_write_all (output, request, request_size, NULL, NULL, error))
    return FALSE;

  GInputStream *input = g_io_stream_get_input_stream (G_IO_STREAM (connected));
  if (!read_all (input, header, sizeof header, error))
    return FALSE;
  guint32 reply_size = ((guint32) header[0] << 24) | ((guint32) header[1] << 16) | ((guint32) header[2] << 8) | header[3];
  if (reply_size == 0 || reply_size > TC_MEDIA_MAX_FRAME) {
    g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_INVALID_DATA, "invalid media reply length");
    return FALSE;
  }
  char reply[TC_MEDIA_MAX_FRAME + 1];
  if (!read_all (input, reply, reply_size, error))
    return FALSE;
  reply[reply_size] = '\0';
  g_autoptr (JsonParser) parsed = json_parser_new ();
  if (!json_parser_load_from_data (parsed, reply, reply_size, error))
    return FALSE;
  JsonNode *root = json_parser_get_root (parsed);
  if (root == NULL || !JSON_NODE_HOLDS_OBJECT (root)
      || g_strcmp0 (json_object_get_string_member_with_default (json_node_get_object (root), "status", NULL), "ok") != 0) {
    g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "media request denied");
    return FALSE;
  }
  *connection = g_steal_pointer (&connected);
  *parser = g_steal_pointer (&parsed);
  return TRUE;
}

static gboolean
valid_capability (const char *capability, GError **error)
{
  if (tc_is_sha256_hex (capability))
    return TRUE;
  g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT, "invalid media capability");
  return FALSE;
}

static gboolean
integer_member (JsonObject *object, const char *name, guint64 *value)
{
  JsonNode *node = json_object_get_member (object, name);
  if (node == NULL || !JSON_NODE_HOLDS_VALUE (node) || json_node_get_value_type (node) != G_TYPE_INT64)
    return FALSE;
  gint64 number = json_node_get_int (node);
  if (number < 0)
    return FALSE;
  *value = (guint64) number;
  return TRUE;
}

gboolean
tc_media_head (const char *socket_path, const char *capability, guint64 *size, char **mime_type, GError **error)
{
  g_return_val_if_fail (size != NULL && mime_type != NULL, FALSE);
  if (!valid_capability (capability, error))
    return FALSE;
  g_autofree char *request = g_strdup_printf ("{\"op\":\"head\",\"capability\":\"%s\"}", capability);
  g_autoptr (GSocketConnection) connection = NULL;
  g_autoptr (JsonParser) parser = NULL;
  if (!exchange (socket_path, request, &connection, &parser, error))
    return FALSE;
  JsonObject *reply = json_node_get_object (json_parser_get_root (parser));
  JsonNode *type = json_object_get_member (reply, "mimeType");
  guint64 parsed_size;
  if (!integer_member (reply, "sizeBytes", &parsed_size) || type == NULL || !JSON_NODE_HOLDS_VALUE (type)
      || json_node_get_value_type (type) != G_TYPE_STRING || strlen (json_node_get_string (type)) > 128) {
    g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_INVALID_DATA, "invalid media head response");
    return FALSE;
  }
  *size = parsed_size;
  *mime_type = g_strdup (json_node_get_string (type));
  return TRUE;
}

gboolean
tc_media_read (const char *socket_path, const char *capability, guint64 offset, void *buffer, guint32 length,
               GError **error)
{
  if (!valid_capability (capability, error) || buffer == NULL || length == 0 || length > TC_MEDIA_MAX_READ
      || offset > G_MAXINT64 || offset + length < offset || offset + length > G_MAXINT64) {
    if (error != NULL && *error == NULL)
      g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT, "invalid media read");
    return FALSE;
  }
  g_autofree char *request = g_strdup_printf ("{\"op\":\"read\",\"capability\":\"%s\",\"offset\":%" G_GUINT64_FORMAT
                                             ",\"length\":%u}", capability, offset, length);
  g_autoptr (GSocketConnection) connection = NULL;
  g_autoptr (JsonParser) parser = NULL;
  if (!exchange (socket_path, request, &connection, &parser, error))
    return FALSE;
  guint64 response_length;
  if (!integer_member (json_node_get_object (json_parser_get_root (parser)), "length", &response_length)
      || response_length != length) {
    g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_INVALID_DATA, "invalid media read response");
    return FALSE;
  }
  return read_all (g_io_stream_get_input_stream (G_IO_STREAM (connection)), buffer, length, error);
}
