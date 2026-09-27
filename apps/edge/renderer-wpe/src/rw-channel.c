#include "rw-channel.h"

#include <string.h>

#define TC_RW_MAX_FRAME_BYTES (64u * 1024u)

typedef struct {
  TcRwFrameKind kind;
  char surface_id[49];
  guint8 *buffer; /* 4-byte big-endian length + JSON */
  gsize length;
  gsize offset; /* bytes already accepted by the socket */
} Outgoing;

typedef struct {
  TcRwChannel *channel;
  guint64 id;
  guint64 generation;
} Ticket;

/* Identity for async tickets. The generation alone cannot tell a stale
 * callback from a live one when the channel struct itself is freed and its
 * memory reused by a new channel at the same address with a coincidentally
 * equal generation: every channel takes a fresh process-wide identity, so a
 * ticket from a dead channel can never drive a new one. All channel use is
 * on one thread, so a plain counter suffices. */
static guint64 next_channel_id = 1;

struct _TcRwChannel {
  guint64 id;
  guint max_queued;
  guint write_timeout_ms;
  TcRwChannelDisconnect on_disconnect;
  gpointer user_data;

  GSocketConnection *connection;
  GQueue *queue; /* Outgoing*, FIFO */
  gboolean write_in_flight;
  guint timeout_source;
  Ticket *timeout_ticket; /* owned while timeout_source != 0 */
  guint64 generation;

  gint64 window_start;
  guint window_count;
};

static void pump_head (TcRwChannel *channel);

gboolean
tc_rw_frame_coalescable (TcRwFrameKind kind)
{
  return kind == TC_RW_FRAME_RESIZE || kind == TC_RW_FRAME_VISIBLE
         || kind == TC_RW_FRAME_MUTE || kind == TC_RW_FRAME_RELOAD;
}

static void
outgoing_free (gpointer data)
{
  Outgoing *frame = data;
  g_free (frame->buffer);
  g_free (frame);
}

TcRwChannel *
tc_rw_channel_new_full (guint max_queued, guint write_timeout_ms,
                        TcRwChannelDisconnect on_disconnect, gpointer user_data)
{
  TcRwChannel *channel = g_new0 (TcRwChannel, 1);
  channel->id = next_channel_id++;
  channel->max_queued = max_queued == 0 ? TC_RW_MAX_OUTGOING : max_queued;
  channel->write_timeout_ms = write_timeout_ms == 0 ? TC_RW_WRITE_TIMEOUT_MS : write_timeout_ms;
  channel->on_disconnect = on_disconnect;
  channel->user_data = user_data;
  channel->queue = g_queue_new ();
  return channel;
}

TcRwChannel *
tc_rw_channel_new (TcRwChannelDisconnect on_disconnect, gpointer user_data)
{
  return tc_rw_channel_new_full (0, 0, on_disconnect, user_data);
}

void
tc_rw_channel_free (TcRwChannel *channel)
{
  if (channel == NULL)
    return;
  tc_rw_channel_detach (channel);
  g_queue_free_full (channel->queue, outgoing_free);
  g_free (channel);
}

void
tc_rw_channel_attach (TcRwChannel *channel, GSocketConnection *connection)
{
  g_return_if_fail (channel != NULL);
  tc_rw_channel_detach (channel);
  channel->connection = g_object_ref (connection);
  channel->window_start = 0;
  channel->window_count = 0;
}

static void
clear_timeout (TcRwChannel *channel)
{
  if (channel->timeout_source != 0) {
    g_source_remove (channel->timeout_source);
    channel->timeout_source = 0;
  }
  g_free (channel->timeout_ticket);
  channel->timeout_ticket = NULL;
}

void
tc_rw_channel_detach (TcRwChannel *channel)
{
  if (channel == NULL)
    return;
  /* Invalidate every outstanding async write and deadline callback first:
   * completions that arrive later see a stale generation and return. */
  channel->generation++;
  channel->write_in_flight = FALSE;
  clear_timeout (channel);
  g_queue_clear_full (channel->queue, outgoing_free);
  g_clear_object (&channel->connection);
}

guint
tc_rw_channel_queued (TcRwChannel *channel)
{
  return channel->queue->length;
}

gboolean
tc_rw_channel_send (TcRwChannel *channel, TcRwFrameKind kind,
                    const char *surface_id, const char *json)
{
  gsize length = json != NULL ? strlen (json) : 0;
  if (channel->connection == NULL || length == 0 || length > TC_RW_MAX_FRAME_BYTES)
    return FALSE;
  if (tc_rw_frame_coalescable (kind) && surface_id != NULL) {
    /* Latest wins, replaced in place: chatter collapses without reordering
     * anything else. The head is skipped while a GIO write references its
     * buffer; replacing that buffer would free memory the write still reads. */
    for (GList *link = channel->queue->head; link != NULL; link = link->next) {
      Outgoing *queued = link->data;
      if (link == channel->queue->head && channel->write_in_flight)
        continue;
      if (queued->kind == kind && g_strcmp0 (queued->surface_id, surface_id) == 0) {
        gsize fresh = length + 4;
        guint8 *buffer = g_malloc (fresh);
        buffer[0] = (guint8) (length >> 24);
        buffer[1] = (guint8) (length >> 16);
        buffer[2] = (guint8) (length >> 8);
        buffer[3] = (guint8) length;
        memcpy (buffer + 4, json, length);
        g_free (queued->buffer);
        queued->buffer = buffer;
        queued->length = fresh;
        queued->offset = 0;
        return TRUE;
      }
    }
  }
  if (channel->queue->length >= channel->max_queued)
    return FALSE;
  Outgoing *frame = g_new0 (Outgoing, 1);
  frame->kind = kind;
  if (surface_id != NULL)
    g_strlcpy (frame->surface_id, surface_id, sizeof frame->surface_id);
  frame->length = length + 4;
  frame->buffer = g_malloc (frame->length);
  frame->buffer[0] = (guint8) (length >> 24);
  frame->buffer[1] = (guint8) (length >> 16);
  frame->buffer[2] = (guint8) (length >> 8);
  frame->buffer[3] = (guint8) length;
  memcpy (frame->buffer + 4, json, length);
  g_queue_push_tail (channel->queue, frame);
  pump_head (channel);
  return TRUE;
}

gboolean
tc_rw_channel_note_incoming (TcRwChannel *channel, gint64 now_us)
{
  if (channel->window_start == 0 || now_us - channel->window_start >= (gint64) TC_RW_INCOMING_WINDOW_US) {
    channel->window_start = now_us;
    channel->window_count = 1;
    return TRUE;
  }
  channel->window_count++;
  return channel->window_count <= TC_RW_MAX_INCOMING_PER_SEC;
}

static void
fail (TcRwChannel *channel, const char *reason)
{
  /* Detach before reporting: the callback disconnects, and a second report
   * for the same failure must be impossible. The generation bump makes any
   * other in-flight completion stale. */
  tc_rw_channel_detach (channel);
  if (channel->on_disconnect != NULL)
    channel->on_disconnect (channel, reason, channel->user_data);
}

static void
on_written (GObject *source, GAsyncResult *result, gpointer user_data)
{
  Ticket *ticket = user_data;
  TcRwChannel *channel = ticket->channel;
  gboolean stale = ticket->id != channel->id || ticket->generation != channel->generation;
  g_free (ticket);
  if (stale)
    return;
  channel->write_in_flight = FALSE;
  g_autoptr (GError) error = NULL;
  gssize written = g_output_stream_write_finish (G_OUTPUT_STREAM (source), result, &error);
  if (written < 0) {
    fail (channel, error != NULL ? error->message : "write failed");
    return;
  }
  Outgoing *head = g_queue_peek_head (channel->queue);
  if (head == NULL) {
    /* Detached and reattached between pump and completion, keeping the
     * generation: the queue was cleared, so there is nothing to advance. */
    return;
  }
  head->offset += (gsize) written;
  if (head->offset < head->length) {
    pump_head (channel);
    return;
  }
  clear_timeout (channel);
  g_queue_pop_head (channel->queue);
  outgoing_free (head);
  pump_head (channel);
}

static void
on_write_timeout (gpointer user_data)
{
  Ticket *ticket = user_data;
  TcRwChannel *channel = ticket->channel;
  gboolean stale = ticket->id != channel->id || ticket->generation != channel->generation;
  if (ticket == channel->timeout_ticket) {
    channel->timeout_source = 0;
    channel->timeout_ticket = NULL;
  }
  g_free (ticket);
  if (stale)
    return;
  if (!channel->write_in_flight)
    return;
  /* The helper is connected but not consuming: stop queueing behind it and
   * let the caller's recovery path (reconnect) take over. */
  fail (channel, "the helper does not consume data");
}

static void
pump_head (TcRwChannel *channel)
{
  if (channel->write_in_flight || g_queue_is_empty (channel->queue) || channel->connection == NULL)
    return;
  Outgoing *head = g_queue_peek_head (channel->queue);
  GOutputStream *out = g_io_stream_get_output_stream (G_IO_STREAM (channel->connection));
  channel->write_in_flight = TRUE;
  if (head->offset == 0) {
    /* One deadline per head frame; partial writes keep the original one. */
    clear_timeout (channel);
    Ticket *timeout = g_new (Ticket, 1);
    timeout->channel = channel;
    timeout->id = channel->id;
    timeout->generation = channel->generation;
    channel->timeout_ticket = timeout;
    channel->timeout_source = g_timeout_add_once (channel->write_timeout_ms, on_write_timeout, timeout);
  }
  Ticket *write_ticket = g_new (Ticket, 1);
  write_ticket->channel = channel;
  write_ticket->id = channel->id;
  write_ticket->generation = channel->generation;
  g_output_stream_write_async (out, head->buffer + head->offset, head->length - head->offset,
                               G_PRIORITY_DEFAULT, NULL, on_written, write_ticket);
}
