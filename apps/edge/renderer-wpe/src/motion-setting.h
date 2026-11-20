/*
 * The value of WPE_SETTING_REDUCED_MOTION that gives pages
 * `prefers-reduced-motion: no-preference`. A signage display has no viewer
 * preference, and the Player Runtime's startup reveal and artwork stop
 * animating under `reduce`.
 *
 * WebKit 2.54.0 and 2.54.1 negate the setting
 * (SystemSettingsManagerProxy::reducedMotion() returned !getBool(...)), so
 * TRUE meant no-preference. WebKit bug 325212 removed the negation in 2.54.2
 * (cherry-pick 4f5451cc6e7e), so FALSE means no-preference from then on. The
 * value follows the WebKit that is loaded at run time, not the version the
 * binary was built against: a newer 2.54 library has the same SONAME and can
 * run under the same renderer.
 */
#pragma once

#include <glib.h>

static inline gboolean
tc_reduced_motion_for_no_preference (guint major, guint minor, guint micro)
{
  return major == 2 && minor == 54 && micro < 2;
}
