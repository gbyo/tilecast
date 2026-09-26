#include "noise.h"

#include <math.h>
#include <string.h>

#define TC_NOISE_BUCKET_MS 10000
#define TC_NOISE_MAX_TRIGGERS 1000

static const char *const STATUSES[] = { "active", "normal", "loud", "unavailable", "inactive", NULL };

static gboolean
only_members (JsonObject *object, const char *const *allowed)
{
  g_autoptr (GList) members = json_object_get_members (object);
  for (GList *member = members; member != NULL; member = member->next) {
    if (!g_strv_contains (allowed, member->data))
      return FALSE;
  }
  return TRUE;
}

static gboolean
number (JsonObject *object, const char *name, double max, double *out)
{
  JsonNode *node = json_object_get_member (object, name);
  if (node == NULL || !JSON_NODE_HOLDS_VALUE (node))
    return FALSE;
  GType type = json_node_get_value_type (node);
  if (type != G_TYPE_INT64 && type != G_TYPE_DOUBLE)
    return FALSE;
  double value = json_node_get_double (node);
  if (!isfinite (value) || value < 0 || value > max)
    return FALSE;
  *out = value;
  return TRUE;
}

/* A whole number in [0, max]; the IPC side decodes these as integers. */
static gboolean
whole (JsonObject *object, const char *name, gint64 max, gint64 *out)
{
  double value = 0;
  if (!number (object, name, (double) max, &value) || value != floor (value))
    return FALSE;
  *out = (gint64) value;
  return TRUE;
}

static gboolean
copy_bucket (JsonObject *bucket, JsonBuilder *builder)
{
  static const char *const allowed[] = { "startedAt", "averageLevel", "peakLevel", "monitoredMs",
                                         "warningMs", "loudMs",       "triggerCount", NULL };
  if (!only_members (bucket, allowed))
    return FALSE;
  const char *started = json_object_get_string_member_with_default (bucket, "startedAt", NULL);
  double average = 0, peak = 0;
  gint64 monitored = 0, warning = 0, loud = 0, triggers = 0;
  if (started == NULL || strlen (started) > 40 || !number (bucket, "averageLevel", 100, &average)
      || !number (bucket, "peakLevel", 100, &peak) || !whole (bucket, "monitoredMs", TC_NOISE_BUCKET_MS, &monitored)
      || !whole (bucket, "warningMs", TC_NOISE_BUCKET_MS, &warning)
      || !whole (bucket, "loudMs", TC_NOISE_BUCKET_MS, &loud)
      || !whole (bucket, "triggerCount", TC_NOISE_MAX_TRIGGERS, &triggers))
    return FALSE;
  g_autoptr (GDateTime) parsed = g_date_time_new_from_iso8601 (started, NULL);
  if (parsed == NULL)
    return FALSE;
  json_builder_set_member_name (builder, "bucket");
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "startedAt");
  json_builder_add_string_value (builder, started);
  json_builder_set_member_name (builder, "averageLevel");
  json_builder_add_double_value (builder, average);
  json_builder_set_member_name (builder, "peakLevel");
  json_builder_add_double_value (builder, peak);
  json_builder_set_member_name (builder, "monitoredMs");
  json_builder_add_int_value (builder, monitored);
  json_builder_set_member_name (builder, "warningMs");
  json_builder_add_int_value (builder, warning);
  json_builder_set_member_name (builder, "loudMs");
  json_builder_add_int_value (builder, loud);
  json_builder_set_member_name (builder, "triggerCount");
  json_builder_add_int_value (builder, triggers);
  json_builder_end_object (builder);
  return TRUE;
}

gboolean
tc_noise_report_copy (JsonObject *message, JsonBuilder *builder)
{
  static const char *const allowed[] = { "type", "status", "level", "bucket", NULL };
  if (message == NULL || !only_members (message, allowed))
    return FALSE;
  const char *status = json_object_get_string_member_with_default (message, "status", NULL);
  if (status == NULL || !g_strv_contains (STATUSES, status))
    return FALSE;
  json_builder_set_member_name (builder, "status");
  json_builder_add_string_value (builder, status);
  JsonNode *level = json_object_get_member (message, "level");
  if (level != NULL && !JSON_NODE_HOLDS_NULL (level)) {
    double value = 0;
    if (!number (message, "level", 100, &value))
      return FALSE;
    json_builder_set_member_name (builder, "level");
    json_builder_add_double_value (builder, value);
  }
  JsonNode *bucket = json_object_get_member (message, "bucket");
  if (bucket != NULL && !JSON_NODE_HOLDS_NULL (bucket)) {
    if (!JSON_NODE_HOLDS_OBJECT (bucket) || !copy_bucket (json_node_get_object (bucket), builder))
      return FALSE;
  }
  return TRUE;
}
