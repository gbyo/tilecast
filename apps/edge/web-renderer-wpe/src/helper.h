/*
 * tilecast-web-renderer-wpe: the isolated process for untrusted remote web
 * content (docs/tilecast-edge-remote-web-threat-review.md).
 *
 * It renders pages off screen in headless WPE WebViews and exports their
 * frames to the trusted renderer. It holds no playback policy: timeouts,
 * reload intervals, fallback and evidence belong to the Player Runtime. It
 * knows nothing about Tilecast credentials, manifests, schedules or content.
 */
#pragma once

#include "frames.h"
#include "rw-protocol.h"

#include <gio/gio.h>
#include <sys/types.h>
#include <wpe/webkit.h>

G_BEGIN_DECLS

#define TC_WEB_VERSION "0.1.0"

typedef struct _TcWeb TcWeb;
typedef struct _TcSurface TcSurface;

struct _TcWeb {
  /* Options. */
  char *control_path;
  char *frames_dir;
  char *data_dir;
  char *cache_dir;
  uid_t client_uid;

  GMainLoop *loop;
  WPEDisplay *display;
  gpointer egl_display;
  gboolean accelerated;
  WebKitWebContext *context;
  WebKitNetworkSession *first_party;
  WebKitNetworkSession *all;

  /* Control connection (one client). */
  GSocketService *service;
  GSocketConnection *client;
  GCancellable *io;
  guchar header[4];
  guchar *payload;
  gsize payload_length;
  gboolean hello_done;
  guint clears_in_flight;

  /* Event budget (threat review §6.1). */
  gint64 event_window_start;
  guint events_in_window;
  GHashTable *deferred_events; /* surface id -> char* frame, latest wins */
  guint deferred_source;

  GHashTable *surfaces; /* surface id -> TcSurface* */
};

/* control.c */
gboolean tc_control_start (TcWeb *web, GError **error);
void tc_control_stop (TcWeb *web);
/* Sends one frame to the client; drops it when no client is connected. */
void tc_control_send (TcWeb *web, const char *json);
/* Sends a surface event within the event budget. */
void tc_control_event (TcWeb *web, const char *surface_id, TcRwEventKind kind, const char *code);

/* surface.c */
TcSurface *tc_surface_create (TcWeb *web, TcRwCreate *create, const char **code);
void tc_surface_resize (TcSurface *surface, guint width, guint height);
void tc_surface_set_visible (TcSurface *surface, gboolean visible);
void tc_surface_set_muted (TcSurface *surface, gboolean muted);
void tc_surface_reload (TcSurface *surface);
void tc_surface_destroy (TcSurface *surface);
const char *tc_surface_capability (TcSurface *surface);
guint64 tc_surface_pixels (TcSurface *surface);
WebKitNetworkSession *tc_surface_private_session (TcSurface *surface);

/* profiles.c */
WebKitNetworkSession *tc_profiles_session (TcWeb *web, TcRwCookiePolicy policy, gboolean *owned);
void tc_profiles_configure (WebKitNetworkSession *session, TcRwCookiePolicy policy);
typedef void (*TcClearDone) (gboolean ok, gpointer user_data);
void tc_profiles_clear (TcWeb *web, TcClearDone done, gpointer user_data);

/* youtube.c */
#define TC_YOUTUBE_BASE_URI "https://org.tilecast.player/"
char *tc_youtube_wrapper (const TcRwCreate *create);
gboolean tc_youtube_subframe_allowed (const char *uri);

G_END_DECLS
