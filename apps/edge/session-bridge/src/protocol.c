#include "protocol.h"

#include <math.h>

const char *
tb_capture_state_name (TbCaptureState state)
{
  switch (state) {
  case TB_CAPTURE_STARTING:
    return "starting";
  case TB_CAPTURE_CAPTURING:
    return "capturing";
  case TB_CAPTURE_NO_MICROPHONE:
    return "no_microphone";
  case TB_CAPTURE_PIPEWIRE_UNAVAILABLE:
    return "pipewire_unavailable";
  case TB_CAPTURE_PERMISSION_DENIED:
    return "permission_denied";
  case TB_CAPTURE_FAILED:
    return "capture_failed";
  case TB_CAPTURE_RECOVERING:
    return "recovering";
  case TB_CAPTURE_IDLE:
  default:
    return "idle";
  }
}

gboolean
tb_rms_from_decibels (const double *decibels, guint channels, double *rms)
{
  if (decibels == NULL || channels == 0 || rms == NULL)
    return FALSE;
  double power = 0.0;
  for (guint i = 0; i < channels; i++) {
    if (isnan (decibels[i]))
      return FALSE;
    /* -inf dB is silence: pow() returns 0. */
    power += pow (10.0, decibels[i] / 10.0);
  }
  double value = sqrt (power / channels);
  *rms = isfinite (value) ? CLAMP (value, 0.0, 1.0) : 1.0;
  return TRUE;
}

JsonNode *
tb_level_data (TbCaptureState state, double rms)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "rms");
  if (state == TB_CAPTURE_CAPTURING && isfinite (rms))
    json_builder_add_double_value (builder, CLAMP (rms, 0.0, 1.0));
  else
    json_builder_add_null_value (builder);
  json_builder_set_member_name (builder, "state");
  /* A level without a reading is not "capturing" (AudioLevel::is_consistent). */
  json_builder_add_string_value (builder, tb_capture_state_name (
    state == TB_CAPTURE_CAPTURING && !isfinite (rms) ? TB_CAPTURE_STARTING : state));
  json_builder_end_object (builder);
  return json_builder_get_root (builder);
}

JsonNode *
tb_inventory_data (const TbInventory *inventory)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "pipewire");
  json_builder_add_string_value (builder, inventory->pipewire ? "available" : "unavailable");
  json_builder_set_member_name (builder, "sources");
  json_builder_add_int_value (builder, MIN (inventory->sources, TB_MAX_AUDIO_DEVICES));
  json_builder_set_member_name (builder, "sinks");
  json_builder_add_int_value (builder, MIN (inventory->sinks, TB_MAX_AUDIO_DEVICES));
  json_builder_set_member_name (builder, "defaultSource");
  json_builder_add_boolean_value (builder, inventory->pipewire && inventory->default_source);
  json_builder_set_member_name (builder, "defaultSink");
  json_builder_add_boolean_value (builder, inventory->pipewire && inventory->default_sink);
  json_builder_end_object (builder);
  return json_builder_get_root (builder);
}

gboolean
tb_parse_capture_set (JsonNode *data, gboolean *enabled)
{
  if (data == NULL || !JSON_NODE_HOLDS_OBJECT (data))
    return FALSE;
  JsonObject *object = json_node_get_object (data);
  if (json_object_get_size (object) != 1)
    return FALSE;
  JsonNode *member = json_object_get_member (object, "enabled");
  if (member == NULL || !JSON_NODE_HOLDS_VALUE (member) || json_node_get_value_type (member) != G_TYPE_BOOLEAN)
    return FALSE;
  *enabled = json_node_get_boolean (member);
  return TRUE;
}

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
