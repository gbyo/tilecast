/*
 * Pure helpers for the opt-in visual trace (visual-trace.c) and the
 * development-only compositor lab (lab/compositor-lab.c).
 *
 * GLib and json-glib only, so tests/test_visual_trace_format.c runs them
 * without a WPE graphics stack. Nothing here runs unless an operator turned
 * a diagnostic on: the renderer creates no writer and connects no handler by
 * default.
 *
 * The record schema is "tilecast-visual-v1" (docs/tilecast-edge-visual-trace.md).
 * Every line of a trace file is one JSON object with a "type" member.
 */
#pragma once

#include <glib.h>
#include <json-glib/json-glib.h>

G_BEGIN_DECLS

#define TC_TRACE_SCHEMA "tilecast-visual-v1"
/* A trace file never grows past this. The last TC_TRACE_SUMMARY_RESERVE bytes
 * are kept for the summary line written when the trace closes. */
#define TC_TRACE_MAX_FILE_BYTES (32u * 1024u * 1024u)
#define TC_TRACE_SUMMARY_RESERVE (16u * 1024u)
#define TC_TRACE_MAX_LINE_BYTES (8u * 1024u)
/* Bounds on what the page may send; the Runtime applies the same bounds. */
#define TC_TRACE_MAX_RECORDS_PER_BATCH 256
#define TC_TRACE_MAX_KEYS 24
#define TC_TRACE_MAX_STRING 48
/* Presentation timestamps kept for pacing statistics. */
#define TC_TRACE_MAX_PACING_SAMPLES 65536

/* ---- bounded JSONL file ------------------------------------------------ */

typedef struct _TcTraceWriter TcTraceWriter;

/* Creates `dir` (0700) if needed, keeps one previous file as `<name>.prev`
 * and opens `<dir>/<name>` (0600, never through a symbolic link). `dir`
 * must be a clean absolute path. */
TcTraceWriter *tc_trace_writer_open (const char *dir, const char *name, gsize max_bytes, GError **error);
/* Appends one line (a newline is added). Returns FALSE, and counts the line
 * as dropped, when it would pass the bound or is longer than
 * TC_TRACE_MAX_LINE_BYTES. */
gboolean tc_trace_writer_line (TcTraceWriter *writer, const char *line);
void tc_trace_writer_flush (TcTraceWriter *writer);
guint64 tc_trace_writer_lines (TcTraceWriter *writer);
guint64 tc_trace_writer_dropped (TcTraceWriter *writer);
gsize tc_trace_writer_bytes (TcTraceWriter *writer);
const char *tc_trace_writer_path (TcTraceWriter *writer);
/* Writes `final_line` (may use the summary reserve), closes and frees. */
void tc_trace_writer_close (TcTraceWriter *writer, const char *final_line);

/* Serializes `builder`'s root as one compact line and appends it. */
gboolean tc_trace_writer_builder (TcTraceWriter *writer, JsonBuilder *builder);

/* ---- what the page may say --------------------------------------------- */

/* [A-Za-z0-9_.:-], at most `max` bytes. Cannot hold a URL, a path with
 * slashes, whitespace or free text. */
gboolean tc_trace_token_valid (const char *value, gsize max);
/* [A-Za-z][A-Za-z0-9]{0,23} */
gboolean tc_trace_key_valid (const char *key);

/*
 * Copies one Runtime record into `builder` as an object with only:
 *   t (finite number), scope (stage|zone|startup|trace from the Runtime, lab
 *   from compositor-lab scenes), ev (token), and up
 *   to TC_TRACE_MAX_KEYS - 3 more members whose key is valid and whose value
 *   is a finite number, a boolean, null or a token.
 * Anything else is left out. Returns FALSE, adding nothing, when t, scope or
 * ev is missing or invalid.
 */
gboolean tc_trace_copy_page_record (JsonObject *record, JsonBuilder *builder);

/*
 * Writes one line per valid record of a Runtime batch
 * ({"type":"diagnostics.visual_trace","batch":{schema,seq,sentAt,dropped,records}}):
 *   {"type":"runtime","recv":<us>,"batch":<seq>,"sentAt":<ms>,"rec":{...}}
 * The first line also carries "dropped" when the page dropped records.
 * Returns the number of lines written; *invalid counts refused records.
 */
guint tc_trace_write_page_batch (TcTraceWriter *writer, JsonObject *message, gint64 recv_monotonic_us,
                                 guint *invalid);

/* ---- environment ------------------------------------------------------- */

/* The compositor and WPE variables that change rendering, and only those.
 * Verified against the WPE WebKit 2.54.0 source; see
 * docs/tilecast-edge-wpe-compositor-lab.md before adding one. */
extern const char *const tc_trace_env_allowlist[];

/* {"NAME": "value" | null} for each allowlisted name. A value that is not a
 * short token (letters, digits, _ . : , x -) is written as "<invalid>". */
void tc_trace_env_to_json (JsonBuilder *builder);

/* ---- buffers ----------------------------------------------------------- */

/* A DRM fourcc as four printable characters ("XR24"); '?' for others. */
void tc_trace_fourcc (guint32 fourcc, char out[5]);

/* ---- frame pacing ------------------------------------------------------ */

typedef struct {
  guint64 frames;     /* presentations */
  guint64 intervals;  /* frames - 1, or 0 */
  double nominal_ms;  /* the display interval used for long and missed frames */
  double mean_ms;
  double median_ms;
  double p95_ms;
  double p99_ms;
  double max_ms;
  double fps;         /* intervals / span */
  guint64 long_frames;   /* interval > 1.5 x nominal */
  guint64 missed_frames; /* display intervals with no new frame, estimated */
} TcPacing;

/* Statistics of monotonic presentation times in microseconds (ascending).
 * `nominal_ms` <= 0 uses the median interval as the display interval. */
void tc_pacing_compute (const gint64 *times_us, gsize n, double nominal_ms, TcPacing *out);
/* The same from intervals in milliseconds (frames = n + 1); for intervals
 * collected only while something was moving. */
void tc_pacing_compute_intervals (const double *intervals_ms, gsize n, double nominal_ms, TcPacing *out);
void tc_pacing_to_json (const TcPacing *pacing, JsonBuilder *builder);

G_END_DECLS
