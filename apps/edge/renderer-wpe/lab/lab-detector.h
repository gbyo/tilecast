/*
 * The compositor lab's frame detector: pure C over sampled pixels, so
 * tests/test_lab_detector.c runs it without WPE.
 *
 * A synthetic scene paints only colors it declares (its palette) and tells
 * the host what it is about to do with markers. For each presented frame
 * the lab samples a grid of points inside the scene's probe rectangle and the
 * detector decides whether the frame is possible:
 *
 *   transition along a path of colors, F to T or F to M to T (marker
 *   "transition-start"):
 *     each point is somewhere on that path. Its progress along it ("mix",
 *     0 at F, 1 at T) may only grow, apart from noise.
 *       reversal   a point's mix fell well below the highest it reached in
 *                  this transition: the old state came back. This is the
 *                  stale or flashed frame the lab exists to catch.
 *       foreign    (rule "foreign") a point is far from the F-T line: a color
 *                  the scene never paints mid-transition, such as a black
 *                  backdrop flashing through.
 *       nonuniform (rule "uniform") points that should move together differ:
 *                  part of the frame is stale (damage or tile problems).
 *   settled on S (marker "settled"):
 *     from TC_LAB_SETTLE_GRACE_FRAMES frames later until the next "arm" or
 *     "transition-start", every point must be S.
 *       unsettled  a point is not S.
 *
 * The detector never decides from timing alone: markers arrive over IPC and
 * can trail the frame they describe by a frame, so every rule tolerates it.
 */
#pragma once

#include <glib.h>

G_BEGIN_DECLS

#define TC_LAB_MAX_PALETTE 16
#define TC_LAB_MAX_PATH 4
#define TC_LAB_MAX_POINTS 256
#define TC_LAB_SETTLE_GRACE_FRAMES 2
/* Thresholds, in 8-bit RGB units and mix fractions. */
#define TC_LAB_COLOR_TOLERANCE 40.0
#define TC_LAB_REVERSAL 0.35
#define TC_LAB_UNIFORM_SPREAD 0.25

typedef struct {
  guint8 r, g, b;
} TcRgb;

typedef enum {
  TC_LAB_ORDER_BGRX, /* XRGB8888 / ARGB8888 little endian, SHM ARGB8888 */
  TC_LAB_ORDER_RGBX, /* XBGR8888 / ABGR8888 little endian */
} TcLabChannelOrder;

typedef enum {
  TC_LAB_RULE_REVERSAL = 1 << 0,
  TC_LAB_RULE_FOREIGN = 1 << 1,
  TC_LAB_RULE_UNIFORM = 1 << 2,
} TcLabRules;

typedef enum {
  TC_LAB_OK,
  TC_LAB_REVERSAL_ANOMALY,
  TC_LAB_FOREIGN_ANOMALY,
  TC_LAB_NONUNIFORM_ANOMALY,
  TC_LAB_UNSETTLED_ANOMALY,
} TcLabVerdict;

const char *tc_lab_verdict_name (TcLabVerdict verdict);

/* A probe rectangle as fractions of the frame (0..1). */
typedef struct {
  double x, y, w, h;
} TcLabProbe;

typedef struct {
  /* What the detector was checking. */
  const char *state; /* "idle", "transition", "armed", "settling", "settled" */
  /* Average over the probe. */
  TcRgb mean;
  /* Transition: lowest, highest and mean mix of the points; settled: 1 when
   * every point is the settled color. */
  double mix_min, mix_max, mix_mean;
  /* Largest distance of a point from the path, or from S. */
  double distance;
  /* The point and value that decided a verdict other than OK. */
  int point;
  double value;
  /* FNV-1a of the sampled points, to spot repeated frames. */
  guint32 hash;
} TcLabFrameMetrics;

typedef struct _TcLabDetector TcLabDetector;

TcLabDetector *tc_lab_detector_new (guint columns, guint rows);
void tc_lab_detector_free (TcLabDetector *detector);
guint tc_lab_detector_points (TcLabDetector *detector);

/* Palette names are tokens declared by the scene. Returns FALSE when full or
 * the name is not a token. */
gboolean tc_lab_detector_set_color (TcLabDetector *detector, const char *name, TcRgb color);
gboolean tc_lab_detector_has_color (TcLabDetector *detector, const char *name);

gboolean tc_lab_detector_transition_start (TcLabDetector *detector, const char *from, const char *to,
                                           TcLabRules rules);
/* The same along 2 to TC_LAB_MAX_PATH palette colors. Refused (and the
 * active path kept) for an unknown name, or for a path that repeats a color
 * when the reversal rule is asked for. */
gboolean tc_lab_detector_transition_path (TcLabDetector *detector, const char *const *names, guint n,
                                          TcLabRules rules);
gboolean tc_lab_detector_settled (TcLabDetector *detector, const char *color);
/* A transition is about to start: stop checking the settled color. */
void tc_lab_detector_arm (TcLabDetector *detector);
/* Back to idle: no rule applies. */
void tc_lab_detector_reset (TcLabDetector *detector);
gboolean tc_lab_detector_checking (TcLabDetector *detector);
/* Between "transition-start" and "settled": the frames transition pacing counts. */
gboolean tc_lab_detector_in_transition (TcLabDetector *detector);
/* Did the last tc_lab_detector_frame apply a rule? FALSE when it was idle,
 * armed, or inside the settle grace after "settled". */
gboolean tc_lab_frame_was_checked (const TcLabFrameMetrics *metrics);

/* Checks one frame's samples (tc_lab_detector_points() of them). */
TcLabVerdict tc_lab_detector_frame (TcLabDetector *detector, const TcRgb *samples, TcLabFrameMetrics *metrics);

/* Samples a columns x rows grid at the centres of equal cells of `probe`
 * inside a width x height frame of 32-bit pixels with `stride` bytes per
 * row. Each sample is the mean of a 3x3 neighbourhood, clamped to the frame. */
void tc_lab_sample_grid (const guint8 *pixels, int width, int height, guint stride, TcLabChannelOrder order,
                         const TcLabProbe *probe, guint columns, guint rows, TcRgb *out);

/* Writes a binary PPM (P6) of the frame scaled down by `scale` (>= 1)
 * into `out`. Returns FALSE for invalid input. */
gboolean tc_lab_ppm (const guint8 *pixels, int width, int height, guint stride, TcLabChannelOrder order, guint scale,
                     GByteArray *out);

G_END_DECLS
