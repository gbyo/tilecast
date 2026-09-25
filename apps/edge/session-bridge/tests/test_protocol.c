/*
 * The bridge's frames against the golden IPC fixtures that the Rust side
 * decodes (packages/edge-protocol/fixtures/ipc). A changed fixture is a
 * changed wire format: never edit one to make this test pass.
 */
#include "protocol.h"

#include <math.h>

static JsonNode *
fixture_frame (const char *relative)
{
  g_autofree char *path = g_build_filename (TB_FIXTURE_DIR, relative, NULL);
  g_autoptr (JsonParser) parser = json_parser_new ();
  g_autoptr (GError) error = NULL;
  if (!json_parser_load_from_file (parser, path, &error))
    g_error ("%s: %s", path, error->message);
  JsonObject *root = json_node_get_object (json_parser_get_root (parser));
  return json_node_copy (json_object_get_member (root, "frame"));
}

static JsonNode *
fixture_data (const char *relative)
{
  g_autoptr (JsonNode) frame = fixture_frame (relative);
  return json_node_copy (json_object_get_member (json_node_get_object (frame), "data"));
}

static void
assert_same (JsonNode *built, JsonNode *expected)
{
  if (!json_node_equal (built, expected)) {
    g_autofree char *a = json_to_string (built, FALSE);
    g_autofree char *b = json_to_string (expected, FALSE);
    g_error ("built %s, fixture %s", a, b);
  }
}

static void
test_frames_match_the_fixtures (void)
{
  g_autoptr (JsonNode) hello = tb_hello_frame ("0.1.0");
  g_autoptr (JsonNode) hello_fixture = fixture_frame ("valid/hello-session-bridge.json");
  assert_same (hello, hello_fixture);

  g_autoptr (JsonNode) level = tb_event_frame (7, "audio.level", tb_level_data (TB_CAPTURE_CAPTURING, 0.0421));
  g_autoptr (JsonNode) level_fixture = fixture_frame ("valid/event-audio-level.json");
  assert_same (level, level_fixture);

  g_autoptr (JsonNode) unavailable = tb_level_data (TB_CAPTURE_PIPEWIRE_UNAVAILABLE, 0.5);
  g_autoptr (JsonNode) unavailable_fixture = fixture_data ("valid/event-audio-level-unavailable.json");
  assert_same (unavailable, unavailable_fixture);

  TbInventory inventory = { .pipewire = TRUE, .sources = 1, .sinks = 2, .default_source = TRUE, .default_sink = TRUE };
  g_autoptr (JsonNode) built = tb_inventory_data (&inventory);
  g_autoptr (JsonNode) inventory_fixture = fixture_data ("valid/event-audio-inventory.json");
  assert_same (built, inventory_fixture);
}

static void
test_levels_never_carry_more_than_a_bounded_number (void)
{
  /* A reading only in the capturing state, and never a NaN. */
  g_autoptr (JsonNode) idle = tb_level_data (TB_CAPTURE_IDLE, 0.7);
  JsonObject *object = json_node_get_object (idle);
  g_assert_true (json_object_get_null_member (object, "rms"));
  g_assert_cmpstr (json_object_get_string_member (object, "state"), ==, "idle");
  g_assert_cmpuint (json_object_get_size (object), ==, 2);
  g_autoptr (JsonNode) nan = tb_level_data (TB_CAPTURE_CAPTURING, NAN);
  g_assert_true (json_object_get_null_member (json_node_get_object (nan), "rms"));
  g_assert_cmpstr (json_object_get_string_member (json_node_get_object (nan), "state"), ==, "starting");
  g_autoptr (JsonNode) loud = tb_level_data (TB_CAPTURE_CAPTURING, 7.0);
  g_assert_cmpfloat (json_object_get_double_member (json_node_get_object (loud), "rms"), ==, 1.0);

  /* Huge counts are clamped to the protocol's bound. */
  TbInventory many = { .pipewire = TRUE, .sources = 500, .sinks = 0 };
  g_autoptr (JsonNode) clamped = tb_inventory_data (&many);
  g_assert_cmpint (json_object_get_int_member (json_node_get_object (clamped), "sources"), ==, TB_MAX_AUDIO_DEVICES);
  TbInventory offline = { .pipewire = FALSE, .default_sink = TRUE };
  g_autoptr (JsonNode) off = tb_inventory_data (&offline);
  g_assert_false (json_object_get_boolean_member (json_node_get_object (off), "defaultSink"));
}

static void
test_rms_comes_from_the_level_elements_decibels (void)
{
  double rms = -1;
  const double silence[] = { -INFINITY, -INFINITY };
  g_assert_true (tb_rms_from_decibels (silence, 2, &rms));
  g_assert_cmpfloat (rms, ==, 0.0);
  const double full[] = { 0.0, 0.0 };
  g_assert_true (tb_rms_from_decibels (full, 2, &rms));
  g_assert_cmpfloat_with_epsilon (rms, 1.0, 1e-9);
  const double tenth[] = { -20.0 };
  g_assert_true (tb_rms_from_decibels (tenth, 1, &rms));
  g_assert_cmpfloat_with_epsilon (rms, 0.1, 1e-9);
  /* One channel at half amplitude, one silent: the power mean. */
  const double half[] = { 20.0 * log10 (0.5), -INFINITY };
  g_assert_true (tb_rms_from_decibels (half, 2, &rms));
  g_assert_cmpfloat_with_epsilon (rms, sqrt (0.125), 1e-9);
  const double invalid[] = { NAN };
  g_assert_false (tb_rms_from_decibels (invalid, 1, &rms));
  g_assert_false (tb_rms_from_decibels (full, 0, &rms));
}

static void
test_capture_set_is_strict (void)
{
  gboolean enabled = FALSE;
  g_autoptr (JsonNode) valid = fixture_data ("valid/event-capture-set.json");
  g_assert_true (tb_parse_capture_set (valid, &enabled));
  g_assert_true (enabled);
  g_autoptr (JsonNode) extra = fixture_data ("invalid/event-capture-set-device.json");
  g_assert_false (tb_parse_capture_set (extra, &enabled));
  g_autoptr (JsonParser) parser = json_parser_new ();
  const char *bad[] = { "{}", "{\"enabled\":1}", "{\"enabled\":\"true\"}", "[true]", "null" };
  for (guint i = 0; i < G_N_ELEMENTS (bad); i++) {
    g_assert_true (json_parser_load_from_data (parser, bad[i], -1, NULL));
    g_assert_false (tb_parse_capture_set (json_parser_get_root (parser), &enabled));
  }
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/bridge/frames-match-fixtures", test_frames_match_the_fixtures);
  g_test_add_func ("/bridge/levels-are-bounded", test_levels_never_carry_more_than_a_bounded_number);
  g_test_add_func ("/bridge/rms-from-decibels", test_rms_comes_from_the_level_elements_decibels);
  g_test_add_func ("/bridge/capture-set-is-strict", test_capture_set_is_strict);
  return g_test_run ();
}
