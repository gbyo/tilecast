/*
 * Describes the buffers a WPEView presents, for the visual trace and the
 * compositor lab: one JSON line per WPEView::buffer-rendered,
 * buffer-released and buffers-changed, with metadata only (never pixels).
 *
 * Buffer identity is an ordinal per WPEBuffer object ("buf") and per
 * underlying DMA-BUF ("mem", from the plane 0 file's inode), so reuse of a
 * swapchain buffer is visible without exposing pointers or file descriptors.
 */
#pragma once

#include <glib.h>
#include <wpe/wpe-platform.h>

G_BEGIN_DECLS

typedef struct _TcBufferTimeline TcBufferTimeline;

TcBufferTimeline *tc_buffer_timeline_new (void);
void tc_buffer_timeline_free (TcBufferTimeline *timeline);

/* Ordinal of a WPEBuffer object, assigned on first sight. */
guint tc_buffer_timeline_buffer_id (TcBufferTimeline *timeline, WPEBuffer *buffer);

/* {"type":"frame","ev":"rendered","mono":..,"seq":..,"buf":..,"mem":..,"w":..,
 *  "h":..,"kind":"dmabuf"|"shm"|"other",...}. Returns the presentation
 * sequence number (from 1). */
guint64 tc_buffer_timeline_rendered (TcBufferTimeline *timeline, WPEBuffer *buffer, gint64 mono_us, GString *line);
/* {"type":"frame","ev":"released","mono":..,"buf":..} */
void tc_buffer_timeline_released (TcBufferTimeline *timeline, WPEBuffer *buffer, gint64 mono_us, GString *line);
/* {"type":"buffers","mono":..,"count":..,"bufs":[..]} */
void tc_buffer_timeline_pool (TcBufferTimeline *timeline, WPEBuffer **buffers, guint n, gint64 mono_us, GString *line);

guint tc_buffer_timeline_distinct_buffers (TcBufferTimeline *timeline);
guint tc_buffer_timeline_distinct_memory (TcBufferTimeline *timeline);

G_END_DECLS
