/*
 * tilecast-session-bridge: the tilecast account's user-session process that
 * holds the `session_bridge` role on tilecastd's socket.
 *
 *   ipc.c        the Edge IPC client (role session_bridge)
 *   protocol.c   pure frame building and parsing
 *
 * The retired Noise Meter used to live here (PipeWire capture and audio
 * inventory); the bridge now only connects, holds the session while Edge
 * runs, and reconnects across daemon restarts.
 */
#pragma once

#include <gio/gio.h>
#include <json-glib/json-glib.h>

#include "protocol.h"

G_BEGIN_DECLS

#define TB_VERSION "0.1.0"

typedef struct {
  GMainLoop *loop;
  char *socket_path;
  int exit_code;

  /* ipc.c */
  GSocketConnection *connection;
  GCancellable *io_cancellable;
  guchar header[4];
  guchar *payload;
  gsize payload_length;
  gboolean welcomed;
  guint64 expected_inbound_seq;
  guint reconnect_source;
  guint reconnect_delay_ms;
  /* The last connect failure logged, so a retry loop logs it once. */
  char *last_connect_error;
  /* When the daemon's socket went missing; the bridge exits after a while. */
  gint64 socket_missing_since;
} TbBridge;

/* ipc.c */
void tb_ipc_start (TbBridge *bridge);
void tb_ipc_stop (TbBridge *bridge, const char *reason);

G_END_DECLS
