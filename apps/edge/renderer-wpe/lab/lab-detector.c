#include "lab-detector.h"

#include <math.h>
#include <string.h>

typedef enum {
  STATE_IDLE,
  STATE_TRANSITION,
  STATE_ARMED,
  STATE_SETTLING,
  STATE_SETTLED,
} State;

static const char *const STATE_NAMES[] = { "idle", "transition", "armed", "settling", "settled" };

struct _TcLabDetector {
  guint columns, rows, points;
  char *names[TC_LAB_MAX_PALETTE];
  TcRgb colors[TC_LAB_MAX_PALETTE];
  guint palette;
  State state;
  TcRgb path[TC_LAB_MAX_PATH];
  guint path_length;
  TcRgb settled;
  TcLabRules rules;
  guint settle_frames;
  double max_mix[TC_LAB_MAX_POINTS];
};

const char *
tc_lab_verdict_name (TcLabVerdict verdict)
{
  switch (verdict) {
  case TC_LAB_REVERSAL_ANOMALY:
    return "reversal";
  case TC_LAB_FOREIGN_ANOMALY:
    return "foreign";
  case TC_LAB_NONUNIFORM_ANOMALY:
    return "nonuniform";
  case TC_LAB_UNSETTLED_ANOMALY:
    return "unsettled";
  case TC_LAB_OK:
  default:
    return "ok";
  }
}

TcLabDetector *
tc_lab_detector_new (guint columns, guint rows)
{
  /* Division, not a product that could wrap past the bound. */
  if (columns == 0 || rows == 0 || columns > TC_LAB_MAX_POINTS / rows)
    return NULL;
  TcLabDetector *detector = g_new0 (TcLabDetector, 1);
  detector->columns = columns;
  detector->rows = rows;
  detector->points = columns * rows;
  return detector;
}

void
tc_lab_detector_free (TcLabDetector *detector)
{
  if (detector == NULL)
    return;
  for (guint i = 0; i < detector->palette; i++)
    g_free (detector->names[i]);
  g_free (detector);
}

guint
tc_lab_detector_points (TcLabDetector *detector)
{
  return detector->points;
}

static gboolean
token (const char *name)
{
  if (name == NULL || *name == '\0' || strlen (name) > 32)
    return FALSE;
  for (const char *c = name; *c; c++) {
    if (!g_ascii_isalnum (*c) && *c != '-' && *c != '_')
      return FALSE;
  }
  return TRUE;
}

static int
find (TcLabDetector *detector, const char *name)
{
  for (guint i = 0; i < detector->palette; i++) {
    if (g_strcmp0 (detector->names[i], name) == 0)
      return (int) i;
  }
  return -1;
}

gboolean
tc_lab_detector_set_color (TcLabDetector *detector, const char *name, TcRgb color)
{
  if (!token (name))
    return FALSE;
  int index = find (detector, name);
  if (index >= 0) {
    detector->colors[index] = color;
    return TRUE;
  }
  if (detector->palette >= TC_LAB_MAX_PALETTE)
    return FALSE;
  detector->names[detector->palette] = g_strdup (name);
  detector->colors[detector->palette++] = color;
  return TRUE;
}

gboolean
tc_lab_detector_has_color (TcLabDetector *detector, const char *name)
{
  return find (detector, name) >= 0;
}

gboolean
tc_lab_detector_transition_start (TcLabDetector *detector, const char *from, const char *to, TcLabRules rules)
{
  const char *const names[] = { from, to };
  return tc_lab_detector_transition_path (detector, names, 2, rules);
}

gboolean
tc_lab_detector_transition_path (TcLabDetector *detector, const char *const *names, guint n, TcLabRules rules)
{
  if (n < 2 || n > TC_LAB_MAX_PATH)
    return FALSE;
  /* Resolve every name first: a refused path leaves the active one as it was. */
  TcRgb path[TC_LAB_MAX_PATH];
  for (guint i = 0; i < n; i++) {
    int index = find (detector, names[i]);
    if (index < 0)
      return FALSE;
    path[i] = detector->colors[index];
  }
  /* A path that comes back to a color (a:b:a) puts one color at two
   * progresses, so the reversal rule cannot tell forward motion from a
   * reversal. It is refused when that rule is asked for. */
  if (rules & TC_LAB_RULE_REVERSAL) {
    for (guint i = 0; i < n; i++) {
      for (guint j = i + 1; j < n; j++) {
        if (path[i].r == path[j].r && path[i].g == path[j].g && path[i].b == path[j].b)
          return FALSE;
      }
    }
  }
  memcpy (detector->path, path, n * sizeof path[0]);
  detector->path_length = n;
  detector->rules = rules;
  detector->state = STATE_TRANSITION;
  for (guint i = 0; i < detector->points; i++)
    detector->max_mix[i] = 0;
  return TRUE;
}

gboolean
tc_lab_detector_settled (TcLabDetector *detector, const char *color)
{
  int index = find (detector, color);
  if (index < 0)
    return FALSE;
  detector->settled = detector->colors[index];
  detector->state = STATE_SETTLING;
  detector->settle_frames = 0;
  return TRUE;
}

void
tc_lab_detector_arm (TcLabDetector *detector)
{
  if (detector->state == STATE_SETTLED || detector->state == STATE_SETTLING)
    detector->state = STATE_ARMED;
}

void
tc_lab_detector_reset (TcLabDetector *detector)
{
  detector->state = STATE_IDLE;
}

gboolean
tc_lab_detector_in_transition (TcLabDetector *detector)
{
  return detector->state == STATE_TRANSITION;
}

gboolean
tc_lab_detector_checking (TcLabDetector *detector)
{
  return detector->state == STATE_TRANSITION || detector->state == STATE_SETTLING
         || detector->state == STATE_SETTLED;
}

static double
distance (TcRgb a, TcRgb b)
{
  double dr = (double) a.r - b.r, dg = (double) a.g - b.g, db = (double) a.b - b.b;
  return sqrt (dr * dr + dg * dg + db * db);
}

/* Projection of p on the segment from -> to: the mix (0..1) and the distance
 * of p from the segment. */
static double
project (TcRgb from, TcRgb to, TcRgb p, double *off_line)
{
  double vx = (double) to.r - from.r, vy = (double) to.g - from.g, vz = (double) to.b - from.b;
  double wx = (double) p.r - from.r, wy = (double) p.g - from.g, wz = (double) p.b - from.b;
  double length2 = vx * vx + vy * vy + vz * vz;
  double t = length2 > 0 ? (vx * wx + vy * wy + vz * wz) / length2 : 1.0;
  t = CLAMP (t, 0.0, 1.0);
  double cx = from.r + t * vx, cy = from.g + t * vy, cz = from.b + t * vz;
  double dx = p.r - cx, dy = p.g - cy, dz = p.b - cz;
  *off_line = sqrt (dx * dx + dy * dy + dz * dz);
  return t;
}

/* Progress of p along the path (0 at its first color, 1 at its last), from
 * the nearest segment, and p's distance from the path. */
static double
progress (const TcLabDetector *detector, TcRgb p, double *off_path)
{
  guint segments = detector->path_length - 1;
  double best = G_MAXDOUBLE, result = 0;
  for (guint k = 0; k < segments; k++) {
    double off = 0;
    double t = project (detector->path[k], detector->path[k + 1], p, &off);
    /* At a shared vertex both segments agree; prefer the later one there. */
    if (off <= best + 1e-9) {
      best = off;
      result = ((double) k + t) / segments;
    }
  }
  *off_path = best;
  return result;
}

static guint32
fnv1a (const TcRgb *samples, guint n)
{
  guint32 hash = 2166136261u;
  for (guint i = 0; i < n; i++) {
    const guint8 bytes[3] = { samples[i].r, samples[i].g, samples[i].b };
    for (int k = 0; k < 3; k++) {
      hash ^= bytes[k];
      hash *= 16777619u;
    }
  }
  return hash;
}

TcLabVerdict
tc_lab_detector_frame (TcLabDetector *detector, const TcRgb *samples, TcLabFrameMetrics *metrics)
{
  TcLabFrameMetrics local;
  TcLabFrameMetrics *m = metrics ? metrics : &local;
  memset (m, 0, sizeof *m);
  m->point = -1;
  guint n = detector->points;
  double sr = 0, sg = 0, sb = 0;
  for (guint i = 0; i < n; i++) {
    sr += samples[i].r;
    sg += samples[i].g;
    sb += samples[i].b;
  }
  m->mean = (TcRgb) { (guint8) lround (sr / n), (guint8) lround (sg / n), (guint8) lround (sb / n) };
  m->hash = fnv1a (samples, n);
  if (detector->state == STATE_SETTLING && ++detector->settle_frames > TC_LAB_SETTLE_GRACE_FRAMES)
    detector->state = STATE_SETTLED;
  m->state = STATE_NAMES[detector->state];

  if (detector->state == STATE_TRANSITION) {
    TcLabVerdict verdict = TC_LAB_OK;
    m->mix_min = 1;
    m->mix_max = 0;
    double sum = 0;
    for (guint i = 0; i < n; i++) {
      double off = 0;
      double mix = progress (detector, samples[i], &off);
      sum += mix;
      m->mix_min = MIN (m->mix_min, mix);
      m->mix_max = MAX (m->mix_max, mix);
      m->distance = MAX (m->distance, off);
      if (verdict == TC_LAB_OK && (detector->rules & TC_LAB_RULE_FOREIGN) && off > TC_LAB_COLOR_TOLERANCE) {
        verdict = TC_LAB_FOREIGN_ANOMALY;
        m->point = (int) i;
        m->value = off;
      }
      if (verdict == TC_LAB_OK && (detector->rules & TC_LAB_RULE_REVERSAL)
          && detector->max_mix[i] - mix > TC_LAB_REVERSAL) {
        verdict = TC_LAB_REVERSAL_ANOMALY;
        m->point = (int) i;
        m->value = detector->max_mix[i] - mix;
      }
      detector->max_mix[i] = MAX (detector->max_mix[i], mix);
    }
    m->mix_mean = sum / n;
    if (verdict == TC_LAB_OK && (detector->rules & TC_LAB_RULE_UNIFORM)
        && m->mix_max - m->mix_min > TC_LAB_UNIFORM_SPREAD) {
      verdict = TC_LAB_NONUNIFORM_ANOMALY;
      m->value = m->mix_max - m->mix_min;
    }
    return verdict;
  }

  if (detector->state == STATE_SETTLED) {
    TcLabVerdict verdict = TC_LAB_OK;
    guint matching = 0;
    for (guint i = 0; i < n; i++) {
      double d = distance (samples[i], detector->settled);
      m->distance = MAX (m->distance, d);
      if (d <= TC_LAB_COLOR_TOLERANCE)
        matching++;
      else if (verdict == TC_LAB_OK) {
        verdict = TC_LAB_UNSETTLED_ANOMALY;
        m->point = (int) i;
        m->value = d;
      }
    }
    m->mix_mean = (double) matching / n;
    m->mix_min = m->mix_max = m->mix_mean;
    return verdict;
  }
  return TC_LAB_OK;
}

static void
read_pixel (const guint8 *pixels, guint stride, TcLabChannelOrder order, int x, int y, double *r, double *g, double *b)
{
  const guint8 *p = pixels + (gsize) y * stride + (gsize) x * 4;
  if (order == TC_LAB_ORDER_BGRX) {
    *b += p[0];
    *g += p[1];
    *r += p[2];
  } else {
    *r += p[0];
    *g += p[1];
    *b += p[2];
  }
}

void
tc_lab_sample_grid (const guint8 *pixels, int width, int height, guint stride, TcLabChannelOrder order,
                    const TcLabProbe *probe, guint columns, guint rows, TcRgb *out)
{
  double px = CLAMP (probe->x, 0.0, 1.0), py = CLAMP (probe->y, 0.0, 1.0);
  double pw = CLAMP (probe->w, 0.0, 1.0 - px), ph = CLAMP (probe->h, 0.0, 1.0 - py);
  for (guint row = 0; row < rows; row++) {
    for (guint column = 0; column < columns; column++) {
      int cx = (int) ((px + pw * (column + 0.5) / columns) * width);
      int cy = (int) ((py + ph * (row + 0.5) / rows) * height);
      double r = 0, g = 0, b = 0;
      int count = 0;
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          int x = CLAMP (cx + dx, 0, width - 1), y = CLAMP (cy + dy, 0, height - 1);
          read_pixel (pixels, stride, order, x, y, &r, &g, &b);
          count++;
        }
      }
      out[row * columns + column] =
        (TcRgb) { (guint8) lround (r / count), (guint8) lround (g / count), (guint8) lround (b / count) };
    }
  }
}

gboolean
tc_lab_ppm (const guint8 *pixels, int width, int height, guint stride, TcLabChannelOrder order, guint scale,
            GByteArray *out)
{
  if (pixels == NULL || width <= 0 || height <= 0 || scale == 0 || stride < (guint) width * 4)
    return FALSE;
  int out_w = MAX (1, width / (int) scale), out_h = MAX (1, height / (int) scale);
  g_autofree char *header = g_strdup_printf ("P6\n%d %d\n255\n", out_w, out_h);
  g_byte_array_append (out, (const guint8 *) header, strlen (header));
  for (int y = 0; y < out_h; y++) {
    for (int x = 0; x < out_w; x++) {
      double r = 0, g = 0, b = 0;
      read_pixel (pixels, stride, order, MIN (x * (int) scale, width - 1), MIN (y * (int) scale, height - 1), &r, &g,
                  &b);
      const guint8 rgb[3] = { (guint8) r, (guint8) g, (guint8) b };
      g_byte_array_append (out, rgb, 3);
    }
  }
  return TRUE;
}

gboolean
tc_lab_frame_was_checked (const TcLabFrameMetrics *metrics)
{
  return g_strcmp0 (metrics->state, "transition") == 0 || g_strcmp0 (metrics->state, "settled") == 0;
}
