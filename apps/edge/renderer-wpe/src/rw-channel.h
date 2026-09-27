/*
 * Bounded async control channel: the trusted renderer's write side of the
 * remote web protocol (threat review §6).
 *
 * The helper is treated as compromised, so the trusted renderer's GLib main
 * loop must never block waiting for it. Every outbound frame is queued in a
 * small bounded FIFO and flushed with one asynchronous GIO write at a time:
 *
 *   - no blocking writes on the main loop;
 *   - message ordering is preserved (FIFO);
 *   - resize/visible/mute/reload chatter coalesces per surface (latest wins)
 *     so a fast producer cannot grow the queue;
 *   - a full queue fails the send synchronously, so the caller disconnects
 *     and the existing recovery path takes over;
 *   - a write that the helper does not consume fails on a deadline, which
 *     also disconnects;
 *   - detach() invalidates every outstanding callback through a per-channel
 *     identity record that outlives the channel itself, so shutdown,
 *     disconnect and reconnect are safe against use-after-free — even a
 *     completion that arrives after the channel struct is freed.
 *
 * Inbound, note_incoming() enforces a per-second frame budget on the trusted
 * side. The helper-side EVENT_BUDGET in control.c is not a security boundary
 * (a compromised helper can ignore it); this one is, because it runs in the
 * victim. Sustained excess disconnects rather than queueing backlog: reads
 * are already asynchronous, so the risk is CPU monopolization, not a queue.
 */
#pragma once

#include <gio/gio.h>

G_BEGIN_DECLS

/* Outgoing queue bound: small enough to cap transient memory (frames are at
 * most 64 KiB) while never filling under a healthy helper. */
#define TC_RW_MAX_OUTGOING 16u
/* How long one head frame may wait for the helper to consume it, matching
 * the helper's SEND_TIMEOUT_SECONDS in the other direction. */
#define TC_RW_WRITE_TIMEOUT_MS 2000u
/* Trusted-side inbound budget: a healthy helper sends a handful of frames
 * per surface per second (loads, stream-ready, failures). */
#define TC_RW_MAX_INCOMING_PER_SEC 64u
#define TC_RW_INCOMING_WINDOW_US (1u * G_USEC_PER_SEC)

typedef enum {
  TC_RW_FRAME_HELLO,
  TC_RW_FRAME_CREATE,
  TC_RW_FRAME_RESIZE,
  TC_RW_FRAME_VISIBLE,
  TC_RW_FRAME_MUTE,
  TC_RW_FRAME_RELOAD,
  TC_RW_FRAME_DESTROY,
  TC_RW_FRAME_CLEAR,
} TcRwFrameKind;

/* Latest-wins kinds: per-surface state updates where only the newest value
 * matters. Everything else is lifecycle and must keep every frame. */
gboolean tc_rw_frame_coalescable (TcRwFrameKind kind);

typedef struct _TcRwChannel TcRwChannel;
typedef void (*TcRwChannelDisconnect) (TcRwChannel *channel, const char *reason, gpointer user_data);

TcRwChannel *tc_rw_channel_new (TcRwChannelDisconnect on_disconnect, gpointer user_data);
/* Test override for the queue bound and the write deadline. */
TcRwChannel *tc_rw_channel_new_full (guint max_queued, guint write_timeout_ms,
                                      TcRwChannelDisconnect on_disconnect, gpointer user_data);
void tc_rw_channel_free (TcRwChannel *channel);

/* Attach to a connected socket (takes a reference) and reset pump state.
 * Detach drops the connection, cancels the deadline, clears the queue and
 * invalidates outstanding async callbacks. */
void tc_rw_channel_attach (TcRwChannel *channel, GSocketConnection *connection);
void tc_rw_channel_detach (TcRwChannel *channel);

/* Queue one JSON frame. Returns FALSE (and queues nothing) when detached,
 * when the frame is empty/oversize, or when the queue is full: the caller
 * must then disconnect and let recovery take over. `surface_id` may be NULL
 * for connection-level frames; it keys coalescing otherwise. */
gboolean tc_rw_channel_send (TcRwChannel *channel, TcRwFrameKind kind,
                             const char *surface_id, const char *json);

/* Record one complete inbound frame at `now_us` (g_get_monotonic_time()).
 * Returns FALSE on sustained excess: the caller must disconnect. */
gboolean tc_rw_channel_note_incoming (TcRwChannel *channel, gint64 now_us);

/* Queued frame count, for tests and diagnostics. */
guint tc_rw_channel_queued (TcRwChannel *channel);

G_END_DECLS
