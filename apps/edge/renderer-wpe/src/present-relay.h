/*
 * The AirPlay stream relay (docs/tilecast-edge-airplay.md §5).
 *
 * WebKit's bubblewrap sandbox gives each web process its own network
 * namespace, so the tcpresent source in the web process cannot receive the
 * RTP that UxPlay sends to the host's loopback. This process stays in the
 * host's namespace. For the source ID of the current activation, it asks
 * tilecastd for the present grant over the media socket, receives the fixed
 * loopback ports of that grant, and relays each stream to a Unix socket
 * <dir>/<id>-video.sock and <dir>/<id>-audio.sock with unixfdsink. The
 * directory is private to the renderer and is the only path the web process
 * gets. The relay asks for the grant again each second and stops when it is
 * gone; a stopped relay removes its sockets.
 */
#pragma once

#include <glib.h>

G_BEGIN_DECLS

typedef struct _TcPresentRelay TcPresentRelay;

/* Called on the main context when a requested relay runs (`ok`) or could not
 * start: the grant was denied, a port was in use, or an element is missing. */
typedef void (*TcPresentRelayReady) (gboolean ok, gpointer data);

TcPresentRelay *tc_present_relay_new (const char *dir, const char *media_socket);
void tc_present_relay_free (TcPresentRelay *relay);

/* Relays the session `source_id` (64 lowercase hex), or stops for NULL. A
 * request for the ID that already runs changes nothing. `ready` is called
 * exactly once, unless a later call replaces the request first: at once when
 * there is nothing to start, otherwise when the grant check answered. */
void tc_present_relay_set (TcPresentRelay *relay, const char *source_id, TcPresentRelayReady ready, gpointer data);

/* A grant check for a requested relay has not answered yet. */
gboolean tc_present_relay_pending (TcPresentRelay *relay);

/* The relay runs. Capture of the screen is refused while it does. */
gboolean tc_present_relay_active (TcPresentRelay *relay);

/*
 * Whether this renderer can show a forwarded stream: GStreamer starts, every
 * element of the relay and of the tcpresent source exists, and an H.264
 * decoder exists. `decoder` gets the decoder of the highest rank, which is
 * the one decodebin selects, and `hardware` whether its class names
 * "Hardware". The answer is computed once.
 */
gboolean tc_present_relay_probe (const char **decoder, gboolean *hardware);

G_END_DECLS
