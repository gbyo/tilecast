/* src/motion-setting.h: the reduced-motion value that gives no-preference. */
#include "motion-setting.h"

static void
test_versions (void)
{
  /* The inverted releases (WebKit bug 325212). */
  g_assert_true (tc_reduced_motion_for_no_preference (2, 54, 0));
  g_assert_true (tc_reduced_motion_for_no_preference (2, 54, 1));
  /* Fixed from 2.54.2 on, and in later series. */
  g_assert_false (tc_reduced_motion_for_no_preference (2, 54, 2));
  g_assert_false (tc_reduced_motion_for_no_preference (2, 54, 3));
  g_assert_false (tc_reduced_motion_for_no_preference (2, 56, 0));
  g_assert_false (tc_reduced_motion_for_no_preference (3, 0, 0));
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/motion-setting/versions", test_versions);
  return g_test_run ();
}
