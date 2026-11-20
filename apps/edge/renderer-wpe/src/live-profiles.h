/*
 * Watch Live H.264 qualification tiers: pure logic shared by live-encoder.c
 * and its unit test (GLib only, no GStreamer).
 *
 * A tier is the highest H.264 profile a candidate encoder proved at startup;
 * every lower H.264 profile is advertised with it. Hardware encoders try
 * 1280x720@30, then 1280x720@15, then 960x540@15. A software encoder only
 * tries 960x540@15: 720p30 is hardware-only and 720p15 is not worth the CPU
 * on a Player that has no hardware encoder.
 */
#pragma once

#include <glib.h>

typedef enum {
  TC_LIVE_TIER_NONE = 0,
  TC_LIVE_TIER_540P15,
  TC_LIVE_TIER_720P15,
  TC_LIVE_TIER_720P30,
} TcLiveTier;

/* One probe attempt: real frames at this size, frame rate and bitrate. */
typedef struct {
  TcLiveTier tier;
  const char *name; /* "720p30": for logs */
  guint width;
  guint height;
  guint fps;
  guint bitrate; /* bits per second, the profile's initial target */
} TcLiveProbeStage;

/* Returns whether the candidate produced a valid stream for `stage`. */
typedef gboolean (*TcLiveProbeFn) (const TcLiveProbeStage *stage, gpointer user_data);

/* The highest tier `probe` passes for a hardware or software candidate, or
 * TC_LIVE_TIER_NONE. Stops at the first stage that passes. */
TcLiveTier tc_live_qualify (gboolean hardware, TcLiveProbeFn probe, gpointer user_data);

/* "720p30", "720p15", "540p15" or "none". */
const char *tc_live_tier_name (TcLiveTier tier);

/* The H.264 profile IDs a tier advertises, best first, NULL terminated. */
const char *const *tc_live_tier_profiles (TcLiveTier tier);

/* Whether a live_encoder.start for `profile` is within what was qualified. */
gboolean tc_live_tier_allows_profile (TcLiveTier tier, const char *profile);

/* Main-loop timer period for a frame rate: the nearest whole millisecond,
 * never zero, so no frame rate can produce a busy loop. */
guint tc_live_timer_interval_ms (guint fps);

/* A keyframe a decoder can start at: SPS and PPS before an IDR slice. */
gboolean tc_live_is_restartable_keyframe (const guint8 *data, gsize size);

/* The first SPS is Constrained Baseline (profile_idc 66 with
 * constraint_set1) at level 3.1 or lower: the contract of the codec string
 * avc1.42e01f, which every Watch Live H.264 profile shares. Writes the SPS
 * level_idc to `level` when it is not NULL. */
gboolean tc_live_sps_conforms (const guint8 *data, gsize size, guint *level);
