/* Unit tests for src/visual-trace-format.c: no WPE, GLib and json-glib only. */
#include "visual-trace-format.h"

#include <glib/gstdio.h>
#include <string.h>
#include <sys/stat.h>

static char *
temp_dir (void)
{
  g_autoptr (GError) error = NULL;
  char *dir = g_dir_make_tmp ("tc-trace-XXXXXX", &error);
  g_assert_no_error (error);
  return dir;
}

static char *
read_all (const char *path)
{
  char *contents = NULL;
  g_assert_true (g_file_get_contents (path, &contents, NULL, NULL));
  return contents;
}

static JsonObject *
parse_object (JsonParser *parser, const char *json)
{
  g_assert_true (json_parser_load_from_data (parser, json, -1, NULL));
  return json_node_get_object (json_parser_get_root (parser));
}

static void
test_writer_bounds_and_summary_reserve (void)
{
  g_autofree char *base = temp_dir ();
  g_autofree char *dir = g_build_filename (base, "trace", NULL);
  g_autoptr (GError) error = NULL;
  gsize bound = TC_TRACE_SUMMARY_RESERVE + 1000;
  TcTraceWriter *writer = tc_trace_writer_open (dir, "t.jsonl", bound, &error);
  g_assert_no_error (error);
  GStatBuf st;
  g_assert_cmpint (g_stat (dir, &st), ==, 0);
  g_assert_cmpint (st.st_mode & 0777, ==, 0700);
  char line[100];
  memset (line, 'a', 99);
  line[99] = '\0';
  guint accepted = 0;
  for (guint i = 0; i < 50; i++)
    accepted += tc_trace_writer_line (writer, line) ? 1 : 0;
  /* 1000 bytes before the reserve hold ten 100-byte lines. */
  g_assert_cmpuint (accepted, ==, 10);
  g_assert_cmpuint (tc_trace_writer_dropped (writer), ==, 40);
  g_assert_cmpuint (tc_trace_writer_bytes (writer), <=, bound - TC_TRACE_SUMMARY_RESERVE);
  g_autofree char *path = g_strdup (tc_trace_writer_path (writer));
  /* The summary still fits: it may use the reserve. */
  tc_trace_writer_close (writer, "{\"type\":\"summary\"}");
  g_assert_cmpint (g_stat (path, &st), ==, 0);
  g_assert_cmpint (st.st_mode & 0777, ==, 0600);
  g_assert_cmpint (st.st_size, <=, (goffset) bound);
  g_autofree char *contents = read_all (path);
  g_assert_true (g_str_has_suffix (contents, "{\"type\":\"summary\"}\n"));
}

static void
test_writer_refuses_long_lines_and_bad_paths (void)
{
  g_autofree char *dir = temp_dir ();
  g_autoptr (GError) error = NULL;
  g_assert_null (tc_trace_writer_open ("relative/dir", "t.jsonl", 1 << 20, &error));
  g_clear_error (&error);
  g_assert_null (tc_trace_writer_open ("/tmp/../etc", "t.jsonl", 1 << 20, &error));
  g_clear_error (&error);
  g_assert_null (tc_trace_writer_open (dir, "../t.jsonl", 1 << 20, &error));
  g_clear_error (&error);
  TcTraceWriter *writer = tc_trace_writer_open (dir, "t.jsonl", 1 << 20, &error);
  g_assert_nonnull (writer);
  g_autofree char *long_line = g_strnfill (TC_TRACE_MAX_LINE_BYTES + 1, 'x');
  g_assert_false (tc_trace_writer_line (writer, long_line));
  g_assert_cmpuint (tc_trace_writer_dropped (writer), ==, 1);
  tc_trace_writer_close (writer, NULL);
}

static void
test_writer_keeps_one_previous_and_never_follows_links (void)
{
  g_autofree char *dir = temp_dir ();
  g_autoptr (GError) error = NULL;
  TcTraceWriter *first = tc_trace_writer_open (dir, "t.jsonl", 1 << 20, &error);
  tc_trace_writer_line (first, "{\"run\":1}");
  tc_trace_writer_close (first, NULL);
  TcTraceWriter *second = tc_trace_writer_open (dir, "t.jsonl", 1 << 20, &error);
  tc_trace_writer_line (second, "{\"run\":2}");
  tc_trace_writer_close (second, NULL);
  g_autofree char *current = g_build_filename (dir, "t.jsonl", NULL);
  g_autofree char *previous = g_build_filename (dir, "t.jsonl.prev", NULL);
  g_autofree char *a = read_all (current);
  g_autofree char *b = read_all (previous);
  g_assert_cmpstr (a, ==, "{\"run\":2}\n");
  g_assert_cmpstr (b, ==, "{\"run\":1}\n");

  /* A symbolic link where the trace goes is refused, never written through. */
  g_autofree char *target = g_build_filename (dir, "elsewhere", NULL);
  g_assert_true (g_file_set_contents (target, "keep", -1, NULL));
  g_unlink (current);
  g_unlink (previous);
  g_assert_cmpint (symlink (target, current), ==, 0);
  TcTraceWriter *third = tc_trace_writer_open (dir, "t.jsonl", 1 << 20, &error);
  if (third != NULL) {
    tc_trace_writer_line (third, "{\"run\":3}");
    tc_trace_writer_close (third, NULL);
  }
  g_autofree char *kept = read_all (target);
  g_assert_cmpstr (kept, ==, "keep");
}

static void
test_tokens_and_keys (void)
{
  g_assert_true (tc_trace_token_valid ("stage.swap", 48));
  g_assert_true (tc_trace_token_valid ("", 48));
  g_assert_true (tc_trace_token_valid ("anim-1:ready_2", 48));
  g_assert_false (tc_trace_token_valid ("tcmedia://cap/abc", 48));
  g_assert_false (tc_trace_token_valid ("two words", 48));
  g_assert_false (tc_trace_token_valid ("é", 48));
  g_assert_false (tc_trace_token_valid ("abcdef", 5));
  g_assert_false (tc_trace_token_valid (NULL, 48));
  g_assert_true (tc_trace_key_valid ("tx"));
  g_assert_true (tc_trace_key_valid ("outgoingVisible"));
  g_assert_false (tc_trace_key_valid ("1tx"));
  g_assert_false (tc_trace_key_valid ("a_b"));
  g_assert_false (tc_trace_key_valid ("abcdefghijklmnopqrstuvwxy"));
  g_assert_false (tc_trace_key_valid (""));
}

static char *
copy_record (const char *json, gboolean *ok)
{
  g_autoptr (JsonParser) parser = json_parser_new ();
  JsonObject *record = parse_object (parser, json);
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  *ok = tc_trace_copy_page_record (record, builder);
  if (!*ok)
    return NULL;
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  return json_to_string (root, FALSE);
}

static void
test_page_record_keeps_only_safe_values (void)
{
  gboolean ok = FALSE;
  g_autofree char *copied = copy_record ("{\"t\":12.5,\"scope\":\"stage\",\"ev\":\"stage.swap\",\"tx\":3,"
                                         "\"layer\":\"a\",\"visible\":true,\"start\":null,"
                                         "\"url\":\"tcmedia://cap/x\",\"name\":\"Lobby TV\",\"nested\":{\"a\":1},"
                                         "\"list\":[1],\"bad_key\":1}",
                                         &ok);
  g_assert_true (ok);
  g_autoptr (JsonParser) parser = json_parser_new ();
  JsonObject *object = parse_object (parser, copied);
  g_assert_cmpfloat (json_object_get_double_member (object, "t"), ==, 12.5);
  g_assert_cmpstr (json_object_get_string_member (object, "layer"), ==, "a");
  g_assert_true (json_object_get_boolean_member (object, "visible"));
  g_assert_true (json_object_get_null_member (object, "start"));
  g_assert_cmpint (json_object_get_int_member (object, "tx"), ==, 3);
  for (const char *const *gone = (const char *const[]) { "url", "name", "nested", "list", "bad_key", NULL }; *gone;
       gone++)
    g_assert_false (json_object_has_member (object, *gone));
}

static void
test_page_record_requires_time_scope_and_event (void)
{
  const char *const invalid[] = {
    "{\"scope\":\"stage\",\"ev\":\"x\"}",
    "{\"t\":\"1\",\"scope\":\"stage\",\"ev\":\"x\"}",
    "{\"t\":1,\"scope\":\"network\",\"ev\":\"x\"}",
    "{\"t\":1,\"scope\":\"stage\",\"ev\":\"\"}",
    "{\"t\":1,\"scope\":\"stage\",\"ev\":\"has space\"}",
    "{\"t\":1,\"scope\":\"stage\"}",
    NULL,
  };
  for (guint i = 0; invalid[i] != NULL; i++) {
    gboolean ok = TRUE;
    g_autofree char *copied = copy_record (invalid[i], &ok);
    g_assert_false (ok);
  }
}

static void
test_page_record_caps_keys (void)
{
  GString *json = g_string_new ("{\"t\":1,\"scope\":\"zone\",\"ev\":\"x\"");
  for (guint i = 0; i < 60; i++)
    g_string_append_printf (json, ",\"k%u\":%u", i, i);
  g_string_append (json, "}");
  gboolean ok = FALSE;
  g_autofree char *copied = copy_record (json->str, &ok);
  g_string_free (json, TRUE);
  g_assert_true (ok);
  g_autoptr (JsonParser) parser = json_parser_new ();
  JsonObject *object = parse_object (parser, copied);
  g_assert_cmpuint (json_object_get_size (object), ==, TC_TRACE_MAX_KEYS);
}

static void
test_page_batch_lines (void)
{
  g_autofree char *dir = temp_dir ();
  TcTraceWriter *writer = tc_trace_writer_open (dir, "t.jsonl", 1 << 20, NULL);
  g_autoptr (JsonParser) parser = json_parser_new ();
  JsonObject *message = parse_object (
    parser, "{\"type\":\"diagnostics.visual_trace\",\"batch\":{\"schema\":\"tilecast-visual-v1\",\"seq\":4,"
            "\"sentAt\":100.5,\"dropped\":2,\"records\":[{\"t\":99,\"scope\":\"stage\",\"ev\":\"a\"},"
            "{\"t\":100,\"scope\":\"bad\",\"ev\":\"b\"},7,{\"t\":100.25,\"scope\":\"zone\",\"ev\":\"c\",\"zone\":1}]}}");
  guint invalid = 0;
  g_assert_cmpuint (tc_trace_write_page_batch (writer, message, 5000, &invalid), ==, 2);
  g_assert_cmpuint (invalid, ==, 2);
  g_autofree char *path = g_strdup (tc_trace_writer_path (writer));
  tc_trace_writer_close (writer, NULL);
  g_autofree char *contents = read_all (path);
  g_auto (GStrv) lines = g_strsplit (contents, "\n", -1);
  g_assert_cmpuint (g_strv_length (lines), ==, 3);
  g_autoptr (JsonParser) first_parser = json_parser_new ();
  JsonObject *first = parse_object (first_parser, lines[0]);
  g_assert_cmpstr (json_object_get_string_member (first, "type"), ==, "runtime");
  g_assert_cmpint (json_object_get_int_member (first, "recv"), ==, 5000);
  g_assert_cmpint (json_object_get_int_member (first, "batch"), ==, 4);
  g_assert_cmpint (json_object_get_int_member (first, "dropped"), ==, 2);
  g_assert_cmpstr (json_object_get_string_member (json_object_get_object_member (first, "rec"), "ev"), ==, "a");
  g_autoptr (JsonParser) second_parser = json_parser_new ();
  JsonObject *second = parse_object (second_parser, lines[1]);
  g_assert_false (json_object_has_member (second, "dropped"));
}

static void
test_page_batch_rejects_wrong_schema_and_bounds_records (void)
{
  g_autofree char *dir = temp_dir ();
  TcTraceWriter *writer = tc_trace_writer_open (dir, "t.jsonl", 1 << 20, NULL);
  g_autoptr (JsonParser) parser = json_parser_new ();
  JsonObject *wrong = parse_object (parser, "{\"batch\":{\"schema\":\"other\",\"seq\":1,\"sentAt\":1,\"records\":[]}}");
  guint invalid = 0;
  g_assert_cmpuint (tc_trace_write_page_batch (writer, wrong, 1, &invalid), ==, 0);
  g_assert_cmpuint (invalid, ==, 1);

  GString *json = g_string_new ("{\"batch\":{\"schema\":\"tilecast-visual-v1\",\"seq\":1,\"sentAt\":1,\"records\":[");
  for (guint i = 0; i < TC_TRACE_MAX_RECORDS_PER_BATCH + 10; i++)
    g_string_append_printf (json, "%s{\"t\":%u,\"scope\":\"stage\",\"ev\":\"e\"}", i ? "," : "", i);
  g_string_append (json, "]}}");
  g_autoptr (JsonParser) big_parser = json_parser_new ();
  JsonObject *big = parse_object (big_parser, json->str);
  g_string_free (json, TRUE);
  g_assert_cmpuint (tc_trace_write_page_batch (writer, big, 1, &invalid), ==, TC_TRACE_MAX_RECORDS_PER_BATCH);
  g_assert_cmpuint (invalid, ==, 10);
  tc_trace_writer_close (writer, NULL);
}

static void
test_env_allowlist (void)
{
  g_setenv ("WEBKIT_USE_SKIA_FOR_COMPOSITION", "0", TRUE);
  g_setenv ("WPE_BUFFER_FORMAT", "XR24:0", TRUE);
  g_setenv ("WEBKIT_DEBUG", "Compositing,Animations", TRUE);
  g_setenv ("WEBKIT_SHOW_FPS", "/etc/passwd", TRUE);
  g_unsetenv ("WEBKIT_SHOW_DAMAGE");
  g_setenv ("TILECAST_SERVER_URL", "https://private.example", TRUE);
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  tc_trace_env_to_json (builder);
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  JsonObject *env = json_node_get_object (root);
  g_assert_cmpstr (json_object_get_string_member (env, "WEBKIT_USE_SKIA_FOR_COMPOSITION"), ==, "0");
  g_assert_cmpstr (json_object_get_string_member (env, "WPE_BUFFER_FORMAT"), ==, "XR24:0");
  g_assert_cmpstr (json_object_get_string_member (env, "WEBKIT_DEBUG"), ==, "Compositing,Animations");
  g_assert_cmpstr (json_object_get_string_member (env, "WEBKIT_SHOW_FPS"), ==, "<invalid>");
  g_assert_true (json_object_get_null_member (env, "WEBKIT_SHOW_DAMAGE"));
  g_assert_false (json_object_has_member (env, "TILECAST_SERVER_URL"));
  guint count = 0;
  while (tc_trace_env_allowlist[count] != NULL)
    count++;
  g_assert_cmpuint (json_object_get_size (env), ==, count);
}

static void
test_fourcc (void)
{
  char out[5];
  tc_trace_fourcc (0x34325258, out); /* DRM_FORMAT_XRGB8888 */
  g_assert_cmpstr (out, ==, "XR24");
  tc_trace_fourcc (0x0000000a, out);
  g_assert_cmpstr (out, ==, "????");
}

static void
test_pacing (void)
{
  /* 60 Hz with one frame held for three vblanks and one for two. */
  gint64 times[12];
  gint64 t = 1000000;
  for (guint i = 0; i < 12; i++) {
    times[i] = t;
    t += i == 4 ? 50000 : i == 8 ? 33333 : 16667;
  }
  TcPacing pacing;
  tc_pacing_compute (times, 12, 16.667, &pacing);
  g_assert_cmpuint (pacing.frames, ==, 12);
  g_assert_cmpuint (pacing.intervals, ==, 11);
  g_assert_cmpfloat_with_epsilon (pacing.median_ms, 16.667, 0.001);
  g_assert_cmpfloat_with_epsilon (pacing.max_ms, 50.0, 0.001);
  g_assert_cmpfloat_with_epsilon (pacing.p99_ms, 50.0, 0.001);
  g_assert_cmpfloat_with_epsilon (pacing.p95_ms, 50.0, 0.001);
  g_assert_cmpuint (pacing.long_frames, ==, 2);
  g_assert_cmpuint (pacing.missed_frames, ==, 3);
  g_assert_cmpfloat_with_epsilon (pacing.fps, 11.0 * 1000.0 / ((t - 16667 - 1000000) / 1000.0), 0.01);

  /* Unknown display interval: the median stands in. */
  tc_pacing_compute (times, 12, 0, &pacing);
  g_assert_cmpfloat_with_epsilon (pacing.nominal_ms, 16.667, 0.001);
  g_assert_cmpuint (pacing.long_frames, ==, 2);

  tc_pacing_compute (times, 1, 16.667, &pacing);
  g_assert_cmpuint (pacing.frames, ==, 1);
  g_assert_cmpuint (pacing.intervals, ==, 0);
  g_autoptr (JsonBuilder) builder = json_builder_new ();
  tc_pacing_to_json (&pacing, builder);
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  g_assert_cmpint (json_object_get_int_member (json_node_get_object (root), "frames"), ==, 1);
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/visual-trace/writer/bounds", test_writer_bounds_and_summary_reserve);
  g_test_add_func ("/visual-trace/writer/refusals", test_writer_refuses_long_lines_and_bad_paths);
  g_test_add_func ("/visual-trace/writer/rotation", test_writer_keeps_one_previous_and_never_follows_links);
  g_test_add_func ("/visual-trace/tokens", test_tokens_and_keys);
  g_test_add_func ("/visual-trace/record/safe-values", test_page_record_keeps_only_safe_values);
  g_test_add_func ("/visual-trace/record/required", test_page_record_requires_time_scope_and_event);
  g_test_add_func ("/visual-trace/record/key-cap", test_page_record_caps_keys);
  g_test_add_func ("/visual-trace/batch/lines", test_page_batch_lines);
  g_test_add_func ("/visual-trace/batch/bounds", test_page_batch_rejects_wrong_schema_and_bounds_records);
  g_test_add_func ("/visual-trace/env", test_env_allowlist);
  g_test_add_func ("/visual-trace/fourcc", test_fourcc);
  g_test_add_func ("/visual-trace/pacing", test_pacing);
  return g_test_run ();
}
