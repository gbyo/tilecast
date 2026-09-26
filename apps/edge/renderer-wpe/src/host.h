/*
 * tilecast-renderer-wpe: a deliberately small WPEPlatform embedder.
 *
 * Responsibilities (docs/tilecast-edge.md §10):
 *   - create the WPE display and one fullscreen web view (drm, wayland,
 *     headless);
 *   - load the trusted Tilecast web runtime from tilecast://runtime/;
 *   - bridge the IPC renderer contract to the runtime through a strict
 *     message handler;
 *   - serve generation-bound media capabilities through tilecastd;
 *   - report readiness, acceptance, evidence, errors and health;
 *   - exit on unrecoverable engine failure so systemd restarts it.
 *
 * It contains no playlist selection, scheduling, downloading, credentials or
 * update logic. Everything it knows arrives from tilecastd.
 */
#pragma once

#include <gio/gio.h>
#include <json-glib/json-glib.h>
#include <wpe/webkit.h>

G_BEGIN_DECLS

#define TC_RENDERER_VERSION "0.1.0"
#define TC_IPC_PROTOCOL_VERSION 1
#define TC_MAX_FRAME_BYTES (4u * 1024u * 1024u)
#define TC_MAX_CONTENT_REFS 1024

typedef enum {
  TC_PLATFORM_DRM,
  TC_PLATFORM_WAYLAND,
  TC_PLATFORM_HEADLESS,
} TcPlatform;

typedef struct {
  char uri[128];
  guint64 size_bytes;
  char *mime_type;
} TcContentRef;

typedef struct _TcHost TcHost;

struct _TcHost {
  /* Options. */
  TcPlatform platform;
  char *socket_path;
  char *runtime_dir;
  /* Daemon-owned media socket; web processes inherit this path. */
  char *media_socket;
  char *gst_plugin_dir;
  int headless_width;
  int headless_height;
  gboolean console_to_stderr;
  /* Exit after this many seconds (CI); 0 means run until stopped. */
  guint exit_after_seconds;

  GMainLoop *loop;
  int exit_code;

  /* Engine. */
  WPEDisplay *display;
  WebKitWebContext *web_context;
  WebKitNetworkSession *network_session;
  WebKitWebView *view;
  gboolean runtime_ready;
  guint web_process_terminations;

  /* IPC. */
  GSocketConnection *connection;
  GCancellable *io_cancellable;
  guchar header[4];
  guchar *payload;
  gsize payload_length;
  guint64 next_outbound_seq;
  guint64 expected_inbound_seq;
  gboolean welcomed;
  guint reconnect_source;
  guint reconnect_delay_ms;
  guint64 next_request_id;
  GHashTable *pending_replies; /* request id -> WebKitScriptMessageReply */

  /* Daemon-provided state. */
  GPtrArray *content;          /* TcContentRef*, current activation + plugins */
  GPtrArray *plugin_content;   /* TcContentRef*, current plugin state */
  GHashTable *media_aliases;   /* "<asset>/<variant>" -> capability URI, from plugin state */
  char *current_activation_id;
  gint64 current_generation;
  char *current_activation_json; /* full presentation.activate data, for re-delivery */
  char *current_plugins_json;
  guint health_source;
};

/* ipc.c */
void tc_ipc_start (TcHost *host);
void tc_ipc_stop (TcHost *host, const char *reason);
gboolean tc_ipc_send_event (TcHost *host, const char *name, JsonNode *data);
gboolean tc_ipc_send_request (TcHost *host, const char *method, JsonNode *params, char **out_id);

/* protocol.c */
void tc_protocol_handle_frame (TcHost *host, JsonObject *frame);
void tc_protocol_send_ready (TcHost *host);
void tc_protocol_send_health (TcHost *host, const char *state, const char *reason);

/* view.c */
gboolean tc_view_create (TcHost *host, GError **error);
void tc_view_deliver (TcHost *host, const char *name, const char *json);
void tc_view_reload_runtime (TcHost *host);
void tc_view_resolve_reply (TcHost *host, const char *request_id, const char *result_json, const char *error_message);

/* schemes.c */
void tc_schemes_register (TcHost *host);
const TcContentRef *tc_host_find_content (TcHost *host, const char *uri);
void tc_content_ref_free (gpointer ref);

G_END_DECLS
