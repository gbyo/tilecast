#include "protocol.h"

JsonNode *
tb_event_frame (guint64 seq, const char *name, JsonNode *data)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "type");
  json_builder_add_string_value (builder, "event");
  json_builder_set_member_name (builder, "seq");
  json_builder_add_int_value (builder, (gint64) seq);
  json_builder_set_member_name (builder, "event");
  json_builder_add_string_value (builder, name);
  json_builder_set_member_name (builder, "data");
  json_builder_add_value (builder, data);
  json_builder_end_object (builder);
  return json_builder_get_root (builder);
}

JsonNode *
tb_hello_frame (const char *version)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "type");
  json_builder_add_string_value (builder, "hello");
  json_builder_set_member_name (builder, "minProtocolVersion");
  json_builder_add_int_value (builder, TB_PROTOCOL_VERSION);
  json_builder_set_member_name (builder, "maxProtocolVersion");
  json_builder_add_int_value (builder, TB_PROTOCOL_VERSION);
  json_builder_set_member_name (builder, "role");
  json_builder_add_string_value (builder, "session_bridge");
  json_builder_set_member_name (builder, "client");
  json_builder_add_string_value (builder, "tilecast-session-bridge");
  json_builder_set_member_name (builder, "clientVersion");
  json_builder_add_string_value (builder, version);
  json_builder_set_member_name (builder, "features");
  json_builder_begin_array (builder);
  json_builder_end_array (builder);
  json_builder_end_object (builder);
  return json_builder_get_root (builder);
}
