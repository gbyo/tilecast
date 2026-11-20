#include "visual-trace-format.h"

#include <errno.h>
#include <fcntl.h>
#include <glib/gstdio.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "validate.h"

struct _TcTraceWriter {
  FILE *file;
  char *path;
  gsize max_bytes;
  gsize bytes;
  guint64 lines;
  guint64 dropped;
};

TcTraceWriter *
tc_trace_writer_open (const char *dir, const char *name, gsize max_bytes, GError **error)
{
  if (!tc_is_clean_absolute_path (dir) || name == NULL || strchr (name, '/') != NULL || *name == '\0') {
    g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT, "trace directory must be a clean absolute path");
    return NULL;
  }
  if (max_bytes <= TC_TRACE_SUMMARY_RESERVE) {
    g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT, "trace bound is too small");
    return NULL;
  }
  if (g_mkdir_with_parents (dir, 0700) != 0) {
    g_set_error (error, G_IO_ERROR, g_io_error_from_errno (errno), "cannot create %s: %s", dir, g_strerror (errno));
    return NULL;
  }
  GStatBuf st;
  if (g_lstat (dir, &st) != 0 || !S_ISDIR (st.st_mode)) {
    g_set_error (error, G_IO_ERROR, G_IO_ERROR_NOT_DIRECTORY, "%s is not a directory", dir);
    return NULL;
  }
  g_autofree char *path = g_build_filename (dir, name, NULL);
  g_autofree char *previous = g_strconcat (path, ".prev", NULL);
  if (g_lstat (path, &st) == 0 && S_ISREG (st.st_mode))
    g_rename (path, previous);
  int fd = open (path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) {
    g_set_error (error, G_IO_ERROR, g_io_error_from_errno (errno), "cannot open %s: %s", path, g_strerror (errno));
    return NULL;
  }
  FILE *file = fdopen (fd, "w");
  if (file == NULL) {
    close (fd);
    g_set_error (error, G_IO_ERROR, G_IO_ERROR_FAILED, "cannot open %s", path);
    return NULL;
  }
  setvbuf (file, NULL, _IOFBF, 64 * 1024);
  TcTraceWriter *writer = g_new0 (TcTraceWriter, 1);
  writer->file = file;
  writer->path = g_steal_pointer (&path);
  writer->max_bytes = max_bytes;
  return writer;
}

static gboolean
write_raw (TcTraceWriter *writer, const char *line, gsize limit)
{
  gsize length = strlen (line);
  if (length > TC_TRACE_MAX_LINE_BYTES || writer->bytes + length + 1 > limit) {
    writer->dropped++;
    return FALSE;
  }
  if (fwrite (line, 1, length, writer->file) != length || fputc ('\n', writer->file) == EOF) {
    writer->dropped++;
    return FALSE;
  }
  writer->bytes += length + 1;
  writer->lines++;
  return TRUE;
}

gboolean
tc_trace_writer_line (TcTraceWriter *writer, const char *line)
{
  if (writer == NULL || line == NULL)
    return FALSE;
  return write_raw (writer, line, writer->max_bytes - TC_TRACE_SUMMARY_RESERVE);
}

gboolean
tc_trace_writer_builder (TcTraceWriter *writer, JsonBuilder *builder)
{
  g_autoptr (JsonNode) root = json_builder_get_root (builder);
  if (root == NULL)
    return FALSE;
  g_autofree char *line = json_to_string (root, FALSE);
  return tc_trace_writer_line (writer, line);
}

void
tc_trace_writer_flush (TcTraceWriter *writer)
{
  if (writer != NULL)
    fflush (writer->file);
}

guint64
tc_trace_writer_lines (TcTraceWriter *writer)
{
  return writer ? writer->lines : 0;
}

guint64
tc_trace_writer_dropped (TcTraceWriter *writer)
{
  return writer ? writer->dropped : 0;
}

gsize
tc_trace_writer_bytes (TcTraceWriter *writer)
{
  return writer ? writer->bytes : 0;
}

const char *
tc_trace_writer_path (TcTraceWriter *writer)
{
  return writer ? writer->path : NULL;
}

void
tc_trace_writer_close (TcTraceWriter *writer, const char *final_line)
{
  if (writer == NULL)
    return;
  if (final_line != NULL)
    write_raw (writer, final_line, writer->max_bytes);
  fflush (writer->file);
  fsync (fileno (writer->file));
  fclose (writer->file);
  g_free (writer->path);
  g_free (writer);
}

gboolean
tc_trace_token_valid (const char *value, gsize max)
{
  if (value == NULL)
    return FALSE;
  gsize length = 0;
  for (const char *c = value; *c != '\0'; c++, length++) {
    if (length >= max)
      return FALSE;
    if (!g_ascii_isalnum (*c) && *c != '_' && *c != '.' && *c != ':' && *c != '-')
      return FALSE;
  }
  return TRUE;
}

gboolean
tc_trace_key_valid (const char *key)
{
  if (key == NULL || !g_ascii_isalpha (key[0]))
    return FALSE;
  gsize length = 0;
  for (const char *c = key; *c != '\0'; c++, length++) {
    if (length >= 24 || !g_ascii_isalnum (*c))
      return FALSE;
  }
  return TRUE;
}

static gboolean
finite_number (JsonNode *node, double *out)
{
  if (node == NULL || !JSON_NODE_HOLDS_VALUE (node))
    return FALSE;
  GType type = json_node_get_value_type (node);
  if (type != G_TYPE_INT64 && type != G_TYPE_DOUBLE)
    return FALSE;
  double value = json_node_get_double (node);
  if (!isfinite (value))
    return FALSE;
  *out = value;
  return TRUE;
}

static const char *const SCOPES[] = { "stage", "zone", "startup", "trace", "lab", NULL };

gboolean
tc_trace_copy_page_record (JsonObject *record, JsonBuilder *builder)
{
  if (record == NULL)
    return FALSE;
  double t = 0;
  if (!finite_number (json_object_get_member (record, "t"), &t))
    return FALSE;
  const char *scope = json_object_get_string_member_with_default (record, "scope", NULL);
  const char *ev = json_object_get_string_member_with_default (record, "ev", NULL);
  gboolean known_scope = FALSE;
  for (guint i = 0; SCOPES[i] != NULL; i++)
    known_scope |= g_strcmp0 (scope, SCOPES[i]) == 0;
  if (!known_scope || !tc_trace_token_valid (ev, TC_TRACE_MAX_STRING) || *ev == '\0')
    return FALSE;
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "t");
  json_builder_add_double_value (builder, t);
  json_builder_set_member_name (builder, "scope");
  json_builder_add_string_value (builder, scope);
  json_builder_set_member_name (builder, "ev");
  json_builder_add_string_value (builder, ev);
  guint keys = 3;
  JsonObjectIter iter;
  const char *key;
  JsonNode *node;
  json_object_iter_init (&iter, record);
  while (json_object_iter_next (&iter, &key, &node)) {
    if (keys >= TC_TRACE_MAX_KEYS)
      break;
    if (g_strcmp0 (key, "t") == 0 || g_strcmp0 (key, "scope") == 0 || g_strcmp0 (key, "ev") == 0
        || !tc_trace_key_valid (key))
      continue;
    double number = 0;
    if (JSON_NODE_HOLDS_NULL (node)) {
      json_builder_set_member_name (builder, key);
      json_builder_add_null_value (builder);
    } else if (!JSON_NODE_HOLDS_VALUE (node)) {
      continue;
    } else if (json_node_get_value_type (node) == G_TYPE_BOOLEAN) {
      json_builder_set_member_name (builder, key);
      json_builder_add_boolean_value (builder, json_node_get_boolean (node));
    } else if (json_node_get_value_type (node) == G_TYPE_STRING) {
      const char *value = json_node_get_string (node);
      if (!tc_trace_token_valid (value, TC_TRACE_MAX_STRING))
        continue;
      json_builder_set_member_name (builder, key);
      json_builder_add_string_value (builder, value);
    } else if (finite_number (node, &number)) {
      json_builder_set_member_name (builder, key);
      /* Ordinals stay integers in the file. */
      if (number == floor (number) && fabs (number) < 9.0e15)
        json_builder_add_int_value (builder, (gint64) number);
      else
        json_builder_add_double_value (builder, number);
    } else {
      continue;
    }
    keys++;
  }
  json_builder_end_object (builder);
  return TRUE;
}

guint
tc_trace_write_page_batch (TcTraceWriter *writer, JsonObject *message, gint64 recv_monotonic_us, guint *invalid)
{
  guint written = 0;
  guint refused = 0;
  JsonObject *batch = message ? json_object_get_object_member (message, "batch") : NULL;
  JsonArray *records = batch ? json_object_get_array_member (batch, "records") : NULL;
  const char *schema = batch ? json_object_get_string_member_with_default (batch, "schema", NULL) : NULL;
  double seq = 0, sent_at = 0, dropped = 0;
  if (records == NULL || g_strcmp0 (schema, TC_TRACE_SCHEMA) != 0
      || !finite_number (json_object_get_member (batch, "seq"), &seq)
      || !finite_number (json_object_get_member (batch, "sentAt"), &sent_at)) {
    if (invalid)
      *invalid = 1;
    return 0;
  }
  finite_number (json_object_get_member (batch, "dropped"), &dropped);
  guint length = json_array_get_length (records);
  if (length > TC_TRACE_MAX_RECORDS_PER_BATCH) {
    refused += length - TC_TRACE_MAX_RECORDS_PER_BATCH;
    length = TC_TRACE_MAX_RECORDS_PER_BATCH;
  }
  for (guint i = 0; i < length; i++) {
    JsonNode *node = json_array_get_element (records, i);
    if (!JSON_NODE_HOLDS_OBJECT (node)) {
      refused++;
      continue;
    }
    g_autoptr (JsonBuilder) builder = json_builder_new ();
    json_builder_begin_object (builder);
    json_builder_set_member_name (builder, "type");
    json_builder_add_string_value (builder, "runtime");
    json_builder_set_member_name (builder, "recv");
    json_builder_add_int_value (builder, recv_monotonic_us);
    json_builder_set_member_name (builder, "batch");
    json_builder_add_int_value (builder, (gint64) seq);
    json_builder_set_member_name (builder, "sentAt");
    json_builder_add_double_value (builder, sent_at);
    if (written == 0 && dropped > 0) {
      json_builder_set_member_name (builder, "dropped");
      json_builder_add_int_value (builder, (gint64) dropped);
    }
    json_builder_set_member_name (builder, "rec");
    if (!tc_trace_copy_page_record (json_node_get_object (node), builder)) {
      refused++;
      continue;
    }
    json_builder_end_object (builder);
    if (tc_trace_writer_builder (writer, builder))
      written++;
  }
  if (invalid)
    *invalid = refused;
  return written;
}

const char *const tc_trace_env_allowlist[] = {
  "WEBKIT_USE_SKIA_FOR_COMPOSITION",
  "WEBKIT_SKIA_ENABLE_CPU_RENDERING",
  "WEBKIT_SKIA_CPU_PAINTING_THREADS",
  "WEBKIT_SKIA_GPU_PAINTING_THREADS",
  "WEBKIT_SKIA_USE_LINEAR_TILE_TEXTURES",
  "WEBKIT_SHOW_DAMAGE",
  "WEBKIT_SHOW_FPS",
  "WEBKIT_FORCE_VBLANK_TIMER",
  "WEBKIT_DISPLAY_REFRESH_THROTTLE_FPS",
  "WEBKIT_DISABLE_DMABUF_ATLAS",
  "WEBKIT_DEBUG",
  "WPE_BUFFER_FORMAT",
  "WPE_DRM_DISABLE_ATOMIC",
  "WPE_USE_EXPLICIT_SYNC",
  NULL,
};

static gboolean
env_value_valid (const char *value)
{
  gsize length = 0;
  for (const char *c = value; *c != '\0'; c++, length++) {
    if (length >= 64)
      return FALSE;
    if (!g_ascii_isalnum (*c) && *c != '_' && *c != '.' && *c != ':' && *c != ',' && *c != '-')
      return FALSE;
  }
  return TRUE;
}

void
tc_trace_env_to_json (JsonBuilder *builder)
{
  json_builder_begin_object (builder);
  for (guint i = 0; tc_trace_env_allowlist[i] != NULL; i++) {
    const char *value = g_getenv (tc_trace_env_allowlist[i]);
    json_builder_set_member_name (builder, tc_trace_env_allowlist[i]);
    if (value == NULL)
      json_builder_add_null_value (builder);
    else
      json_builder_add_string_value (builder, env_value_valid (value) ? value : "<invalid>");
  }
  json_builder_end_object (builder);
}

void
tc_trace_fourcc (guint32 fourcc, char out[5])
{
  for (int i = 0; i < 4; i++) {
    char c = (char) ((fourcc >> (8 * i)) & 0xff);
    out[i] = g_ascii_isprint (c) ? c : '?';
  }
  out[4] = '\0';
}

static int
compare_double (gconstpointer a, gconstpointer b)
{
  double x = *(const double *) a, y = *(const double *) b;
  return (x > y) - (x < y);
}

/* Nearest-rank percentile of an ascending array. */
static double
percentile (const double *sorted, gsize n, double p)
{
  if (n == 0)
    return 0;
  gsize rank = (gsize) ceil (p / 100.0 * (double) n);
  if (rank < 1)
    rank = 1;
  if (rank > n)
    rank = n;
  return sorted[rank - 1];
}

void
tc_pacing_compute (const gint64 *times_us, gsize n, double nominal_ms, TcPacing *out)
{
  if (n < 2) {
    memset (out, 0, sizeof *out);
    out->frames = n;
    return;
  }
  gsize count = n - 1;
  g_autofree double *intervals = g_new (double, count);
  for (gsize i = 0; i < count; i++) {
    gint64 delta = times_us[i + 1] - times_us[i];
    intervals[i] = delta > 0 ? (double) delta / 1000.0 : 0.0;
  }
  tc_pacing_compute_intervals (intervals, count, nominal_ms, out);
}

void
tc_pacing_compute_intervals (const double *intervals, gsize count, double nominal_ms, TcPacing *out)
{
  memset (out, 0, sizeof *out);
  out->frames = count ? count + 1 : 0;
  if (count == 0)
    return;
  double sum = 0;
  for (gsize i = 0; i < count; i++)
    sum += intervals[i];
  g_autofree double *sorted = g_memdup2 (intervals, count * sizeof (double));
  qsort (sorted, count, sizeof (double), compare_double);
  out->intervals = count;
  out->mean_ms = sum / (double) count;
  out->median_ms = percentile (sorted, count, 50);
  out->p95_ms = percentile (sorted, count, 95);
  out->p99_ms = percentile (sorted, count, 99);
  out->max_ms = sorted[count - 1];
  out->fps = sum > 0 ? (double) count * 1000.0 / sum : 0;
  out->nominal_ms = nominal_ms > 0 ? nominal_ms : out->median_ms;
  if (out->nominal_ms <= 0)
    return;
  for (gsize i = 0; i < count; i++) {
    if (intervals[i] > 1.5 * out->nominal_ms) {
      out->long_frames++;
      double slots = floor (intervals[i] / out->nominal_ms + 0.5);
      if (slots > 1)
        out->missed_frames += (guint64) (slots - 1);
    }
  }
}

static void
add_ms (JsonBuilder *builder, const char *name, double value)
{
  json_builder_set_member_name (builder, name);
  json_builder_add_double_value (builder, round (value * 1000.0) / 1000.0);
}

void
tc_pacing_to_json (const TcPacing *pacing, JsonBuilder *builder)
{
  json_builder_begin_object (builder);
  json_builder_set_member_name (builder, "frames");
  json_builder_add_int_value (builder, (gint64) pacing->frames);
  json_builder_set_member_name (builder, "intervals");
  json_builder_add_int_value (builder, (gint64) pacing->intervals);
  add_ms (builder, "nominalMs", pacing->nominal_ms);
  add_ms (builder, "meanMs", pacing->mean_ms);
  add_ms (builder, "medianMs", pacing->median_ms);
  add_ms (builder, "p95Ms", pacing->p95_ms);
  add_ms (builder, "p99Ms", pacing->p99_ms);
  add_ms (builder, "maxMs", pacing->max_ms);
  add_ms (builder, "fps", pacing->fps);
  json_builder_set_member_name (builder, "longFrames");
  json_builder_add_int_value (builder, (gint64) pacing->long_frames);
  json_builder_set_member_name (builder, "missedFrames");
  json_builder_add_int_value (builder, (gint64) pacing->missed_frames);
  json_builder_end_object (builder);
}
