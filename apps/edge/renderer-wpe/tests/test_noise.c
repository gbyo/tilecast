/*
 * The page's Noise Meter report against the IPC fixtures: what the host
 * builds must decode on the Rust side, and nothing else may pass.
 */
#include "noise.h"

static JsonNode *
fixture_data (const char *relative)
{
  g_autofree char *path = g_build_filename (TC_IPC_FIXTURE_DIR, relative, NULL);
  g_autoptr (JsonParser) parser = json_parser_new ();
  g_autoptr (GError) error = NULL;
  if (!json_parser_load_from_file (parser, path, &error))
    g_error ("%s: %s", path, error->message);
  JsonObject *frame = json_object_get_object_member (json_node_get_object (json_parser_get_root (parser)), "frame");
  return json_node_copy (json_object_get_member (frame, "data"));
}

static gboolean
copy (JsonNode *message, JsonNode **out)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  gboolean ok = tc_noise_report_copy (json_node_get_object (message), builder);
  json_builder_end_object (builder);
  *out = json_builder_get_root (builder);
  return ok;
}

static void
test_valid_reports_pass_unchanged (void)
{
  const char *valid[] = { "valid/event-noise-report.json", "valid/event-noise-report-inactive.json" };
  for (guint i = 0; i < G_N_ELEMENTS (valid); i++) {
    g_autoptr (JsonNode) data = fixture_data (valid[i]);
    g_autoptr (JsonNode) out = NULL;
    g_assert_true (copy (data, &out));
    g_assert_true (json_node_equal (out, data));
  }
}

static void
test_anything_else_is_refused (void)
{
  const char *invalid[] = { "invalid/event-noise-report-audio.json", "invalid/event-noise-report-bucket-too-long.json" };
  for (guint i = 0; i < G_N_ELEMENTS (invalid); i++) {
    g_autoptr (JsonNode) data = fixture_data (invalid[i]);
    g_autoptr (JsonNode) out = NULL;
    g_assert_false (copy (data, &out));
  }
  g_autoptr (JsonParser) parser = json_parser_new ();
  const char *bad[] = {
    "{\"status\":\"shouting\"}",
    "{\"status\":\"loud\",\"level\":101}",
    "{\"status\":\"loud\",\"level\":\"50\"}",
    "{\"status\":\"loud\",\"bucket\":{\"startedAt\":\"yesterday\",\"averageLevel\":1,\"peakLevel\":1,"
    "\"monitoredMs\":10,\"warningMs\":0,\"loudMs\":0,\"triggerCount\":0}}",
    "{\"status\":\"loud\",\"bucket\":{\"startedAt\":\"2026-09-25T12:00:00Z\",\"averageLevel\":1,\"peakLevel\":1,"
    "\"monitoredMs\":10.5,\"warningMs\":0,\"loudMs\":0,\"triggerCount\":0}}",
  };
  for (guint i = 0; i < G_N_ELEMENTS (bad); i++) {
    g_assert_true (json_parser_load_from_data (parser, bad[i], -1, NULL));
    g_autoptr (JsonNode) out = NULL;
    g_assert_false (copy (json_parser_get_root (parser), &out));
  }
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/noise/valid", test_valid_reports_pass_unchanged);
  g_test_add_func ("/noise/invalid", test_anything_else_is_refused);
  return g_test_run ();
}
