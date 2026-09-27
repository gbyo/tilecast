/*
 * Remote web protocol v1: the closed control protocol between the trusted
 * renderer (client) and tilecast-web-renderer-wpe (server).
 * docs/tilecast-edge-remote-web-threat-review.md §6.
 *
 * Framing is the Edge IPC framing: a big-endian u32 length, then one UTF-8
 * JSON object. Every object has a closed member set; anything else is a
 * protocol violation and closes the connection. Both programs compile this
 * file, and both test it against packages/edge-protocol/fixtures/remote-web.
 */
#pragma once

#include <glib.h>
#include <json-glib/json-glib.h>

G_BEGIN_DECLS

#define TC_RW_PROTOCOL_VERSION 1
#define TC_RW_MAX_FRAME (64u * 1024u)
#define TC_RW_MAX_SURFACES 4u
#define TC_RW_MAX_WARM 2u
#define TC_RW_MAX_EDGE 3840u
#define TC_RW_MIN_EDGE 16u
#define TC_RW_MAX_PIXELS 8294400u
#define TC_RW_MAX_URL 2048u
#define TC_RW_MAX_HOSTS 25u
#define TC_RW_MAX_HOST 253u
#define TC_RW_MAX_USER_AGENT 256u
#define TC_RW_MAX_SCROLL 100000u
#define TC_RW_MAX_IN_FLIGHT 8u
#define TC_RW_CAPABILITY_HEX 64u

typedef enum {
  TC_RW_COOKIES_DISABLED,
  TC_RW_COOKIES_FIRST_PARTY,
  TC_RW_COOKIES_ALL,
} TcRwCookiePolicy;

typedef enum {
  TC_RW_CONTENT_PAGE,
  TC_RW_CONTENT_YOUTUBE,
} TcRwContentKind;

/* A validated `create` request. Strings are owned. */
typedef struct {
  char surface_id[49];
  guint width;
  guint height;
  gboolean muted;
  gboolean visible;
  TcRwContentKind kind;

  /* page */
  char *url;
  GPtrArray *allowed_hosts; /* char*, lowercase, no trailing dot */
  gboolean javascript;
  gboolean dom_storage;
  TcRwCookiePolicy cookies;
  char *user_agent; /* empty for the engine default */
  guint zoom_percent;
  guint scroll_x;
  guint scroll_y;
  char background[10]; /* "#RRGGBB" or "#RRGGBBAA" */

  /* youtube */
  char video_id[129];
  char playlist_id[129];
  guint start_seconds;
  gint end_seconds; /* -1: none */
  gboolean loop;
  gboolean author_muted;
  guint volume;
  gboolean captions;
  char caption_language[9];
  gboolean controls;
} TcRwCreate;

void tc_rw_create_clear (TcRwCreate *create);

typedef enum {
  TC_RW_REQ_INVALID,
  TC_RW_REQ_HELLO,
  TC_RW_REQ_CREATE,
  TC_RW_REQ_RESIZE,
  TC_RW_REQ_VISIBLE,
  TC_RW_REQ_MUTE,
  TC_RW_REQ_RELOAD,
  TC_RW_REQ_DESTROY,
  TC_RW_REQ_CLEAR_DATA,
} TcRwRequestType;

/* One parsed request. For CREATE, `create` is filled; callers clear it. */
typedef struct {
  TcRwRequestType type;
  guint version;
  char surface_id[49];
  guint width;
  guint height;
  gboolean flag; /* visible or muted */
  char request_id[49];
  TcRwCreate create;
} TcRwRequest;

/* Parses one request object. Returns FALSE (and a stable reason token in
 * *reason) for anything outside the closed protocol. */
gboolean tc_rw_parse_request (JsonObject *object, TcRwRequest *out, const char **reason);

/* Event kinds the helper sends for a surface. */
typedef enum {
  TC_RW_EVENT_STREAM_READY,
  TC_RW_EVENT_LOADED,
  TC_RW_EVENT_NAVIGATION_BLOCKED,
  TC_RW_EVENT_FAILED,
  TC_RW_EVENT_PROCESS_TERMINATED,
  TC_RW_EVENT_MEDIA_ENDED,
} TcRwEventKind;

const char *tc_rw_event_kind_name (TcRwEventKind kind);
gboolean tc_rw_event_kind_parse (const char *name, TcRwEventKind *kind);

/* Stable failure codes. The runtime maps them onto its Website failure path. */
gboolean tc_rw_is_failure_code (const char *code);

/* Helper → renderer messages. */
typedef enum {
  TC_RW_MSG_INVALID,
  TC_RW_MSG_WELCOME,
  TC_RW_MSG_CREATED,
  TC_RW_MSG_REJECTED,
  TC_RW_MSG_EVENT,
  TC_RW_MSG_CLEARED,
} TcRwMessageType;

typedef struct {
  TcRwMessageType type;
  guint version;
  gboolean accelerated;
  char surface_id[49];
  char capability[TC_RW_CAPABILITY_HEX + 1];
  char code[33];
  TcRwEventKind event;
  char request_id[49];
  gboolean ok;
} TcRwMessage;

gboolean tc_rw_parse_message (JsonObject *object, TcRwMessage *out, const char **reason);

/* Builders. Each returns a new JSON string. */
char *tc_rw_build_welcome (gboolean accelerated);
char *tc_rw_build_created (const char *surface_id, const char *capability);
char *tc_rw_build_rejected (const char *surface_id, const char *code);
char *tc_rw_build_event (const char *surface_id, TcRwEventKind kind, const char *code);
char *tc_rw_build_cleared (const char *request_id, gboolean ok);

/* Primitive checks, shared with the renderer's validation of runtime input. */
gboolean tc_rw_is_surface_id (const char *value);
gboolean tc_rw_is_capability (const char *value);
gboolean tc_rw_is_youtube_id (const char *value);
gboolean tc_rw_is_language_code (const char *value);
gboolean tc_rw_is_color (const char *value);
/* Lowercases and strips one trailing dot into `out`; FALSE if not a host. */
gboolean tc_rw_normalize_host (const char *value, char out[TC_RW_MAX_HOST + 1]);
gboolean tc_rw_is_printable_ascii (const char *value, gsize max);

G_END_DECLS
