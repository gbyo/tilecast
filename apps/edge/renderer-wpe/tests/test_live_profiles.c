/* Watch Live H.264 qualification tiers (src/live-profiles.c): which stages a
 * hardware or software candidate tries, what each tier advertises, and the
 * timer and keyframe checks. GLib only: no VA-API or GStreamer needed. */
#include "live-profiles.h"

#include <string.h>

typedef struct {
  TcLiveTier passes_up_to; /* the probe passes stages at or below this tier */
  guint attempts;
  TcLiveProbeStage log[4];
} FakeProbe;

static gboolean
fake_probe (const TcLiveProbeStage *stage, gpointer user_data)
{
  FakeProbe *fake = user_data;
  g_assert_cmpuint (fake->attempts, <, 4);
  fake->log[fake->attempts++] = *stage;
  return stage->tier <= fake->passes_up_to;
}

static void
test_hardware_qualifies_the_highest_stage_it_passes (void)
{
  FakeProbe fake = { .passes_up_to = TC_LIVE_TIER_720P30 };
  g_assert_cmpint (tc_live_qualify (TRUE, fake_probe, &fake), ==, TC_LIVE_TIER_720P30);
  g_assert_cmpuint (fake.attempts, ==, 1);
  g_assert_cmpstr (fake.log[0].name, ==, "720p30");
  g_assert_cmpuint (fake.log[0].width, ==, 1280);
  g_assert_cmpuint (fake.log[0].height, ==, 720);
  g_assert_cmpuint (fake.log[0].fps, ==, 30);
  g_assert_cmpuint (fake.log[0].bitrate, ==, 2500000);

  /* 720p30 fails: 720p15 is still qualified, probed at its own rate and bitrate. */
  FakeProbe fifteen = { .passes_up_to = TC_LIVE_TIER_720P15 };
  g_assert_cmpint (tc_live_qualify (TRUE, fake_probe, &fifteen), ==, TC_LIVE_TIER_720P15);
  g_assert_cmpuint (fifteen.attempts, ==, 2);
  g_assert_cmpstr (fifteen.log[0].name, ==, "720p30");
  g_assert_cmpstr (fifteen.log[1].name, ==, "720p15");
  g_assert_cmpuint (fifteen.log[1].fps, ==, 15);
  g_assert_cmpuint (fifteen.log[1].bitrate, ==, 1500000);

  /* 720p15 fails too: 540p15 at 900 kbit/s. */
  FakeProbe small = { .passes_up_to = TC_LIVE_TIER_540P15 };
  g_assert_cmpint (tc_live_qualify (TRUE, fake_probe, &small), ==, TC_LIVE_TIER_540P15);
  g_assert_cmpuint (small.attempts, ==, 3);
  g_assert_cmpuint (small.log[2].width, ==, 960);
  g_assert_cmpuint (small.log[2].height, ==, 540);
  g_assert_cmpuint (small.log[2].bitrate, ==, 900000);

  FakeProbe none = { .passes_up_to = TC_LIVE_TIER_NONE };
  g_assert_cmpint (tc_live_qualify (TRUE, fake_probe, &none), ==, TC_LIVE_TIER_NONE);
  g_assert_cmpuint (none.attempts, ==, 3);
}

static void
test_software_never_qualifies_a_720p_tier (void)
{
  /* Even a probe that would pass everything: software only tries 540p15. */
  FakeProbe fake = { .passes_up_to = TC_LIVE_TIER_720P30 };
  g_assert_cmpint (tc_live_qualify (FALSE, fake_probe, &fake), ==, TC_LIVE_TIER_540P15);
  g_assert_cmpuint (fake.attempts, ==, 1);
  g_assert_cmpstr (fake.log[0].name, ==, "540p15");
  FakeProbe failing = { .passes_up_to = TC_LIVE_TIER_NONE };
  g_assert_cmpint (tc_live_qualify (FALSE, fake_probe, &failing), ==, TC_LIVE_TIER_NONE);
  g_assert_cmpuint (failing.attempts, ==, 1);
}

static void
test_tiers_advertise_everything_below_them_best_first (void)
{
  const char *const *ids = tc_live_tier_profiles (TC_LIVE_TIER_720P30);
  g_assert_cmpstr (ids[0], ==, "h264-720p30");
  g_assert_cmpstr (ids[1], ==, "h264-720p15");
  g_assert_cmpstr (ids[2], ==, "h264-540p15");
  g_assert_cmpstr (ids[3], ==, "h264-540p10");
  g_assert_null (ids[4]);
  ids = tc_live_tier_profiles (TC_LIVE_TIER_720P15);
  g_assert_cmpstr (ids[0], ==, "h264-720p15");
  g_assert_cmpstr (ids[2], ==, "h264-540p10");
  g_assert_null (ids[3]);
  ids = tc_live_tier_profiles (TC_LIVE_TIER_540P15);
  g_assert_cmpstr (ids[0], ==, "h264-540p15");
  g_assert_null (ids[2]);
  g_assert_null (tc_live_tier_profiles (TC_LIVE_TIER_NONE)[0]);

  g_assert_cmpstr (tc_live_tier_name (TC_LIVE_TIER_720P30), ==, "720p30");
  g_assert_cmpstr (tc_live_tier_name (TC_LIVE_TIER_720P15), ==, "720p15");
  g_assert_cmpstr (tc_live_tier_name (TC_LIVE_TIER_540P15), ==, "540p15");
  g_assert_cmpstr (tc_live_tier_name (TC_LIVE_TIER_NONE), ==, "none");
}

static void
test_a_start_above_the_qualified_tier_is_refused (void)
{
  g_assert_true (tc_live_tier_allows_profile (TC_LIVE_TIER_720P30, "h264-720p30"));
  g_assert_true (tc_live_tier_allows_profile (TC_LIVE_TIER_720P30, "h264-720p15"));
  g_assert_false (tc_live_tier_allows_profile (TC_LIVE_TIER_720P15, "h264-720p30"));
  g_assert_true (tc_live_tier_allows_profile (TC_LIVE_TIER_720P15, "h264-720p15"));
  g_assert_false (tc_live_tier_allows_profile (TC_LIVE_TIER_540P15, "h264-720p15"));
  g_assert_false (tc_live_tier_allows_profile (TC_LIVE_TIER_540P15, "h264-720p30"));
  g_assert_true (tc_live_tier_allows_profile (TC_LIVE_TIER_540P15, "h264-540p10"));
  g_assert_false (tc_live_tier_allows_profile (TC_LIVE_TIER_NONE, "h264-540p10"));
  g_assert_false (tc_live_tier_allows_profile (TC_LIVE_TIER_720P30, "mjpeg-540p10"));
  g_assert_false (tc_live_tier_allows_profile (TC_LIVE_TIER_720P30, "h264-1080p30"));
  g_assert_false (tc_live_tier_allows_profile (TC_LIVE_TIER_720P30, NULL));
}

static void
test_the_timer_never_rounds_to_zero_and_matches_the_profile_slot (void)
{
  g_assert_cmpuint (tc_live_timer_interval_ms (30), ==, 33);
  g_assert_cmpuint (tc_live_timer_interval_ms (15), ==, 67);
  g_assert_cmpuint (tc_live_timer_interval_ms (10), ==, 100);
  g_assert_cmpuint (tc_live_timer_interval_ms (8), ==, 125);
  g_assert_cmpuint (tc_live_timer_interval_ms (0), ==, 1000);
  for (guint fps = 1; fps <= 5000; fps++)
    g_assert_cmpuint (tc_live_timer_interval_ms (fps), >=, 1);
}

static const guint8 KEYFRAME_L31[] = { 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xac, 0xd9, 0x40, 0, 0, 0, 1, 0x68,
                                       0xce, 0x3c, 0x80, 0, 0, 1, 0x65, 0x88, 0x84 };

static void
test_keyframes_must_be_restartable_and_conform_to_level_3_1 (void)
{
  guint level = 0;
  g_assert_true (tc_live_is_restartable_keyframe (KEYFRAME_L31, sizeof KEYFRAME_L31));
  g_assert_true (tc_live_sps_conforms (KEYFRAME_L31, sizeof KEYFRAME_L31, &level));
  g_assert_cmpuint (level, ==, 31);

  /* IDR before its parameter sets, or without them, is not restartable. */
  const guint8 no_pps[] = { 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x65, 0x88 };
  g_assert_false (tc_live_is_restartable_keyframe (no_pps, sizeof no_pps));
  const guint8 idr_first[] = { 0, 0, 1, 0x65, 0x88, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 1, 0x68, 0xce };
  g_assert_false (tc_live_is_restartable_keyframe (idr_first, sizeof idr_first));
  g_assert_false (tc_live_is_restartable_keyframe (NULL, 0));

  /* Level 3.0 conforms; level 4.0, 3.2 and 4.1 are above the codec string. */
  guint8 key[sizeof KEYFRAME_L31];
  memcpy (key, KEYFRAME_L31, sizeof key);
  key[7] = 30;
  g_assert_true (tc_live_sps_conforms (key, sizeof key, NULL));
  key[7] = 32;
  g_assert_false (tc_live_sps_conforms (key, sizeof key, &level));
  g_assert_cmpuint (level, ==, 32);
  key[7] = 40;
  g_assert_false (tc_live_sps_conforms (key, sizeof key, NULL));
  /* Main profile, or Baseline without constraint_set1, is not Constrained Baseline. */
  memcpy (key, KEYFRAME_L31, sizeof key);
  key[5] = 77;
  g_assert_false (tc_live_sps_conforms (key, sizeof key, NULL));
  memcpy (key, KEYFRAME_L31, sizeof key);
  key[6] = 0x00;
  g_assert_false (tc_live_sps_conforms (key, sizeof key, NULL));
  /* No SPS, or a truncated one. */
  const guint8 delta[] = { 0, 0, 1, 0x41, 0x88, 0xa0 };
  g_assert_false (tc_live_sps_conforms (delta, sizeof delta, NULL));
  const guint8 truncated[] = { 0, 0, 0, 1, 0x67, 0x42 };
  g_assert_false (tc_live_sps_conforms (truncated, sizeof truncated, NULL));
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/live-profiles/hardware-qualifies-highest-stage", test_hardware_qualifies_the_highest_stage_it_passes);
  g_test_add_func ("/live-profiles/software-never-720p", test_software_never_qualifies_a_720p_tier);
  g_test_add_func ("/live-profiles/tier-profile-lists", test_tiers_advertise_everything_below_them_best_first);
  g_test_add_func ("/live-profiles/start-above-tier-refused", test_a_start_above_the_qualified_tier_is_refused);
  g_test_add_func ("/live-profiles/timer-interval", test_the_timer_never_rounds_to_zero_and_matches_the_profile_slot);
  g_test_add_func ("/live-profiles/keyframe-and-level", test_keyframes_must_be_restartable_and_conform_to_level_3_1);
  return g_test_run ();
}
