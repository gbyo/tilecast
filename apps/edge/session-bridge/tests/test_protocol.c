/*
 * The bridge's frames against the golden IPC fixtures that the Rust side
 * decodes (packages/edge-protocol/fixtures/ipc). A changed fixture is a
 * changed wire format: never edit one to make this test pass.
 */
#include "protocol.h"

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
test_hello_matches_the_fixture (void)
{
  g_autoptr (JsonNode) hello = tb_hello_frame ("0.1.0");
  g_autoptr (JsonNode) hello_fixture = fixture_frame ("valid/hello-session-bridge.json");
  assert_same (hello, hello_fixture);
}

static void
test_event_frames_carry_only_a_name_and_data (void)
{
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "ok");
  json_builder_add_boolean_value (builder, TRUE);
  json_builder_end_object (builder);
  g_autoptr (JsonNode) frame = tb_event_frame (7, "session.note", json_builder_get_root (builder));
  JsonObject *object = json_node_get_object (frame);
  g_assert_cmpstr (json_object_get_string_member (object, "type"), ==, "event");
  g_assert_cmpint (json_object_get_int_member (object, "seq"), ==, 7);
  g_assert_cmpstr (json_object_get_string_member (object, "event"), ==, "session.note");
  JsonObject *data = json_node_get_object (json_object_get_member (object, "data"));
  g_assert_true (json_object_get_boolean_member (data, "ok"));
  g_assert_cmpuint (json_object_get_size (object), ==, 4);
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/bridge/hello-matches-fixture", test_hello_matches_the_fixture);
  g_test_add_func ("/bridge/event-frames-carry-a-name-and-data", test_event_frames_carry_only_a_name_and_data);
  return g_test_run ();
}
