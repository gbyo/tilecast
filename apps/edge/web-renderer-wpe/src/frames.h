/*
 * Frame export for one remote surface (threat review §7, spike §4).
 *
 *   WPEView::buffer-rendered → TcFrames → appsrc → leaky queue(1) → unixfdsink
 *
 * - SHM buffers (no GPU): one copy into a memfd-backed buffer.
 * - DMA-BUF buffers (GPU): one GPU blit into a buffer from this surface's own
 *   pool, exported as DMA-BUF. The slot returns to the pool only when the
 *   consumer releases the buffer, so WebKit's reuse of its own swapchain
 *   buffer can never tear a frame the renderer still shows.
 * - Latest frame only. The software path is limited to 30 fps; the last
 *   frame is sent again after one idle second so the consumer can tell a
 *   still page from a stalled stream.
 */
#pragma once

#include <gio/gio.h>
#include <wpe/wpe-platform.h>

G_BEGIN_DECLS

typedef struct _TcFrames TcFrames;

typedef void (*TcFramesFirstFrame) (gpointer user_data);

/* Creates the unixfdsink pipeline listening on `socket_path` (mode 0660).
 * `egl_display` may be NULL; DMA-BUF frames then fail the stream. */
TcFrames *tc_frames_new (const char *socket_path, gpointer egl_display, TcFramesFirstFrame first_frame,
                         gpointer user_data, GError **error);
void tc_frames_push (TcFrames *frames, WPEBuffer *buffer);
/* TRUE when the last frame failed to export (the surface then fails). */
gboolean tc_frames_failed (TcFrames *frames);
guint64 tc_frames_sent (TcFrames *frames);
/* Stops the pipeline and removes the socket. */
void tc_frames_free (TcFrames *frames);

/* Test hook: a GPU copy of one DMA-BUF buffer into a pool buffer, without a
 * pipeline. Returns the exported fd or -1. */
int tc_frames_test_gpu_copy (gpointer egl_display, WPEBuffer *buffer, guint32 *fourcc, guint64 *modifier,
                             guint32 *stride);

G_END_DECLS
