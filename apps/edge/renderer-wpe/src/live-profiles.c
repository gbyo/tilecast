#include "live-profiles.h"

#include <string.h>

/* H.264 level 3.1 as level_idc. 1280x720x30 is exactly its 27,648,000
 * luma samples a second. */
#define TC_LIVE_MAX_LEVEL_IDC 31

static const TcLiveProbeStage hardware_stages[] = {
  { TC_LIVE_TIER_720P30, "720p30", 1280, 720, 30, 2500000 },
  { TC_LIVE_TIER_720P15, "720p15", 1280, 720, 15, 1500000 },
  { TC_LIVE_TIER_540P15, "540p15", 960, 540, 15, 900000 },
};

static const TcLiveProbeStage software_stages[] = {
  { TC_LIVE_TIER_540P15, "540p15", 960, 540, 15, 900000 },
};

TcLiveTier
tc_live_qualify (gboolean hardware, TcLiveProbeFn probe, gpointer user_data)
{
  const TcLiveProbeStage *stages = hardware ? hardware_stages : software_stages;
  gsize count = hardware ? G_N_ELEMENTS (hardware_stages) : G_N_ELEMENTS (software_stages);
  for (gsize i = 0; i < count; i++)
    if (probe (&stages[i], user_data))
      return stages[i].tier;
  return TC_LIVE_TIER_NONE;
}

const char *
tc_live_tier_name (TcLiveTier tier)
{
  switch (tier) {
  case TC_LIVE_TIER_720P30:
    return "720p30";
  case TC_LIVE_TIER_720P15:
    return "720p15";
  case TC_LIVE_TIER_540P15:
    return "540p15";
  default:
    return "none";
  }
}

const char *const *
tc_live_tier_profiles (TcLiveTier tier)
{
  static const char *const none[] = { NULL };
  static const char *const p540[] = { "h264-540p15", "h264-540p10", NULL };
  static const char *const p720p15[] = { "h264-720p15", "h264-540p15", "h264-540p10", NULL };
  static const char *const p720p30[] = { "h264-720p30", "h264-720p15", "h264-540p15", "h264-540p10", NULL };
  switch (tier) {
  case TC_LIVE_TIER_720P30:
    return p720p30;
  case TC_LIVE_TIER_720P15:
    return p720p15;
  case TC_LIVE_TIER_540P15:
    return p540;
  default:
    return none;
  }
}

gboolean
tc_live_tier_allows_profile (TcLiveTier tier, const char *profile)
{
  if (profile == NULL)
    return FALSE;
  for (const char *const *id = tc_live_tier_profiles (tier); *id != NULL; id++)
    if (strcmp (*id, profile) == 0)
      return TRUE;
  return FALSE;
}

guint
tc_live_timer_interval_ms (guint fps)
{
  if (fps == 0)
    return 1000;
  return MAX (1u, (1000u + fps / 2) / fps);
}

/* The NAL header index after the next start code at or after `from`, or 0. */
static gsize
next_nal (const guint8 *data, gsize size, gsize from)
{
  for (gsize i = from; i + 3 < size; i++)
    if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1)
      return i + 3;
  return 0;
}

gboolean
tc_live_is_restartable_keyframe (const guint8 *data, gsize size)
{
  gboolean sps = FALSE, pps = FALSE;
  for (gsize at = next_nal (data, size, 0); at != 0; at = next_nal (data, size, at)) {
    guint type = data[at] & 0x1f;
    if (type == 7)
      sps = TRUE;
    else if (type == 8)
      pps = TRUE;
    else if (type == 5)
      return sps && pps;
  }
  return FALSE;
}

gboolean
tc_live_sps_conforms (const guint8 *data, gsize size, guint *level)
{
  for (gsize at = next_nal (data, size, 0); at != 0; at = next_nal (data, size, at)) {
    if ((data[at] & 0x1f) != 7)
      continue;
    /* NAL header, profile_idc, constraint flags, level_idc. */
    if (at + 3 >= size)
      return FALSE;
    guint profile_idc = data[at + 1], constraints = data[at + 2], level_idc = data[at + 3];
    if (level != NULL)
      *level = level_idc;
    return profile_idc == 66 && (constraints & 0x40) != 0 && level_idc <= TC_LIVE_MAX_LEVEL_IDC;
  }
  return FALSE;
}
