/*
 * The session bridge's side of the Edge IPC contract (edge_protocol::ipc,
 * role `session_bridge`). Pure functions only, unit tested against the
 * golden fixtures in packages/edge-protocol/fixtures/ipc.
 *
 * The bridge sends no events: it hellos, holds the session, and says
 * goodbye. Anything else on the wire is framing.
 */
#pragma once

#include <json-glib/json-glib.h>

G_BEGIN_DECLS

#define TB_PROTOCOL_VERSION 1
/* tilecastd sends only small frames to the bridge. */
#define TB_MAX_INBOUND_FRAME_BYTES (64 * 1024)
#define TB_MAX_OUTBOUND_FRAME_BYTES (4 * 1024)

/* A complete event frame: {"type":"event","seq":N,"event":name,"data":…}. */
JsonNode *tb_event_frame (guint64 seq, const char *name, JsonNode *data);

/* The hello frame for the session_bridge role. */
JsonNode *tb_hello_frame (const char *version);

G_END_DECLS
