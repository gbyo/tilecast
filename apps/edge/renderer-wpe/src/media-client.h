#pragma once

#include <gio/gio.h>

G_BEGIN_DECLS

#define TC_MEDIA_MAX_READ (1024u * 1024u)

/* The socket is daemon-owned. Each call makes one bounded request. */
gboolean tc_media_head (const char *socket_path, const char *capability, guint64 *size, char **mime_type, GError **error);
gboolean tc_media_read (const char *socket_path, const char *capability, guint64 offset, void *buffer, guint32 length,
                        GError **error);

/*
 * Frame reads: identical framing with `"expect":"frame"` appended, so the
 * daemon resolves a frame grant instead of a media grant. Media reads never
 * send the field, keeping their bytes identical for older daemons.
 */
gboolean tc_media_head_frame (const char *socket_path, const char *capability, guint64 *size, char **mime_type,
                              GError **error);
gboolean tc_media_read_frame (const char *socket_path, const char *capability, guint64 offset, void *buffer,
                              guint32 length, GError **error);

/*
 * Present grants (docs/tilecast-edge-airplay.md §5): one request,
 * `{"op":"present","capability":"<64 lowercase hex>"}`. The daemon answers with
 * the fixed loopback ports of the active AirPlay session. The value is the
 * opaque present capability, never an AirPlay session ID. A reply that names
 * any other port is refused here, so the page and the reply can never choose
 * an address or a port. `audio` is FALSE when the session forwards no audio.
 */
#define TC_PRESENT_VIDEO_PORT 42000
#define TC_PRESENT_AUDIO_PORT 42002
gboolean tc_media_present (const char *socket_path, const char *capability, gboolean *audio, GError **error);

G_END_DECLS
