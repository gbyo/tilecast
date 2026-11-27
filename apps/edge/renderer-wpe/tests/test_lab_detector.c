/* Unit tests for lab/lab-detector.c: pure C, no WPE. */
#include "lab-detector.h"

#include <string.h>

static const TcRgb RED = { 200, 40, 30 };
static const TcRgb BLUE = { 30, 90, 200 };
static const TcRgb BLACK = { 0, 0, 0 };

static TcRgb
mix (TcRgb a, TcRgb b, double t)
{
  return (TcRgb) { (guint8) (a.r + (b.r - a.r) * t + 0.5), (guint8) (a.g + (b.g - a.g) * t + 0.5),
                   (guint8) (a.b + (b.b - a.b) * t + 0.5) };
}

static void
fill (TcRgb *samples, guint n, TcRgb color)
{
  for (guint i = 0; i < n; i++)
    samples[i] = color;
}

static TcLabDetector *
crossfade_detector (void)
{
  TcLabDetector *detector = tc_lab_detector_new (4, 3);
  g_assert_true (tc_lab_detector_set_color (detector, "a", RED));
  g_assert_true (tc_lab_detector_set_color (detector, "b", BLUE));
  g_assert_true (tc_lab_detector_set_color (detector, "black", BLACK));
  return detector;
}

static void
test_idle_checks_nothing (void)
{
  TcLabDetector *detector = crossfade_detector ();
  TcRgb samples[12];
  fill (samples, 12, BLACK);
  TcLabFrameMetrics metrics;
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_OK);
  g_assert_cmpstr (metrics.state, ==, "idle");
  g_assert_false (tc_lab_detector_checking (detector));
  tc_lab_detector_free (detector);
}

static void
test_monotonic_crossfade_is_ok (void)
{
  TcLabDetector *detector = crossfade_detector ();
  g_assert_true (tc_lab_detector_transition_start (detector, "a", "b",
                                                   TC_LAB_RULE_REVERSAL | TC_LAB_RULE_FOREIGN | TC_LAB_RULE_UNIFORM));
  TcRgb samples[12];
  for (int step = 0; step <= 20; step++) {
    fill (samples, 12, mix (RED, BLUE, step / 20.0));
    TcLabFrameMetrics metrics;
    g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_OK);
    g_assert_cmpfloat_with_epsilon (metrics.mix_mean, step / 20.0, 0.02);
  }
  /* Repeated frames and small noise are not reversals. */
  fill (samples, 12, mix (RED, BLUE, 0.9));
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, NULL), ==, TC_LAB_OK);
  tc_lab_detector_free (detector);
}

static void
test_reversal_is_the_stale_frame (void)
{
  TcLabDetector *detector = crossfade_detector ();
  tc_lab_detector_transition_start (detector, "a", "b", TC_LAB_RULE_REVERSAL);
  TcRgb samples[12];
  fill (samples, 12, mix (RED, BLUE, 0.95));
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, NULL), ==, TC_LAB_OK);
  /* The incoming layer vanishes for a frame: the outgoing item is back. */
  fill (samples, 12, RED);
  TcLabFrameMetrics metrics;
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_REVERSAL_ANOMALY);
  g_assert_cmpstr (tc_lab_verdict_name (TC_LAB_REVERSAL_ANOMALY), ==, "reversal");
  g_assert_cmpint (metrics.point, ==, 0);
  g_assert_cmpfloat (metrics.value, >, 0.9);
  tc_lab_detector_free (detector);
}

static void
test_partial_reversal_of_one_point (void)
{
  TcLabDetector *detector = crossfade_detector ();
  tc_lab_detector_transition_start (detector, "a", "b", TC_LAB_RULE_REVERSAL);
  TcRgb samples[12];
  fill (samples, 12, BLUE);
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, NULL), ==, TC_LAB_OK);
  samples[7] = RED;
  TcLabFrameMetrics metrics;
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_REVERSAL_ANOMALY);
  g_assert_cmpint (metrics.point, ==, 7);
  tc_lab_detector_free (detector);
}

static void
test_foreign_black_flash (void)
{
  TcLabDetector *detector = crossfade_detector ();
  tc_lab_detector_transition_start (detector, "a", "b", TC_LAB_RULE_REVERSAL | TC_LAB_RULE_FOREIGN);
  TcRgb samples[12];
  fill (samples, 12, BLACK);
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, NULL), ==, TC_LAB_FOREIGN_ANOMALY);
  /* Without the rule a black frame is only judged by its progress. */
  tc_lab_detector_transition_start (detector, "a", "b", TC_LAB_RULE_REVERSAL);
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, NULL), ==, TC_LAB_OK);
  tc_lab_detector_free (detector);
}

static void
test_nonuniform_frame (void)
{
  TcLabDetector *detector = crossfade_detector ();
  tc_lab_detector_transition_start (detector, "a", "b", TC_LAB_RULE_UNIFORM);
  TcRgb samples[12];
  fill (samples, 12, mix (RED, BLUE, 0.5));
  for (guint i = 0; i < 6; i++)
    samples[i] = RED;
  TcLabFrameMetrics metrics;
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_NONUNIFORM_ANOMALY);
  g_assert_cmpfloat (metrics.value, >, 0.4);
  tc_lab_detector_free (detector);
}

static void
test_settled_grace_and_arm (void)
{
  TcLabDetector *detector = crossfade_detector ();
  g_assert_true (tc_lab_detector_settled (detector, "b"));
  TcRgb samples[12];
  fill (samples, 12, RED);
  /* Markers can trail the frame they describe: the first frames are not judged. */
  for (int i = 0; i < TC_LAB_SETTLE_GRACE_FRAMES; i++)
    g_assert_cmpint (tc_lab_detector_frame (detector, samples, NULL), ==, TC_LAB_OK);
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, NULL), ==, TC_LAB_UNSETTLED_ANOMALY);
  fill (samples, 12, BLUE);
  TcLabFrameMetrics metrics;
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_OK);
  g_assert_cmpstr (metrics.state, ==, "settled");
  g_assert_cmpfloat (metrics.mix_mean, ==, 1.0);
  tc_lab_detector_arm (detector);
  fill (samples, 12, RED);
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_OK);
  g_assert_cmpstr (metrics.state, ==, "armed");
  tc_lab_detector_free (detector);
}

static void
test_palette_bounds (void)
{
  TcLabDetector *detector = tc_lab_detector_new (1, 1);
  g_assert_false (tc_lab_detector_set_color (detector, "has space", RED));
  g_assert_false (tc_lab_detector_set_color (detector, "", RED));
  g_assert_false (tc_lab_detector_set_color (detector, NULL, RED));
  for (guint i = 0; i < TC_LAB_MAX_PALETTE; i++) {
    g_autofree char *name = g_strdup_printf ("c%u", i);
    g_assert_true (tc_lab_detector_set_color (detector, name, RED));
  }
  g_assert_false (tc_lab_detector_set_color (detector, "extra", RED));
  g_assert_true (tc_lab_detector_set_color (detector, "c3", BLUE));
  g_assert_false (tc_lab_detector_transition_start (detector, "c1", "missing", TC_LAB_RULE_REVERSAL));
  g_assert_false (tc_lab_detector_settled (detector, "missing"));
  g_assert_null (tc_lab_detector_new (0, 1));
  g_assert_null (tc_lab_detector_new (17, 16));
  /* 65536 x 65536 wraps to 0 as an unsigned product; it must still be refused. */
  g_assert_null (tc_lab_detector_new (65536, 65536));
  g_assert_null (tc_lab_detector_new (G_MAXUINT, 2));
  TcLabDetector *largest = tc_lab_detector_new (16, 16);
  g_assert_nonnull (largest);
  g_assert_cmpuint (tc_lab_detector_points (largest), ==, TC_LAB_MAX_POINTS);
  tc_lab_detector_free (largest);
  tc_lab_detector_free (detector);
}

static void
test_refused_path_keeps_the_active_one (void)
{
  TcLabDetector *detector = crossfade_detector ();
  g_assert_true (tc_lab_detector_transition_start (detector, "a", "b", TC_LAB_RULE_REVERSAL | TC_LAB_RULE_FOREIGN));
  TcRgb samples[12];
  fill (samples, 12, mix (RED, BLUE, 0.5));
  TcLabFrameMetrics metrics;
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_OK);
  const char *const bad[] = { "black", "missing" };
  g_assert_false (tc_lab_detector_transition_path (detector, bad, 2, TC_LAB_RULE_REVERSAL));
  /* Still judged on a -> b with the progress it had. */
  fill (samples, 12, mix (RED, BLUE, 0.6));
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_OK);
  g_assert_cmpfloat_with_epsilon (metrics.mix_mean, 0.6, 0.02);
  g_assert_true (tc_lab_detector_in_transition (detector));
  g_assert_true (tc_lab_frame_was_checked (&metrics));
  tc_lab_detector_free (detector);
}

static void
test_a_path_back_to_its_start_is_refused_for_reversal (void)
{
  TcLabDetector *detector = crossfade_detector ();
  const char *const there_and_back[] = { "a", "b", "a" };
  g_assert_false (tc_lab_detector_transition_path (detector, there_and_back, 3, TC_LAB_RULE_REVERSAL));
  g_assert_false (tc_lab_detector_checking (detector));
  /* Without the reversal rule the path is usable. */
  g_assert_true (tc_lab_detector_transition_path (detector, there_and_back, 3, TC_LAB_RULE_FOREIGN));
  const char *const distinct[] = { "a", "b" };
  g_assert_true (tc_lab_detector_transition_path (detector, distinct, 2, TC_LAB_RULE_REVERSAL));
  tc_lab_detector_free (detector);
}

static void
test_sample_grid_and_channel_order (void)
{
  /* 8x4 frame: left half red, right half blue, stored as BGRX with padding. */
  int width = 8, height = 4;
  guint stride = 40;
  g_autofree guint8 *bgrx = g_malloc0 (stride * height);
  g_autofree guint8 *rgbx = g_malloc0 (stride * height);
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      TcRgb c = x < 4 ? RED : BLUE;
      guint8 *p = bgrx + y * stride + x * 4;
      p[0] = c.b, p[1] = c.g, p[2] = c.r, p[3] = 0xff;
      guint8 *q = rgbx + y * stride + x * 4;
      q[0] = c.r, q[1] = c.g, q[2] = c.b, q[3] = 0xff;
    }
  }
  TcLabProbe whole = { 0, 0, 1, 1 };
  TcRgb out[2];
  tc_lab_sample_grid (bgrx, width, height, stride, TC_LAB_ORDER_BGRX, &whole, 2, 1, out);
  g_assert_cmpint (out[0].r, ==, RED.r);
  g_assert_cmpint (out[1].b, ==, BLUE.b);
  tc_lab_sample_grid (rgbx, width, height, stride, TC_LAB_ORDER_RGBX, &whole, 2, 1, out);
  g_assert_cmpint (out[0].r, ==, RED.r);
  g_assert_cmpint (out[1].b, ==, BLUE.b);
  /* A probe on the right half sees only blue; out-of-range probes clamp. */
  TcLabProbe right = { 0.5, 0, 0.5, 1 };
  tc_lab_sample_grid (bgrx, width, height, stride, TC_LAB_ORDER_BGRX, &right, 2, 1, out);
  g_assert_cmpint (out[0].b, ==, BLUE.b);
  TcLabProbe outside = { 2, 2, 5, 5 };
  tc_lab_sample_grid (bgrx, width, height, stride, TC_LAB_ORDER_BGRX, &outside, 1, 1, out);

  g_autoptr (GByteArray) ppm = g_byte_array_new ();
  g_assert_true (tc_lab_ppm (bgrx, width, height, stride, TC_LAB_ORDER_BGRX, 2, ppm));
  const char header[] = "P6\n4 2\n255\n";
  g_assert_cmpint (memcmp (ppm->data, header, strlen (header)), ==, 0);
  g_assert_cmpuint (ppm->len, ==, strlen (header) + 4 * 2 * 3);
  g_assert_cmpint (ppm->data[strlen (header)], ==, RED.r);
  g_assert_false (tc_lab_ppm (bgrx, width, height, 4, TC_LAB_ORDER_BGRX, 1, ppm));
  g_assert_false (tc_lab_ppm (bgrx, width, height, stride, TC_LAB_ORDER_BGRX, 0, ppm));
}

static void
test_path_progress (void)
{
  const TcRgb WHITE = { 255, 255, 255 };
  TcLabDetector *detector = crossfade_detector ();
  tc_lab_detector_set_color (detector, "white", WHITE);
  const char *const path[] = { "a", "black", "white" };
  g_assert_true (tc_lab_detector_transition_path (detector, path, 3, TC_LAB_RULE_REVERSAL | TC_LAB_RULE_FOREIGN));
  TcRgb samples[12];
  /* Half the points start on the mark color, half are already black; all end
   * white, through black. */
  for (int step = 0; step <= 10; step++) {
    for (guint i = 0; i < 12; i++) {
      double t = step / 10.0;
      samples[i] = i < 6 ? (t < 0.5 ? mix (RED, BLACK, t * 2) : mix (BLACK, WHITE, t * 2 - 1))
                         : mix (BLACK, WHITE, t);
    }
    TcLabFrameMetrics metrics;
    g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_OK);
  }
  /* A covered point drops back to black: the card snapped back. */
  samples[11] = BLACK;
  TcLabFrameMetrics metrics;
  g_assert_cmpint (tc_lab_detector_frame (detector, samples, &metrics), ==, TC_LAB_REVERSAL_ANOMALY);
  g_assert_cmpint (metrics.point, ==, 11);
  g_assert_cmpfloat_with_epsilon (metrics.value, 0.5, 0.01);
  const char *const too_long[] = { "a", "b", "a", "b", "a" };
  g_assert_false (tc_lab_detector_transition_path (detector, too_long, 5, TC_LAB_RULE_REVERSAL));
  g_assert_false (tc_lab_detector_transition_path (detector, path, 1, TC_LAB_RULE_REVERSAL));
  tc_lab_detector_free (detector);
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/lab-detector/idle", test_idle_checks_nothing);
  g_test_add_func ("/lab-detector/monotonic", test_monotonic_crossfade_is_ok);
  g_test_add_func ("/lab-detector/reversal", test_reversal_is_the_stale_frame);
  g_test_add_func ("/lab-detector/partial-reversal", test_partial_reversal_of_one_point);
  g_test_add_func ("/lab-detector/foreign", test_foreign_black_flash);
  g_test_add_func ("/lab-detector/nonuniform", test_nonuniform_frame);
  g_test_add_func ("/lab-detector/settled", test_settled_grace_and_arm);
  g_test_add_func ("/lab-detector/palette", test_palette_bounds);
  g_test_add_func ("/lab-detector/sampling", test_sample_grid_and_channel_order);
  g_test_add_func ("/lab-detector/path", test_path_progress);
  g_test_add_func ("/lab-detector/path-refused", test_refused_path_keeps_the_active_one);
  g_test_add_func ("/lab-detector/path-overlap", test_a_path_back_to_its_start_is_refused_for_reversal);
  return g_test_run ();
}
