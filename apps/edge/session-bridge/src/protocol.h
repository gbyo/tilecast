/*
 * The session bridge's side of the Edge IPC contract (edge_protocol::ipc,
 * role `session_bridge`). Pure functions only, unit tested against the
 * golden fixtures in packages/edge-protocol/fixtures/ipc.
 *
 * The bridge sends two events and receives one:
 *
 *   bridge → tilecastd  audio.inventory {pipewire, sources, sinks,
 *                                         defaultSource, defaultSink}
 *   bridge → tilecastd  audio.level     {rms: 0..1 | null, state}
 *   tilecastd → bridge  capture.set     {enabled}
 *
 * Nothing else: no device names, no PipeWire object IDs, no samples.
 */
#pragma once

#include <json-glib/json-glib.h>

G_BEGIN_DECLS

#define TB_PROTOCOL_VERSION 1
#define TB_MAX_AUDIO_DEVICES 64
/* tilecastd sends only small frames to the bridge. */
#define TB_MAX_INBOUND_FRAME_BYTES (64 * 1024)
#define TB_MAX_OUTBOUND_FRAME_BYTES (4 * 1024)

typedef enum {
  TB_CAPTURE_IDLE,
  TB_CAPTURE_STARTING,
  TB_CAPTURE_CAPTURING,
  TB_CAPTURE_NO_MICROPHONE,
  TB_CAPTURE_PIPEWIRE_UNAVAILABLE,
  TB_CAPTURE_PERMISSION_DENIED,
  TB_CAPTURE_FAILED,
  TB_CAPTURE_RECOVERING,
} TbCaptureState;

typedef struct {
  gboolean pipewire;
  guint sources;
  guint sinks;
  gboolean default_source;
  gboolean default_sink;
} TbInventory;

/* The wire token for a capture state (edge_protocol CaptureState). */
const char *tb_capture_state_name (TbCaptureState state);

/*
 * One linear RMS amplitude in [0, 1] from the GStreamer `level` element's
 * per-channel `rms` values in dB: the square root of the mean channel
 * power. Silence (-inf dB) is 0. Returns FALSE when there is no channel or
 * a value is NaN.
 */
gboolean tb_rms_from_decibels (const double *decibels, guint channels, double *rms);

/* `audio.level` data. `rms` is used only in TB_CAPTURE_CAPTURING. */
JsonNode *tb_level_data (TbCaptureState state, double rms);

/* `audio.inventory` data; counts are clamped to TB_MAX_AUDIO_DEVICES. */
JsonNode *tb_inventory_data (const TbInventory *inventory);

/*
 * Strict `capture.set` data: exactly one boolean member `enabled`. Anything
 * else is a protocol violation and the bridge closes the session.
 */
gboolean tb_parse_capture_set (JsonNode *data, gboolean *enabled);

/* A complete event frame: {"type":"event","seq":N,"event":name,"data":…}. */
JsonNode *tb_event_frame (guint64 seq, const char *name, JsonNode *data);

/* The hello frame for the session_bridge role. */
JsonNode *tb_hello_frame (const char *version);

G_END_DECLS
