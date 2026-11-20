/*
 * --visual-trace: an operator-started, time-bounded record of what the
 * Player Runtime says its layers are doing and of every buffer WPE presents,
 * on one monotonic timeline (docs/tilecast-edge-visual-trace.md).
 *
 * Off unless the renderer is started with --visual-trace. Then, and only
 * then, the renderer:
 *   - injects tilecast-visual-trace.js into the trusted top document, so the
 *     Runtime records its transition and startup events;
 *   - follows WPEView::buffer-rendered/-released and writes one metadata line
 *     per buffer (never pixels);
 *   - samples the page clock against CLOCK_MONOTONIC once a second;
 *   - writes all of it to a bounded JSONL file in its cache directory, and
 *     stops after --visual-trace-seconds.
 */
#pragma once

#include <glib.h>
#include <json-glib/json-glib.h>
#include <wpe/webkit.h>

G_BEGIN_DECLS

typedef struct _TcHost TcHost;
typedef struct _TcVisualTrace TcVisualTrace;

#define TC_VISUAL_TRACE_DEFAULT_SECONDS 120
#define TC_VISUAL_TRACE_MIN_SECONDS 5
#define TC_VISUAL_TRACE_MAX_SECONDS 1800
#define TC_VISUAL_TRACE_FILE "visual-trace.jsonl"

/* Starts the trace for `view`. Returns NULL, with a warning, if the trace
 * file cannot be opened; the renderer then runs exactly as without it. */
TcVisualTrace *tc_visual_trace_start (TcHost *host, WPEView *view, const char *dir, guint seconds, gboolean deep);
/* A "diagnostics.visual_trace" page message. Ignored once the window ended. */
void tc_visual_trace_page_message (TcVisualTrace *trace, JsonObject *message);
/* A Runtime document finished loading: sample its clock now. */
void tc_visual_trace_document_ready (TcVisualTrace *trace);
/* Writes the summary, closes the file and disconnects. Safe with NULL. */
void tc_visual_trace_stop (TcVisualTrace *trace);

G_END_DECLS
