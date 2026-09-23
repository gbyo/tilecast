#include "validate.h"

static const char *const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

static void
test_sha256 (void)
{
  g_assert_true (tc_is_sha256_hex (EMPTY));
  g_assert_false (tc_is_sha256_hex ("E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"));
  g_assert_false (tc_is_sha256_hex ("../../../../etc/passwd"));
  g_assert_false (tc_is_sha256_hex (""));
  g_assert_false (tc_is_sha256_hex (NULL));
}

static void
test_runtime_paths (void)
{
  g_assert_true (tc_runtime_path_is_allowed ("/static/index.html"));
  g_assert_true (tc_runtime_path_is_allowed ("/dist/renderer/renderer.js"));
  g_assert_false (tc_runtime_path_is_allowed ("/static/../../identity/node-key.pk8"));
  g_assert_false (tc_runtime_path_is_allowed ("/static/.."));
  g_assert_false (tc_runtime_path_is_allowed ("/static/%2e%2e"));
  g_assert_false (tc_runtime_path_is_allowed ("/static/a/b.js"));
  g_assert_false (tc_runtime_path_is_allowed ("/etc/passwd"));
  g_assert_false (tc_runtime_path_is_allowed ("/static/"));
  g_assert_cmpstr (tc_runtime_content_type ("/static/index.html"), ==, "text/html; charset=utf-8");
  g_assert_null (tc_runtime_content_type ("/static/archive.tar"));
}

static void
test_ranges (void)
{
  guint64 start = 0, end = 0;
  g_assert_cmpint (tc_parse_range (NULL, 100, &start, &end), ==, TC_RANGE_NONE);
  g_assert_cmpint (tc_parse_range ("bytes=0-", 100, &start, &end), ==, TC_RANGE_OK);
  g_assert_cmpuint (start, ==, 0);
  g_assert_cmpuint (end, ==, 99);
  g_assert_cmpint (tc_parse_range ("bytes=10-19", 100, &start, &end), ==, TC_RANGE_OK);
  g_assert_cmpuint (end, ==, 19);
  g_assert_cmpint (tc_parse_range ("bytes=90-500", 100, &start, &end), ==, TC_RANGE_OK);
  g_assert_cmpuint (end, ==, 99);
  g_assert_cmpint (tc_parse_range ("bytes=-10", 100, &start, &end), ==, TC_RANGE_OK);
  g_assert_cmpuint (start, ==, 90);
  g_assert_cmpint (tc_parse_range ("bytes=100-", 100, &start, &end), ==, TC_RANGE_UNSATISFIABLE);
  g_assert_cmpint (tc_parse_range ("bytes=0-1,5-6", 100, &start, &end), ==, TC_RANGE_INVALID);
  g_assert_cmpint (tc_parse_range ("bytes=5-1", 100, &start, &end), ==, TC_RANGE_INVALID);
  g_assert_cmpint (tc_parse_range ("bytes=a-b", 100, &start, &end), ==, TC_RANGE_INVALID);
  g_assert_cmpint (tc_parse_range ("items=0-1", 100, &start, &end), ==, TC_RANGE_INVALID);
  g_assert_cmpint (tc_parse_range ("bytes=99999999999999999999-", 100, &start, &end), ==, TC_RANGE_INVALID);
}

static void
test_clean_paths (void)
{
  g_assert_true (tc_is_clean_absolute_path ("/var/lib/tilecast-edge/cas"));
  g_assert_false (tc_is_clean_absolute_path ("var/lib"));
  g_assert_false (tc_is_clean_absolute_path ("/var/lib/../identity"));
  g_assert_false (tc_is_clean_absolute_path ("/var//lib"));
  g_assert_false (tc_is_clean_absolute_path (NULL));
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/validate/sha256", test_sha256);
  g_test_add_func ("/validate/runtime-paths", test_runtime_paths);
  g_test_add_func ("/validate/ranges", test_ranges);
  g_test_add_func ("/validate/clean-paths", test_clean_paths);
  return g_test_run ();
}
