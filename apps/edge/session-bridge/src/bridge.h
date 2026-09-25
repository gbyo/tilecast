/*
 * tilecast-session-bridge: the tilecast account's user-session process that
 * gives tilecastd what only the session can see (docs/tilecast-edge.md §4.4).
 *
 *   inventory.c  WirePlumber: audio sources and sinks, default nodes
 *   capture.c    GStreamer: pipewiresrc ! audioconvert ! level
 *   ipc.c        the Edge IPC client (role session_bridge)
 *   protocol.c   pure frame building and parsing
 *
 * Raw audio exists only inside the GStreamer pipeline. The bridge sends
 * tilecastd one derived RMS value per level interval, and only while
 * tilecastd has asked for capture.
 */
#pragma once

#include <gio/gio.h>
#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include "protocol.h"

G_BEGIN_DECLS

#define TB_VERSION "0.1.0"

typedef struct _WpCore WpCore;
typedef struct _WpObjectManager WpObjectManager;
typedef struct _WpPlugin WpPlugin;

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
  guint64 next_outbound_seq;
  guint64 expected_inbound_seq;
  guint reconnect_source;
  guint reconnect_delay_ms;
  /* The last connect failure logged, so a retry loop logs it once. */
  char *last_connect_error;
  /* When the daemon's socket went missing; the bridge exits after a while. */
  gint64 socket_missing_since;

  /* capture.c */
  gboolean capture_wanted;
  TbCaptureState capture_state;
  GstElement *pipeline;
  guint capture_retry_source;
  guint capture_watchdog_source;
  gint64 last_level_at;

  /* inventory.c */
  WpCore *core;
  WpObjectManager *nodes;
  WpPlugin *default_nodes;
  TbInventory inventory;
  guint inventory_retry_source;
} TbBridge;

/* ipc.c */
void tb_ipc_start (TbBridge *bridge);
void tb_ipc_stop (TbBridge *bridge, const char *reason);
gboolean tb_ipc_send_event (TbBridge *bridge, const char *name, JsonNode *data);
/* Resends the current inventory and capture state (after a welcome). */
void tb_ipc_announce (TbBridge *bridge);

/* capture.c */
void tb_capture_set_wanted (TbBridge *bridge, gboolean wanted);
void tb_capture_stop (TbBridge *bridge);
void tb_capture_send_state (TbBridge *bridge);

/* inventory.c */
void tb_inventory_start (TbBridge *bridge);
void tb_inventory_stop (TbBridge *bridge);
void tb_inventory_send (TbBridge *bridge);

G_END_DECLS
